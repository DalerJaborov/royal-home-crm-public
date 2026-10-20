import { z } from "zod";
import { VIDEO_REMAKE_REASONS } from "./videoRemake.js";

/**
 * ЗАЯВКА АГЕНТА НА ИЗМЕНЕНИЕ ОПУБЛИКОВАННОГО ОБЪЕКТА (07.10.2026, решение владельца).
 *
 * После публикации агент в своей карточке не меняет ничего (замок правки —
 * `propertyEditLock.ts`). Если цена или данные изменились, а ролик и посты уже вышли,
 * агент «подходит и говорит»: нажимает готовую кнопку, директор/админ решают, и CRM
 * сама делает то, что умеет через API сетей. Единственный источник правды по видам
 * заявок и форме тел — здесь; api и web импортируют отсюда.
 *
 * Что CRM умеет сама после «Принять» (по возможностям API, проверено 07.10.2026):
 *  — цена: сайт, подпись в базе, Facebook, Telegram (основной и доп. чаты), YouTube,
 *    история «цена снижена»; Instagram Reels / TikTok / Threads подпись через API менять
 *    НЕЛЬЗЯ — идут в `manual` и становятся задачей человеку, а не строкой в журнале;
 *  — данные карточки: то же + подпись в базе, остальное по «Готово» (`finish-edit`);
 *  — перемонтаж: `sendBackToMontajer` (опционально «сначала снять из соцсетей»);
 *  — снятие из соцсетей: `removeFromSocial` там, где площадка позволяет;
 *  — «Другое»: только решение руководителя, CRM ничего не выполняет.
 */

export const PROPERTY_CHANGE_KINDS = ["PRICE_CHANGE", "CARD_DATA", "REMAKE_VIDEO", "UNPUBLISH", "OTHER"] as const;
export type PropertyChangeKind = (typeof PROPERTY_CHANGE_KINDS)[number];

export const PROPERTY_CHANGE_STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED", "FAILED"] as const;
export type PropertyChangeStatus = (typeof PROPERTY_CHANGE_STATUSES)[number];

/** Названия готовых кнопок агента — они же заголовки заявок у директора. */
export const PROPERTY_CHANGE_KIND_LABELS: Record<PropertyChangeKind, string> = {
  PRICE_CHANGE: "Цена изменилась",
  CARD_DATA: "Изменились данные объекта",
  REMAKE_VIDEO: "Перемонтировать ролик",
  UNPUBLISH: "Убрать из соцсетей",
  OTHER: "Другое",
};

/** Подсказка под кнопкой: что произойдёт после «Принять» (честно, по возможностям API). */
export const PROPERTY_CHANGE_KIND_HINTS: Record<PropertyChangeKind, string> = {
  PRICE_CHANGE:
    "Цена обновится на сайте, в Facebook, Telegram и YouTube. В Instagram, TikTok и Threads подпись придётся поправить руками — мы напомним.",
  CARD_DATA: "Данные обновятся в карточке и на сайте; подписи в соцсетях пересоберём.",
  REMAKE_VIDEO: "Ролик вернётся монтажёру с вашим комментарием; при желании старый уберём из соцсетей заранее.",
  UNPUBLISH: "Уберём ролик там, где это позволяет сама сеть; остальное покажем списком.",
  OTHER: "Опишите, что нужно изменить: директор решит и сделает сам.",
};

export const PROPERTY_CHANGE_STATUS_LABELS: Record<PropertyChangeStatus, string> = {
  PENDING: "Ждёт решения",
  APPROVED: "Принято",
  REJECTED: "Отклонено",
  CANCELLED: "Отозвано",
  FAILED: "Не выполнилось",
};

const comment = z.string().trim().max(2000);

/** Цена: новая сумма в валюте объекта (валюту объекта сервер знает сам; `currency` — только если меняют). */
export const priceChangePayloadSchema = z.object({
  newPrice: z.number().positive().max(1_000_000_000),
  currency: z.enum(["USD", "TJS"]).optional(),
  /** true — «и перемонтировать ролик с новой ценой» (цена в кадре видео меняется только перемонтажом). */
  remake: z.boolean().default(false),
});

/**
 * Данные карточки: подмножество полей, которые попадают в подпись/ролик/сайт
 * (список полей без цены — как `CAPTION_FACT_FIELDS`; точный набор и типы сервер берёт из
 * `propertyUpdateSchema.pick(...)`, здесь — свободный объект, форму проверяет сервер).
 */
export const cardDataPayloadSchema = z.object({
  patch: z.record(z.string(), z.unknown()).refine((o) => Object.keys(o).length > 0, "Не указано, что изменить"),
  remake: z.boolean().default(false),
});

export const remakeVideoPayloadSchema = z.object({
  reason: z.enum(VIDEO_REMAKE_REASONS),
  removeFromSocial: z.boolean().default(true),
});

export const unpublishPayloadSchema = z.object({
  /** Пусто — все каналы, где ролик отмечен опубликованным. */
  channels: z.array(z.string().min(1).max(40)).max(12).optional(),
});

export const otherPayloadSchema = z.object({
  text: z.string().trim().min(10, "Опишите подробнее (хотя бы 10 символов)").max(2000),
});

/** Тело POST /properties/:id/change-requests — распознаваемое объединение по `kind`. */
export const createPropertyChangeRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PRICE_CHANGE"), payload: priceChangePayloadSchema, comment: comment.optional() }),
  z.object({ kind: z.literal("CARD_DATA"), payload: cardDataPayloadSchema, comment: comment.optional() }),
  z.object({ kind: z.literal("REMAKE_VIDEO"), payload: remakeVideoPayloadSchema, comment: comment.optional() }),
  z.object({ kind: z.literal("UNPUBLISH"), payload: unpublishPayloadSchema, comment: comment.optional() }),
  z.object({ kind: z.literal("OTHER"), payload: otherPayloadSchema, comment: comment.optional() }),
]);
export type CreatePropertyChangeRequestInput = z.infer<typeof createPropertyChangeRequestSchema>;

export const decidePropertyChangeRequestSchema = z.object({ note: comment.optional() });
export const rejectPropertyChangeRequestSchema = z.object({
  note: z.string().trim().min(3, "Напишите причину отказа").max(2000),
});

/** Итог выполнения после «Принять» — то, что видит директор и что уходит автору. */
export interface PropertyChangeResult {
  /** Человеческие строки «что сделано»: «Цена на сайте обновлена», «Подпись Facebook обновлена»… */
  applied: string[];
  /** Остаток руками: канал + что именно сделать («Instagram: поправьте цену в подписи Reels»). */
  manual: { channel: string; text: string }[];
  /** Ролик отправлен/поставлен на перемонтаж. */
  remakeQueued: boolean;
}

/** Форма заявки в ответах API (оба конца читают одно и то же). */
export interface PropertyChangeRequestDto {
  id: string;
  propertyId: string;
  propertyShortId: number;
  kind: PropertyChangeKind;
  status: PropertyChangeStatus;
  payload: unknown;
  comment: string | null;
  author: { id: string; fullName: string };
  decidedBy: { id: string; fullName: string } | null;
  decidedAt: string | null;
  decisionNote: string | null;
  result: PropertyChangeResult | null;
  /** Текст ошибки, если status === "FAILED". */
  error: string | null;
  createdAt: string;
}

/** Одной строкой для списков и уведомлений: «Цена изменилась: 95 000 → 89 000 с.» собирает вызывающий. */
export function propertyChangeKindLabel(kind: PropertyChangeKind): string {
  return PROPERTY_CHANGE_KIND_LABELS[kind];
}
