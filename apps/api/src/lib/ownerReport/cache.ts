import type { OwnerReportResponse } from "@royal-home/shared";

/**
 * КЭШ ГОТОВОГО «ОТЧЁТА ВЛАДЕЛЬЦУ» И УЧЁТ ОТКРЫТИЙ В ПАМЯТИ (ревью 04.10.2026).
 *
 * ЗАЧЕМ. Один GET публичной страницы — около полусотни запросов к базе (два вызова «голоса
 * рынка», обращения, сайт, реклама). Лимитер пускает 60 запросов за 5 минут с адреса, то есть
 * одной ссылкой, открытой в цикле, можно занять пул соединений (15) и затормозить CRM. Цифры
 * отчёта за полторы минуты не меняются настолько, чтобы это было видно владельцу, поэтому
 * собранный ответ держится 90 секунд.
 *
 * ЧТО НЕ КЭШИРУЕТСЯ
 *  • ссылка и её отзыв — они читаются из базы на КАЖДЫЙ запрос (routes/ownerReportPublic.ts):
 *    отозванная ссылка и удалённый объект гаснут сразу, а не через 90 секунд;
 *  • «объекта нет» (null) — 404 не запоминается;
 *  • ошибка сборки — её получают все, кто ждал этот же расчёт, но следующий запрос считает заново.
 *
 * ПАМЯТЬ ОГРАНИЧЕНА: не больше MAX_ENTRIES отчётов (самый старый вытесняется), просроченные
 * убираются при записи и при обращении, а не копятся.
 *
 * ОДНА СБОРКА НА ОБЪЕКТ: пока отчёт собирается, все новые запросы по этому объекту ждут тот же
 * промис и не запускают свои пятьдесят запросов.
 */

export const OWNER_REPORT_CACHE_TTL_MS = 90_000;
export const OWNER_REPORT_CACHE_MAX_ENTRIES = 200;
/** Не чаще одного засчитанного открытия на ссылку в минуту. */
export const OWNER_REPORT_VIEW_COUNT_INTERVAL_MS = 60_000;
/** Потолок таблицы «когда ссылку засчитывали»: запись старше интервала всё равно ничего не решает. */
const VIEW_THROTTLE_MAX_ENTRIES = 1_000;

interface CacheEntry {
  expiresAt: number;
  report: OwnerReportResponse;
}

const reports = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<OwnerReportResponse | null>>();
const viewCountedAt = new Map<string, number>();

function evictExpired(now: number): void {
  for (const [key, entry] of reports) {
    if (entry.expiresAt <= now) reports.delete(key);
  }
}

function store(propertyId: string, report: OwnerReportResponse, now: number): void {
  // Перезапись двигает ключ в конец порядка вставки: вытесняется всегда самый давний.
  reports.delete(propertyId);
  if (reports.size >= OWNER_REPORT_CACHE_MAX_ENTRIES) {
    evictExpired(now);
    while (reports.size >= OWNER_REPORT_CACHE_MAX_ENTRIES) {
      const oldest = reports.keys().next();
      if (oldest.done) break;
      reports.delete(oldest.value);
    }
  }
  reports.set(propertyId, { expiresAt: now + OWNER_REPORT_CACHE_TTL_MS, report });
}

/**
 * Отчёт по объекту: из кэша, из уже идущей сборки или новой сборкой `build`.
 * `null` от `build` (объекта нет) наружу уходит как есть и в кэш не попадает.
 */
export function cachedOwnerReport(
  propertyId: string,
  build: () => Promise<OwnerReportResponse | null>,
  now: number = Date.now()
): Promise<OwnerReportResponse | null> {
  const hit = reports.get(propertyId);
  if (hit) {
    if (hit.expiresAt > now) return Promise.resolve(hit.report);
    reports.delete(propertyId);
  }
  const running = inFlight.get(propertyId);
  if (running) return running;

  const job = (async () => {
    try {
      const report = await build();
      if (report) store(propertyId, report, Date.now());
      return report;
    } finally {
      inFlight.delete(propertyId);
    }
  })();
  inFlight.set(propertyId, job);
  return job;
}

/**
 * Нужно ли засчитать это открытие ссылки: не чаще одного раза в минуту на ссылку, чтобы GET
 * не превращался в запись в базу на каждый запрос. Вызов сам помечает ссылку засчитанной.
 */
export function shouldCountOwnerReportView(linkId: string, now: number = Date.now()): boolean {
  const last = viewCountedAt.get(linkId);
  if (last !== undefined && now - last < OWNER_REPORT_VIEW_COUNT_INTERVAL_MS) return false;
  if (viewCountedAt.size >= VIEW_THROTTLE_MAX_ENTRIES) {
    for (const [key, at] of viewCountedAt) {
      if (now - at >= OWNER_REPORT_VIEW_COUNT_INTERVAL_MS) viewCountedAt.delete(key);
    }
    // Все записи свежие (шторм разных ссылок) — освобождаем самую давнюю, а не растём.
    while (viewCountedAt.size >= VIEW_THROTTLE_MAX_ENTRIES) {
      const oldest = viewCountedAt.keys().next();
      if (oldest.done) break;
      viewCountedAt.delete(oldest.value);
    }
  }
  viewCountedAt.delete(linkId);
  viewCountedAt.set(linkId, now);
  return true;
}

/** Сбросить кэш, идущие сборки и таблицу открытий — для тестов. */
export function resetOwnerReportServeState(): void {
  reports.clear();
  inFlight.clear();
  viewCountedAt.clear();
}

/** Сколько отчётов лежит в кэше — для теста потолка. */
export function ownerReportCacheSize(): number {
  return reports.size;
}
