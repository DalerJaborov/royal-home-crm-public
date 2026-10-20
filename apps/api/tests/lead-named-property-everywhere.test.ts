import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ОБЪЕКТ, НАЗВАННЫЙ КЛИЕНТОМ, ДОХОДИТ ДО РАЗДАЧИ ПО ВСЕМ ПУТЯМ (24.09.2026,
 * проход по классам после ОБ-000118, /mnt/project-files/uznavanie-24-09/klassy.md).
 *
 *  - п.5: ночью назначение откладывается, и утренняя волна не знала, какой
 *    объект человек назвал — лид уходил общей очередью;
 *  - п.6: разбор звонка выбирал агента до того, как запрос лёг в карточку, —
 *    шаг «запрос совпал с объектом» читал пустую карточку;
 *  - п.8: подбор для раздачи не смотрел тип жилья — покупатель дома «совпадал»
 *    с квартирой;
 *  - п.7: чат узнаёт описанное объявление («видел у вас … у Бодомзора»), а
 *    желание без слов про объявление объектом не считает.
 */

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => undefined),
  sendPushToAgents: vi.fn(async () => undefined),
}));

const { prisma } = await import("../src/db.js");
const { createLeadFromChannel } = await import("../src/services/leads/intake.js");
const { assignPendingLeads } = await import("../src/services/leads/reassignment.js");
const { findMatchingPropertiesForClient } = await import("../src/routes/matching.js");
const { assignAgentForLead } = await import("../src/services/leads/assignment.js");
const { resolveBotPropertyMention, mentionsSeenListing, placePhrases } = await import("../src/lib/botPropertyMention.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
/** Метка в начале слова: соседние файлы с «Бодомзором» не совпадут (см. property-identify.test.ts). */
const tag = String(runId)
  .slice(-8)
  .split("")
  .reverse()
  .map((d) => "бвгдзклмнр"[Number(d)])
  .join("");

let ownerId: string;
let districtId: string;
const propertyIds: string[] = [];
const clientIds: string[] = [];
let savedStrategy: string | null = null;

async function makeProperty(data: Record<string, unknown>) {
  const p = await prisma.property.create({
    data: {
      title: `Объект раздачи ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: 400000,
      currency: "TJS",
      condition: "GOOD",
      status: "AVAILABLE",
      publishedOnSite: true,
      intakeAgentId: ownerId,
      ownerContact: `+99291${tail}${propertyIds.length}`,
      ...data,
    } as never,
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  ownerId = await createTestAgent(`Хозяин объекта ${runId}`);
  districtId = (await prisma.district.create({ data: { name: `Район раздачи ${runId}` } })).id;
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { leadDistributionStrategy: true } });
  savedStrategy = settings?.leadDistributionStrategy ?? null;
  if (savedStrategy === "manual") {
    await prisma.settings.update({ where: { id: "singleton" }, data: { leadDistributionStrategy: "fair" } });
  }
});

afterAll(async () => {
  if (savedStrategy === "manual") {
    await prisma.settings.update({ where: { id: "singleton" }, data: { leadDistributionStrategy: "manual" } });
  }
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await deleteAgentsWithTraces([ownerId]);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("объект, названный клиентом, доходит до раздачи", () => {
  it("ночью заявка со страницы объекта ждёт утра — утренняя волна отдаёт её агенту объекта (п.5)", async () => {
    const property = await makeProperty({ price: 401234 });
    const { clientId } = await createLeadFromChannel({
      fullName: `Ночной клиент ${runId}`,
      phone: `+99270${tail}`,
      source: "WEBSITE",
      kind: "BUYER",
      propertyId: property.id,
      deferAssignment: true,
    });
    clientIds.push(clientId);
    const night = await prisma.client.findUniqueOrThrow({
      where: { id: clientId },
      select: { assignedAgentId: true, requestedPropertyId: true },
    });
    expect(night.assignedAgentId).toBeNull();
    expect(night.requestedPropertyId).toBe(property.id);

    await assignPendingLeads();
    const morning = await prisma.client.findUniqueOrThrow({
      where: { id: clientId },
      select: { assignedAgentId: true, assignReason: true, matchedPropertyId: true },
    });
    expect(morning.assignedAgentId).toBe(ownerId);
    expect(morning.assignReason).toBe("own_property_explicit");
    expect(morning.matchedPropertyId).toBe(property.id);
  });

  it("запрос звонка, ещё не записанный в карточку, виден подбору; продавцу подбор по описанию не отдаёт (п.6)", async () => {
    const property = await makeProperty({ price: 402345, rooms: 2, districtId });
    const client = await prisma.client.create({
      data: { fullName: `Звонящий ${runId}`, phone: `+99271${tail}`, source: "PHONE_CALL", kind: "BUYER", currency: "TJS" },
    });
    clientIds.push(client.id);
    const requirements = { desiredDistrictId: districtId, desiredRooms: 2, budgetMax: 402345 };

    // Карточка пустая: без запроса звонка подбор объекта в этом районе не видит.
    const bare = await findMatchingPropertiesForClient(client.id);
    const withCall = await findMatchingPropertiesForClient(client.id, { requirements });
    const scoreOf = (list: { propertyId: string; score: number }[]) => list.find((m) => m.propertyId === property.id)?.score ?? 0;
    expect(scoreOf(withCall)).toBeGreaterThan(scoreOf(bare));
    expect(scoreOf(withCall)).toBeGreaterThanOrEqual(90);

    const buyer = await assignAgentForLead({ clientId: client.id, kind: "BUYER", requirements });
    expect(buyer.reason).toBe("own_property_match");
    expect(buyer.agentId).toBe(ownerId);

    const seller = await assignAgentForLead({ clientId: client.id, kind: "SELLER", requirements });
    expect(seller.reason).not.toBe("own_property_match");
  });

  it("подбор для раздачи учитывает тип: покупателю дома квартира не подходит, без типа — любой (п.8)", async () => {
    const flat = await makeProperty({ price: 403456, rooms: 3, districtId, type: "APARTMENT" });
    const house = await makeProperty({ price: 403456, rooms: 3, districtId, type: "HOUSE" });
    const client = await prisma.client.create({
      data: {
        fullName: `Ищет дом ${runId}`,
        phone: `+99272${tail}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        currency: "TJS",
        desiredDistrictId: districtId,
        desiredRooms: 3,
        budgetMax: 403456,
        desiredType: "HOUSE",
      },
    });
    clientIds.push(client.id);
    const ids = (await findMatchingPropertiesForClient(client.id)).map((m) => m.propertyId);
    expect(ids).toContain(house.id);
    expect(ids).not.toContain(flat.id);

    const any = (await findMatchingPropertiesForClient(client.id, { requirements: { desiredType: null } })).map((m) => m.propertyId);
    // null в запросе не перекрывает карточку — тип остаётся «дом».
    expect(any).not.toContain(flat.id);
    await prisma.client.update({ where: { id: client.id }, data: { desiredType: null } });
    const untyped = (await findMatchingPropertiesForClient(client.id)).map((m) => m.propertyId);
    expect(untyped).toEqual(expect.arrayContaining([flat.id, house.id]));
  });

  it("чат: «видел у вас квартиру у <ориентира> за …» узнаёт объявление, желание без слов про объявление — нет (п.7)", async () => {
    const place = `${tag}бодомзор`;
    const property = await makeProperty({ price: 300000, landmark: `Бог ${place}`, rooms: 2, districtId });

    expect(mentionsSeenListing("видел у вас двушку, сколько стоит?")).toBe(true);
    expect(mentionsSeenListing("ищу двушку до 300")).toBe(false);
    expect(placePhrases(`видел квартиру у ${place}а за 300 000`)).toContain(place);

    const seen = await resolveBotPropertyMention(`Здравствуйте, видел у вас квартиру у ${place}а, ещё продаётся?`, {
      budgetMax: 300000,
      rooms: 2,
    });
    expect(seen).toBe(property.id);

    const wish = await resolveBotPropertyMention(`Ищу двушку у ${place}а до 300 000`, { budgetMax: 300000, rooms: 2 });
    expect(wish).toBeNull();

    // Номер объекта — как раньше, без повода «видел».
    expect(await resolveBotPropertyMention(`объект №${property.shortId}`, {})).toBe(property.id);
  });
});
