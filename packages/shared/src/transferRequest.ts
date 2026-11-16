import { z } from "zod";

/**
 * ПЕРЕДАЧА С ПОДТВЕРЖДЕНИЕМ ХОЗЯИНА (владелец 16.11.2026).
 *
 * РОП просит передать объект или клиента другому агенту; текущий хозяин
 * отвечает «Подтвердить» или «Отказать» в большом окне поверх CRM. Не ответил
 * за срок из настроек — запрос отменяется. Типы и схемы живут здесь, чтобы
 * сервер и экран считали одинаково.
 */
export const TRANSFER_REQUEST_KINDS = ["PROPERTY", "CLIENT"] as const;
export type TransferRequestKind = (typeof TRANSFER_REQUEST_KINDS)[number];

/** PENDING — ждёт хозяина; CONFIRMED — передано; DECLINED — хозяин отказал; EXPIRED — не ответил или данные изменились;
 *  CANCELLED — отозвал тот, кто просил; FAILED — хозяин подтвердил, но передать не вышло (причина в resultNote). */
export const TRANSFER_REQUEST_STATUSES = ["PENDING", "CONFIRMED", "DECLINED", "EXPIRED", "CANCELLED", "FAILED"] as const;
export type TransferRequestStatus = (typeof TRANSFER_REQUEST_STATUSES)[number];

export const TRANSFER_REQUEST_STATUS_LABELS: Record<TransferRequestStatus, string> = {
  PENDING: "Ждёт ответа хозяина",
  CONFIRMED: "Хозяин подтвердил, передано",
  DECLINED: "Хозяин отказал",
  EXPIRED: "Хозяин не ответил, передача отменена",
  CANCELLED: "Запрос отозван",
  FAILED: "Хозяин подтвердил, но передать не удалось",
};

/** Срок ответа по умолчанию и границы настройки (часы). */
export const TRANSFER_CONFIRM_HOURS_DEFAULT = 24;
export const TRANSFER_CONFIRM_HOURS_MIN = 1;
export const TRANSFER_CONFIRM_HOURS_MAX = 168;

export const transferRequestCreateSchema = z.object({
  kind: z.enum(TRANSFER_REQUEST_KINDS),
  /** id объекта или клиента — по `kind`. */
  targetId: z.guid(),
  toAgentId: z.guid(),
  reason: z.string().trim().min(3, "Напишите, почему передаёте").max(500),
});
export type TransferRequestCreateInput = z.infer<typeof transferRequestCreateSchema>;

export const transferRequestRespondSchema = z.object({
  decision: z.enum(["confirm", "decline"]),
  /** Необязательное слово от хозяина — РОП увидит его при отказе. */
  note: z.string().trim().max(300).optional(),
});
export type TransferRequestRespondInput = z.infer<typeof transferRequestRespondSchema>;

/** Что отдаёт API окну хозяина и спискам. Номеров телефонов здесь нет намеренно. */
export interface TransferRequestView {
  id: string;
  kind: TransferRequestKind;
  status: TransferRequestStatus;
  /** Объект: «№123 · 2-комн., Сомони»; клиент: имя. */
  targetTitle: string;
  /** Короткий номер объекта/клиента для ссылки на карточку. */
  targetShortId: number | null;
  targetId: string;
  fromAgent: { id: string; fullName: string } | null;
  toAgent: { id: string; fullName: string } | null;
  requestedBy: { id: string; fullName: string } | null;
  reason: string;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  resultNote: string | null;
}
