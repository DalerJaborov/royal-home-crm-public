import type { Request } from "express";
import { scopeToOwnAgent } from "../auth/middleware.js";
import { prisma } from "../db.js";

/**
 * ЧТО ВИДИТ ЭТОТ СОТРУДНИК В ЭТОЙ КАРТОЧКЕ КЛИЕНТА — ОДНА ДВЕРЬ (аудит
 * безопасности 17.11.2026, часть 2, S1/S2).
 *
 * До этого правило жило копиями в четырёх маршрутах (GET /clients/:id,
 * /:id/timeline, /:id/conversation-export, /:id/property-activity), и копии
 * разошлись: «до принятия — только имя» стояло только для ТЕКУЩЕГО владельца,
 * а «бывший агент» (`lastAgentId` — его пишет changeClientAgent при ЛЮБОЙ
 * смене владельца, в том числе когда агент сам отклонил лид или лид сняли за
 * непозвоненный звонок) получал всю карточку: бюджет, требования, сводку ИИ,
 * переписку всех каналов, ник в Telegram, выгрузку переписки и новые сообщения.
 * Отклонить лид значило открыть то, что до принятия закрыто.
 *
 * Уровни:
 *  - `full`        — руководство с правом видеть всех (clients.viewAll: РОП,
 *                    директор, СБ, акционер — как и было), свой принятый
 *                    клиент, своя сделка по чужому клиенту;
 *  - `nameOnly`    — свой, но ещё не принятый лид: имя без контактов, требований
 *                    и истории (решение владельца 20.08.2026);
 *  - `transferred` — карточку у агента забрали: только факт передачи (кому,
 *                    когда, почему) и имя, без контактов, требований, истории,
 *                    выгрузки и новых сообщений;
 *  - `denied`      — посторонний: 403.
 *
 * Новый путь, отдающий данные клиента по id, зовёт эту функцию, а не пишет
 * своё сравнение `assignedAgentId`/`lastAgentId` — сторож
 * `apps/api/tests/client-card-access-door.test.ts` не пропускает чтение
 * `lastAgentId` для решения о доступе в маршрутах мимо этого файла.
 */
export type ClientCardAccess = "full" | "nameOnly" | "transferred" | "denied";

export interface ClientCardAccessFacts {
  assignedAgentId: string | null;
  lastAgentId?: string | null;
  acceptedAt: Date | null;
}

/**
 * Чистое решение. `viewerOwnAgentId` — результат scopeToOwnAgent: пусто у
 * того, кто видит всех клиентов. `hasDeal` — есть ли у смотрящего своя сделка
 * с этим клиентом (нужен только когда клиент закреплён не за ним).
 */
export function decideClientCardAccess(
  viewerOwnAgentId: string | undefined,
  client: ClientCardAccessFacts,
  hasDeal: boolean,
): ClientCardAccess {
  if (!viewerOwnAgentId) return "full";
  if (client.assignedAgentId === viewerOwnAgentId) return client.acceptedAt ? "full" : "nameOnly";
  // Своя сделка по чужому клиенту (так назначил руководитель) — работать по
  // ней без карточки нельзя; чужие сделки в ней режет scopeDealsToOwnAgent.
  if (hasDeal) return "full";
  if (client.lastAgentId && client.lastAgentId === viewerOwnAgentId) return "transferred";
  return "denied";
}

/**
 * То же решение для маршрута: сам берёт права из запроса и, только если нужно,
 * спрашивает базу про сделку. `deals` — уже загруженные сделки клиента (если
 * маршрут их и так выбрал), чтобы не ходить в базу второй раз.
 */
export async function resolveClientCardAccess(
  req: Pick<Request, "agent">,
  client: ClientCardAccessFacts & { id: string; deals?: { agentId: string }[] },
): Promise<ClientCardAccess> {
  if (!req.agent) return "denied";
  const own = scopeToOwnAgent(req);
  if (!own || client.assignedAgentId === own) return decideClientCardAccess(own, client, false);
  const hasDeal = client.deals
    ? client.deals.some((d) => d.agentId === own)
    : (await prisma.deal.count({ where: { clientId: client.id, agentId: own } })) > 0;
  return decideClientCardAccess(own, client, hasDeal);
}

/**
 * Профиль, закрытый до принятия лида и после передачи: требования, бюджет,
 * сводка ИИ. Один набор на карточку и на список клиентов (routes/clients/list.ts).
 */
export const CLIENT_PROFILE_HIDDEN = {
  budgetMin: null,
  budgetMax: null,
  requirementsNotes: null,
  desiredDistrictId: null,
  desiredDistrict: null,
  desiredRooms: null,
  desiredType: null,
  // Сводка ИИ — пересказ той самой переписки и хронологии, которые закрыты:
  // оставить её значило бы отдать закрытое содержимое коротким текстом.
  aiInsight: null,
  aiInsightAt: null,
} as const;

/** История карточки: хронология, факты о ней, сделки, переписка всех каналов,
 *  «Где ищет». Закрыта и до принятия, и после передачи. */
export const CLIENT_CARD_HISTORY_HIDDEN = {
  desiredPlaces: [] as never[],
  interactions: [] as never[],
  interactionsTotal: 0,
  hadConductedShowing: false,
  callsCount: 0,
  hadRealCall: false,
  deals: [] as never[],
  botConversation: [] as never[],
  telegramConversation: null,
  telegramDirectConversations: [] as never[],
} as const;

/**
 * Сверх профиля и истории бывшему агенту не отдаётся ничего, по чему клиента
 * можно найти или продолжить вести мимо CRM: запасные номера, почта, адрес,
 * ник и чат Telegram, фото профиля, объект интереса, свободные тексты причин.
 * Главный номер маскирует presentClient (canSeePhone=false).
 */
export const CLIENT_TRANSFERRED_HIDDEN = {
  extraPhones: [] as string[],
  email: null,
  address: null,
  telegramUsername: null,
  telegramChatId: null,
  avatarUrl: null,
  aiScore: null,
  aiScoreReason: null,
  matchedPropertyId: null,
  requestedPropertyId: null,
  matchScore: null,
  leadReason: null,
  refusalReason: null,
  deferredReason: null,
  securityNote: null,
  firstCallDueAt: null,
  firstCallDone: null,
} as const;
