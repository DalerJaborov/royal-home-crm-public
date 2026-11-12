import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { catalogRaw } from "./helpers/somonPage.js";
import { MIN_SAMPLE } from "../src/lib/market/comps.js";
import { buildSegments, median, type SegmentRow } from "../src/lib/market/segments.js";
import { MIN_SALE_PRICE_TJS, trimmedMean } from "../src/lib/market/plausible.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * GET /api/v1/market/segments — цены по сегментам (район × комнаты × ремонт), 10.11.2026.
 * Порог MIN_SAMPLE=8 (общий с comps.ts), медиана и среднее за м² и за объект, склейка дублей между
 * площадками, фильтры Zod, права (только вошедший сотрудник).
 */

const runId = `${Date.now()}`.slice(-8);
const DISTRICT = `Тест-сегменты-${runId}`;
const password = "testpass123";
const agentIds: string[] = [];
const listingIds: string[] = [];
let token: string;

async function add(i: number, over: Record<string, unknown> = {}) {
  const areaSqm = (over.areaSqm as number | undefined) ?? 50 + i * 5;
  const perSqm = (over.perSqm as number | undefined) ?? 10_000 + i * 1_000;
  const { perSqm: _p, areaSqm: _a, ...rest } = over;
  void _p;
  void _a;
  const priceTjs = perSqm * areaSqm;
  const l = await prisma.marketListing.create({
    data: {
      source: "somon.tj",
      sourceId: `${runId}-${listingIds.length}`,
      sourceUrl: `https://somon.tj/adv/${runId}-${listingIds.length}`,
      dealType: "SALE",
      propertyType: "APARTMENT",
      city: "Душанбе",
      districtName: DISTRICT,
      rooms: 2,
      repair: "RENOVATED",
      isNewBuilding: false,
      areaSqm,
      price: priceTjs,
      currency: "TJS",
      priceTjs,
      pricePerSqmTjs: perSqm,
      title: `Сегмент ${i}`,
      isActive: true,
      lastSeenAt: new Date(),
      raw: catalogRaw(rest),
      ...rest,
    },
  });
  listingIds.push(l.id);
  return l;
}

const get = (qs: string, auth = true) => {
  const r = request(app).get(`/api/v1/market/segments?${qs}`);
  return auth ? r.set("Authorization", `Bearer ${token}`) : r;
};

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Агент сегментов ${runId}`, phone: `+992987${runId.slice(-7)}`, role: "AGENT", passwordHash },
  });
  agentIds.push(agent.id);
  token = (await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password })).body.accessToken;

  // 2 комнаты, ремонт RENOVATED: ровно MIN_SAMPLE объявлений, цена за м² 10 000…17 000 (шаг 1 000), медиана 13 500.
  for (let i = 0; i < MIN_SAMPLE; i++) await add(i);
  // 2 комнаты, без ремонта в объявлении: на один меньше порога — «Данных мало».
  for (let i = 0; i < MIN_SAMPLE - 1; i++) await add(i, { repair: null, perSqm: 9_000 + i * 100 });
  // 3 комнаты, новостройка: достаточно, но другая выборка (фильтр building=new).
  for (let i = 0; i < MIN_SAMPLE; i++) await add(i, { rooms: 3, isNewBuilding: true, repair: "WHITE", perSqm: 12_000 + i * 100, areaSqm: 80 + i * 3 });
  // Не должны попасть вовсе: неактивное, аренда, устаревшее.
  await add(0, { isActive: false });
  await add(1, { dealType: "RENT" });
  await add(2, { lastSeenAt: new Date(Date.now() - 90 * 24 * 3600_000) });
});

afterAll(async () => {
  await prisma.marketListing.deleteMany({ where: { id: { in: listingIds } } });
  await deleteAgentsWithTraces(agentIds);
});

const seg = (body: { segments: { districtName: string; rooms: number; repair: string | null }[] }, rooms: number, repair: string | null) =>
  body.segments.find((s) => s.districtName === DISTRICT && s.rooms === rooms && s.repair === repair);

describe("GET /market/segments", () => {
  it("без входа — 401", async () => {
    expect((await get("", false)).status).toBe(401);
  });

  it("сегмент с восемью объявлениями получает медиану и среднее; семь — «данных мало» без чисел", async () => {
    const res = await get(`districtName=${encodeURIComponent(DISTRICT)}`);
    expect(res.status).toBe(200);
    expect(res.body.minSample).toBe(MIN_SAMPLE);

    const full = seg(res.body, 2, "RENOVATED");
    expect(full).toMatchObject({ count: 8, enough: true, medianPerSqmTjs: 13_500, averagePerSqmTjs: 13_500 });
    // Цена за объект: (10000+i*1000) * (50+i*5), i = 0..7 — считаем независимо от кода.
    const prices = Array.from({ length: 8 }, (_, i) => (10_000 + i * 1_000) * (50 + i * 5)).sort((a, b) => a - b);
    expect(full.medianPriceTjs).toBe(Math.round((prices[3] + prices[4]) / 2));
    expect(full.averagePriceTjs).toBe(Math.round(prices.reduce((s: number, v: number) => s + v, 0) / 8));
    expect(full.newLast7Days).toBe(8);
    expect(typeof full.freshestSeenAt).toBe("string");

    const few = seg(res.body, 2, null);
    expect(few).toMatchObject({ count: 7, enough: false });
    expect(few.medianPerSqmTjs).toBeNull();
    expect(few.averagePerSqmTjs).toBeNull();
    expect(few.medianPriceTjs).toBeNull();
    expect(few.averagePriceTjs).toBeNull();
  });

  it("неактивные, аренда и устаревшие в сегменты не входят", async () => {
    const res = await get(`districtName=${encodeURIComponent(DISTRICT)}&rooms=2&repair=RENOVATED`);
    expect(res.body.segments).toHaveLength(1);
    expect(res.body.segments[0].count).toBe(8);
  });

  it("фильтр новостройка/вторичка", async () => {
    const d = encodeURIComponent(DISTRICT);
    const fresh = await get(`districtName=${d}&building=new`);
    expect(fresh.body.segments.map((s: { rooms: number }) => s.rooms)).toEqual([3]);
    const old = await get(`districtName=${d}&building=secondary`);
    expect(old.body.segments.every((s: { rooms: number }) => s.rooms === 2)).toBe(true);
    expect(old.body.segments).toHaveLength(2);
  });

  it("источники считаются, неверные параметры — 400", async () => {
    const res = await get(`districtName=${encodeURIComponent(DISTRICT)}`);
    const somon = (res.body.sources as { source: string; count: number }[]).find((s) => s.source === "somon.tj");
    expect(somon?.count).toBeGreaterThanOrEqual(23);
    expect(res.body.truncated).toBe(false);
    for (const bad of ["rooms=0", "rooms=abc", "repair=GOLD", "building=maybe", "foo=1", "districtName="]) {
      expect((await get(bad)).status, bad).toBe(400);
    }
  });
});

describe("buildSegments (чистая часть)", () => {
  const base = new Date("2026-11-10T10:00:00Z");
  const row = (over: Partial<SegmentRow>): SegmentRow => ({
    source: "somon.tj", districtName: "Сино", rooms: 2, repair: "RENOVATED", areaSqm: 60, priceTjs: 600_000,
    pricePerSqmTjs: 10_000, floor: 3, firstSeenAt: base, lastSeenAt: base, ...over,
  });

  it("медиана: чётное число — среднее двух средних, нечётное — средний", () => {
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(median([1, 2, 9])).toBe(2);
    expect(median([])).toBe(0);
  });

  it("выброс не двигает ни медиану, ни усечённое среднее (10% с краёв)", () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      row({ priceTjs: 600_000 + i, pricePerSqmTjs: 10_000 + i, areaSqm: 40 + i * 4, firstSeenAt: new Date("2026-01-01") })
    );
    // Дорогое, но правдоподобное объявление (95 000 за м², внутри границ): обычное среднее ушло бы к 18 500.
    rows.push(row({ priceTjs: 9_000_000, pricePerSqmTjs: 95_000, areaSqm: 94 }));
    const [s] = buildSegments(rows, base.getTime());
    expect(s.count).toBe(10);
    expect(s.medianPerSqmTjs).toBeLessThan(10_100);
    expect(s.averagePerSqmTjs).toBeLessThan(10_100);
    expect(s.averagePriceTjs).toBeLessThan(700_000);
    expect(s.newLast7Days).toBe(1);
  });

  it("неправдоподобные цены отсекаются: ниже порога цены и цена за м² вне 500–100 000", () => {
    const good = Array.from({ length: MIN_SAMPLE }, (_, i) => row({ areaSqm: 40 + i * 4, priceTjs: 500_000 + i * 1000, pricePerSqmTjs: 10_000 + i }));
    const junk = [
      row({ areaSqm: 60, priceTjs: MIN_SALE_PRICE_TJS - 1, pricePerSqmTjs: 800 }),
      row({ areaSqm: 61, priceTjs: 6_500_000, pricePerSqmTjs: null }), // 106 557 за м²: в базе записан null
      row({ areaSqm: 62, priceTjs: 700_000, pricePerSqmTjs: 100_001 }),
    ];
    const [s] = buildSegments([...good, ...junk], base.getTime());
    expect(s.count).toBe(MIN_SAMPLE);
  });

  it("trimmedMean: по одному краю на десять значений", () => {
    expect(trimmedMean([1, 10, 10, 10, 10, 10, 10, 10, 10, 1000])).toBe(10);
    expect(trimmedMean([5, 7])).toBe(6);
    expect(trimmedMean([])).toBe(0);
  });

  it("один объект на Somon и Paydo считается один раз: девять записей из восьми объектов — не хватает до порога", () => {
    const rows = Array.from({ length: 7 }, (_, i) => row({ areaSqm: 40 + i * 10, priceTjs: 400_000 + i * 60_000, pricePerSqmTjs: 10_000 }));
    // Дубль первой квартиры на другой площадке: площадь ±1, цена ±2%.
    rows.push(row({ source: "paydo.tj", areaSqm: 41, priceTjs: 408_000, pricePerSqmTjs: 9_951 }));
    const [s] = buildSegments(rows, base.getTime());
    expect(s.count).toBe(7);
    expect(s.enough).toBe(false);
  });

  it("одна квартира, выложенная на той же площадке трижды, считается один раз (12.11.2026)", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row({ source: "paydo.tj", areaSqm: 40 + i * 10, priceTjs: 400_000 + i * 60_000, pricePerSqmTjs: 10_000 }));
    rows.push(row({ source: "paydo.tj", areaSqm: 40, priceTjs: 400_000, pricePerSqmTjs: 10_000 }));
    rows.push(row({ source: "paydo.tj", areaSqm: 40, priceTjs: 400_000, pricePerSqmTjs: 10_000 }));
    const [s] = buildSegments(rows, base.getTime());
    expect(s.count).toBe(6);
    expect(s.enough).toBe(false);
  });

  it("если за м² известно меньше порога, число за м² не показываем, а за объект показываем", () => {
    const rows = Array.from({ length: MIN_SAMPLE }, (_, i) =>
      row({ areaSqm: i < 3 ? 40 + i * 10 : null, priceTjs: 400_000 + i * 50_000, pricePerSqmTjs: i < 3 ? 10_000 : null })
    );
    const [s] = buildSegments(rows, base.getTime());
    expect(s.enough).toBe(true);
    expect(s.medianPerSqmTjs).toBeNull();
    expect(s.medianPriceTjs).not.toBeNull();
  });
});
