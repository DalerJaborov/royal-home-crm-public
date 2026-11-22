import { z } from "zod";

/**
 * ВОПРОСЫ АГЕНТУ О ПОКАЗЕ (владелец 22.11.2026).
 *
 * Слова владельца: «лучше показы делать уведомлением с кнопками в Шабнам, там люди
 * охотнее нажимают кнопку, и после разговора можно своими словами отвечать Шабнам:
 * да, у нас показ». CRM — хранилище, Шабнам — главный способ ответить; тот же
 * вопрос стоит карточкой в CRM (Главная и карточка клиента) — на случай, если у
 * агента нет Telegram или он не ответил там.
 *
 * Два вида вопроса:
 *  - AGREEMENT — «Договорились о показе?»: ИИ услышал в звонке или прочитал в
 *    переписке о показе, но не понял до конца (нет времени или объекта);
 *  - OUTCOME — «У вас был показ?»: через час после времени показа.
 *
 * Ответ в одном месте закрывает вопрос в другом: и кнопки Шабнам, и карточка CRM
 * зовут одну серверную дверь (apps/api/src/lib/showingQuestions.ts).
 */
export const SHOWING_QUESTION_KINDS = ["AGREEMENT", "OUTCOME"] as const;
export type ShowingQuestionKind = (typeof SHOWING_QUESTION_KINDS)[number];

/** Что дальше с клиентом после состоявшегося показа. */
export const SHOWING_NEXT_STEPS = ["another_showing", "pick_others", "callback", "refused"] as const;
export type ShowingNextStep = (typeof SHOWING_NEXT_STEPS)[number];

export const SHOWING_NEXT_STEP_LABELS: Record<ShowingNextStep, string> = {
  another_showing: "Ещё показ",
  pick_others: "Подобрать другие",
  callback: "Думает, перезвонить",
  refused: "Отказался",
};

/** Время показа или перезвона: ISO-момент (поле datetime-local фронт переводит сам). */
const instant = z.string().trim().min(10).max(40).refine((v) => !Number.isNaN(Date.parse(v)), "Неверное время");

/**
 * Ответ на вопрос — одна схема на CRM и Шабнам.
 *  - book — «Да, договорились»: объект и время показа;
 *  - no — «Нет, не договорились»;
 *  - held — «Да, показ был» + следующий шаг (для callback — когда перезвонить);
 *  - reschedule — «Нет, перенесли» + новое время;
 *  - cancelled — «Нет, отменили» + причина.
 */
export const showingQuestionAnswerSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("book"), propertyId: z.string().trim().min(1).max(64), at: instant }).strict(),
  z.object({ action: z.literal("no") }).strict(),
  z
    .object({ action: z.literal("held"), next: z.enum(SHOWING_NEXT_STEPS), callbackAt: instant.optional() })
    .strict()
    .refine((v) => v.next !== "callback" || !!v.callbackAt, { message: "Укажите, когда перезвонить", path: ["callbackAt"] }),
  z.object({ action: z.literal("reschedule"), at: instant }).strict(),
  z.object({ action: z.literal("cancelled"), reason: z.string().trim().min(3, "Напишите причину").max(500) }).strict(),
]);
export type ShowingQuestionAnswer = z.infer<typeof showingQuestionAnswerSchema>;

/** Объект, который можно выбрать одним касанием. */
export interface ShowingQuestionPropertyOption {
  id: string;
  shortId: number;
  title: string;
}

/** Вопрос в CRM (GET /api/v1/showing-questions). */
export interface ShowingQuestionView {
  id: string;
  kind: ShowingQuestionKind;
  clientId: string;
  clientShortId: number;
  clientName: string;
  /** OUTCOME — показ, о котором спрашиваем. */
  showingId: string | null;
  /** Время показа: из разговора (AGREEMENT) или назначенное (OUTCOME). null — время не поняли. */
  at: string | null;
  /** Объект: доказанный из разговора или назначенный. null — объект не поняли. */
  property: ShowingQuestionPropertyOption | null;
  /** AGREEMENT без объекта — подходящие объекты на выбор (до трёх). */
  options: ShowingQuestionPropertyOption[];
  /** Короткая цитата из разговора — чтобы агент вспомнил, о чём речь. */
  quote: string | null;
  askedAt: string;
}
