import { z } from "zod";

/**
 * ПЕРЕДАЧА РОП — С УВЕДОМЛЕНИЕМ ДИРЕКТОРУ (решение владельца 16.11.2026, вторая редакция).
 *
 * РОП передаёт объект или клиента другому агенту СРАЗУ, как и директор; хозяину ничего не
 * приходит и ничего у него не спрашивается (у агентов вообще нет прав и окон на передачу).
 * После передачи директору (и администратору) уходит уведомление в CRM и в Telegram с кнопками
 * «Подтвердить» и «Отклонить». Отклонить = вернуть карточку прежнему хозяину. Типы и схемы
 * живут здесь, чтобы сервер и экран считали одинаково.
 */
export const TRANSFER_REQUEST_KINDS = ["PROPERTY", "CLIENT"] as const;
export type TransferRequestKind = (typeof TRANSFER_REQUEST_KINDS)[number];

/** PENDING — передача сделана, директор ещё не решил; CONFIRMED — директор подтвердил; DECLINED — директор
 *  отклонил и карточка возвращена прежнему хозяину; CANCELLED — передали повторно, прежнее уведомление снято;
 *  FAILED — директор отклонил, но вернуть не удалось (причина в resultNote); EXPIRED не используется
 *  (оставлен в схеме БД от первой редакции). */
export const TRANSFER_REQUEST_STATUSES = ["PENDING", "CONFIRMED", "DECLINED", "EXPIRED", "CANCELLED", "FAILED"] as const;
export type TransferRequestStatus = (typeof TRANSFER_REQUEST_STATUSES)[number];

export const TRANSFER_REQUEST_STATUS_LABELS: Record<TransferRequestStatus, string> = {
  PENDING: "Ждёт решения директора",
  CONFIRMED: "Директор подтвердил",
  DECLINED: "Директор отклонил, карточка возвращена",
  EXPIRED: "Закрыто",
  CANCELLED: "Передано повторно",
  FAILED: "Директор отклонил, но вернуть не удалось",
};

export const transferRequestRespondSchema = z.object({
  decision: z.enum(["confirm", "decline"]),
  /** Необязательное слово директора — РОП увидит его при отклонении. */
  note: z.string().trim().max(300).optional(),
});
export type TransferRequestRespondInput = z.infer<typeof transferRequestRespondSchema>;

/** Что отдаёт API окну директора. Номеров телефонов здесь нет намеренно. */
export interface TransferRequestView {
  id: string;
  kind: TransferRequestKind;
  status: TransferRequestStatus;
  /** Объект: «Объект №123 · 2-комн., Сомони»; клиент: «Клиент Имя». */
  targetTitle: string;
  /** Короткий номер объекта/клиента. */
  targetShortId: number | null;
  targetId: string;
  /** Прежний хозяин. */
  fromAgent: { id: string; fullName: string } | null;
  /** Новый хозяин. */
  toAgent: { id: string; fullName: string } | null;
  /** Кто передал (РОП). */
  requestedBy: { id: string; fullName: string } | null;
  reason: string;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  resultNote: string | null;
}
