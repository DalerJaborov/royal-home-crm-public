/**
 * ИНКРЕМЕНТ SOMON (каждые 15 минут, 12.11.2026): первые страницы разделов продажи квартир и домов.
 *
 * Зачем. Между воскресными полными обходами квартиры Somon попадали в каталог только из минутного
 * парсера лидов (он отдаёт каталогу уже скачанные страницы). Пауза Telegram-уведомлений площадок
 * (`telegramPortalPause.ts`) выключает этот парсер целиком — и каталог Somon стоял с 11.11.2026.
 * Пауза обязана глушить уведомления и лиды, а не рынок. Дома парсер лидов не читает вовсе.
 *
 * Чего здесь нет — двойного трафика. Квартиры читаются, только когда парсер лидов сам их НЕ пишет
 * (`somonMonitorFeedsMarket`: лиды выключены, остановлены или на паузе); дома — всегда. Все запросы —
 * через общую дверь `fetchSomon` в фоновом режиме (тот же темп 10 с, уступает лидам, 403 — полная
 * остановка источника, 429/5xx — пауза), обход — тем же `crawlSection` с правилом своей рубрики.
 * Источник остановлен или на долгой паузе после отказа — тик тихо пропускается, без ожидания.
 *
 * Чего инкремент НЕ делает никогда: не помечает объявления исчезнувшими (по двум страницам из ста
 * «нет в списке» ничего не доказывает) — это дело полного обхода.
 *
 * Замок общий с полными обходами и инкрементом Paydo (`withMarketCrawlLock`): занят — тик пропускается.
 * Расписание — cron.ts (`market-somon-incremental`, минуты 7/22/37/52 — мимо тиков Paydo на :00/:10/…),
 * флаг MARKET_CRAWL_ENABLED=1, как у остальных задач рынка.
 */

import { prisma } from "../../db.js";
import { somonMonitorFeedsMarket } from "../somonLeads/monitor.js";
import { saveListings } from "./marketStore.js";
import { withMarketCrawlLock } from "./nightly.js";
import { APARTMENTS_SECTION, crawlSection, SECTIONS, type CrawlStop } from "./somonCrawler.js";
import { SOMON_SOURCE } from "./somonRubrics.js";

/** Сколько первых страниц раздела читаем за тик (60 объявлений на страницу; новое лежит сверху). */
export const SOMON_INCREMENTAL_PAGES = 3;
/** Потолок времени тика: меньше интервала расписания (15 минут). */
export const SOMON_INCREMENTAL_MAX_RUNTIME_MS = 10 * 60_000;
/** Бюджет закрыт дольше этого (пауза после 429/5xx) — тик не ждёт, а пропускается. */
const LONG_BLOCK_MS = 60_000;

let running = false;

export interface SomonIncrementalSection {
  section: string;
  pages: number;
  saved: number;
  foreignSkipped: number;
  /** Почему раздел закончился раньше потолка страниц; `skipped_monitor` — квартиры пишет парсер лидов. */
  stopReason?: CrawlStop | "skipped_monitor";
}

export interface SomonIncrementalStats {
  sections: SomonIncrementalSection[];
}

export interface SomonIncrementalOptions {
  pages?: number;
  maxRuntimeMs?: number;
  /** Для тестов: подмена ожидания слота бюджета. */
  pause?: (ms: number) => Promise<void>;
}

/** Источник остановлен (403/5 сбоев) или бюджет закрыт надолго — сегодня к Somon не ходим. */
async function sourceClosed(now: Date): Promise<boolean> {
  const state = await prisma.somonMonitor.findUnique({ where: { id: "singleton" }, select: { sourceStopped: true, blockedUntil: true } });
  if (!state) return false;
  if (state.sourceStopped) return true;
  return !!state.blockedUntil && state.blockedUntil.getTime() - now.getTime() > LONG_BLOCK_MS;
}

/** null — тик пропущен: замок занят, прошлый тик ещё идёт или источник закрыт. */
export async function runSomonIncremental(options: SomonIncrementalOptions = {}): Promise<SomonIncrementalStats | null> {
  if (running) return null;
  running = true;
  try {
    if (await sourceClosed(new Date())) return null;
    const monitorFeeds = await somonMonitorFeedsMarket();
    const maxRuntime = options.maxRuntimeMs ?? SOMON_INCREMENTAL_MAX_RUNTIME_MS;
    const locked = await withMarketCrawlLock(async (lock) => {
      const deadline = Date.now() + maxRuntime;
      const shouldStop = () => lock.isLost() || Date.now() >= deadline;
      const stats: SomonIncrementalStats = { sections: [] };
      for (const section of SECTIONS) {
        if (section === APARTMENTS_SECTION && monitorFeeds) {
          stats.sections.push({ section: section.label, pages: 0, saved: 0, foreignSkipped: 0, stopReason: "skipped_monitor" });
          continue;
        }
        let saved = 0;
        const result = await crawlSection(section, {
          maxPages: options.pages ?? SOMON_INCREMENTAL_PAGES,
          shouldStop,
          pause: options.pause,
          onPage: async (listings) => {
            const s = await saveListings(SOMON_SOURCE, listings);
            saved += s.created + s.updated;
          },
        });
        const stopReason = result.stopReason === "page_limit" ? undefined : result.stopReason;
        stats.sections.push({ section: section.label, pages: result.pagesFetched, saved, foreignSkipped: result.foreignSkipped, ...(stopReason ? { stopReason } : {}) });
        // Отказ сайта или остановка бюджета — дальше в этом тике не ходим (причина уже в журнале).
        if (stopReason && stopReason !== "wrong_scope") break;
      }
      return stats;
    }, maxRuntime);
    return locked ? locked.value : null;
  } finally {
    running = false;
  }
}
