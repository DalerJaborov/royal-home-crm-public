import type { Client } from "../types";

/**
 * ЧИП СТРОКИ КЛИЕНТА = ДЕЙСТВИЕ (контракт 06.10.2026, review-statuses.md п. 3).
 *
 * В строке ровно один чип, и он называет, что делать. Выбирается ПЕРВЫЙ
 * сработавший по приоритету: принять лид → позвонить сейчас → ответить →
 * первый звонок. Нет действия, нет чипа. «Горячий», «новый» и «холодный» чипом
 * не рисуются: это оценка машины, а не дело (остаются фильтром в шторке).
 *
 * Только поля, которые список клиентов уже отдаёт (GET /clients). Чипа «показ
 * сегодня 14:00» здесь НЕТ намеренно: ближайшего показа клиента список не несёт,
 * выдумывать его из текста шага нельзя.
 *
 * Чистая функция: время приходит аргументом, чтобы результат не зависел от часов.
 */
export type ClientActionTone = "warn" | "crit";

export interface ClientAction {
  id: "accept" | "waiting" | "call-now" | "reply" | "first-call";
  tone: ClientActionTone;
  /** Подпись на компьютере. */
  label: string;
  /** Короткая подпись для телефона, где в строке мало места. */
  short: string;
}

type ActionInput = Pick<
  Client,
  | "kind"
  | "status"
  | "workStatus"
  | "pendingAcceptance"
  | "escalatedAt"
  | "acceptedAt"
  | "firstContactAt"
  | "unread"
  | "nextStep"
  | "deletedAt"
  | "hiddenReason"
>;

export function clientAction(c: ActionInput, nowMs: number, canAccept: boolean): ClientAction | null {
  // Не назначается агенту, в корзине или скрыт: у такой карточки своё состояние, не дело.
  if (c.kind === "OTHER" || c.deletedAt || c.hiddenReason) return null;
  if (["LOST", "ARCHIVED", "DEAL_CLOSED"].includes(c.status)) return null;
  if (c.workStatus && c.workStatus !== "ACTIVE") return null;

  if (c.pendingAcceptance) {
    if (canAccept) {
      return { id: "accept", tone: c.escalatedAt ? "crit" : "warn", label: "принять лид", short: "принять лид" };
    }
    // Смотрит не держатель (руководитель): принять он не может, поэтому не зовём к действию.
    return c.escalatedAt
      ? { id: "waiting", tone: "crit", label: "никто не принял", short: "не принят" }
      : { id: "waiting", tone: "warn", label: "ждёт принятия", short: "ждёт принятия" };
  }

  const due = c.nextStep?.nextActionDate;
  if (due && new Date(due).getTime() < nowMs) {
    return { id: "call-now", tone: "warn", label: "позвонить сейчас", short: "позвонить" };
  }
  if (c.unread) return { id: "reply", tone: "warn", label: "ответить", short: "ответить" };
  if (c.status === "NEW" && c.acceptedAt && !c.firstContactAt) {
    return { id: "first-call", tone: "warn", label: "первый звонок", short: "первый звонок" };
  }
  return null;
}
