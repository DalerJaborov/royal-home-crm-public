/**
 * Тип, ключ и пределы отложенного повтора публикации ролика объекта в Meta-каналы
 * (Instagram, Facebook, Threads, истории Instagram) — ОТДЕЛЬНО от обработчика
 * (jobs/socialPublishRetry.ts), тем же приёмом и по той же причине, что
 * `tiktokPublishRetryPolicy.ts`: задание ставит `lib/videoHandoff.ts`, а
 * обработчик импортирует из неё `applySucceededPublishResults`. Держи эти
 * константы в обработчике — получился бы круг импортов.
 */
import { enqueueBackgroundJob } from "./enqueue.js";

export const SOCIAL_PUBLISH_RETRY_JOB_TYPE = "social-publish-retry";

/**
 * Что повторяет задание. TikTok здесь НЕТ намеренно: у него своё задание с
 * лесенкой в часы (лимиты TikTok живут сутками), а у Meta отказ скачать файл
 * проходит за минуты. YouTube и Telegram читают ролик с нашего диска, а не по
 * ссылке, — этого отказа у них не бывает.
 */
export const SOCIAL_PUBLISH_RETRY_TARGETS = ["INSTAGRAM", "FACEBOOK", "THREADS", "INSTAGRAM_STORIES"] as const;
export type SocialPublishRetryTarget = (typeof SOCIAL_PUBLISH_RETRY_TARGETS)[number];

export function isSocialPublishRetryTarget(value: string): value is SocialPublishRetryTarget {
  return (SOCIAL_PUBLISH_RETRY_TARGETS as readonly string[]).includes(value);
}

/** Одно ожидающее повторение на объект И канал: Facebook не должен ждать, пока сдастся Threads. */
export function socialPublishRetryDedupeKey(propertyId: string, target: SocialPublishRetryTarget): string {
  return `${SOCIAL_PUBLISH_RETRY_JOB_TYPE}:${propertyId}:${target}`;
}

/** Все ключи объекта — для «идёт ли публикация» и снятия ждущих повторов при отзыве ролика. */
export function socialPublishRetryDedupeKeys(propertyId: string): string[] {
  return SOCIAL_PUBLISH_RETRY_TARGETS.map((target) => socialPublishRetryDedupeKey(propertyId, target));
}

/**
 * Первая попытка — через 5 минут: выкат с перезапуском nginx длится 2–6 минут
 * (объект №208: 18:47:37–18:49:10 UTC), раньше файл может ещё не отдаваться.
 */
export const SOCIAL_PUBLISH_RETRY_FIRST_DELAY_MS = 5 * 60_000;

/**
 * Четыре попытки: +5, затем +15, +30, +45 минут — всего около полутора часов.
 * Потолок 45, а не час, ради историй: серия, начатая больше двух часов назад,
 * уже не считается «той же» (SERIES_RESUME_WINDOW_MS в lib/instagramStories.ts),
 * и поздний повтор выложил бы вышедшую часть второй раз. 5+15+30+45 = 95 минут
 * плюс сами попытки укладываются в это окно с запасом.
 */
export const SOCIAL_PUBLISH_RETRY_MAX_ATTEMPTS = 4;

const BACKOFF_MINUTES = [15, 30, 45];

/** `attempt` — сколько попыток уже сделано (runner.ts зовёт с 1 после первой неудачи). */
export function socialPublishRetryBackoffMs(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), BACKOFF_MINUTES.length) - 1;
  return BACKOFF_MINUTES[index] * 60_000;
}

/**
 * Окно, в котором повтор историй ещё безопасен (SERIES_RESUME_WINDOW_MS = 2 ч в
 * lib/instagramStories.ts) — с запасом 20 минут на саму попытку.
 */
const STORIES_RETRY_WINDOW_MS = 100 * 60_000;

/**
 * ОДНА ДВЕРЬ постановки повтора (публикация объекта и само задание повтора
 * зовут только её). Ключ на объект+канал: второй такой же отказ, пока первый
 * повтор ждёт, нового задания не заводит (jobs/enqueue.ts).
 * `now` — без ожидания (истории вслед за только что вышедшим Reels).
 */
export async function enqueueSocialPublishRetry(
  propertyId: string,
  target: SocialPublishRetryTarget,
  opts: { now?: boolean } = {}
): Promise<void> {
  const startAt = Date.now() + (opts.now ? 0 : SOCIAL_PUBLISH_RETRY_FIRST_DELAY_MS);
  await enqueueBackgroundJob({
    type: SOCIAL_PUBLISH_RETRY_JOB_TYPE,
    payload: {
      propertyId,
      channel: target,
      ...(target === "INSTAGRAM_STORIES" ? { notAfter: new Date(Date.now() + STORIES_RETRY_WINDOW_MS).toISOString() } : {}),
    },
    dedupeKey: socialPublishRetryDedupeKey(propertyId, target),
    maxAttempts: SOCIAL_PUBLISH_RETRY_MAX_ATTEMPTS,
    ...(opts.now ? {} : { runAt: new Date(startAt) }),
  });
}

/** Подпись канала для человека — в журнале и в «Что не доехало». */
export const SOCIAL_PUBLISH_RETRY_TARGET_LABELS: Record<SocialPublishRetryTarget, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  THREADS: "Threads",
  INSTAGRAM_STORIES: "истории Instagram",
};
