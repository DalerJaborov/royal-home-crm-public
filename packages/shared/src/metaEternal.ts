import { z } from "zod";

/**
 * Вечные ключи Meta (12.11.2026): договор между сервером
 * (apps/api/src/lib/metaEternalTokens.ts) и экраном Настройки → Каналы.
 */

export const metaEternalStateSchema = z.enum(["ready", "off", "no_system", "no_page", "page_not_shared", "mismatch", "error"]);
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
});
export type MetaEternalKeyRow = z.infer<typeof metaEternalKeyRowSchema>;

export const metaEternalStatusSchema = z.object({
  preferred: z.boolean(),
  systemUser: z.object({
    configured: z.boolean(),
    ok: z.boolean(),
    name: z.string().optional(),
    appId: z.string().optional(),
    detail: z.string().optional(),
  }),
  rows: z.array(metaEternalKeyRowSchema),
});
export type MetaEternalStatus = z.infer<typeof metaEternalStatusSchema>;

/** Страница вручную (цифры id) или пусто — найти автоматически. */
export const metaEternalPageInputSchema = z.object({ pageId: z.string().trim().regex(/^\d{5,30}$/).optional() }).strict();
export const metaEternalPreferredInputSchema = z.object({ enabled: z.boolean() }).strict();

/** Как подписать состояние для человека — одно место для экрана. */
export const META_ETERNAL_STATE_LABEL: Record<MetaEternalState, string> = {
  ready: "Вечный ключ работает",
  off: "Выключено",
  no_system: "Нет вечного ключа",
  no_page: "Страница не выбрана",
  page_not_shared: "Нужно выдать доступ",
  mismatch: "Не та Страница",
  error: "Ошибка проверки",
};
