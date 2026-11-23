import type { Client } from "../types";

type StateInput = Pick<Client, "status" | "pendingAcceptance" | "hiddenReason" | "deletedAt" | "kind">;
export interface ClientPrimaryState {
  id: "hidden" | "pending" | "other" | "trashed";
  label: string;
  tone: string;
  title?: string;
}

/**
 * ОДНА ОТМЕТКА НА СТРОКУ — И ТОЛЬКО КОГДА ЕСТЬ ЧТО СКАЗАТЬ (владелец 16.11.2026:
 * «удалить все статусы, ничего лишнего, полный минимализм»).
 *
 * Раньше здесь была цветная отметка состояния у каждого клиента: «Новый»,
 * «На контакте», «Горячий», «Холодный», «Не отвечает», «Неактивный» со
 * светофором, «Отложен», «Потерян», «В архиве». Теперь клиент либо просто в
 * списке (без отметки — null), либо у него есть факт, от которого зависит
 * следующее действие: в Корзине, прочее обращение, закрытая сделка, ждёт
 * принятия, на проверке/эскалации (текст — с сервера, computeHiddenReason).
 */
export function clientPrimaryState(c: StateInput): ClientPrimaryState | null {
  if (c.deletedAt || c.hiddenReason?.kind === "trashed")
    return { id: "trashed", label: "В Корзине", tone: "mute", title: c.hiddenReason?.detail };
  if (c.kind === "OTHER") return { id: "other", label: "Прочее обращение", tone: "mute" };
  // «Сделка закрыта» как отметка статуса снята 17.11.2026 (статусы клиента не
  // показываются); сделки видны в своём разделе.
  // Проверка СБ — служебная тайна: в обычной отметке её не называем никогда.
  if (c.hiddenReason && c.hiddenReason.kind !== "securityReview")
    return { id: "hidden", label: c.hiddenReason.label, tone: "warn", title: c.hiddenReason.detail };
  if (c.pendingAcceptance) return { id: "pending", label: "Ждёт принятия", tone: "warn" };
  return null;
}
