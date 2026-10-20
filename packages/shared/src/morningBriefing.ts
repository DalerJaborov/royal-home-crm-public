import { z } from "zod";

/**
 * Утренний брифинг директору внутри CRM — те же числа, что уходят в 08:00
 * push-сводкой (api lib/morningNumbers.ts), плюс короткий связный текст на
 * русском и озвучка голосом лица ИИ.
 *
 * Схема одна на api и web: сервер решает, что показывать, и границу суток
 * считает по Душанбе; фронт показывает карточку и играет WAV.
 */

/** Числа брифинга. `null` означает «данных нет» — в тексте так и говорится. */
export const briefingNumbersSchema = z.object({
  tasksToday: z.number().int().min(0),
  leadsYesterday: z.number().int().min(0),
  dealsYesterday: z.number().int().min(0),
  /** Комиссия месяца в сомони (валютные сделки сконвертированы). */
  commissionMonth: z.number().min(0),
  errorsYesterday: z.number().int().min(0),
  incomingYesterday: z.number().int().min(0),
  missedYesterday: z.number().int().min(0),
  unqualifiedNow: z.number().int().min(0),
  /** Медиана первого касания в минутах; null — вчера никого не коснулись. */
  firstTouchMedianMin: z.number().int().min(0).nullable(),
  firstTouchSlowCount: z.number().int().min(0),
  firstTouchNoneCount: z.number().int().min(0),
  showingSummariesOverdue48h: z.number().int().min(0),
  sellersWithoutPropertyOver7Days: z.number().int().min(0),
});

export type BriefingNumbers = z.infer<typeof briefingNumbersSchema>;

/** Откуда взялся текст: модель или шаблон по числам при отказе ИИ. */
export const BRIEFING_SOURCES = ["ai", "fallback"] as const;
export type BriefingSource = (typeof BRIEFING_SOURCES)[number];

export const morningBriefingSchema = z.object({
  /** Календарная дата по Душанбе — "YYYY-MM-DD", ключ кеша на сервере и показа на фронте. */
  dushanbeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** 3–5 предложений по-русски. Выдуманных чисел нет: где данных нет — «данных нет». */
  text: z.string(),
  source: z.enum(BRIEFING_SOURCES),
  numbers: briefingNumbersSchema,
  /** null — озвучка недоступна (нет ключа, квота, таймаут); карточка всё равно показывается. */
  audioUrl: z.string().nullable(),
});

export type MorningBriefing = z.infer<typeof morningBriefingSchema>;

/** Окно показа развёрнутой карточки — с 08:00 до 12:00 по Душанбе. */
export const BRIEFING_WINDOW_START_HOUR = 8;
export const BRIEFING_WINDOW_END_HOUR = 12;

/** Утро ли сейчас по Душанбе: [08:00, 12:00). Час передаётся снаружи (web: dushanbeHour()). */
export function isBriefingWindow(dushanbeHour: number): boolean {
  return dushanbeHour >= BRIEFING_WINDOW_START_HOUR && dushanbeHour < BRIEFING_WINDOW_END_HOUR;
}

/**
 * Ключ localStorage «этот брифинг уже прослушан/закрыт»: привязан к дате по
 * Душанбе, поэтому назавтра карточка разворачивается сама, а перезагрузка
 * страницы в тот же день её не возвращает.
 */
export function briefingSeenKey(dushanbeDate: string): string {
  return `rh:briefing:seen:${dushanbeDate}`;
}
