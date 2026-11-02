import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * GET /api/v1/market/estimate — тонкая обвязка над estimateFromComps
 * (apps/api/src/lib/market/comps.ts, логика уже проверена своими тестами).
 * Здесь проверяем только контракт роута: авторизацию, пустой ответ без 500,
 * и что при валидных параметрах приходит медиана и не больше 5 listings.
 */

const runId = Date.now().toString().slice(-9);
const password = "testpass123";
const DISTRICT_NAME = `Тест-рынок-${runId}`;
/** MIN_SAMPLE = 8 в comps.ts — заводим 10 с запасом. */
const SAMPLE_SIZE = 10;

let agentId: string;
let districtId: string;
let propertyId: string;
let landId: string;
let token: string;
const listingIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: "Агент рыночной оценки", phone: `+992970${runId}`, role: "ADMIN", passwordHash },
  });
  agentId = agent.id;

  const district = await prisma.district.create({ data: { name: DISTRICT_NAME } });
  districtId = district.id;
  const baseProperty = {
    areaSqm: 75,
    price: 900000,
    currency: "TJS" as const,
    districtId,
    address: "Тестовая, 1",
    condition: "GOOD" as const,
    assignedAgentId: agentId,
    ownerContact: "+992900000097",
  };
  propertyId = (await prisma.property.create({
    data: { ...baseProperty, title: `Рынок-объект-${runId}`, type: "APARTMENT", rooms: 3 },
  })).id;
  landId = (await prisma.property.create({
    data: { ...baseProperty, title: `Рынок-участок-${runId}`, type: "LAND" },
  })).id;

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
  await prisma.property.deleteMany({ where: { id: { in: [propertyId, landId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("GET /market/estimate", () => {
  it("без авторизации — 401", async () => {
    const res = await request(app).get(`/api/v1/market/estimate?districtName=${encodeURIComponent(DISTRICT_NAME)}`);
    expect([401, 403]).toContain(res.status);
  });

  it("без района/на пустой выборке — пустой ответ без 500", async () => {
    const res = await request(app)
      .get(`/api/v1/market/estimate?districtName=${encodeURIComponent(`Нет-такого-района-${runId}`)}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.medianPerSqm).toBeNull();
    expect(res.body.sampleSize).toBe(0);
    expect(res.body.listings).toEqual([]);
  });

  it("с валидными параметрами — медиана и не больше 5 listings", async () => {
    const res = await request(app)
      .get(`/api/v1/market/estimate?districtName=${encodeURIComponent(DISTRICT_NAME)}&rooms=3`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.medianPerSqm).toBeGreaterThan(0);
    expect(res.body.sampleSize).toBe(SAMPLE_SIZE);
    expect(res.body.listings.length).toBeLessThanOrEqual(5);
    expect(res.body.listings[0].sourceUrl).toContain("example.tj");
  });

  it("с priceTjs — приходит comparison с вердиктом", async () => {
    const res = await request(app)
      .get(
        `/api/v1/market/estimate?districtName=${encodeURIComponent(DISTRICT_NAME)}&rooms=3&areaSqm=75&priceTjs=100000`
      )
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.comparison).not.toBeNull();
    expect(["below", "market", "above", "unknown"]).toContain(res.body.comparison.verdict);
  });

  it("мусор вместо числа отклоняется с 400", async () => {
    const res = await request(app)
      .get(`/api/v1/market/estimate?rooms=not-a-number`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe("GET /market/property/:id", () => {
  it("без авторизации — 401", async () => {
    const res = await request(app).get(`/api/v1/market/property/${propertyId}`);
    expect([401, 403]).toContain(res.status);
  });

  it("квартира: середина рынка, вилка, вердикт и не больше пяти похожих", async () => {
    const res = await request(app).get(`/api/v1/market/property/${propertyId}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.sampleSize).toBe(SAMPLE_SIZE);
    expect(res.body.listings.length).toBeLessThanOrEqual(5);
    expect(res.body.moreCount).toBe(SAMPLE_SIZE - 5);
    expect(res.body.rangeLowTjs).toBeLessThanOrEqual(res.body.estimatedPriceTjs);
    expect(res.body.subject.askingPriceTjs).toBe(900000);
    // 900 000 при ~ 10 450 × 75 = 783 750 → выше рынка больше чем на 10%
    expect(res.body.comparison.verdict).toBe("above");
  });

  it("участок — unsupported, без числа", async () => {
    const res = await request(app).get(`/api/v1/market/property/${landId}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("unsupported");
    expect(res.body.medianPerSqm).toBeNull();
  });

  it("несуществующий объект — 404", async () => {
    const res = await request(app)
      .get(`/api/v1/market/property/00000000-0000-4000-8000-000000000000`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
