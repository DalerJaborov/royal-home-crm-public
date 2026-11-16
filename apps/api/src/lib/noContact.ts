import { noContactCutoff } from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { CLIENT_IN_WORK_WHERE } from "./clientInWork.js";

/**
 * «БЕЗ КОНТАКТА» НА СЕРВЕРЕ — выборка по правилу из packages/shared
 * (clientNoContact.ts). Одна дверь: и счётчик сводки, и «Контроль руководителя»,
 * и «Команда», и контекст помощника директора берут условие отсюда.
 *
 * Настоящий звонок — тот, где клиент взял трубку и был разговор. Ручная запись
 * агента с исходом, заметка, задача сюда НЕ входят (в отличие от
 * REAL_CALL_CONTACT_WHERE в clientContact.ts, которое считает и ручные записи).
 */
export const TALKED_CALL_WHERE = {
  type: "CALL",
  OR: [{ callAttempt: "TALKED" }, { recordingDurationSec: { gt: 0 } }],
} satisfies Prisma.InteractionWhereInput;

/**
 * Клиенты в работе (покупатели и продавцы с агентом), у которых дольше порога не
 * было настоящего контакта. Новая карточка без контакта попадает сюда, когда с её
 * создания прошёл порог — lastContactAt не читается вовсе.
 */
export function noContactWhere(now: Date = new Date()): Prisma.ClientWhereInput {
  const cutoff = noContactCutoff(now);
  return {
    AND: [
      CLIENT_IN_WORK_WHERE,
      { kind: { in: ["BUYER", "SELLER"] }, assignedAgentId: { not: null } },
      { createdAt: { lt: cutoff } },
      { OR: [{ lastClientMessageAt: null }, { lastClientMessageAt: { lt: cutoff } }] },
      { interactions: { none: { ...TALKED_CALL_WHERE, createdAt: { gte: cutoff } } } },
    ],
  };
}
