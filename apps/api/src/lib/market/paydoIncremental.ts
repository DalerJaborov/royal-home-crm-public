/**
 * ИНКРЕМЕНТ Paydo (каждые 10 минут, 03.11.2026): добирает НОВОЕ и изменившееся в цене.
 *
 * Почему так можно. Выдача Paydo без параметров сортировки идёт «сначала платные продвижения
 * (VIP/PREMIUM), затем свежие по дате публикации»: курсор содержит `search_after` вида
 * [ранг продвижения, оценка, время публикации (мс), id], а на живой выдаче 03.11.2026 после
 * двух продвинутых объявлений шли BASIC по убыванию времени. Значит, всё новое лежит на первых
 * страницах, и идти вглубь, пока там встречается новое, достаточно. Сортировка в API
 * объявлена (`sorting`: default/date/price_low/price_high), но как её передать в
 * `POST /api/v1/search/`, не проверено: сайт её в этом запросе не шлёт. Поэтому порядок
 * по умолчанию — единственное, на что мы опираемся, и опираемся осторожно: останов не по одной
 * известной странице (наверху бывают старые продвинутые), а по ДВУМ подряд, плюс потолок страниц.
 *
 * Чего инкремент НЕ делает никогда: не помечает объявления исчезнувшими (это дело полного
 * ночного обхода — по неполной выдаче «нет в списке» ничего не доказывает).
 *
 * Замок общий с полными обходами (`withMarketCrawlLock`): занят — тик тихо пропускается.
 * 403/429 — стоп без повторов; в журнал идёт только код ответа, без тел и токенов.
 */

import { prisma } from "../../db.js";
import { logSystemError } from "../systemError.js";
import { withMarketCrawlLock, type CrawlLock } from "./nightly.js";
import { saveListings } from "./marketStore.js";
import { PaydoBlockedError, PaydoClient } from "./paydoClient.js";
import { crawlPaydoSection, PAYDO_SECTIONS, type PaydoStop } from "./paydoCrawler.js";
import { PAYDO_SOURCE } from "./paydoParser.js";
import type { ParsedListing } from "./somonParser.js";

/** Сколько страниц подряд должно целиком состоять из известных неизменённых объявлений, чтобы остановиться. */
export const INCREMENTAL_KNOWN_PAGES_TO_STOP = 2;
/** Потолок страниц на раздел за один тик (20 объявлений на страницу). */
export const INCREMENTAL_MAX_PAGES = 15;
/** Потолок времени тика: меньше интервала расписания (10 минут), чтобы тики не наезжали. */
export const INCREMENTAL_MAX_RUNTIME_MS = 8 * 60_000;

let running = false;

export type IncrementalStop = PaydoStop | "paydo_blocked" | "failed" | "deadline" | "lock_lost";

export interface IncrementalSectionStats {
  section: string;
  pages: number;
  /** Почему раздел закончился раньше конца выдачи; пусто — выдача кончилась сама. */
  stopReason?: IncrementalStop;
}

export interface IncrementalStats {
  created: number;
  updated: number;
  priceChanges: number;
  sections: IncrementalSectionStats[];
}

export interface IncrementalOptions {
  maxPagesPerSection?: number;
  maxRuntimeMs?: number;
}

interface KnownRow {
  sourceId: string;
  price: unknown;
  currency: string | null;
  isActive: boolean;
}

/** Объявление известно и не изменилось: есть в каталоге, активно, цена и валюта те же. */
export function isKnownUnchanged(prev: KnownRow | undefined, l: Pick<ParsedListing, "price" | "currency">): boolean {
  if (!prev || !prev.isActive) return false;
  if (prev.currency !== l.currency) return false;
  if (prev.price == null || l.price == null) return prev.price == null && l.price == null;
  return Math.abs(Number(prev.price as never) - Number(l.price)) < 0.005;
}

/** Все ли объявления страницы уже известны и не менялись (проверять ДО saveListings). */
async function pageIsKnown(listings: ParsedListing[]): Promise<boolean> {
  const rows = await prisma.marketListing.findMany({
    where: { source: PAYDO_SOURCE, sourceId: { in: listings.map((l) => l.sourceId) } },
    select: { sourceId: true, price: true, currency: true, isActive: true },
  });
  const bySourceId = new Map<string, KnownRow>(rows.map((r) => [r.sourceId, r]));
  return listings.every((l) => isKnownUnchanged(bySourceId.get(l.sourceId), l));
}

async function incrementalPass(lock: CrawlLock, options: IncrementalOptions): Promise<IncrementalStats> {
  const stats: IncrementalStats = { created: 0, updated: 0, priceChanges: 0, sections: [] };
  const deadline = Date.now() + (options.maxRuntimeMs ?? INCREMENTAL_MAX_RUNTIME_MS);
  const client = new PaydoClient();

  for (const section of PAYDO_SECTIONS) {
    if (lock.isLost()) {
      stats.sections.push({ section: section.label, pages: 0, stopReason: "lock_lost" });
      break;
    }
    if (Date.now() >= deadline) {
      stats.sections.push({ section: section.label, pages: 0, stopReason: "deadline" });
      break;
    }
    let knownStreak = 0;
    const flag: { interrupted: "lock_lost" | "deadline" | null } = { interrupted: null }; // меняется в колбэке: узкий let TS бы «застолбил» как null
    try {
      const result = await crawlPaydoSection(client, section, {
        maxPages: options.maxPagesPerSection ?? INCREMENTAL_MAX_PAGES,
        onPage: async (listings) => {
          if (lock.isLost()) {
            flag.interrupted = "lock_lost";
            return "stop";
          }
          if (Date.now() >= deadline) {
            flag.interrupted = "deadline";
            return "stop";
          }
          const known = await pageIsKnown(listings);
          const saved = await saveListings(PAYDO_SOURCE, listings);
          stats.created += saved.created;
          stats.updated += saved.updated;
          stats.priceChanges += saved.priceChanges;
          knownStreak = known ? knownStreak + 1 : 0;
          return knownStreak >= INCREMENTAL_KNOWN_PAGES_TO_STOP ? "stop" : undefined;
        },
      });
      const stopReason: IncrementalStop | undefined = flag.interrupted ?? (result.complete ? undefined : result.stopReason);
      stats.sections.push({ section: section.label, pages: result.pagesFetched, ...(stopReason ? { stopReason } : {}) });
      if (result.stopReason === "page_failed") {
        await logSystemError("api", `Инкремент Paydo: «${section.label}» не отдал страницу после повторов`, { dedupKey: "market-paydo-incremental-failed" });
        break;
      }
      if (flag.interrupted) break;
    } catch (err) {
      if (err instanceof PaydoBlockedError) {
        stats.sections.push({ section: section.label, pages: 0, stopReason: "paydo_blocked" });
        await logSystemError("api", `Инкремент Paydo остановлен: сайт ответил ${err.status}`, { dedupKey: "market-paydo-blocked" });
      } else {
        // Тело ошибки не пишем: в нём могут оказаться заголовки или фрагменты ответа.
        stats.sections.push({ section: section.label, pages: 0, stopReason: "failed" });
        await logSystemError("api", "Инкремент Paydo оборван ошибкой", { dedupKey: "market-paydo-incremental-failed" });
      }
      break;
    }
  }
  return stats;
}

/** null — тик пропущен: замок занят (полный обход, ручной скрипт) или предыдущий инкремент ещё идёт. */
export async function runPaydoIncremental(options: IncrementalOptions = {}): Promise<IncrementalStats | null> {
  if (running) return null;
  running = true;
  try {
    const maxRuntime = options.maxRuntimeMs ?? INCREMENTAL_MAX_RUNTIME_MS;
    const locked = await withMarketCrawlLock((lock) => incrementalPass(lock, options), maxRuntime);
    return locked ? locked.value : null;
  } finally {
    running = false;
  }
}
