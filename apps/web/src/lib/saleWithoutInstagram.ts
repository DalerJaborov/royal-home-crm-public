import { ApiError } from "./apiError";

/**
 * «ВЫВЕСТИ В ПРОДАЖУ БЕЗ INSTAGRAM» (17.11.2026, волна 2 Шабнам, живой случай ОБ-000193).
 *
 * Можно ли — решает сервер (lib/propertyCompleteEditing.ts: право директора/админа, ролик принят и
 * вышел хотя бы в одну сеть) и говорит это в отказе «Готово» (409, `code: "NOT_READY"`,
 * `withoutInstagram.allowed`). Экран правило не повторяет: только читает ответ сервера, поэтому
 * кнопка не появится у того, кому сервер всё равно откажет.
 */
export interface SaleWithoutInstagramOffer {
  /** Где ролик уже вышел — подписями сервера («YouTube», «Facebook»…). */
  channels: string[];
}

export function saleWithoutInstagramOffer(error: unknown): SaleWithoutInstagramOffer | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const data = error.data as { code?: unknown; withoutInstagram?: { allowed?: unknown; channels?: unknown } } | null | undefined;
  if (!data || data.code !== "NOT_READY") return null;
  const offer = data.withoutInstagram;
  if (!offer || offer.allowed !== true || !Array.isArray(offer.channels)) return null;
  const channels = offer.channels.filter((c): c is string => typeof c === "string" && c.length > 0);
  return channels.length > 0 ? { channels } : null;
}
