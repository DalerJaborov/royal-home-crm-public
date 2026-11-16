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
 * Условие правила без отбора «кто в работе»: настоящего контакта не было после
 * `cutoff` — ни сообщения самого клиента, ни разговора по телефону. Карточка, с
 * которой контакта не было ни разу, подходит сразу (оба условия выполнены).
 * Тем же условием пользуются рассылка «вернуть клиента» (lib/reactivationCampaign.ts)
 * и пауза бота (lib/conversationState.ts) — каждая со своим порогом.
 */
export function noContactSinceWhere(cutoff: Date): Prisma.ClientWhereInput {
  return {
    AND: [
      { OR: [{ lastClientMessageAt: null }, { lastClientMessageAt: { lt: cutoff } }] },
      { interactions: { none: { ...TALKED_CALL_WHERE, createdAt: { gte: cutoff } } } },
    ],
  };
}

/**
 * Клиенты в работе (покупатели и продавцы с агентом) «без контакта» по общему
 * правилу (packages/shared/src/clientNoContact.ts): контакта не было ни разу —
 * сразу; был — когда с последнего прошло больше порога. lastContactAt не читается.
 */
export function noContactWhere(now: Date = new Date()): Prisma.ClientWhereInput {
  return {
    AND: [
      CLIENT_IN_WORK_WHERE,
      { kind: { in: ["BUYER", "SELLER"] }, assignedAgentId: { not: null } },
      noContactSinceWhere(noContactCutoff(now)),
    ],
  };
}
