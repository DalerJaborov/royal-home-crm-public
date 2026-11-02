/**
 * ПОЛНЫЙ ОБХОД РЫНКА (раз в неделю): Somon (HTML, через общую дверь `fetchSomon`) + Paydo
 * (JSON API, только чтение).
 *
 * Только квартиры и дома в Душанбе (владелец 02.11.2026). Между обходами каталог
 * подпитывает минутный парсер лидов (он отдаёт уже скачанные страницы квартир),
 * поэтому полный обход нужен редко.
 *
 * Правила, которые нельзя ослаблять:
 *  - один прогон за раз во ВСЕХ процессах: замок `pg_try_advisory_xact_lock` держится
 *    транзакцией на всё время прогона (снимается сам при падении процесса);
 *  - «исчезло» помечаем ТОЛЬКО после ПОЛНОГО обхода источника: оборванный даёт
 *    ложные «продано». И только тех, кого не видели дольше 1,5 интервала обхода
 *    (`DISAPPEAR_AFTER_HOURS`, ≈ 11 суток), то есть мимо двух полных обходов подряд:
 *    у Somon выдача по смещению, и за 1–2 часа обхода объявление может проскочить
 *    между страницами. Полным считается обход, дошедший до последней страницы, и
 *    не подозрительно маленький (меньше 60 % от того, что источник отдавал раньше —
 *    так ловим молча оборванный обход, например сбой Paydo после ретраев);
 *  - прогон ограничен по времени (3 часа) и сам останавливается при потере замка;
 *  - Somon не получает ни одного запроса мимо общего бюджета: 403/429 — стоп без ретраев.
 *
 * Расписание — в cron.ts (раз в неделю, MARKET_CRAWL_ENABLED=1; по умолчанию выключено).
 */

import { prisma } from "../../db.js";
import { logSystemError } from "../systemError.js";
import { DISAPPEAR_AFTER_HOURS, markDisappeared, saveListings } from "./marketStore.js";
import { crawlPaydoSection, PAYDO_SECTIONS } from "./paydoCrawler.js";
import { PaydoBlockedError, PaydoClient } from "./paydoClient.js";
import { PAYDO_SOURCE } from "./paydoParser.js";
import { crawlSection, SECTIONS, type CrawlStop } from "./somonCrawler.js";

const SOMON_SOURCE = "somon.tj";
/** Потолок времени одного прогона. */
export const MAX_RUNTIME_MS = 3 * 60 * 60_000;
/** Обход считаем подозрительно маленьким, если собрал меньше этой доли прежнего. */
const TRUNCATION_RATIO = 0.6;
/** Малые базы (первый прогон, новый источник) под защиту не попадают: сравнивать не с чем. */
const TRUNCATION_MIN_PREVIOUS = 100;
const HEARTBEAT_MS = 60_000;

let running = false;

export type FullCrawlStop = CrawlStop | "paydo_blocked" | "paydo_failed" | "too_small" | "lock_lost";

export interface SourceStats {
  saved: number;
  pages: number;
  complete: boolean;
  stopReason?: FullCrawlStop;
  /** Сколько помечено исчезнувшими (0, если обход неполный). */
  disappeared: number;
}

export interface FullCrawlStats {
  somon: SourceStats;
  paydo: SourceStats;
}

export interface FullCrawlOptions {
  /** Для тестов: подмена ожидания и предела времени. */
  pause?: (ms: number) => Promise<void>;
  maxRuntimeMs?: number;
}

export interface CrawlLock {
  isLost(): boolean;
}

/**
 * Выполняет `fn` под межпроцессным замком обхода. Замок уже занят — null (без ошибки).
 *
 * Транзакционный advisory-замок (как в syncMetaAds): сессионный pg_advisory_lock при
 * пуле соединений Prisma рискует снимать замок на другом соединении. Транзакция живёт
 * весь прогон; чтобы сервер не прибил «простаивающую» транзакцию, раз в минуту шлём
 * SELECT 1, а если он упал — замок считается потерянным и обход останавливается.
 */
export async function withMarketCrawlLock<T>(
  fn: (lock: CrawlLock) => Promise<T>,
  maxRuntimeMs = MAX_RUNTIME_MS
): Promise<{ value: T } | null> {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext('market-full-crawl')) AS locked`;
      if (!rows[0]?.locked) return null;
      let lost = false;
      const beat = setInterval(() => {
        tx.$queryRaw`SELECT 1`.then(undefined, () => {
          lost = true;
        });
      }, HEARTBEAT_MS);
      try {
        return { value: await fn({ isLost: () => lost }) };
      } finally {
        clearInterval(beat);
      }
    },
    { timeout: maxRuntimeMs + 10 * 60_000, maxWait: 15_000 }
  );
}

/** Сколько объявлений источник отдавал в обходимой области недавно (для защиты от обрыва). */
async function previousScopeCount(source: string): Promise<number> {
  return prisma.marketListing.count({
    where: {
      source,
      isActive: true,
      dealType: "SALE",
      propertyType: { in: ["APARTMENT", "HOUSE"] },
      lastSeenAt: { gte: new Date(Date.now() - 14 * 24 * 3600_000) },
    },
  });
}

export function looksTruncated(seen: number, previous: number): boolean {
  return previous >= TRUNCATION_MIN_PREVIOUS && seen < previous * TRUNCATION_RATIO;
}

class CrawlInterrupted extends Error {
  constructor(public readonly reason: "deadline" | "lock_lost") {
    super(reason);
  }
}

async function crawlSomon(shouldStop: () => boolean, options: FullCrawlOptions): Promise<SourceStats> {
  const stats: SourceStats = { saved: 0, pages: 0, complete: true, disappeared: 0 };
  const previous = await previousScopeCount(SOMON_SOURCE);
  const seen = new Set<string>();
  for (const section of SECTIONS) {
    const result = await crawlSection(section, {
      shouldStop,
      pause: options.pause,
      onPage: async (listings) => {
        const s = await saveListings(SOMON_SOURCE, listings);
        stats.saved += s.created + s.updated;
        for (const l of listings) seen.add(l.sourceId);
      },
    });
    stats.pages += result.pagesFetched;
    if (!result.complete) {
      stats.complete = false;
      stats.stopReason = result.stopReason;
      break; // причина уже записана в журнал самим обходчиком
    }
  }
  if (stats.complete && looksTruncated(seen.size, previous)) {
    stats.complete = false;
    stats.stopReason = "too_small";
    await logSystemError("api", `Полный обход Somon дал подозрительно мало объявлений (${seen.size} при ${previous} раньше): исчезнувшие не помечены`, { dedupKey: "market-somon-too-small" });
  }
  if (stats.complete) stats.disappeared = await markDisappeared(SOMON_SOURCE, DISAPPEAR_AFTER_HOURS);
  return stats;
}

async function crawlPaydo(shouldStop: () => boolean, lock: CrawlLock): Promise<SourceStats> {
  const stats: SourceStats = { saved: 0, pages: 0, complete: true, disappeared: 0 };
  if (shouldStop()) return { ...stats, complete: false, stopReason: lock.isLost() ? "lock_lost" : "deadline" };
  const previous = await previousScopeCount(PAYDO_SOURCE);
  const seen = new Set<string>();
  try {
    const client = new PaydoClient();
    for (const section of PAYDO_SECTIONS) {
      const result = await crawlPaydoSection(client, section, {
        onPage: async (listings) => {
          if (lock.isLost()) throw new CrawlInterrupted("lock_lost");
          if (shouldStop()) throw new CrawlInterrupted("deadline");
          const s = await saveListings(PAYDO_SOURCE, listings);
          stats.saved += s.created + s.updated;
          for (const l of listings) seen.add(l.sourceId);
        },
      });
      stats.pages += result.pagesFetched;
      // Раздел не дочитан до конца выдачи (страница не отдалась после ретраев, пустой ответ,
      // предел страниц) или страниц нет совсем: обход неполный, «исчезнувшие» не помечаем.
      // Иначе сбой посреди раздела погасил бы ~половину каталога ложным «сняли».
      if (!result.complete || result.pagesFetched === 0) {
        stats.complete = false;
        stats.stopReason = "paydo_failed";
        const why = result.pagesFetched === 0 ? "не отдал ни одной страницы" : `оборван на стр. ${result.pagesFetched + 1} (${result.stopReason ?? "неизвестно"})`;
        await logSystemError("api", `Полный обход Paydo: «${section.label}» ${why}; исчезнувшие не помечены`, { dedupKey: "market-paydo-failed" });
        break;
      }
    }
  } catch (err) {
    stats.complete = false;
    if (err instanceof CrawlInterrupted) {
      stats.stopReason = err.reason;
    } else if (err instanceof PaydoBlockedError) {
      stats.stopReason = "paydo_blocked";
      await logSystemError("api", `Полный обход Paydo остановлен: сайт ответил ${err.status}`, { dedupKey: "market-paydo-blocked" });
    } else {
      stats.stopReason = "paydo_failed";
      await logSystemError("api", "Полный обход Paydo оборван ошибкой", { dedupKey: "market-paydo-failed" });
    }
  }
  if (stats.complete && looksTruncated(seen.size, previous)) {
    stats.complete = false;
    stats.stopReason = "too_small";
    await logSystemError("api", `Полный обход Paydo дал подозрительно мало объявлений (${seen.size} при ${previous} раньше): исчезнувшие не помечены`, { dedupKey: "market-paydo-too-small" });
  }
  if (stats.complete) stats.disappeared = await markDisappeared(PAYDO_SOURCE, DISAPPEAR_AFTER_HOURS);
  return stats;
}

/** null — прогон уже идёт (в этом или другом процессе) и новый не начат. */
export async function runMarketFullCrawl(options: FullCrawlOptions = {}): Promise<FullCrawlStats | null> {
  if (running) return null;
  running = true;
  try {
    const maxRuntime = options.maxRuntimeMs ?? MAX_RUNTIME_MS;
    const locked = await withMarketCrawlLock(async (lock) => {
      const deadline = Date.now() + maxRuntime;
      const shouldStop = () => lock.isLost() || Date.now() >= deadline;
      const somon = await crawlSomon(shouldStop, options);
      const paydo = await crawlPaydo(shouldStop, lock);
      return { somon, paydo } satisfies FullCrawlStats;
    }, maxRuntime);
    return locked ? locked.value : null;
  } finally {
    running = false;
  }
}

/** @deprecated прежнее имя; cron.ts переводится на `runMarketFullCrawl` (раз в неделю). */
export const runNightlyMarketCrawl = runMarketFullCrawl;
