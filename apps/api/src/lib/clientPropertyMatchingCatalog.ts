import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { loadMoneyContext } from "./money.js";
import { loadMatchPolicy } from "./matchPolicy.js";
import { evaluateClientProperty, compareClientProperties, hasClientMatchingCriteria, clientTextWishes,
  type MatchingBuyerCriteria } from "./clientPropertyMatching.js";
import { loadMatchWeights, scoreClientProperty } from "../routes/matching.js";
import type { ClientPropertyMatchSummary } from "@royal-home/shared";

const factSelect = {
  id: true, shortId: true, type: true, districtId: true, price: true, currency: true, rooms: true,
  areaSqm: true, floor: true, totalFloors: true, lat: true, lng: true, condition: true,
  marketType: true, amenities: true, details: true, description: true,
  intakeAgentId: true, assignedAgentId: true, createdById: true,
} satisfies Prisma.PropertySelect;

export const clientMatchCardSelect = {
  id: true, shortId: true, title: true, type: true, status: true, districtId: true,
  price: true, currency: true, areaSqm: true, rooms: true, floor: true, totalFloors: true,
  lat: true, lng: true, offSite: true, publishedOnSite: true, intakeAgentId: true, assignedAgentId: true, createdById: true,
  district: true,
  photos: { take: 1, orderBy: { order: "asc" }, select: { id: true, thumbUrl: true, url: true, order: true } },
  assignedAgent: { select: { id: true, fullName: true, avatarUrl: true } },
  intakeAgent: { select: { id: true, fullName: true, avatarUrl: true } },
} satisfies Prisma.PropertySelect;

function requirementsSummary(client: MatchingBuyerCriteria): string[] {
  const result: string[] = [];
  if (client.desiredType) result.push("Тип объекта указан");
  if (client.desiredRooms != null) result.push(`${client.desiredRooms} комнаты`);
  if (client.budgetMin != null || client.budgetMax != null) {
    const min = client.budgetMin == null ? "" : `от ${Number(client.budgetMin).toLocaleString("ru-RU")}`;
    const max = client.budgetMax == null ? "" : `до ${Number(client.budgetMax).toLocaleString("ru-RU")}`;
    result.push(`${min} ${max} ${client.currency === "USD" ? "$" : "сомони"}`.trim());
  }
  if (client.desiredDistrictId) result.push("Указанный район");
  if (client.desiredPlaces.length) result.push(`Ориентиры: ${client.desiredPlaces.length}`);
  if (client.desiredAreaMin) result.push(`От ${client.desiredAreaMin} м²`);
  if (client.desiredFloorMin != null || client.desiredFloorMax != null) result.push("Указанные этажи");
  for (const wish of clientTextWishes(client.requirementsNotes)) result.push(`${wish.label}: ${wish.wanted ? "нужно" : "без"}`);
  return result;
}

/** Compare every currently visible record, in bounded DB batches, before slicing the ranked result. */
export async function clientPropertyMatchingCatalog(
  clientId: string, client: MatchingBuyerCriteria,
  options: { viewerId: string; canDeleteProperties: boolean; page: number; pageSize: number; scope: "all" | "mine" }
) {
  const [money, policy, weights] = await Promise.all([loadMoneyContext(), loadMatchPolicy(), loadMatchWeights()]);
  const where: Prisma.PropertyWhereInput = { status: "AVAILABLE", deletedAt: null,
    OR: [{ sellerClientId: null }, { sellerClientId: { not: clientId } }],
    ...(!options.canDeleteProperties ? { deleteRequests: { none: { status: "PENDING", requestedById: options.viewerId } } } : {}) };
  let cursor: string | undefined;
  let scanned = 0;
  const ranked: Array<NonNullable<ReturnType<typeof evaluateClientProperty>> & { score: number }> = [];
  for (;;) {
    const batch = await prisma.property.findMany({ where, select: factSelect, orderBy: { id: "asc" }, take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    scanned += batch.length;
    for (const property of batch) {
      const evaluated = evaluateClientProperty(client, property, money, policy, options.viewerId);
      if (evaluated) ranked.push({ ...evaluated,
        // Retained for old consumers only. UI uses the evidence, not this legacy weight sum.
        score: scoreClientProperty(client, property, money,
          { weights, includeHotBonus: false }).score });
    }
    if (batch.length < 200) break;
    cursor = batch[batch.length - 1].id;
  }
  ranked.sort(compareClientProperties);
  const mineTotal = ranked.filter(item => item.match.isMine).length;
  const visible = options.scope === "mine" ? ranked.filter(item => item.match.isMine) : ranked;
  const start = (options.page - 1) * options.pageSize;
  const page = visible.slice(start, start + options.pageSize);
  const ids = page.map(item => item.id);
  const [properties, sends] = await Promise.all([
    prisma.property.findMany({ where: { ...where, id: { in: ids } }, select: clientMatchCardSelect }),
    prisma.propertyExposure.groupBy({ by: ["propertyId"], where: { clientId, propertyId: { in: ids } },
      _max: { sentAt: true }, _count: { _all: true } }),
  ]);
  const propertyById = new Map(properties.map(item => [item.id, item]));
  const sentById = new Map(sends.map(item => [item.propertyId, item]));
  const summary: ClientPropertyMatchSummary = {
    unfiltered: !hasClientMatchingCriteria(client), scanned, eligible: ranked.length, total: visible.length, mineTotal,
    page: options.page, pageSize: options.pageSize, scope: options.scope, hasMore: start + options.pageSize < visible.length,
    reason: hasClientMatchingCriteria(client) ? null : "needs_requirements", requirementsSummary: requirementsSummary(client),
  };
  return { ...summary, properties: page.flatMap(item => {
    const property = propertyById.get(item.id);
    if (!property) return [];
    const send = sentById.get(item.id);
    return [{ ...property, score: item.score, distanceM: item.distanceM, aiReason: null,
      match: { ...item.match, lastSentAt: send?._max.sentAt?.toISOString() ?? null, sentCount: send?._count._all ?? 0 } }];
  }) };
}
