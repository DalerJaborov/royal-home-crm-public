/**
 * Тип, ключ и пределы отложенного повтора публикации в TikTok — ОТДЕЛЬНО от
 * самого обработчика (jobs/tiktokPublishRetry.ts), тем же приёмом и по той же
 * причине, что `aiReplyRetryPolicy.ts`: ставит задание `lib/videoHandoff.ts`, а
 * обработчик импортирует из неё `applySucceededPublishResults`. Держи эти
 * константы в обработчике — получился бы круг импортов.
 */
export const TIKTOK_PUBLISH_RETRY_JOB_TYPE = "tiktok-publish-retry";

/** Одно ожидающее повторение на объект, не пачка. */
export function tiktokPublishRetryDedupeKey(propertyId: string): string {
  return `${TIKTOK_PUBLISH_RETRY_JOB_TYPE}:${propertyId}`;
}

/**
 * Восемь попыток по лесенке 1ч → 2ч → 4ч → 8ч → 8ч… — около полутора суток
 * ожидания. Больше бессмысленно: если за сутки с лишним неподтверждённые
 * черновики во «Входящих» TikTok никто не разобрал, ждать нечего, и задание
 * должно честно сдаться человеку.
 */
export const TIKTOK_PUBLISH_RETRY_MAX_ATTEMPTS = 8;

/** Лимиты TikTok живут сутками, а не минутами: повторять чаще — копить в
 *  журнале один и тот же отказ. */
export function tiktokPublishRetryBackoffMs(attempt: number): number {
  return Math.min(2 ** attempt, 8) * 60 * 60_000;
}

/** Через сколько пробовать в первый раз — раньше часа смысла нет. */
export const TIKTOK_PUBLISH_RETRY_FIRST_DELAY_MS = 60 * 60_000;
