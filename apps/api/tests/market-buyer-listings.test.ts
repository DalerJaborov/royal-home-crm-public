import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { loadMoneyContext, toTjs } from "../src/lib/money.js";
import { buyerDistance, rankBuyerListings, type BuyerRow, type BuyerWants } from "../src/lib/market/buyerMatch.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * GET /api/v1/clients/:id/market-listings — секция «С площадок (Somon/Paydo)» подбора покупателя
 * (10.11.2026). Что проверяем: попадание под район/комнаты, бюджет в валюте клиента (USD → сомони
 * общим курсом), исключение объявлений, признанных НАШИМИ объектами (CONFIRMED/CANDIDATE; DISMISSED —
 * чужое), склейку дублей между площадками, предел 10 и те же гейты, что у /match.
 */

const runId = `${Date.now()}`.slice(-8);
const password = "testpass123";
const DISTRICT = `Тест-площадки-${runId}`;
const agentIds: string[] = [];
const clientIds: string[] = [];
const listingIds: string[] = [];
const propertyIds: string[] = [];
let districtId: string;
let agentToken: string;
let otherToken: string;
let buyerId: string;
let ceilingTjs: number;
const ids: Record<string, string> = {};

async function makeListing(key: string, over: Record<string, unknown> = {}) {
  const priceTjs = (over.priceTjs as number | undefined) ?? 400_000;
  const areaSqm = (over.areaSqm as number | undefined) ?? 60;
  const { priceTjs: _p, areaSqm: _a, ...rest } = over;
  void _p;
  void _a;
  const l = await prisma.marketListing.create({
    data: {
      source: "somon.tj",
      sourceId: `${runId}-${key}`,
      sourceUrl: `https://somon.tj/adv/${runId}-${key}`,
      dealType: "SALE",
      propertyType: "APARTMENT",
      city: "Душанбе",
      districtName: DISTRICT,
      rooms: 2,
      areaSqm,
      price: priceTjs,
      currency: "TJS",
      priceTjs,
      pricePerSqmTjs: Math.round(priceTjs / areaSqm),
      title: `Объявление ${key}`,
      isActive: true,
      lastSeenAt: new Date(),
      raw: {},
      ...rest,
    },
  });
  listingIds.push(l.id);
  ids[key] = l.id;
  return l;
}

const get = (id: string, token = agentToken, qs = "") =>
  request(app).get(`/api/v1/clients/${id}/market-listings${qs}`).set("Authorization", `Bearer ${token}`);

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: DISTRICT } })).id;
  const agent = await prisma.agent.create({
    data: { fullName: `Агент площадок ${runId}`, phone: `+992981${runId.slice(-7)}`, role: "AGENT", passwordHash },
  });
  const other = await prisma.agent.create({
    data: { fullName: `Чужой агент ${runId}`, phone: `+992982${runId.slice(-7)}`, role: "AGENT", passwordHash },
  });
  agentIds.push(agent.id, other.id);
  agentToken = (await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password })).body.accessToken;
  otherToken = (await request(app).post("/api/v1/auth/login").send({ phone: other.phone, password })).body.accessToken;

  // Бюджет — в долларах: потолок в сомони считает общий курс, тест берёт его тем же путём.
  ceilingTjs = Math.round(toTjs(50_000, "USD", await loadMoneyContext()));

  const buyer = await prisma.client.create({
    data: {
      fullName: `Покупатель ${runId}`,
      phone: `+992983${runId.slice(-7)}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
      budgetMax: 50_000,
      currency: "USD",
      desiredDistrictId: districtId,
      desiredRooms: 2,
    },
  });
  clientIds.push(buyer.id);
  buyerId = buyer.id;

  await makeListing("inBudget", { priceTjs: ceilingTjs - 20_000, areaSqm: 62 });
  await makeListing("overBudget", { priceTjs: ceilingTjs + 20_000 });
  await makeListing("threeRooms", { rooms: 3, priceTjs: ceilingTjs - 20_000 });
  await makeListing("inactive", { isActive: false, priceTjs: ceilingTjs - 20_000 });
  await makeListing("stale", { lastSeenAt: new Date(Date.now() - 90 * 24 * 3600_000), priceTjs: ceilingTjs - 20_000 });
  await makeListing("ours", { priceTjs: ceilingTjs - 15_000, areaSqm: 70 });
  await makeListing("dismissed", { priceTjs: ceilingTjs - 30_000, areaSqm: 80 });
  // Тот же объект, что inBudget, на второй площадке: разница в площади 1 м², в цене около 3%.
  await makeListing("dupOnPaydo", { source: "paydo.tj", priceTjs: ceilingTjs - 20_000 + 2_000, areaSqm: 63 });

  // Наш объект и объявление, которое признано им: в подбор «с площадок» не попадает.
  const property = await prisma.property.create({
    data: {
      title: `Наш объект ${runId}`, type: "APARTMENT", areaSqm: 70, rooms: 2, price: 300_000, currency: "TJS",
      districtId, address: "Тест", condition: "GOOD", assignedAgentId: agent.id, ownerContact: "+992900000098",
    },
  });
  propertyIds.push(property.id);
  await prisma.propertyMarketMatch.create({ data: { propertyId: property.id, listingId: ids.ours, score: 90, reasons: [], status: "CONFIRMED" } });
  await prisma.propertyMarketMatch.create({ data: { propertyId: property.id, listingId: ids.dismissed, score: 40, reasons: [], status: "DISMISSED" } });
});

afterAll(async () => {
  await prisma.propertyMarketMatch.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.marketListing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("GET /clients/:id/market-listings", () => {
  it("находит подходящие под район, комнаты и бюджет в долларах; наше, дорогое, неактивное и устаревшее — нет", async () => {
    const res = await get(buyerId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.budgetMaxTjs).toBe(ceilingTjs);
    const urls = (res.body.listings as { sourceUrl: string }[]).map((l) => l.sourceUrl);
    expect(urls).toContain(`https://somon.tj/adv/${runId}-inBudget`);
    // «Не наш» (DISMISSED) — это чужое объявление, оно в подборе остаётся.
    expect(urls).toContain(`https://somon.tj/adv/${runId}-dismissed`);
    for (const gone of ["overBudget", "threeRooms", "inactive", "stale", "ours"]) {
      expect(urls, gone).not.toContain(`https://somon.tj/adv/${runId}-${gone}`);
    }
    for (const l of res.body.listings as { priceTjs: number }[]) expect(l.priceTjs).toBeLessThanOrEqual(ceilingTjs);
    expect(res.body.criteria).toEqual(expect.arrayContaining([`район ${DISTRICT}`, "2-комнатные"]));
  });

  it("один объект на двух площадках показан один раз", async () => {
    const res = await get(buyerId);
    const same = (res.body.listings as { sourceUrl: string }[]).filter((l) => /inBudget|dupOnPaydo/.test(l.sourceUrl));
    expect(same).toHaveLength(1);
    expect(res.body.total).toBe(2); // inBudget (с дублем) и dismissed
  });

  it("не отдаёт телефоны и сырые данные, только ссылку и цифры", async () => {
    const res = await get(buyerId);
    for (const l of res.body.listings as Record<string, unknown>[]) {
      expect(l).not.toHaveProperty("sellerPhone");
      expect(l).not.toHaveProperty("raw");
      expect(typeof l.sourceUrl).toBe("string");
    }
  });

  it("предел: limit=1 отдаёт одно, больше десяти и лишние параметры — 400", async () => {
    const one = await get(buyerId, agentToken, "?limit=1");
    expect(one.status).toBe(200);
    expect(one.body.listings).toHaveLength(1);
    expect(one.body.total).toBe(2);
    expect((await get(buyerId, agentToken, "?limit=11")).status).toBe(400);
    expect((await get(buyerId, agentToken, "?limit=0")).status).toBe(400);
    expect((await get(buyerId, agentToken, "?foo=1")).status).toBe(400);
  });

  it("без района и бюджета подбор не выдумывает: no_criteria", async () => {
    const c = await prisma.client.create({
      data: {
        fullName: `Пустой ${runId}`, phone: `+992984${runId.slice(-7)}`, source: "PHONE_CALL", kind: "BUYER",
        assignedAgentId: agentIds[0], acceptedAt: new Date(), desiredRooms: 2,
      },
    });
    clientIds.push(c.id);
    const res = await get(c.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "no_criteria", total: 0, listings: [] });
  });

  it("продавец — not_buyer, непринятый лид — pending_acceptance, чужой агент — 403, неверный id — 400, без входа — 401", async () => {
    const seller = await prisma.client.create({
      data: {
        fullName: `Продавец ${runId}`, phone: `+992985${runId.slice(-7)}`, source: "PHONE_CALL", kind: "SELLER",
        assignedAgentId: agentIds[0], acceptedAt: new Date(), budgetMax: 50_000, desiredDistrictId: districtId,
      },
    });
    const pending = await prisma.client.create({
      data: {
        fullName: `Новый ${runId}`, phone: `+992986${runId.slice(-7)}`, source: "PHONE_CALL", kind: "BUYER",
        assignedAgentId: agentIds[0], assignedAt: new Date(), budgetMax: 50_000, desiredDistrictId: districtId,
      },
    });
    clientIds.push(seller.id, pending.id);
    expect((await get(seller.id)).body.status).toBe("not_buyer");
    const p = await get(pending.id);
    expect(p.body.status).toBe("pending_acceptance");
    expect(p.body.listings).toEqual([]);
    expect((await get(buyerId, otherToken)).status).toBe(403);
    expect((await get("not-a-guid")).status).toBe(400);
    expect((await request(app).get(`/api/v1/clients/${buyerId}/market-listings`)).status).toBe(401);
  });
});

describe("rankBuyerListings (чистая часть)", () => {
  const wants: BuyerWants = {
    districtName: "Сино", city: "Душанбе", rooms: 2, propertyType: "APARTMENT", areaMin: null,
    budgetMinTjs: 400_000, budgetMaxTjs: 600_000,
  };
  const row = (over: Partial<BuyerRow>): BuyerRow => ({
    source: "somon.tj", sourceUrl: "u", title: "t", priceTjs: 500_000, pricePerSqmTjs: 8000, areaSqm: 60, rooms: 2, floor: 3,
    totalFloors: 9, districtName: "Сино", firstSeenAt: new Date("2026-11-01"), publishedAt: null, ...over,
  });

  it("ближе к середине бюджета — выше; без даты публикации берётся firstSeenAt", () => {
    const { listings } = rankBuyerListings([row({ sourceUrl: "far", priceTjs: 410_000 }), row({ sourceUrl: "mid", priceTjs: 500_000 })], wants, 10);
    expect(listings.map((l) => l.sourceUrl)).toEqual(["mid", "far"]);
    expect(listings[0].publishedAt).toBe("2026-11-01T00:00:00.000Z");
    expect(buyerDistance(row({ priceTjs: 500_000 }), wants)).toBe(0);
  });

  it("предел применяется после склейки дублей, total — число уникальных", () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      row({ sourceUrl: `u${i}`, priceTjs: 450_000 + i * 5_000, areaSqm: 40 + i * 5 })
    );
    const res = rankBuyerListings(rows, wants, 10);
    expect(res.listings).toHaveLength(10);
    expect(res.total).toBe(15);
  });
});
