/**
 * ПРЕДЛОЖИТЬ ОБЪЕКТ КОЛЛЕГЕ ДЛЯ ЕГО КЛИЕНТА (решение владельца 10.11.2026).
 *
 * Агент, заведший объект, видит подходящих чужих клиентов без имени и телефона
 * и одной кнопкой предлагает объект агенту-владельцу клиента. Клиенту ничего не
 * уходит, владелец клиента не меняется (docs/law/lead-ownership.md). Одна строка
 * `PropertyClientOffer` на пару объект+клиент: повторное нажатие второй раз не
 * шлёт. Подходит ли клиент — те же правила подбора (`clientMatchesPropertyNow`).
 */
import type { Request } from "express";
import { can } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { clientMatchesPropertyNow } from "./propertyMatchingClients.js";

export type OfferRefusal = "not_found" | "forbidden" | "not_matching" | "own_client" | "no_agent";
export type OfferResult =
  | { status: "created"; offerId: string; toAgent: { id: string; fullName: string; telegramChatId: string | null } }
  | { status: "already"; toAgentName: string }
  | { status: "refused"; reason: OfferRefusal };

export async function createPropertyClientOffer(viewer: Pick<Request, "agent">, propertyId: string, clientId: string): Promise<OfferResult> {
  const fromAgentId = viewer.agent?.id;
  if (!fromAgentId) return { status: "refused", reason: "forbidden" };
  const [property, client] = await Promise.all([
    prisma.property.findFirst({ where: { id: propertyId, deletedAt: null }, select: { id: true, assignedAgentId: true, intakeAgentId: true, createdById: true } }),
    prisma.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { id: true, assignedAgentId: true, assignedAgent: { select: { id: true, fullName: true, telegramChatId: true, isActive: true } } } }),
  ]);
  if (!property || !client) return { status: "refused", reason: "not_found" };
  // Предлагает тот, чей это объект (завёл, принял или ведёт), либо руководство.
  const ownsProperty = [property.assignedAgentId, property.intakeAgentId, property.createdById].includes(fromAgentId);
  if (!ownsProperty && !can(viewer, "properties.editForeign")) return { status: "refused", reason: "forbidden" };
  if (client.assignedAgentId === fromAgentId) return { status: "refused", reason: "own_client" };
  const toAgent = client.assignedAgent;
  if (!toAgent || !toAgent.isActive) return { status: "refused", reason: "no_agent" };
  if (!(await clientMatchesPropertyNow(property.id, client.id))) return { status: "refused", reason: "not_matching" };
  const existing = await prisma.propertyClientOffer.findUnique({ where: { propertyId_clientId: { propertyId: property.id, clientId: client.id } } });
  if (existing) return { status: "already", toAgentName: toAgent.fullName };
  try {
    const offer = await prisma.propertyClientOffer.create({
      data: { propertyId: property.id, clientId: client.id, fromAgentId, toAgentId: toAgent.id, channel: toAgent.telegramChatId ? "TELEGRAM" : "CRM" },
    });
    return { status: "created", offerId: offer.id, toAgent: { id: toAgent.id, fullName: toAgent.fullName, telegramChatId: toAgent.telegramChatId } };
  } catch (error) {
    // Два нажатия разом: вторая вставка упирается в уникальный ключ пары.
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") return { status: "already", toAgentName: toAgent.fullName };
    throw error;
  }
}

export async function setPropertyClientOfferChannel(offerId: string, channel: "TELEGRAM" | "CRM"): Promise<void> {
  await prisma.propertyClientOffer.update({ where: { id: offerId }, data: { channel } });
}

/** Ответ агента-владельца клиента. Отвечает только адресат и только один раз. */
export async function answerPropertyClientOffer(agentId: string, offerId: string, answer: "WILL_SEND" | "NOT_SUITABLE") {
  const updated = await prisma.propertyClientOffer.updateMany({
    where: { id: offerId, toAgentId: agentId, status: "SENT" },
    data: { status: answer, respondedAt: new Date() },
  });
  return updated.count === 1;
}
