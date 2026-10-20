/**
 * ЗАЯВКИ АГЕНТА НА ИЗМЕНЕНИЕ ОПУБЛИКОВАННОГО ОБЪЕКТА — общие помощники (07.10.2026).
 *
 * Договор (виды, тела, DTO) — packages/shared/src/propertyChangeRequest.ts; роуты —
 * routes/properties/changeRequests.ts; выполнение «Принять» —
 * lib/propertyChangeExecutor.ts. Здесь: «опубликован ли объект», сборка DTO, текст
 * для уведомлений и разбор тела по виду.
 */
import {
  isPropertyPublished,
  propertyUpdateSchema,
  floorRuleError,
  normalizePropertyPatchForType,
  propertyFieldShown,
  type PropertyChangeKind,
  type PropertyChangeRequestDto,
  type PropertyChangeResult,
  type PropertyChangeStatus,
  type PropertyStatus,
  PROPERTY_CHANGE_KIND_LABELS,
} from "@royal-home/shared";
import type { z } from "zod";
import type { Prisma } from "../generated/prisma/client.js";
import { formatPrice } from "../ai/seoGenerator.js";
import { CAPTION_FACT_FIELDS } from "./publishedVideoFix.js";
import { changedPropertyFields } from "./propertyChanges.js";

/**
 * ОБЪЕКТ «ОПУБЛИКОВАН» — вышел из конвейера подготовки (его карточку уже не правит сам агент).
 * Правило одно с замком правки — `isPropertyPublished` из shared.
 */
export function isPublishedForChangeRequest(status: PropertyStatus): boolean {
  return isPropertyPublished(status);
}

/** Названия каналов для людей — в итогах и уведомлениях. */
export const CHANNEL_NAMES: Record<string, string> = {
  CAPTION: "Подпись",
  FACEBOOK: "Facebook",
  INSTAGRAM: "Instagram",
  TELEGRAM: "Telegram",
  YOUTUBE: "YouTube",
  TIKTOK: "TikTok",
  THREADS: "Threads",
  VIDEO: "Ролик",
};
export const channelName = (c: string): string => CHANNEL_NAMES[c] ?? c;

type RequestRow = Prisma.PropertyChangeRequestGetPayload<{
  include: {
    author: { select: { id: true; fullName: true } };
    decidedBy: { select: { id: true; fullName: true } };
    property: { select: { shortId: true } };
  };
}>;

export const CHANGE_REQUEST_INCLUDE = {
  author: { select: { id: true, fullName: true } },
  decidedBy: { select: { id: true, fullName: true } },
  property: { select: { shortId: true } },
} as const;

/** Строка таблицы → форма ответа API (общая для обоих концов, см. shared). */
export function toChangeRequestDto(row: RequestRow): PropertyChangeRequestDto {
  return {
    id: row.id,
    propertyId: row.propertyId,
    propertyShortId: row.property.shortId,
    kind: row.kind,
    status: row.status as PropertyChangeStatus,
    payload: row.payload,
    comment: row.comment,
    author: row.author,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decisionNote: row.decisionNote,
    result: (row.result as PropertyChangeResult | null) ?? null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Что в карточке сейчас — нужно, чтобы описать «было → стало». */
export interface PropertyForSummary {
  price: Prisma.Decimal | number;
  currency: string;
}

/**
 * Одна строка «суть заявки» для уведомления директору и записи в журнал:
 * «Цена изменилась: 95 000 с. → 89 000 с.».
 */
export function summarizeChangeRequest(kind: PropertyChangeKind, payload: unknown, property: PropertyForSummary): string {
  const label = PROPERTY_CHANGE_KIND_LABELS[kind];
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (kind) {
    case "PRICE_CHANGE": {
      const next = Number(p.newPrice);
      const nextCurrency = typeof p.currency === "string" ? p.currency : property.currency;
      return `${label}: ${formatPrice(Number(property.price), property.currency)} → ${formatPrice(next, nextCurrency)}`;
    }
    case "CARD_DATA": {
      const fields = Object.keys((p.patch ?? {}) as object);
      return `${label}: ${fields.length} ${fields.length === 1 ? "поле" : "полей"}`;
    }
    case "REMAKE_VIDEO":
      return `${label}`;
    case "UNPUBLISH":
      return `${label}`;
    case "OTHER":
      return `${label}: ${String(p.text ?? "").slice(0, 120)}`;
  }
}

/** Правка карточки в форме схемы PATCH (все поля необязательны). */
export type PropertyUpdateInput = z.infer<typeof propertyUpdateSchema>;

export type CardPatchResult =
  | { ok: true; patch: PropertyUpdateInput; changed: string[] }
  | { ok: false; error: string; /** true — менять уже нечего (не отказ, а холостой ход) */ noop?: true };

/**
 * ПРАВКА ДАННЫХ ИЗ ЗАЯВКИ: только поля фактов подписи (`CAPTION_FACT_FIELDS`; цена едет своей
 * заявкой), форма и значения — те же, что у PATCH карточки (propertyUpdateSchema).
 *
 * Схема правки с проверкой связей полей не принимает `.pick` (Zod 4: refine), поэтому набор
 * ключей режется ЗДЕСЬ, а типы и значения проверяет сама схема на урезанном объекте.
 * Из результата берутся только присланные ключи: `.partial()` не снимает дефолты полей, и
 * «разобранный» объект иначе нёс бы лишнее — а оно легло бы в карточку.
 */
export function parseCardPatch(
  raw: Record<string, unknown>,
  existing: Record<string, unknown> & { floor?: number | null; totalFloors?: number | null }
): CardPatchResult {
  const allowed = CAPTION_FACT_FIELDS as readonly string[];
  const foreign = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (foreign.length > 0) {
    return {
      ok: false,
      error: `Через заявку меняются только данные карточки, которые видны в подписи (не: ${foreign.join(", ")}). Цена — отдельной кнопкой.`,
    };
  }
  const parsed = propertyUpdateSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Неверные данные" };
  const data = parsed.data as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) picked[key] = data[key];
  // Поля, которых у типа нет (этаж у дома и т.п.), не пишутся; при смене типа
  // лишние очищаются — то же правило, что у PATCH (propertyTypeFields.ts).
  const patch =
    typeof existing.type === "string"
      ? normalizePropertyPatchForType(picked, existing as { type: string; details?: unknown })
      : picked;
  const typeAfter = (patch.type ?? existing.type) as string | undefined;
  const floorError = propertyFieldShown(typeAfter, "floor") && floorRuleError(
    patch.floor !== undefined ? (patch.floor as number | null) : (existing.floor ?? null),
    patch.totalFloors !== undefined ? (patch.totalFloors as number | null) : (existing.totalFloors ?? null)
  );
  if (floorError) return { ok: false, error: floorError };
  const changed = changedPropertyFields(patch, existing);
  if (changed.length === 0) return { ok: false, error: "Эти данные уже такие в карточке — менять нечего", noop: true };
  // Значения прошли propertyUpdateSchema выше — приведение типа только собирает их обратно в её форму.
  return { ok: true, patch: Object.fromEntries(changed.map((k) => [k, patch[k]])) as PropertyUpdateInput, changed };
}
