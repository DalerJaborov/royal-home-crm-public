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

/** Страница Facebook, выданная ключу компании, — для кнопки «Подключить Messenger». */
export const metaCompanyPageSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** У системного пользователя есть задача «Сообщения» на этой Странице. */
  canMessage: z.boolean(),
  /** "settings" — основная Страница из Настроек; "account" — подключена кнопкой; null — не подключена. */
  connected: z.enum(["settings", "account"]).nullable(),
  accountId: z.string().optional(),
  /** Наше приложение подписано на сообщения Страницы (null — не удалось проверить). */
  subscribed: z.boolean().nullable().optional(),
});
export type MetaCompanyPage = z.infer<typeof metaCompanyPageSchema>;

export const metaCompanyPagesSchema = z.object({
  pages: z.array(metaCompanyPageSchema),
  error: z.string().optional(),
});
export type MetaCompanyPages = z.infer<typeof metaCompanyPagesSchema>;

// ───────────────────── Вход через Facebook (13.11.2026) ─────────────────────
//
// «Войти через Facebook» в Настройках → Каналы: человек входит своим Facebook,
// CRM сама находит Страницы, их Instagram и рекламные кабинеты, человек ставит
// галочки — и всё подключается. Маркер входа живёт только на сервере.
//
// Договор РАСШИРЯЕМЫЙ ПО ВИДАМ: ответ «что нашлось» и запрос «подключить» —
// объекты с полем на каждый вид. Следующий вид (номера WhatsApp) добавляется
// новым полем рядом, не ломая существующие: старый экран его просто не покажет.

const pageIdField = z.string().trim().regex(/^\d{5,30}$/);
const igIdField = z.string().trim().regex(/^\d{5,30}$/);
const adAccountIdField = z.string().trim().regex(/^(act_)?\d{5,30}$/);

/** Страница Facebook, найденная входом. */
export const metaLoginPageSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** У вошедшего есть задача «Сообщения» (или «Управление») на Странице. */
  canMessage: z.boolean(),
  /** Instagram, привязанный к Странице. */
  ig: z.object({ id: z.string(), username: z.string().nullable() }).nullable(),
  /** "settings" — основная Страница из Настроек; "account" — уже подключена; null — нет. */
  connected: z.enum(["settings", "account"]).nullable(),
});
export type MetaLoginPage = z.infer<typeof metaLoginPageSchema>;

/** Instagram, привязанный к одной из найденных Страниц. */
export const metaLoginInstagramSchema = z.object({
  id: z.string(),
  username: z.string().nullable(),
  pageId: z.string(),
  pageName: z.string(),
  /** "page" — уже в CRM и привязан к этой Странице; "account" — в CRM, отвечает своим ключом; null — нет. */
  connected: z.enum(["page", "account"]).nullable(),
});
export type MetaLoginInstagram = z.infer<typeof metaLoginInstagramSchema>;

/** Рекламный кабинет, видный входу. */
export const metaLoginAdAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** account_status Meta: 1 — активен; остальное — ограничен/закрыт. */
  status: z.number().nullable(),
  connected: z.boolean(),
});
export type MetaLoginAdAccount = z.infer<typeof metaLoginAdAccountSchema>;

export const metaLoginAssetsSchema = z.object({
  pages: z.array(metaLoginPageSchema),
  instagram: z.array(metaLoginInstagramSchema),
  adAccounts: z.array(metaLoginAdAccountSchema),
  /** Что прочитать не удалось (например, кабинеты без права ads_read) — словами. */
  warnings: z.array(z.string()),
});
export type MetaLoginAssets = z.infer<typeof metaLoginAssetsSchema>;

/** Что подключить из найденного входом. Пустой вид — пропустить. */
export const metaLoginConnectInputSchema = z
  .object({
    pageIds: z.array(pageIdField).max(100).default([]),
    instagramIds: z.array(igIdField).max(100).default([]),
    adAccountIds: z.array(adAccountIdField).max(50).default([]),
  })
  .strict();
export type MetaLoginConnectInput = z.infer<typeof metaLoginConnectInputSchema>;

export const metaLoginAssetKindSchema = z.enum(["page", "instagram", "adAccount"]);
export type MetaLoginAssetKind = z.infer<typeof metaLoginAssetKindSchema>;

/** Итог по каждой выбранной строке — словами, для экрана. */
export const metaLoginConnectResultSchema = z.object({
  results: z.array(
    z.object({
      kind: metaLoginAssetKindSchema,
      id: z.string(),
      name: z.string(),
      ok: z.boolean(),
      message: z.string(),
    })
  ),
});
export type MetaLoginConnectResult = z.infer<typeof metaLoginConnectResultSchema>;

export const metaLoginStartSchema = z.object({ url: z.string().url() });
