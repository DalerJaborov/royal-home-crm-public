import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ЕДИНАЯ ПОЛИТИКА ПОДБОРА (17.09.2026, docs/match-policy-plan-17-09.md).
 *
 * Проверяет lib/matchPolicy.ts и то, как Настройки реально двигают три
 * потребителя (автоподбор, счётчик спроса, список «Кому подойдёт»), а не
 * только то, что loadMatchPolicy читает нужные колонки.
 */
vi.mock("../src/lib/propertyAutoStatus.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, refreshPropertiesOfSeller: vi.fn(async () => 0) };
});

const { prisma } = await import("../src/db.js");
const { notifyWaitingBuyersOfNewProperty } = await import("../src/lib/propertyMatchFilter.js");
const { computeDemandCounts, findMatchingClients } = await import("../src/routes/matching.js");
const { refreshPropertiesOfSeller } = await import("../src/lib/propertyAutoStatus.js");
const { checkExplicitRefusal } = await import("../src/lib/explicitRefusalDetector.js");

const runId = Date.now();
let districtId: string;
let agentId: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];

/** Умолчания политики (schema.prisma) — восстанавливаются после каждого теста,
 *  чтобы правка одного теста не протекла в следующий (тот же приём, что и в
 *  matching-score.test.ts::afterEach). */
const DEFAULTS = {
  autoMatchEnabled: true,
  matchIncludeInactive: true,
  matchIncludeDeferred: true,
  matchNotifyPropertyOwner: true,
  matchRequirementTtlDays: 60,
  matchPriceDropRenotifyPct: 5,
  matchBudgetTolerancePct: 10,
  matchAreaTolerancePct: 10,
  matchRoomsTolerance: 1,
  matchDefaultRadiusM: 1500,
  matchRadiusMaxMultiplier: 3,
  matchMinCandidates: 3,
};

afterEach(async () => {
  await prisma.settings.upsert({ where: { id: "singleton" }, update: DEFAULTS, create: { id: "singleton", ...DEFAULTS } });
});

async function makeClient(data: Record<string, unknown>) {
  const c = await prisma.client.create({
    data: {
      fullName: `Политика подбора-${clientIds.length}-${runId}`,
      phone: `+9929${runId.toString().slice(-8)}${clientIds.length}`,
      status: "NEW",
      kind: "BUYER",
      source: "WEBSITE",
      assignedAgentId: agentId,
      desiredDistrictId: districtId,
      desiredRooms: 3,
      currency: "TJS",
      ...data,
    } as never,
  });
  clientIds.push(c.id);
  return c;
}

async function makeProperty(data: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Объект политики подбора ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 60,
      rooms: 3,
      price: 400000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "AVAILABLE",
      ...data,
    } as never,
  });
  propertyIds.push(p.id);
  return p;
}

async function autoMatchInteractions(propertyId: string) {
  return prisma.interaction.findMany({ where: { propertyId, clientId: { in: clientIds }, type: "SYSTEM" } });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Политика-подбора-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент политики подбора ${runId}`, phone: `+992949${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Общий рубильник autoMatchEnabled", () => {
  it("выключен — notifyWaitingBuyersOfNewProperty не пишет запись", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { autoMatchEnabled: false } });
    const property = await makeProperty();
    const client = await makeClient({ budgetMax: 450000 });

    await notifyWaitingBuyersOfNewProperty(property);

    const rows = await autoMatchInteractions(property.id);
    expect(rows.map((r) => r.clientId)).not.toContain(client.id);
  });
});

describe("Срок жизни пожелания (matchRequirementTtlDays)", () => {
  it("молчавший 61 день не в выборке при TTL 60, в выборке при TTL 0", async () => {
    const property = await makeProperty();
    const stale = await makeClient({
      budgetMax: 450000,
      lastContactAt: new Date(Date.now() - 61 * 24 * 60 * 60 * 1000),
    });

    await notifyWaitingBuyersOfNewProperty(property);
    expect((await autoMatchInteractions(property.id)).map((r) => r.clientId)).not.toContain(stale.id);

    await prisma.settings.update({ where: { id: "singleton" }, data: { matchRequirementTtlDays: 0 } });
    await notifyWaitingBuyersOfNewProperty(property);
    expect((await autoMatchInteractions(property.id)).map((r) => r.clientId)).toContain(stale.id);
  });

  it("DEFERRED в выборке всегда, независимо от срока молчания", async () => {
    const property = await makeProperty();
    const deferred = await makeClient({
      budgetMax: 450000,
      workStatus: "DEFERRED",
      lastContactAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
    });

    await notifyWaitingBuyersOfNewProperty(property);
    expect((await autoMatchInteractions(property.id)).map((r) => r.clientId)).toContain(deferred.id);
  });
});

describe("matchIncludeInactive", () => {
  it("false — workStatus=INACTIVE не в выборке findMatchingClients", async () => {
    const property = await makeProperty();
    const inactive = await makeClient({ budgetMax: 450000, workStatus: "INACTIVE" });

    await prisma.settings.update({ where: { id: "singleton" }, data: { matchIncludeInactive: false } });
    const { items } = await findMatchingClients(property.id, 300);
    expect(items.map((m) => m.id)).not.toContain(inactive.id);

    // По умолчанию (true) он же виден — доказывает, что дело именно в настройке.
    await prisma.settings.update({ where: { id: "singleton" }, data: { matchIncludeInactive: true } });
    const { items: withInactive } = await findMatchingClients(property.id, 300);
    expect(withInactive.map((m) => m.id)).toContain(inactive.id);
  });
});

describe("Допуск бюджета (matchBudgetTolerancePct)", () => {
  it("20% пропускает объект на 15% дороже бюджета, 10% (умолчание) — нет", async () => {
    // Бюджет 100 000, объект на 15% дороже — 115 000.
    const property = await makeProperty({ price: 115000 });
    const client = await makeClient({ budgetMax: 100000, budgetMin: null });

    const { items: withDefault } = await findMatchingClients(property.id, 300);
    expect(withDefault.map((m) => m.id)).not.toContain(client.id);

    await prisma.settings.update({ where: { id: "singleton" }, data: { matchBudgetTolerancePct: 20 } });
    const { items: withWiderTolerance } = await findMatchingClients(property.id, 300);
    expect(withWiderTolerance.map((m) => m.id)).toContain(client.id);
  });
});

describe("Одно множество на трёх потребителей", () => {
  it("computeDemandCounts и findMatchingClients().total дают одно число на одном наборе", async () => {
    const property = await makeProperty();
    await makeClient({ budgetMax: 450000 });
    await makeClient({ budgetMax: 450000, workStatus: "INACTIVE" });
    await makeClient({ budgetMax: 450000, workStatus: "DEFERRED" });

    const { total } = await findMatchingClients(property.id, 300);
    const demand = await computeDemandCounts([
      {
        id: property.id,
        price: property.price,
        currency: property.currency,
        districtId: property.districtId,
        rooms: property.rooms,
        areaSqm: property.areaSqm,
        floor: property.floor,
        totalFloors: property.totalFloors,
        lat: property.lat,
        lng: property.lng,
      },
    ]);
    expect(demand.get(property.id)).toBe(total);
  });
});

describe("Дедуп без парсинга текста", () => {
  it("старая запись только с префиксом (без цены) всё ещё глушит повтор", async () => {
    const property = await makeProperty({ price: 400000 });
    const client = await makeClient({ budgetMax: 450000 });

    // Запись «до 14.09.2026» — прежний формат, matchNotifiedPriceTjs пуст.
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId: agentId,
        type: "SYSTEM",
        propertyId: property.id,
        notes: `Автоподбор: появился подходящий объект №${property.shortId} — для клиента №${client.shortId}`,
        matchNotifiedPriceTjs: null,
      },
    });

    await notifyWaitingBuyersOfNewProperty(property);

    const rows = await autoMatchInteractions(property.id);
    expect(rows.filter((r) => r.clientId === client.id)).toHaveLength(1);
  });

  it("новая запись узнаётся по propertyId + цене, без обращения к тексту", async () => {
    const property = await makeProperty({ price: 400000 });
    const client = await makeClient({ budgetMax: 450000 });

    await notifyWaitingBuyersOfNewProperty(property);
    // Та же цена — дедуп должен сработать по matchNotifiedPriceTjs, не по тексту.
    await notifyWaitingBuyersOfNewProperty(property);

    const rows = await autoMatchInteractions(property.id).then((r) => r.filter((x) => x.clientId === client.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].matchNotifiedPriceTjs).not.toBeNull();
  });
});

describe("Продавец пишет «уже продал» — объект снимается сразу, не ночным кроном", () => {
  it("вызывает refreshPropertiesOfSeller", async () => {
    vi.mocked(refreshPropertiesOfSeller).mockClear();
    const seller = await prisma.client.create({
      data: {
        fullName: `Продавец политики подбора ${runId}`,
        phone: `+992951${runId}`,
        kind: "SELLER",
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    });
    clientIds.push(seller.id);

    await checkExplicitRefusal({ clientId: seller.id, text: "Уже продал квартиру на прошлой неделе" });

    expect(refreshPropertiesOfSeller).toHaveBeenCalledWith(seller.id);
  });
});
