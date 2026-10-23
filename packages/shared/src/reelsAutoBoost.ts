import { z } from "zod";

/**
 * АВТОПРОДВИЖЕНИЕ РОЛИКОВ (Reels объектов → одна постоянная кампания Meta).
 *
 * Здесь только то, что нужно и серверу, и сайту: допустимые кнопки, границы
 * настроек и схема их правки. Само решение «создать / поставить на паузу» живёт
 * на сервере (apps/api/src/lib/ads/reelsAutoBoostDecide.ts).
 *
 * Выключено по умолчанию, и пробный режим включён по умолчанию (в Meta не уходит
 * ничего): реклама тратит деньги, поэтому включение — два осознанных шага.
 */

/**
 * Кнопка объявления. Значения — наши; в вызов Meta они превращаются в
 * apps/api/src/lib/ads/reelsAutoBoostMeta.ts (ctaFor):
 *  - WHATSAPP_MESSAGE  → call_to_action {type: WHATSAPP_MESSAGE, value: {app_destination: WHATSAPP}};
 *  - INSTAGRAM_DIRECT  → {type: MESSAGE_PAGE, value: {app_destination: INSTAGRAM_DIRECT}};
 *  - MESSENGER         → {type: MESSAGE_PAGE, value: {app_destination: MESSENGER}}.
 * Источники: https://developers.facebook.com/documentation/ads-commerce/instagram/ads-api/guides/use-posts-as-ads
 * (INSTAGRAM_DIRECT/MESSENGER) и
 * https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/messaging-ads/click-to-whatsapp
 * (WHATSAPP_MESSAGE).
 */
export const REELS_AUTOBOOST_CTA_TYPES = ["WHATSAPP_MESSAGE", "INSTAGRAM_DIRECT", "MESSENGER"] as const;
export type ReelsAutoBoostCtaType = (typeof REELS_AUTOBOOST_CTA_TYPES)[number];

export const REELS_AUTOBOOST_DEFAULTS = {
  enabled: false,
  dryRun: true,
  adSetId: null as string | null,
  maxActive: 30,
  maxAgeDays: 10,
  stopLossSpendUsd: 4,
  ctaType: "WHATSAPP_MESSAGE" as ReelsAutoBoostCtaType,
} as const;

export const REELS_AUTOBOOST_STATUSES = ["PLANNED", "ACTIVE", "PAUSED", "FAILED", "SKIPPED"] as const;
export type ReelsAutoBoostStatus = (typeof REELS_AUTOBOOST_STATUSES)[number];

/** Номер группы объявлений из Ads Manager — только цифры (допускаем пробелы по краям). */
const adSetIdSchema = z
  .string()
  .trim()
  .regex(/^\d{5,25}$/, "Номер группы объявлений — только цифры, как в Ads Manager");

/** Правка настроек: любое подмножество полей; adSetId = null или "" очищает. */
export const reelsAutoBoostSettingsPatchSchema = z
  .object({
    enabled: z.boolean(),
    dryRun: z.boolean(),
    adSetId: z.union([adSetIdSchema, z.literal(""), z.null()]).transform((v) => (v === "" ? null : v)),
    maxActive: z.number().int().min(1).max(200),
    maxAgeDays: z.number().int().min(1).max(60),
    stopLossSpendUsd: z.number().min(0).max(1000),
    ctaType: z.enum(REELS_AUTOBOOST_CTA_TYPES),
  })
  .partial()
  .strict();
export type ReelsAutoBoostSettingsPatch = z.infer<typeof reelsAutoBoostSettingsPatchSchema>;

/** Настройки целиком — как их видит сайт. */
export interface ReelsAutoBoostSettings {
  enabled: boolean;
  dryRun: boolean;
  adSetId: string | null;
  maxActive: number;
  maxAgeDays: number;
  stopLossSpendUsd: number;
  ctaType: ReelsAutoBoostCtaType;
}

/** Строка журнала решений для сайта. */
export interface ReelsAutoBoostRow {
  id: string;
  propertyId: string;
  propertyShortId: number | null;
  propertyTitle: string | null;
  instagramMediaId: string;
  metaAdId: string | null;
  status: ReelsAutoBoostStatus;
  reason: string;
  spendUsd: number | null;
  conversations: number | null;
  updatedAt: string;
  lastCheckedAt: string | null;
}

export interface ReelsAutoBoostOverview {
  settings: ReelsAutoBoostSettings;
  /** Сколько роликов сейчас продвигается (ACTIVE) и сколько запланировано пробным режимом (PLANNED). */
  counts: Record<ReelsAutoBoostStatus, number>;
  rows: ReelsAutoBoostRow[];
}
