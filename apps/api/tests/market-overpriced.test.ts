import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { buildMarketIndex, type SegmentRow } from "../src/lib/market/segments.js";
import { findOverpricedPropertiesCached, OVERPRICED_CACHE_MS, pickOverpriced, resetOverpricedCache, type OverpricedCandidate } from "../src/lib/market/overpriced.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { makeAgent, medianOf, seedMarketListings, segmentListingSpec } from "./helpers/marketFixtures.js";

/**
 * GET /api/v1/market/overpriced — наши объекты в продаже, которые просят дороже рынка (14.11.2026).
 * Проверяем: попадают только AVAILABLE выше порога вердикта, сортировка по отклонению, объект без данных
 * на рынке (меньше порога 8) не попадает и считается «без данных», доступ любому вошедшему, без входа 401.
 */

const runId = `${Date.now()}`.slice(-8);
const DISTRICT = `Тест-дорого-${runId}`;
const DISTRICT_EMPTY = `Тест-пусто-${runId}`;
const agentIds: string[] = [];
const listingIds: string[] = [];
const propertyIds: string[] = [];
const districtIds: string[] = [];
let token: string;
const ids: Record<string, string> = {};

const MEDIAN_PER_SQM = Math.round(medianOf(Array.from({ length: 10 }, (_, i) => segmentListingSpec(i).pricePerSqm)));
const estimate = (area: number) => Math.round(MEDIAN_PER_SQM * area);

async function makeProperty(key: string, over: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Дорого-${key}-${runId}`, type: "APARTMENT", areaSqm: 60, rooms: 2, price: estimate(60), currency: "TJS",
      districtId: districtIds[0], address: "Тест", condition: "GOOD", assignedAgentId: agentIds[0], ownerContact: "+992900000091",
      status: "AVAILABLE", ...over,
    },
  });
  propertyIds.push(p.id);
  ids[key] = p.id;
  return p;
}

const get = (auth = true) => {
  const r = request(app).get("/api/v1/market/overpriced");
  return auth ? r.set("Authorization", `Bearer ${token}`) : r;
};

beforeAll(async () => {
  const agent = await makeAgent(runId, "2");
  agentIds.push(agent.id);
  token = (await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password: "testpass123" })).body.accessToken;
  for (const name of [DISTRICT, DISTRICT_EMPTY]) districtIds.push((await prisma.district.create({ data: { name } })).id);
  listingIds.push(...(await seedMarketListings(runId, DISTRICT, 2, 10)));

  await makeProperty("high", { price: Math.round(estimate(60) * 1.4) });
  await makeProperty("higher", { price: Math.round(estimate(60) * 1.8) });
  await makeProperty("inMarket", { price: Math.round(estimate(60) * 1.05) });
  await makeProperty("cheap", { price: Math.round(estimate(60) * 0.7) });
  await makeProperty("sold", { price: Math.round(estimate(60) * 2), status: "SOLD" });
  await makeProperty("noData", { price: 2_000_000, districtId: districtIds[1] });
  await makeProperty("threeRooms", { price: 2_000_000, rooms: 3 });
  resetOverpricedCache();
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.marketListing.deleteMany({ where: { id: { in: listingIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.district.deleteMany({ where: { id: { in: districtIds } } });
});

describe("GET /market/overpriced", () => {
  it("отдаёт только объекты в продаже выше порога, самые завышенные первыми, с основанием", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const ours = (res.body.items as Array<{ propertyId: string; diffPercent: number; estimatedPriceTjs: number; sampleSize: number; basis: string }>).filter((i) =>
      propertyIds.includes(i.propertyId)
    );
    expect(ours.map((i) => i.propertyId)).toEqual([ids.higher, ids.high]);
    expect(ours[0].diffPercent).toBe(80);
    expect(ours[1].diffPercent).toBe(40);
    expect(ours[0].estimatedPriceTjs).toBe(estimate(60));
    expect(ours[0].sampleSize).toBe(10);
    expect(ours[0].basis).toContain(DISTRICT);
    expect(res.body).toMatchObject({ minSample: 8, thresholdPercent: 10 });
  });

  it("в рынке, дешевле рынка и проданные в список не попадают; объект без данных рынка не показывает чисел", async () => {
    const res = await get();
    const found = new Set((res.body.items as Array<{ propertyId: string }>).map((i) => i.propertyId));
    for (const key of ["inMarket", "cheap", "sold", "noData", "threeRooms"]) expect(found.has(ids[key]), key).toBe(false);
    // noData и threeRooms: сегмента с достаточной выборкой нет, это не «в рынке», а «без данных».
    expect(res.body.withoutData).toBeGreaterThanOrEqual(2);
    expect(res.body.checked).toBeGreaterThanOrEqual(6);
  });

  it("без входа 401", async () => {
    expect((await get(false)).status).toBe(401);
  });
});

describe("кэш списка на сервере (10 минут)", () => {
  it("второй запрос в пределах срока отдаёт тот же ответ, не пересчитывая; после срока или сброса считает заново", async () => {
    resetOverpricedCache();
    const t0 = Date.now();
    const first = await findOverpricedPropertiesCached(t0);
    await makeProperty("late", { price: Math.round(estimate(60) * 2.5) });
    const again = await findOverpricedPropertiesCached(t0 + OVERPRICED_CACHE_MS - 1000);
    expect(again).toBe(first);
    expect(again.items.some((i) => i.propertyId === ids.late)).toBe(false);
    const after = await findOverpricedPropertiesCached(t0 + OVERPRICED_CACHE_MS + 1000);
    expect(after.items[0].propertyId).toBe(ids.late);
    resetOverpricedCache();
  });
});

describe("pickOverpriced (чистая часть)", () => {
  const row = (i: number): SegmentRow => {
    const s = segmentListingSpec(i);
    return { source: "somon.tj", districtName: "Сино", rooms: 2, repair: null, areaSqm: s.areaSqm, priceTjs: s.priceTjs, pricePerSqmTjs: s.pricePerSqm, floor: s.floor, firstSeenAt: new Date(), lastSeenAt: new Date(), sellerId: null };
  };
  const cand = (over: Partial<OverpricedCandidate>): OverpricedCandidate => ({
    id: "p", shortId: 1, title: "Объект", rooms: 2, areaSqm: 60, askingPriceTjs: 1_000_000, condition: "GOOD", districtName: "Сино", ...over,
  });

  it("порог вердикта: ровно +10% ещё «в рынке», +11% уже в списке; при равном отклонении свежий номер выше", () => {
    const index = buildMarketIndex(Array.from({ length: 10 }, (_, i) => row(i)));
    const base = estimate(60);
    const at10 = pickOverpriced([cand({ askingPriceTjs: Math.round(base * 1.1) })], index);
    expect(at10.items).toHaveLength(0);
    const at11 = pickOverpriced([cand({ askingPriceTjs: Math.round(base * 1.11), shortId: 1 }), cand({ askingPriceTjs: Math.round(base * 1.11), shortId: 2, id: "q" })], index);
    expect(at11.items.map((x) => x.shortId)).toEqual([2, 1]);
    expect(at11.withoutData).toBe(0);
  });

  it("мало объявлений в сегменте — объект «без данных», в список не идёт", () => {
    const index = buildMarketIndex(Array.from({ length: 5 }, (_, i) => row(i)));
    const out = pickOverpriced([cand({ askingPriceTjs: 9_000_000 })], index);
    expect(out.items).toHaveLength(0);
    expect(out.withoutData).toBe(1);
  });
});
