import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { loadMoneyContext, toTjs } from "../src/lib/money.js";

/**
 * GET /api/v1/market/property/:id — блок «Рынок» карточки объекта. Подбор и порог проверены
 * чистыми тестами (market-similar-comps); здесь контракт маршрута: права, перевод валюты по
 * курсу, ремонт/признак дома из объекта, исключение наших объявлений, все четыре вердикта.
 * Старый GET /market/estimate удалён (второе место вердикта против правила «одна дверь»).
 */

const runId = Date.now().toString().slice(-9);
const password = "testpass123";
const DISTRICT_NAME = `Тест-рынок-${runId}`;
/** MIN_SAMPLE = 8 — заводим 10 с запасом. */
const SAMPLE_SIZE = 10;
/** Середина рынка: цены за м² 10 000…10 900, медиана 10 450 × 75 м² = 783 750. */
const MARKET_TJS = 783_750;

let agentId: string;
let districtId: string;
let token: string;
const propertyIds: string[] = [];
const listingIds: string[] = [];

const baseProperty = () => ({
  areaSqm: 75,
  price: 900000,
  currency: "TJS" as const,
  districtId,
  address: "Тестовая, 1",
  condition: "GOOD" as const,
  assignedAgentId: agentId,
  ownerContact: "+992900000097",
});

async function makeProperty(key: string, over: Record<string, unknown> = {}): Promise<string> {
  const p = await prisma.property.create({
    data: { ...baseProperty(), title: `Рынок-${key}-${runId}`, type: "APARTMENT", rooms: 3, ...over },
  });
  propertyIds.push(p.id);
  return p.id;
}

const get = (id: string, auth = true) => {
  const r = request(app).get(`/api/v1/market/property/${id}`);
  return auth ? r.set("Authorization", `Bearer ${token}`) : r;
};

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: "Агент рыночной оценки", phone: `+992970${runId}`, role: "ADMIN", passwordHash },
  });
  agentId = agent.id;
  districtId = (await prisma.district.create({ data: { name: DISTRICT_NAME } })).id;

  for (let i = 0; i < SAMPLE_SIZE; i++) {
    const pricePerSqm = 10000 + i * 100;
    const areaSqm = 70 + i;
    const priceTjs = pricePerSqm * areaSqm;
    const listing = await prisma.marketListing.create({
      data: {
        source: "test-source",
        sourceId: `${runId}-${i}`,
        sourceUrl: `https://example.tj/listing/${runId}-${i}`,
        dealType: "SALE",
        propertyType: "APARTMENT",
        city: "Душанбе",
        districtName: DISTRICT_NAME,
        rooms: 3,
        areaSqm,
        price: priceTjs,
        currency: "TJS",
        priceTjs,
        pricePerSqmTjs: pricePerSqm,
        title: `Тестовая квартира ${i}`,
        isAgency: false,
        negotiable: false,
        photoCount: 0,
        isActive: true,
        lastSeenAt: new Date(),
        raw: {},
      },
    });
    listingIds.push(listing.id);
  }

  const res = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.marketListing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("GET /market/estimate удалён", () => {
  it("старый маршрут больше не отвечает оценкой", async () => {
    const res = await request(app)
      .get(`/api/v1/market/estimate?districtName=${encodeURIComponent(DISTRICT_NAME)}&rooms=3`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /market/property/:id", () => {
  it("без авторизации — 401", async () => {
    const id = await makeProperty("auth");
    const res = await get(id, false);
    expect([401, 403]).toContain(res.status);
  });

  it("квартира: середина рынка, вилка, вердикт и не больше пяти похожих", async () => {
    const id = await makeProperty("main");
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.sampleSize).toBe(SAMPLE_SIZE);
    expect(res.body.mergedDuplicates).toBe(0);
    expect(res.body.listings.length).toBeLessThanOrEqual(5);
    expect(res.body.moreCount).toBe(SAMPLE_SIZE - 5);
    expect(res.body.rangeLowTjs).toBeLessThanOrEqual(res.body.estimatedPriceTjs);
    expect(res.body.estimatedPriceTjs).toBe(MARKET_TJS);
    expect(res.body.subject.askingPriceTjs).toBe(900000);
    // 900 000 при 783 750 → +14,8% → «выше»
    expect(res.body.comparison).toEqual({ verdict: "above", diffPercent: 15 });
  });

  it("все четыре вердикта — точные значения", async () => {
    const below = await get(await makeProperty("below", { price: 600000 }));
    expect(below.body.comparison).toEqual({ verdict: "below", diffPercent: -23 });
    const market = await get(await makeProperty("market", { price: 800000 }));
    expect(market.body.comparison).toEqual({ verdict: "market", diffPercent: 2 });
    const above = await get(await makeProperty("above", { price: 900000 }));
    expect(above.body.comparison).toEqual({ verdict: "above", diffPercent: 15 });
    // цена 0 — нечего сравнивать
    const unknown = await get(await makeProperty("unknown", { price: 0 }));
    expect(unknown.status).toBe(200);
    expect(unknown.body.comparison).toEqual({ verdict: "unknown", diffPercent: null });
  });

  it("объект в долларах: цена переводится в сомони по курсу из Настроек", async () => {
    const ctx = await loadMoneyContext();
    const usd = Math.round(800000 / ctx.usdToTjs);
    const res = await get(await makeProperty("usd", { price: usd, currency: "USD" }));
    expect(res.status).toBe(200);
    expect(res.body.subject.askingPriceTjs).toBe(Math.round(toTjs(usd, "USD", ctx)));
    // без перевода 70 000 «сомони» дали бы «ниже»; по курсу цена ≈ 800 000 → в рынке
    expect(res.body.comparison.verdict).toBe("market");
  });

  it("«новостройка» в состоянии — признак дома, а не ремонт", async () => {
    const res = await get(await makeProperty("newb", { condition: "NEW_BUILDING" }));
    expect(res.status).toBe(200);
    expect(res.body.subject.repair).toBeNull();
    expect(res.body.subject.isNewBuilding).toBe(true);
    // и явный тип рынка главнее состояния
    const secondary = await get(await makeProperty("sec", { condition: "NEW_BUILDING", marketType: "SECONDARY" }));
    expect(secondary.body.subject.isNewBuilding).toBe(false);
    // остальные состояния переводятся в ремонт как раньше
    const repairs = await Promise.all(
      (["NEEDS_REPAIR", "GOOD", "EXCELLENT"] as const).map(async (c) => (await get(await makeProperty(`c-${c}`, { condition: c }))).body.subject.repair)
    );
    expect(repairs).toEqual(["SHELL", "PARTIAL", "RENOVATED"]);
  });

  it("объявление, найденное как наш объект (CANDIDATE/CONFIRMED), из выборки исключается", async () => {
    const id = await makeProperty("own");
    const match = await prisma.propertyMarketMatch.create({
      data: { propertyId: id, listingId: listingIds[0], score: 90, reasons: [], status: "CONFIRMED" },
    });
    try {
      const res = await get(id);
      expect(res.body.sampleSize).toBe(SAMPLE_SIZE - 1);
      expect(res.body.listings.some((l: { sourceUrl: string }) => l.sourceUrl.endsWith(`${runId}-0`))).toBe(false);
      await prisma.propertyMarketMatch.update({ where: { id: match.id }, data: { status: "DISMISSED" } });
      expect((await get(id)).body.sampleSize).toBe(SAMPLE_SIZE);
    } finally {
      await prisma.propertyMarketMatch.deleteMany({ where: { id: match.id } });
    }
  });

  it("участок — unsupported, без числа", async () => {
    const res = await get(await makeProperty("land", { type: "LAND", rooms: null }));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("unsupported");
    expect(res.body.medianPerSqm).toBeNull();
  });

  it("несуществующий объект — 404", async () => {
    const res = await get("00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
  });

  it("удалённый объект: без archive.view — 404", async () => {
    const agent = await prisma.agent.create({
      data: { fullName: "Агент без архива", phone: `+992973${runId}`, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) },
    });
    const deleted = await makeProperty("deleted", { deletedAt: new Date() });
    try {
      const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
      expect(login.status).toBe(200);
      const res = await request(app).get(`/api/v1/market/property/${deleted}`).set("Authorization", `Bearer ${login.body.accessToken}`);
      expect(res.status).toBe(404);
    } finally {
      await prisma.agent.deleteMany({ where: { id: agent.id } });
    }
  });
});
