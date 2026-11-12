import { z } from "zod";

/**
 * Вечные ключи Meta (12.11.2026): договор между сервером
 * (apps/api/src/lib/metaEternalTokens.ts) и экраном Настройки → Каналы.
 */

export const metaEternalStateSchema = z.enum([
  "ready",
  "pending_first_send",
  "off",
  "awaiting_review",
  "no_system",
  "missing_scopes",
  "no_page",
  "page_not_shared",
  "mismatch",
  "error",
]);
export type MetaEternalState = z.infer<typeof metaEternalStateSchema>;

export const metaEternalKeyRowSchema = z.object({
  key: z.string(),
  title: z.string(),
  channel: z.enum(["INSTAGRAM", "FACEBOOK", "ADS", "SYSTEM"]),
  accountId: z.string().optional(),
  pageId: z.string().nullable().optional(),
  pageName: z.string().optional(),
  state: metaEternalStateSchema,
  hint: z.string(),
  subscribed: z.boolean().nullable().optional(),
  /** Последняя успешная отправка через Страницу (ISO) — «работает» только после неё. */
  lastSentAt: z.string().nullable().optional(),
});
export type MetaEternalKeyRow = z.infer<typeof metaEternalKeyRowSchema>;

export const metaEternalStatusSchema = z.object({
  preferred: z.boolean(),
  /** Отметка директора «App Review одобрен» — без неё переписку ключом компании не включить. */
  appReviewApproved: z.boolean(),
  systemUser: z.object({
    configured: z.boolean(),
    ok: z.boolean(),
    name: z.string().optional(),
    appId: z.string().optional(),
    detail: z.string().optional(),
    /** Каких прав для переписки нет у ключа компании (/me/permissions). */
    missingScopes: z.array(z.string()),
  }),
  rows: z.array(metaEternalKeyRowSchema),
});
export type MetaEternalStatus = z.infer<typeof metaEternalStatusSchema>;

/** Страница вручную (цифры id) или пусто — найти автоматически. */
export const metaEternalPageInputSchema = z.object({ pageId: z.string().trim().regex(/^\d{5,30}$/).optional() }).strict();
export const metaEternalPreferredInputSchema = z.object({ enabled: z.boolean() }).strict();
export const metaEternalAppReviewInputSchema = z.object({ approved: z.boolean() }).strict();

/** Как подписать состояние для человека — одно место для экрана. */
export const META_ETERNAL_STATE_LABEL: Record<MetaEternalState, string> = {
  ready: "Работает: была отправка",
  pending_first_send: "Готов, ждёт первой отправки",
  off: "Готов, рубильник выключен",
  awaiting_review: "Ждёт одобрения Meta",
  no_system: "Нет ключа компании",
  missing_scopes: "Не хватает прав",
  no_page: "Страница не выбрана",
  page_not_shared: "Нужно выдать доступ",
  mismatch: "Не та Страница",
  error: "Ошибка проверки",
};
