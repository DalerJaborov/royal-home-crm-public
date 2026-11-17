/**
 * «УЖЕ СВЯЗЫВАЛИСЬ» ПО ЧУЖИМ ОБЪЯВЛЕНИЯМ (17.11.2026): чтобы два агента не дёргали одного хозяина.
 *
 * Два источника, оба уже существующие, без второй копии учёта:
 *  · MarketListingContact — номер продавца взяли кнопкой «Показать номер» или «Написать в WhatsApp»
 *    (пишет одна дверь POST /market/listing-contact, routes/marketContact.ts);
 *  · SomonDelivery — продавца с Somon уже передали агенту поиском собственников (lib/somonLeads, тот же номер
 *    объявления: MarketListing.sourceId = id объявления Somon). Отменённая или неудачная передача не считается.
 * На объявление — одна последняя отметка (кто, когда, каким действием). Всё одним запросом на источник, без N+1.
 */
import type { MarketListingContactInfo } from "@royal-home/shared";
import { prisma } from "../../db.js";

/** Передачи поиска собственников, которые значат «продавцу уже звонит агент». */
const LIVE_DELIVERY = ["SENDING", "DISPATCHED", "ACCEPTED", "UNKNOWN"];

export async function loadListingContacts(sourceUrls: readonly string[], viewerId: string): Promise<Map<string, MarketListingContactInfo>> {
  const out = new Map<string, MarketListingContactInfo>();
  if (sourceUrls.length === 0) return out;
  const listings = await prisma.marketListing.findMany({
    where: { sourceUrl: { in: [...sourceUrls] } },
    select: { id: true, source: true, sourceId: true, sourceUrl: true },
  });
  if (listings.length === 0) return out;
  const byId = new Map(listings.map((l) => [l.id, l]));
  const somonIds = listings.filter((l) => l.source === "somon.tj").map((l) => l.sourceId);
  const [contacts, deliveries] = await Promise.all([
    prisma.marketListingContact.findMany({
      where: { listingId: { in: listings.map((l) => l.id) } },
      orderBy: { createdAt: "desc" },
      select: { listingId: true, agentId: true, action: true, createdAt: true },
      take: 500,
    }),
    somonIds.length
      ? prisma.somonDelivery.findMany({
          where: { advertId: { in: somonIds }, status: { in: LIVE_DELIVERY } },
          select: { advertId: true, agentId: true, createdAt: true },
        })
      : Promise.resolve([]),
  ]);
  const agentIds = [...new Set([...contacts.map((c) => c.agentId), ...deliveries.map((d) => d.agentId)])];
  const agents = agentIds.length
    ? await prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, fullName: true } })
    : [];
  const nameOf = new Map(agents.map((a) => [a.id, a.fullName]));
  const put = (sourceUrl: string, info: MarketListingContactInfo) => {
    const prev = out.get(sourceUrl);
    if (!prev || prev.at < info.at) out.set(sourceUrl, info);
  };
  for (const c of contacts) {
    const l = byId.get(c.listingId);
    if (!l) continue;
    put(l.sourceUrl, {
      action: c.action === "PHONE" ? "PHONE" : "WHATSAPP",
      agentName: nameOf.get(c.agentId) ?? "Сотрудник",
      byMe: c.agentId === viewerId,
      at: c.createdAt.toISOString(),
    });
  }
  const bySomonId = new Map(listings.filter((l) => l.source === "somon.tj").map((l) => [l.sourceId, l]));
  for (const d of deliveries) {
    const l = bySomonId.get(d.advertId);
    if (!l) continue;
    put(l.sourceUrl, { action: "OWNER_LEAD", agentName: nameOf.get(d.agentId) ?? "Сотрудник", byMe: d.agentId === viewerId, at: d.createdAt.toISOString() });
  }
  return out;
}
