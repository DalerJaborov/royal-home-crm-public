import { logSystemError } from "../systemError.js";

/**
 * ТАЙМАУТ СТАНЦИИ — ОДНА СТРОКА В ЧАС, А НЕ ПО СТРОКЕ НА КАЖДЫЙ ВЫЗОВ (журнал 28.11.2026).
 *
 * Пять разных текстов («АТС (ARI): ответ на канал — … aborted due to timeout», «Станция не
 * приняла вердикт … не ответила за 3 с», «Синхронизация очереди … не ответила за 5 с», «сверка
 * сирот … timeout» и др.) — это ОДИН факт: станция на минуту не отвечала. У разных вызовов
 * разные тексты, поэтому общий десятиминутный дедуп их не склеивал, и каждый такой всплеск
 * оставлял в журнале директора пять-шесть «разных» ошибок. Саму станцию сторожит сводная
 * проверка телефонии (stationHealth.ts: настоящее падение даёт отдельную тревогу), так что
 * здесь журнал — только след для разработчика: один общий ключ, окно в час, без пуша.
 * Отказы НЕ по таймауту (станция ответила ошибкой) пишутся как раньше, каждый своим текстом.
 */
export const STATION_TIMEOUT_DEDUP_KEY = "telephony-station-timeout";
export const STATION_TIMEOUT_WINDOW_MS = 60 * 60 * 1000;

const TIMEOUT_RE = /aborted due to timeout|timed? ?out|станция не ответила за|не ответила за \d+ с|ETIMEDOUT/i;

export function isStationTimeoutText(text: string): boolean {
  return TIMEOUT_RE.test(String(text));
}

/** Контекст для logSystemError: у таймаута станции — общий ключ и час окна, у остального — ничего. */
export function stationTimeoutContext(text: string): { dedupKey: string; dedupWindowMs: number; silent: true } | undefined {
  return isStationTimeoutText(text)
    ? { dedupKey: STATION_TIMEOUT_DEDUP_KEY, dedupWindowMs: STATION_TIMEOUT_WINDOW_MS, silent: true }
    : undefined;
}

/** Запись отказа телефонии с учётом правила выше. Вызывающий код продолжает как раньше (`void`). */
export function logTelephonyFailure(message: string, context?: { dedupKey?: string }): Promise<void> {
  return logSystemError("telephony", message, stationTimeoutContext(message) ?? context);
}
