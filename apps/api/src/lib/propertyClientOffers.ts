/**
 * ПРЕДЛОЖИТЬ ОБЪЕКТ КОЛЛЕГЕ ДЛЯ ЕГО КЛИЕНТА (решение владельца 10.11.2026).
 *
 * Агент, заведший объект, видит подходящих чужих клиентов без имени и телефона
 * и одной кнопкой предлагает объект агенту-владельцу клиента. Клиенту ничего не
 * уходит, владелец клиента не меняется (docs/law/lead-ownership.md). Одна
 * строка `PropertyClientOffer` на пару объект+клиент. Подходит ли клиент — те
 * же правила подбора (`clientMatchesPropertyNow`).
 *
 * Статусы: PENDING — записано, доставка ещё не подтверждена (упали между записью
 * и отправкой — повтор разрешён); SENT — доставлено, ждёт ответа; WILL_SEND /
 * NOT_SUITABLE — ответ владельца клиента (из Telegram или из CRM, одна функция);
 * CLOSED — клиент ушёл к другому агенту (lib/ownershipSatellites.ts).
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
  const channel = toAgent.telegramChatId ? "TELEGRAM" : "CRM";
  const target = { id: toAgent.id, fullName: toAgent.fullName, telegramChatId: toAgent.telegramChatId };
  const existing = await prisma.propertyClientOffer.findUnique({ where: { propertyId_clientId: { propertyId: property.id, clientId: client.id } } });
  if (existing) {
    // Доставлено или отвечено — второй раз не шлём. Не доставлено или закрыто сменой
    // владельца — шлём заново, адресат — текущий владелец клиента.
    if (existing.status !== "PENDING" && existing.status !== "CLOSED") return { status: "already", toAgentName: toAgent.fullName };
    const reopened = await prisma.propertyClientOffer.updateMany({
      where: { id: existing.id, status: existing.status },
      data: { status: "PENDING", toAgentId: toAgent.id, fromAgentId, channel, respondedAt: null },
    });
    if (reopened.count !== 1) return { status: "already", toAgentName: toAgent.fullName };
    return { status: "created", offerId: existing.id, toAgent: target };
  }
  try {
    const offer = await prisma.propertyClientOffer.create({
      data: { propertyId: property.id, clientId: client.id, fromAgentId, toAgentId: toAgent.id, channel },
    });
    return { status: "created", offerId: offer.id, toAgent: target };
  } catch (error) {
    // Два нажатия разом: вторая вставка упирается в уникальный ключ пары.
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") return { status: "already", toAgentName: toAgent.fullName };
    throw error;
  }
}

/** Доставка подтверждена: теперь повтор нажатия второй раз не шлёт. */
export async function markPropertyClientOfferDelivered(offerId: string, channel: "TELEGRAM" | "CRM"): Promise<void> {
  await prisma.propertyClientOffer.updateMany({ where: { id: offerId, status: "PENDING" }, data: { status: "SENT", channel } });
}

export type OfferAnswer = "WILL_SEND" | "NOT_SUITABLE";

/**
 * Ответ агента-владельца клиента — из Telegram и из CRM одной функцией.
 * Отвечает только адресат, только пока он ведёт клиента, и только один раз.
 */
export async function answerPropertyClientOffer(agentId: string, offerId: string, answer: OfferAnswer): Promise<boolean> {
  const updated = await prisma.propertyClientOffer.updateMany({
    where: { id: offerId, toAgentId: agentId, status: "SENT", client: { assignedAgentId: agentId, deletedAt: null } },
    data: { status: answer, respondedAt: new Date() },
  });
  return updated.count === 1;
}

export { closePropertyClientOffersOnTransfer } from "./propertyClientOfferClose.js";

/** Номер предложения из адреса уведомления CRM (`/properties/<id>?offer=<offerId>`). */
export function offerIdFromNotificationUrl(url: string | null | undefined): string | null {
  const query = url?.split("?")[1];
  const id = query ? new URLSearchParams(query).get("offer") : null;
  return id && /^[\da-f-]{36}$/u.test(id) ? id : null;
}

export interface NotificationOfferState {
  id: string;
  status: string;
  /** Можно ли сейчас ответить: доставлено, ответа ещё нет, клиента ведёт этот агент. */
  answerable: boolean;
}

/**
 * Статус предложения рядом с уведомлением в ленте (10.11.2026): после
 * перезагрузки страницы лента показывает ответ, а не снова обе кнопки.
 * Одна выборка на страницу ленты, только предложения самого агента.
 */
export async function attachOfferStates<T extends { kind: string; url: string | null }>(agentId: string, rows: T[]): Promise<(T & { offer?: NotificationOfferState })[]> {
  const ids = [...new Set(rows.filter(row => row.kind === "property-offer").map(row => offerIdFromNotificationUrl(row.url)).filter((id): id is string => Boolean(id)))];
  if (!ids.length) return rows;
  const offers = await prisma.propertyClientOffer.findMany({
    where: { id: { in: ids }, toAgentId: agentId },
    select: { id: true, status: true, client: { select: { assignedAgentId: true, deletedAt: true } } },
  });
  const byId = new Map(offers.map(offer => [offer.id, {
    id: offer.id, status: offer.status,
    answerable: offer.status === "SENT" && offer.client.assignedAgentId === agentId && !offer.client.deletedAt,
  }]));
  return rows.map(row => {
    const offer = row.kind === "property-offer" ? byId.get(offerIdFromNotificationUrl(row.url) ?? "") : undefined;
    return offer ? { ...row, offer } : row;
  });
}
