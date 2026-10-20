import {
  PROPERTY_CHANGE_KINDS,
  PROPERTY_CHANGE_KIND_HINTS,
  PROPERTY_CHANGE_KIND_LABELS,
  VIDEO_REMAKE_REASONS_REQUIRING_COMMENT,
  isPropertyPublished,
  cardDataPayloadSchema,
  createPropertyChangeRequestSchema,
  otherPayloadSchema,
  priceChangePayloadSchema,
  remakeVideoPayloadSchema,
  unpublishPayloadSchema,
  type Currency,
  type CreatePropertyChangeRequestInput,
  type PropertyChangeKind,
  type PropertyChangeRequestDto,
  type PropertyChangeResult,
  type VideoRemakeReason,
} from "@royal-home/shared";
import { formatMoney } from "./format";

/**
 * ЗАЯВКИ НА ИЗМЕНЕНИЕ ОПУБЛИКОВАННОГО ОБЪЕКТА — чистая логика экрана (07.10.2026).
 * Видимость блока, сборка тел запросов, тексты «что просили» и «что получилось».
 * Вынесено из компонента, чтобы проверяться без браузера (jsdom в проекте нет).
 */

/**
 * Опубликован ли объект — то есть прошёл конвейер подготовки и замок правки
 * закрывает прямое редактирование. Правило одно — `isPropertyPublished` из shared.
 */
export function isPublishedForChangeRequests(status: string): boolean {
  return isPropertyPublished(status);
}

export type ChangeRequestMode = "author" | "decider" | null;

/**
 * Кому и в каком виде показывать блок.
 *  — решатель (право `properties.delete`): видит заявки по объекту и принимает решения,
 *    а в режим автора не попадает, даже если у него есть и `properties.requestChange`;
 *  — автор (`properties.requestChange`, но не решатель): готовые кнопки и «Мои заявки»,
 *    только по объекту, за который он отвечает (сервер откажет остальным);
 *  — на неопубликованном объекте и в корзине блока нет вообще.
 */
export function changeRequestMode(input: {
  status: string;
  isTrashed: boolean;
  isResponsible: boolean;
  canRequest: boolean;
  canDecide: boolean;
}): ChangeRequestMode {
  if (input.isTrashed || !isPublishedForChangeRequests(input.status)) return null;
  if (input.canDecide) return "decider";
  if (input.canRequest && input.isResponsible) return "author";
  return null;
}

/** Виды заявок в порядке кнопок — единый список из shared, без своих копий. */
export const CHANGE_KIND_BUTTONS: readonly PropertyChangeKind[] = PROPERTY_CHANGE_KINDS;

export const UNPUBLISH_EMPTY_HINT = "В CRM нет отметок, что ролик где-то вышел — снимать нечего";

/** Кнопка «Убрать из соцсетей» активна, только когда есть отметки о выходе ролика. */
export function kindDisabledReason(kind: PropertyChangeKind, publishedChannels: readonly string[]): string | null {
  if (kind === "UNPUBLISH" && publishedChannels.length === 0) return UNPUBLISH_EMPTY_HINT;
  return null;
}

/** Каналы, которые CRM знает (подписи для выбора и списков). */
export const CHANNEL_LABELS: Record<string, string> = {
  FACEBOOK: "Facebook",
  TELEGRAM: "Telegram",
  YOUTUBE: "YouTube",
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
  THREADS: "Threads",
  SITE: "Сайт",
};
export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

// ───────────────────────── сборка тел запросов ─────────────────────────

type Built = { ok: true; body: CreatePropertyChangeRequestInput } | { ok: false; error: string };

function parseNumber(raw: string): number | null {
  const n = Number(raw.trim().replace(/\s+/g, "").replace(",", "."));
  return raw.trim() !== "" && Number.isFinite(n) ? n : null;
}

function finish(candidate: unknown): Built {
  const parsed = createPropertyChangeRequestSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, body: parsed.data };
  return { ok: false, error: parsed.error.issues[0]?.message ?? "Проверьте поля заявки" };
}

function withComment(comment: string): { comment?: string } {
  const text = comment.trim();
  return text ? { comment: text } : {};
}

export function buildPriceChangeBody(input: { newPrice: string; remake: boolean; comment: string }): Built {
  const newPrice = parseNumber(input.newPrice);
  if (newPrice === null || newPrice <= 0) return { ok: false, error: "Укажите новую цену числом" };
  return finish({ kind: "PRICE_CHANGE", payload: { newPrice, remake: input.remake }, ...withComment(input.comment) });
}

/** Поля формы «Изменились данные объекта» — набор из фактов, что попадают в подпись и ролик. */
export const CARD_DATA_FIELDS = [
  { key: "areaSqm", label: "Площадь, м²", kind: "number" },
  { key: "rooms", label: "Комнат", kind: "int" },
  { key: "floor", label: "Этаж", kind: "int" },
  { key: "totalFloors", label: "Этажность", kind: "int" },
  { key: "address", label: "Адрес", kind: "text" },
  { key: "districtId", label: "Район", kind: "district" },
] as const;
export type CardDataFieldKey = (typeof CARD_DATA_FIELDS)[number]["key"];

/** Текущие значения объекта в строковом виде формы (то, что уже стоит в карточке). */
export function cardDataInitial(property: {
  areaSqm: string;
  rooms: number | null;
  floor: number | null;
  totalFloors: number | null;
  address: string | null;
  districtId: string | null;
}): Record<CardDataFieldKey, string> {
  // areaSqm приходит десятичной строкой базы («55.00») — убираем хвост нулей, чтобы
  // «55» в форме не считалось изменением относительно «55.00».
  const area = Number(property.areaSqm);
  return {
    areaSqm: Number.isFinite(area) ? String(area) : property.areaSqm,
    rooms: property.rooms == null ? "" : String(property.rooms),
    floor: property.floor == null ? "" : String(property.floor),
    totalFloors: property.totalFloors == null ? "" : String(property.totalFloors),
    address: property.address ?? "",
    districtId: property.districtId ?? "",
  };
}

/** Только то, что агент действительно поменял, в типах, которые ждёт `propertyUpdateSchema`. */
export function buildCardDataPatch(
  current: Record<CardDataFieldKey, string>,
  edited: Record<CardDataFieldKey, string>
): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string } {
  const patch: Record<string, unknown> = {};
  for (const f of CARD_DATA_FIELDS) {
    const before = current[f.key].trim();
    const after = edited[f.key].trim();
    if (before === after) continue;
    if (after === "") return { ok: false, error: `Поле «${f.label}» нельзя очистить — впишите новое значение` };
    if (f.kind === "number" || f.kind === "int") {
      const n = parseNumber(after);
      if (n === null || n <= 0 || (f.kind === "int" && !Number.isInteger(n))) {
        return { ok: false, error: `Поле «${f.label}»: нужно ${f.kind === "int" ? "целое число" : "число"} больше нуля` };
      }
      patch[f.key] = n;
    } else {
      patch[f.key] = after;
    }
  }
  return { ok: true, patch };
}

export function buildCardDataBody(input: {
  current: Record<CardDataFieldKey, string>;
  edited: Record<CardDataFieldKey, string>;
  remake: boolean;
  comment: string;
}): Built {
  const patch = buildCardDataPatch(input.current, input.edited);
  if (!patch.ok) return patch;
  if (Object.keys(patch.patch).length === 0) return { ok: false, error: "Ничего не изменено — поправьте хотя бы одно поле" };
  return finish({
    kind: "CARD_DATA",
    payload: { patch: patch.patch, remake: input.remake },
    ...withComment(input.comment),
  });
}

export function buildRemakeBody(input: {
  reason: VideoRemakeReason | null;
  removeFromSocial: boolean;
  comment: string;
}): Built {
  if (!input.reason) return { ok: false, error: "Выберите причину перемонтажа" };
  if (VIDEO_REMAKE_REASONS_REQUIRING_COMMENT.includes(input.reason) && !input.comment.trim()) {
    return { ok: false, error: "Для этой причины нужен комментарий — что именно не так" };
  }
  return finish({
    kind: "REMAKE_VIDEO",
    payload: { reason: input.reason, removeFromSocial: input.removeFromSocial },
    ...withComment(input.comment),
  });
}

/** Выбраны все каналы — шлём пустой список («все отмеченные»), а не перечень: так сервер сам возьмёт актуальные. */
export function buildUnpublishBody(input: {
  selected: readonly string[];
  available: readonly string[];
  comment: string;
}): Built {
  if (input.available.length === 0) return { ok: false, error: UNPUBLISH_EMPTY_HINT };
  if (input.selected.length === 0) return { ok: false, error: "Отметьте хотя бы один канал" };
  const all = input.available.every((c) => input.selected.includes(c));
  return finish({
    kind: "UNPUBLISH",
    payload: all ? {} : { channels: [...input.selected] },
    ...withComment(input.comment),
  });
}

export function buildOtherBody(input: { text: string }): Built {
  return finish({ kind: "OTHER", payload: { text: input.text }, comment: undefined });
}

// ───────────────────────── тексты заявок ─────────────────────────

interface PriceContext {
  price: string;
  currency: Currency;
}

function numberText(value: unknown): string {
  return typeof value === "number" || typeof value === "string" ? String(value) : "—";
}

const CARD_FIELD_LABEL: Record<string, string> = Object.fromEntries(CARD_DATA_FIELDS.map((f) => [f.key, f.label]));

/**
 * «Что просили» одной строкой: «Цена: 95 000 → 89 000 с.». Старую цену называем только у
 * заявки, которая ещё ждёт решения (тогда она совпадает с ценой в карточке); у решённой
 * цена карточки уже могла поменяться.
 */
export function describeChangeRequest(
  request: Pick<PropertyChangeRequestDto, "kind" | "status" | "payload">,
  property: PriceContext
): string {
  switch (request.kind) {
    case "PRICE_CHANGE": {
      const p = priceChangePayloadSchema.safeParse(request.payload);
      if (!p.success) return PROPERTY_CHANGE_KIND_LABELS.PRICE_CHANGE;
      const currency = p.data.currency ?? property.currency;
      const next = formatMoney(p.data.newPrice, currency);
      return request.status === "PENDING"
        ? `Цена: ${formatMoney(property.price, property.currency)} → ${next}`
        : `Цена: новая ${next}`;
    }
    case "CARD_DATA": {
      const p = cardDataPayloadSchema.safeParse(request.payload);
      if (!p.success) return PROPERTY_CHANGE_KIND_LABELS.CARD_DATA;
      const parts = Object.entries(p.data.patch).map(
        ([k, v]) => `${CARD_FIELD_LABEL[k] ?? k}: ${k === "districtId" ? "другой район" : numberText(v)}`
      );
      return `Данные: ${parts.join(", ")}`;
    }
    case "REMAKE_VIDEO": {
      const p = remakeVideoPayloadSchema.safeParse(request.payload);
      return p.success && p.data.removeFromSocial
        ? "Перемонтировать ролик, старый убрать из соцсетей"
        : PROPERTY_CHANGE_KIND_LABELS.REMAKE_VIDEO;
    }
    case "UNPUBLISH": {
      const p = unpublishPayloadSchema.safeParse(request.payload);
      const channels = p.success ? p.data.channels : undefined;
      return channels && channels.length > 0
        ? `Убрать из соцсетей: ${channels.map(channelLabel).join(", ")}`
        : "Убрать из соцсетей: везде, где вышел ролик";
    }
    case "OTHER": {
      const p = otherPayloadSchema.safeParse(request.payload);
      return p.success ? `Другое: ${p.data.text}` : PROPERTY_CHANGE_KIND_LABELS.OTHER;
    }
  }
}

/** Просили ли «и перемонтировать» — для подсказки «что произойдёт». */
export function requestWantsRemake(request: Pick<PropertyChangeRequestDto, "kind" | "payload">): boolean {
  if (request.kind === "REMAKE_VIDEO") return true;
  if (request.kind === "PRICE_CHANGE") {
    const p = priceChangePayloadSchema.safeParse(request.payload);
    return p.success && p.data.remake;
  }
  if (request.kind === "CARD_DATA") {
    const p = cardDataPayloadSchema.safeParse(request.payload);
    return p.success && p.data.remake;
  }
  return false;
}

/** «Что произойдёт после “Принять”»: подсказка вида из shared + «и перемонтаж», если просили. */
export function consequenceLine(request: Pick<PropertyChangeRequestDto, "kind" | "payload">): string {
  const base = PROPERTY_CHANGE_KIND_HINTS[request.kind];
  if (request.kind === "REMAKE_VIDEO") return base;
  return requestWantsRemake(request) ? `${base} Ролик уйдёт на перемонтаж.` : base;
}

export interface ChangeResultView {
  /** Что сделано сразу — галочками. */
  applied: string[];
  /** Остаток руками: канал + что именно. Пусто — блок «Руками» не рисуется. */
  manual: { channel: string; text: string }[];
  remakeQueued: boolean;
  /** Текст ошибки, если заявка не выполнилась (FAILED). */
  failed: string | null;
}

export function changeResultView(
  request: Pick<PropertyChangeRequestDto, "status" | "result" | "error">
): ChangeResultView | null {
  if (request.status === "FAILED") {
    const result: PropertyChangeResult | null = request.result;
    return {
      applied: result?.applied ?? [],
      manual: result?.manual ?? [],
      remakeQueued: result?.remakeQueued ?? false,
      failed: request.error?.trim() || "Не удалось выполнить заявку",
    };
  }
  if (request.status !== "APPROVED" || !request.result) return null;
  return {
    applied: request.result.applied,
    manual: request.result.manual,
    remakeQueued: request.result.remakeQueued,
    failed: null,
  };
}
