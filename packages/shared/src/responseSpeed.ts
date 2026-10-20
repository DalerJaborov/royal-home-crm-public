import { z } from "zod";

/**
 * СКОРОСТЬ ПЕРВОГО ОТВЕТА ПРОТИВ ДОХОДА ДО ПОКАЗА — форма GET /reports/response-speed.
 *
 * «Моментом первого ответа» считается Client.firstContactAt — первая работа
 * АГЕНТА по карточке (звонок или запись в хронологию), тот же показатель, что и в
 * утренней сводке. Ответов бота и ответов в мессенджере вне CRM он не видит —
 * это ограничение показывает экран.
 */

export const RESPONSE_SPEED_BUCKET_KEYS = ["lt1", "m1to5", "m5to15", "m15to60", "gt60", "none"] as const;
export type ResponseSpeedBucketKey = (typeof RESPONSE_SPEED_BUCKET_KEYS)[number];

export const RESPONSE_SPEED_BUCKET_LABELS: Record<ResponseSpeedBucketKey, string> = {
  lt1: "до 1 мин",
  m1to5: "1–5 мин",
  m5to15: "5–15 мин",
  m15to60: "15–60 мин",
  gt60: "больше часа",
  none: "без ответа",
};

/** Верхние границы корзин в минутах (исключительно): до 1, 1–5, 5–15, 15–60. */
export const RESPONSE_SPEED_BOUNDS_MIN = [1, 5, 15, 60] as const;

/** Меньше стольких обращений в корзине — долю показа не сравниваем, пишем «мало данных». */
export const RESPONSE_SPEED_MIN_SAMPLE = 10;

export interface ResponseSpeedBucket {
  key: ResponseSpeedBucketKey;
  label: string;
  /** Обращений в корзине. */
  leads: number;
  /** Доля всех обращений периода, 0..1. */
  share: number;
  /** Из них дошли до показа или сделки. */
  reachedShowing: number;
  /** reachedShowing / leads, 0..1; null — выборка меньше порога. */
  showingRate: number | null;
  /** Медиана минут до ответа в корзине; null у «без ответа» и пустых корзин. */
  medianMinutes: number | null;
}

export interface ResponseSpeedResponse {
  days: number;
  generatedAt: string;
  /** Всего обращений (покупатели, созданные за окно). */
  leads: number;
  /** Медиана минут до первого ответа по всем ответившим; null — ответивших нет. */
  medianMinutes: number | null;
  buckets: ResponseSpeedBucket[];
  /** Обращения моложе стольких дней в выборку не входят: им ещё не успели ни ответить, ни показать. */
  matureAfterDays: number;
  /** Не вошло: первый контакт агента раньше создания карточки (агент сам завёл клиента). */
  excluded: number;
  /** Выборка упёрлась в потолок — старые обращения не вошли. */
  truncated: boolean;
}

export const responseSpeedQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(180).default(90),
});
export type ResponseSpeedQuery = z.infer<typeof responseSpeedQuerySchema>;
