import bcrypt from "bcrypt";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Реальная цена клиента в /ads/board и /ads/property/:id (волна 1 рекламы, 03.10.2026):
 * цепочка объявление → клиент (Client.sourceAdId) → показ → сделка → комиссия, с
 * делением на объекты той же аллокацией, что и деньги, и приколотым клиентом (диалог
 * бота связал его с одним объектом объявления).
 *
 * Деньги и клиенты лежат в марте 2025 — окно, где в общей базе нет чужих данных.
 */

vi.mock("../src/lib/ads/metaAdsApi.js", async (importOriginal) => {
  class MetaAdsTokenError extends Error {}
  return {
    ...(await importOriginal<typeof import("../src/lib/ads/metaAdsApi.js")>()),
    loadMetaAdsCredentials: vi.fn(async () => ({ enabled: false, token: null, adAccountIds: [] })),
    isMetaAdsConfigured: () => false,
    fetchAdAccountDetails: vi.fn(async () => null),
    fetchMetaAds: vi.fn(async () => []),
    fetchMetaAdSets: vi.fn(async () => ({ byId: new Map(), partial: false })),
    fetchMetaAdDailyStats: vi.fn(async () => []),
    fetchAdAccountCurrency: vi.fn(async () => "USD" as const),
    fetchAccountSpendTotal: vi.fn(async () => 0),
    parseAdAccountIds: (raw: string | null) =>
      (raw ?? "").split(/[\s,;]+/).filter(Boolean).map((p) => `act_${p.replace(/\D/g, "")}`),
    MetaAdsTokenError,
  };
});
vi.mock("../src/lib/ads/syncMetaAds.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ads/syncMetaAds.js")>()),
  FULL_SYNC_DAYS: 90,
  syncMetaAds: vi.fn(async () => ({ days: 7, ads: 0, matched: 0, foreign: 0, spendRows: 0 })),
  syncMetaAdsQuietly: vi.fn(async () => null),
}));
vi.mock("../src/messengers/instagramFeed.js", () => ({
  getAllOwnMedia: vi.fn(async () => []),
  getInstagramMedia: vi.fn(async () => []),
  refreshInstagramTokenIfDue: vi.fn(async () => false),
}));
vi.mock("../src/lib/ads/adInsights.js", () => ({
  buildAdInsights: vi.fn(async () => null),
  hasAdData: vi.fn(async () => false),
  _clearInsightsCache: vi.fn(),
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { setAdProperties } = await import("../src/lib/ads/adAllocation.js");
const { loadLeadFacts } = await import("../src/lib/ads/adLeadAttribution.js");
const { centsToTjs, fromCents, loadMoneyContext, toCents } = await import("../src/lib/money.js");

const runId = Date.now();
const password = "testpass123";
const PERIOD = "from=2025-03-01&to=2025-03-31";
const MARCH = new Date("2025-03-15T08:00:00.000Z");

let adminToken = "";
const agentIds: string[] = [];
let districtId = "";
const propertyIds: string[] = [];
const clientIds: string[] = [];
const adIds: string[] = [];
let props: { id: string }[] = [];
let adId = "";
let adExternalId = "";
let expectedSpendTjsCents = 0;

const get = (path: string, token: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);

async function makeClient(i: number, extra: Record<string, unknown> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `Тест-реклама-клиент-${runId}-${i}`,
      phone: `+992975${runId}${i}`,
      source: "INSTAGRAM",
      kind: "BUYER",
      currency: "TJS",
      assignedAgentId: agentIds[0],
      createdAt: MARCH,
      ...extra,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ лиды-реклама", phone: `+992976${runId}`, role: "ADMIN", passwordHash },
  });
  agentIds.push(admin.id);
  const login = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  adminToken = login.body.accessToken;

  districtId = (await prisma.district.create({ data: { name: `Тест-район-лиды-реклама-${runId}` } })).id;
  props = [];
  for (let i = 0; i < 4; i++) {
    const p = await prisma.property.create({
      data: {
        title: `Тест-лиды-реклама-${runId}-${i}`,
        type: "APARTMENT",
        rooms: 2,
        areaSqm: 55,
        price: 45000,
        currency: "USD",
        districtId,
        address: `Лиды-реклама, ${i}`,
        condition: "GOOD",
      },
    });
    propertyIds.push(p.id);
    props.push(p);
  }

  const ad = await prisma.ad.create({
    data: {
      platform: "META",
      externalId: `lead-routes-${runId}`,
      name: `Тест-объявление-лиды ${runId}`,
      adAccountId: "act_lead_routes",
      status: "PAUSED",
      assetCount: 4,
      lastSyncedAt: new Date(),
    },
  });
  adIds.push(ad.id);
  adId = ad.id;
  adExternalId = ad.externalId;
  // Веса 4/3/2/1 — без ничьих, чтобы раскладка не зависела от порядка строк в базе.
  await setAdProperties(
    ad.id,
    props.map((p, i) => ({ propertyId: p.id, weight: 4 - i })),
    "FEED_CAPTION"
  );
  await prisma.adSpendDaily.create({
    data: {
      adId: ad.id,
      date: new Date("2025-03-15T00:00:00.000Z"),
      spend: 100,
      currency: "USD",
      impressions: 1000,
      clicks: 10,
      conversations: 8,
    },
  });
  const money = await loadMoneyContext();
  expectedSpendTjsCents = centsToTjs(toCents(100), "USD", money);

  // Клиент 1: приколот диалогом бота к props[2], дошёл до показа и закрыл сделку.
  const c1 = await makeClient(1, { sourceAdId: adExternalId });
  await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `lead-routes-sub-${runId}`,
      clientId: c1.id,
      adExternalId,
      adPropertyId: props[2].id,
    },
  });
  await prisma.interaction.create({
    data: { clientId: c1.id, propertyId: props[2].id, agentId: admin.id, type: "SHOWING", notes: "Показ", completedAt: MARCH },
  });
  await prisma.deal.create({
    data: {
      clientId: c1.id,
      propertyId: props[2].id,
      agentId: admin.id,
      stage: "COMPLETED",
      currency: "TJS",
      commissionAmount: 1000,
      commissionCompanyAmount: 500,
      closedAt: MARCH,
    },
  });
  // Клиент 2: дошёл до показа.
  const c2 = await makeClient(2, { sourceAdId: adExternalId });
  await prisma.interaction.create({
    data: { clientId: c2.id, propertyId: props[0].id, agentId: admin.id, type: "SHOWING", notes: "Показ", completedAt: MARCH },
  });
  // Клиенты 3 и 4: просто пришли.
  await makeClient(3, { sourceAdId: adExternalId });
  await makeClient(4, { sourceAdId: adExternalId });
  // Не считаются: без объявления; из Корзины; создан в феврале (вне периода доски).
  await makeClient(5);
  await makeClient(6, { sourceAdId: adExternalId, deletedAt: MARCH });
  await makeClient(7, { sourceAdId: adExternalId, createdAt: new Date("2025-02-10T08:00:00.000Z") });
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.botConversation.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.adSpendDaily.deleteMany({ where: { adId: { in: adIds } } });
  await prisma.ad.deleteMany({ where: { id: { in: adIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.$disconnect();
});

describe("loadLeadFacts", () => {
  it("берёт клиентов периода по sourceAdId: без объявления, из Корзины и вне периода не попадают", async () => {
    const { facts, truncated } = await loadLeadFacts(
      [adExternalId],
      { start: new Date("2025-03-01T00:00:00.000Z"), end: new Date("2025-04-01T00:00:00.000Z") }
    );
    expect(truncated).toBe(false);
    expect(facts).toHaveLength(4);
    expect(facts.filter((f) => f.showed)).toHaveLength(2);
    const pinned = facts.filter((f) => f.pinnedPropertyId);
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatchObject({ pinnedPropertyId: props[2].id, deals: 1, commissionCents: 500_00 });
  });

  it("за всё время клиент февраля тоже виден (когорта без границ)", async () => {
    const { facts } = await loadLeadFacts([adExternalId], { start: null, end: null });
    expect(facts).toHaveLength(5);
  });

  it("отменённый показ не засчитывается как «дошёл»", async () => {
    const c = await makeClient(8, { sourceAdId: adExternalId, createdAt: new Date("2025-03-20T08:00:00.000Z") });
    await prisma.interaction.create({
      data: {
        clientId: c.id,
        propertyId: props[0].id,
        agentId: agentIds[0],
        type: "SHOWING",
        notes: "Показ отменён",
        // Отмена по проекту — nextAction снят и declinedAt проставлен вместе.
        nextAction: null,
        declinedAt: new Date("2025-03-20T09:00:00.000Z"),
      },
    });
    const { facts } = await loadLeadFacts(
      [adExternalId],
      { start: new Date("2025-03-01T00:00:00.000Z"), end: new Date("2025-04-01T00:00:00.000Z") }
    );
    expect(facts).toHaveLength(5);
    expect(facts.filter((f) => f.showed)).toHaveLength(2);
  });
});

describe("GET /ads/board", () => {
  it("строка объявления несёт клиентов, показы, сделку, комиссию и цену клиента рядом с ценой обращения Meta", async () => {
    const res = await get(`/api/v1/ads/board?${PERIOD}`, adminToken);
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { id: string }) => r.id === adId);
    expect(row).toBeTruthy();

    // Клиент 8 (отменённый показ) тоже создан в марте: клиентов 5, дошли до показа 2.
    const s = row.leadStats;
    expect(s.leads).toBe(5);
    expect(s.showings).toBe(2);
    expect(s.deals).toBe(1);
    expect(s.commissionTjs).toBe(500);
    expect(s.costPerLeadTjs).toBe(fromCents(Math.round(expectedSpendTjsCents / 5)));
    expect(s.costPerShowingTjs).toBe(fromCents(Math.round(expectedSpendTjsCents / 2)));
    // По версии Meta обращений 8, а клиентов в CRM 5 — цена клиента выше цены обращения.
    expect(s.costPerLeadMeta).toBe(fromCents(Math.round(expectedSpendTjsCents / 8)));
    expect(s.costPerLeadTjs).toBeGreaterThan(s.costPerLeadMeta);

    // Объекты: клиенты делятся теми же весами 4/3/2/1, а приколотый уходит p2 целиком.
    const byId = new Map<string, { leadStats: { leads: number; deals: number; commissionTjs: number } }>(
      row.properties.map((p: { id: string; leadStats: { leads: number; deals: number; commissionTjs: number } }) => [p.id, p])
    );
    expect(Array.from(byId.values()).reduce((a, p) => a + p.leadStats.leads, 0)).toBe(5);
    expect(byId.get(props[2].id)!.leadStats.deals).toBe(1);
    expect(byId.get(props[2].id)!.leadStats.commissionTjs).toBe(500);
    for (const i of [0, 1, 3]) expect(byId.get(props[i].id)!.leadStats.commissionTjs).toBe(0);

    // Итог доски — сумма показанных строк.
    expect(res.body.totals.leadStats.leads).toBeGreaterThanOrEqual(5);
    expect(res.body.leadsTruncated).toBe(false);
  });

  it("поля старого контракта на месте: расход и обращения Meta не изменились", async () => {
    const res = await get(`/api/v1/ads/board?${PERIOD}`, adminToken);
    const row = res.body.rows.find((r: { id: string }) => r.id === adId);
    expect(row.period.conversations).toBe(8);
    expect(row.period.spendTjs).toBe(fromCents(expectedSpendTjsCents));
    const spendByObjects = row.properties.reduce((a: number, p: { spendTjs: number }) => a + toCents(p.spendTjs), 0);
    expect(spendByObjects).toBe(expectedSpendTjsCents);
  });
});

describe("GET /ads/property/:id", () => {
  it("плашка объекта: его доля клиентов и цена клиента за всё время", async () => {
    const res = await get(`/api/v1/ads/property/${props[2].id}`, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.leadStats).toBeTruthy();
    // У p2 приколотый клиент со сделкой — не меньше одного клиента, сделка и комиссия его.
    expect(res.body.leadStats.leads).toBeGreaterThanOrEqual(1);
    expect(res.body.leadStats.deals).toBe(1);
    expect(res.body.leadStats.commissionTjs).toBe(500);
    expect(res.body.leadStats.costPerLeadTjs).toBeGreaterThan(0);
    // Деньги объекта прежние: доля расхода по весу 2 из 10.
    expect(res.body.spendTjs).toBe(fromCents(Math.round(expectedSpendTjsCents * 0.2)));
  });

  it("объект без клиентов: цена клиента null при расходе, а не ноль", async () => {
    const res = await get(`/api/v1/ads/property/${props[3].id}`, adminToken);
    expect(res.status).toBe(200);
    // У p3 вес 1 из 10 — клиентов может достаться ноль или один; при нуле цена обязана быть null.
    if (res.body.leadStats.leads === 0) expect(res.body.leadStats.costPerLeadTjs).toBeNull();
    expect(res.body.spendTjs).toBeGreaterThan(0);
  });
});

describe("ревью 03.10.2026: сделки по объекту сделки (п. 6) и дробные клиенты (п. 7)", () => {
  it("комиссия сделки по ДРУГОМУ объекту не уходит в окупаемость объекта объявления, но входит в итог объявления", async () => {
    const outsider = await prisma.property.create({
      data: {
        title: `Тест-лиды-реклама-чужой-${runId}`,
        type: "APARTMENT",
        rooms: 2,
        areaSqm: 55,
        price: 45000,
        currency: "USD",
        districtId,
        address: `Лиды-реклама-чужой, ${runId}`,
        condition: "GOOD",
      },
    });
    propertyIds.push(outsider.id);
    // Клиент пришёл с объявления про props[0..3], а купил объект вне объявления.
    const buyer = await makeClient(9, { sourceAdId: adExternalId, createdAt: new Date("2025-03-18T08:00:00.000Z") });
    await prisma.deal.create({
      data: {
        clientId: buyer.id,
        propertyId: outsider.id,
        agentId: agentIds[0],
        stage: "COMPLETED",
        currency: "TJS",
        commissionAmount: 1400,
        commissionCompanyAmount: 700,
        closedAt: MARCH,
      },
    });

    const res = await get(`/api/v1/ads/board?${PERIOD}`, adminToken);
    const row = res.body.rows.find((r: { id: string }) => r.id === adId);
    // Итог объявления — всё, что принесли его клиенты: 500 (p2) + 700 (сделка вне объявления).
    expect(row.leadStats.deals).toBe(2);
    expect(row.leadStats.commissionTjs).toBe(1200);
    // Разбивка по объектам: 700 не осело ни на одном; у p2 по-прежнему только его 500.
    const commissions = row.properties.map((p: { id: string; leadStats: { commissionTjs: number } }) => [p.id, p.leadStats.commissionTjs]);
    expect(Object.fromEntries(commissions)[props[2].id]).toBe(500);
    for (const i of [0, 1, 3]) expect(Object.fromEntries(commissions)[props[i].id]).toBe(0);
    expect(commissions.reduce((a: number, [, v]: [string, number]) => a + v, 0)).toBe(500);
  });

  it("клиенты общего объявления в разбивке — доли с двумя знаками; последний объект не остаётся с «клиентов нет»", async () => {
    const res = await get(`/api/v1/ads/board?${PERIOD}`, adminToken);
    const row = res.body.rows.find((r: { id: string }) => r.id === adId);
    const shares = row.properties.map((p: { leadStats: { leads: number; leadsAreShares?: boolean } }) => p.leadStats);
    expect(shares.every((s: { leadsAreShares?: boolean }) => s.leadsAreShares === true)).toBe(true);
    // Вес 1 из 10 у p3: из «общей кучи» ему достаётся доля клиента, а не ноль.
    const p3 = row.properties.find((p: { id: string }) => p.id === props[3].id).leadStats;
    expect(p3.leads).toBeGreaterThan(0);
    expect(p3.costPerLeadTjs).toBeGreaterThan(0);
    for (const s of shares) expect(Math.round(s.leads * 100) / 100).toBe(s.leads);
    // Итог объявления не изменился и остаётся целым числом клиентов.
    const sum = shares.reduce((a: number, s: { leads: number }) => a + s.leads, 0);
    expect(Math.round(sum * 100) / 100).toBe(row.leadStats.leads);
    expect(Number.isInteger(row.leadStats.leads)).toBe(true);
    expect(row.leadStats.leadsAreShares).toBeUndefined();
  });
});
