/**
 * КОМУ ПОДХОДИТ ОБЪЕКТ — тело `GET /properties/:id/matching-clients`, вынесено
 * 10.11.2026, чтобы мастер в Telegram сразу после создания объекта показывал
 * агенту то же, что панель «Подбор» в CRM. Движок подбора — routes/matching.ts.
 *
 * Права: «видеть всех» (clients.viewAll) — вся выдача, как у REST; без этого
 * права — только свои клиенты агента (чужие имена закрыты). Имя карточки
 * прячется без права clients.viewPhone: у старых карточек номер лежит в имени
 * (lib/clientPhone.ts).
 */
import type { Request } from "express";
import type { MatchingClientsResponse } from "@royal-home/shared";
import { can } from "../auth/middleware.js";
import { findMatchingClients } from "../routes/matching.js";
import { clientNamePhoneSafe } from "./clientPhone.js";

/** Сколько кандидатов смотреть, когда агенту видны только свои: срез делается после фильтра. */
const OWN_SCAN_LIMIT = 300;

export async function matchingClientsForViewer(viewer: Pick<Request, "agent">, propertyId: string, limit = 10): Promise<MatchingClientsResponse> {
  const agentId = viewer.agent?.id;
  if (!agentId) return { items: [], total: 0 };
  const seeAll = can(viewer, "clients.viewAll");
  const found = await findMatchingClients(propertyId, seeAll ? limit : OWN_SCAN_LIMIT);
  const visible = seeAll ? found : (() => {
    const own = found.items.filter((client) => client.assignedAgentId === agentId);
    return { items: own.slice(0, limit), total: own.length };
  })();
  if (can(viewer, "clients.viewPhone")) return visible;
  return { ...visible, items: visible.items.map((client) => ({ ...client, fullName: clientNamePhoneSafe(client.fullName, false) })) };
}
