/**
 * КОМУ ПОДХОДИТ ОБЪЕКТ — одна дверь для панели «Подбор» в CRM
 * (`GET /properties/:id/matching-clients`) и мастера объекта в Telegram.
 * Правила подбора — routes/matching.ts (`findMatchingClients`), здесь только кто
 * что видит. Маскировка — здесь, на сервере, а не в тексте сообщения.
 *
 * REST (`matchingClientsForViewer`): маршрут закрыт правом clients.viewAll —
 * агенту по-прежнему 403. Имя карточки прячется без права clients.viewPhone: у
 * старых карточек номер лежит в имени (lib/clientPhone.ts).
 *
 * Помощник (`matchingClientsForAssistant`, решение владельца 10.11.2026): агент
 * видит ВСЕХ подходящих клиентов, чтобы быстрее продать, но чужих — без имени и
 * телефона (номер, кто ведёт, бюджет, комнаты, район, причины). Руководство
 * (clients.viewAll) — всех полностью. Это расширение только в помощнике.
 */
import type { Request } from "express";
import type { ClientMatchEvidence, MatchingClient, MatchingClientsResponse } from "@royal-home/shared";
import { can } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { findMatchingClients } from "../routes/matching.js";
import { clientNamePhoneSafe } from "./clientPhone.js";

export async function matchingClientsForViewer(viewer: Pick<Request, "agent">, propertyId: string, limit = 10): Promise<MatchingClientsResponse> {
  const result = await findMatchingClients(propertyId, limit);
  if (can(viewer, "clients.viewPhone")) return result;
  return { ...result, items: result.items.map((client) => ({ ...client, fullName: clientNamePhoneSafe(client.fullName, false) })) };
}

export interface AssistantClientMatch {
  clientId: string;
  shortId: number;
  /** Клиент этого агента. */
  own: boolean;
  /** null — чужой клиент: имя и телефон агенту закрыты. */
  name: string | null;
  agentId: string | null;
  agentName: string | null;
  /** Уровень, что совпало, уступки, «не знаем» и когда уже отправляли — та же
   *  модель, что в «Подборе» CRM (lib/clientPropertyMatching.ts). */
  match: ClientMatchEvidence;
  budgetMax: number | null;
  currency: "TJS" | "USD";
  rooms: number | null;
  districtName: string | null;
}

export interface AssistantMatches {
  /** Сколько клиентов агентства подходит всего (как счётчик спроса на объекте). */
  total: number;
  own: AssistantClientMatch[];
  colleagues: AssistantClientMatch[];
}

export async function matchingClientsForAssistant(viewer: Pick<Request, "agent">, propertyId: string, limit = 12): Promise<AssistantMatches> {
  const agentId = viewer.agent?.id;
  if (!agentId) return { total: 0, own: [], colleagues: [] };
  const seeAll = can(viewer, "clients.viewAll");
  // Свои — отдельным запросом по агенту: среди первых N всего агентства их может не оказаться.
  const [all, mine] = await Promise.all([
    findMatchingClients(propertyId, limit),
    findMatchingClients(propertyId, limit, { assignedAgentId: agentId }),
  ]);
  const colleagueItems = all.items.filter((client) => client.assignedAgentId !== agentId);
  const ids = [...mine.items, ...colleagueItems].map((client) => client.id);
  const facts = new Map((await prisma.client.findMany({
    where: { id: { in: ids } },
    select: { id: true, budgetMax: true, currency: true, desiredRooms: true, desiredDistrict: { select: { name: true } } },
  })).map((row) => [row.id, row]));
  const canSeePhone = can(viewer, "clients.viewPhone");
  const present = (client: MatchingClient, own: boolean): AssistantClientMatch => {
    const fact = facts.get(client.id);
    return {
      clientId: client.id,
      shortId: client.shortId,
      own,
      name: own || seeAll ? clientNamePhoneSafe(client.fullName, canSeePhone) : null,
      agentId: client.assignedAgentId,
      agentName: client.assignedAgentName ?? null,
      match: client.match,
      budgetMax: fact?.budgetMax != null ? Number(fact.budgetMax) : null,
      currency: fact?.currency === "USD" ? "USD" : "TJS",
      rooms: fact?.desiredRooms ?? null,
      districtName: fact?.desiredDistrict?.name ?? null,
    };
  };
  return {
    total: all.total,
    own: mine.items.map((client) => present(client, true)),
    colleagues: colleagueItems.map((client) => present(client, false)),
  };
}

/** Клиент подходит объекту по тем же правилам подбора (проверка кнопки «Предложить»). */
export async function clientMatchesPropertyNow(propertyId: string, clientId: string): Promise<boolean> {
  const found = await findMatchingClients(propertyId, 1, { clientId });
  return found.items.some((client) => client.id === clientId);
}
