import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { catalogRaw } from "./helpers/somonPage.js";
import { MIN_SAMPLE } from "../src/lib/market/comps.js";
import { dushanbeDateString } from "../src/lib/dushanbeTime.js";
import {
  ALL_DISTRICTS, buildMedianHistory, isOwnerSeller, OWNER_MAX_ACTIVE_LISTINGS, recordMedianHistory, type HistoryInputRow,
} from "../src/lib/market/medianHistory.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * История медиан (14.11.2026): порог 8, собственники отдельно, граница суток по Душанбе,
 * идемпотентность повторной записи, ряд по GET /market/history.
 */

const row = (i: number, over: Partial<HistoryInputRow> = {}): HistoryInputRow => ({
  source: "somon.tj", districtName: "Сино", rooms: 2, areaSqm: 50 + i * 5, priceTjs: (10_000 + i * 1_000) * (50 + i * 5),
  pricePerSqmTjs: 10_000 + i * 1_000, floor: i + 1, repair: null, sellerId: `s${i}`, sellerPhone: null, isNewBuilding: false,
  isOwner: true, firstSeenAt: new Date(), lastSeenAt: new Date(), ...over,
});
const many = (n: number, over: Partial<HistoryInputRow> = {}) => Array.from({ length: n }, (_, i) => row(i, over));
const pick = (rows: ReturnType<typeof buildMedianHistory>, d: string, rooms: number, building: string, audience: string) =>
  rows.find((r) => r.districtName === d && r.rooms === rooms && r.building === building && r.audience === audience);

describe("buildMedianHistory (чистая часть)", () => {
  it("порог: восемь объявлений — строка с числами, семь — строки нет вовсе", () => {
    const ok = buildMedianHistory(many(MIN_SAMPLE));
    expect(pick(ok, "Сино", 2, "SECONDARY", "ALL")).toMatchObject({ count: 8, medianPerSqmTjs: 13_500, averagePerSqmTjs: 13_500 });
    expect(buildMedianHistory(many(MIN_SAMPLE - 1))).toEqual([]);
  });

  it("объявление без района в сегменты не попадает", () => {
    expect(buildMedianHistory(many(MIN_SAMPLE, { districtName: "" }))).toEqual([]);
  });

  it("весь город (*), любые комнаты (0) и любой дом (ANY) — отдельные ряды из тех же объявлений", () => {
    const rows = buildMedianHistory([...many(8), ...many(8, { districtName: "Фирдавси", sellerId: "x" })]);
    expect(pick(rows, ALL_DISTRICTS, 0, "ANY", "ALL")?.count).toBe(16);
    expect(pick(rows, "Сино", 0, "ANY", "ALL")?.count).toBe(8);
    expect(pick(rows, "Сино", 2, "NEW", "ALL")).toBeUndefined();
  });

  it("собственники отдельно: агентства в OWNERS не входят, и порог считается по ним", () => {
    const agency = many(6, { isOwner: false, sellerId: "ag", rooms: 3, districtName: "Сино" });
    const rows = buildMedianHistory([...many(8, { isOwner: true }), ...agency]);
    expect(pick(rows, "Сино", 2, "SECONDARY", "OWNERS")?.count).toBe(8);
    // Агентских объявлений 6 < 8: отдельной строки по 3 комнатам нет ни для ALL, ни для OWNERS.
    expect(pick(rows, "Сино", 3, "SECONDARY", "ALL")).toBeUndefined();
    // Сплошь агентства: аудитории OWNERS нет вовсе.
    expect(buildMedianHistory(many(10, { isOwner: false })).some((r) => r.audience === "OWNERS")).toBe(false);
  });

  it("правило собственника: не агентство и меньше порога активных объявлений", () => {
    expect(isOwnerSeller(false, OWNER_MAX_ACTIVE_LISTINGS - 1)).toBe(true);
    expect(isOwnerSeller(false, OWNER_MAX_ACTIVE_LISTINGS)).toBe(false);
    expect(isOwnerSeller(true, 1)).toBe(false);
    expect(isOwnerSeller(false, null)).toBe(true);
  });
});

describe("граница суток по Душанбе (UTC+5)", () => {
  it("19:00 UTC — уже следующие сутки, 18:59 UTC — ещё прежние", () => {
    expect(dushanbeDateString(new Date("2026-11-14T18:59:00Z"))).toBe("2026-11-14");
    expect(dushanbeDateString(new Date("2026-11-14T19:00:00Z"))).toBe("2026-11-15");
  });
});

const runId = `${Date.now()}`.slice(-8);
const DISTRICT = `Тест-история-${runId}`;
const CITY = "Душанбе";
const password = "testpass123";
const agentIds: string[] = [];
const listingIds: string[] = [];
let token: string;
const NOW = new Date();
const DAY = dushanbeDateString(NOW);

async function add(i: number, over: Record<string, unknown> = {}) {
  const areaSqm = 50 + i * 5;
  const perSqm = 10_000 + i * 1_000;
  const { sellerId, ...rest } = over;
  const l = await prisma.marketListing.create({
    data: {
      source: "somon.tj", sourceId: `${runId}-${listingIds.length}`, sourceUrl: `https://somon.tj/adv/${runId}-${listingIds.length}`,
      dealType: "SALE", propertyType: "APARTMENT", city: CITY, districtName: DISTRICT, rooms: 2, isNewBuilding: false, areaSqm,
      price: perSqm * areaSqm, currency: "TJS", priceTjs: perSqm * areaSqm, pricePerSqmTjs: perSqm, title: `История ${i}`,
      isActive: true, lastSeenAt: new Date(), sellerId: (sellerId as string | undefined) ?? `own-${runId}-${i}`, floor: i + 1,
      raw: catalogRaw(rest), ...rest,
    },
  });
  listingIds.push(l.id);
  return l;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({ data: { fullName: `Агент истории ${runId}`, phone: `+992986${runId.slice(-7)}`, role: "AGENT", passwordHash } });
  agentIds.push(agent.id);
  token = (await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password })).body.accessToken;
  // 8 собственников (по одному объявлению у продавца) + 4 одного риелтора с 4 объявлениями (не меньше порога 3).
  for (let i = 0; i < 8; i++) await add(i);
  for (let i = 8; i < 12; i++) await add(i, { sellerId: `realtor-${runId}` });
  // Аренда и неактивное в историю не идут.
  await add(1, { dealType: "RENT" });
  await add(2, { isActive: false });
});

afterAll(async () => {
  await prisma.marketMedianDaily.deleteMany({ where: { districtName: DISTRICT } });
  await prisma.marketListing.deleteMany({ where: { id: { in: listingIds } } });
  await deleteAgentsWithTraces(agentIds);
});

describe("recordMedianHistory (в базе)", () => {
  it("пишет сегменты суток; собственники отдельно; аренда и неактивные не считаются; повторный запуск не множит строки", async () => {
    const first = await recordMedianHistory(CITY, NOW);
    expect(first.day).toBe(DAY);
    expect(first.skipped).toBeNull();
    const mine = () =>
      prisma.marketMedianDaily.findMany({ where: { districtName: DISTRICT, day: DAY }, orderBy: [{ audience: "asc" }, { building: "asc" }, { rooms: "asc" }] });
    const rows1 = await mine();
    const all = rows1.find((r) => r.audience === "ALL" && r.rooms === 2 && r.building === "SECONDARY");
    const owners = rows1.find((r) => r.audience === "OWNERS" && r.rooms === 2 && r.building === "SECONDARY");
    expect(all?.count).toBe(12);
    expect(owners?.count).toBe(8);

    const second = await recordMedianHistory(CITY, NOW);
    expect(second.written).toBe(first.written);
    const rows2 = await mine();
    expect(rows2).toHaveLength(rows1.length);
    expect(rows2.map((r) => `${r.rooms}${r.building}${r.audience}${r.count}`)).toEqual(rows1.map((r) => `${r.rooms}${r.building}${r.audience}${r.count}`));
  });

  it("другие сутки по Душанбе — отдельные строки", async () => {
    const next = new Date(NOW.getTime() + 24 * 3600_000);
    await recordMedianHistory(CITY, next);
    const days = await prisma.marketMedianDaily.findMany({
      where: { districtName: DISTRICT, rooms: 2, building: "SECONDARY", audience: "ALL" },
      select: { day: true },
    });
    expect(days.map((d) => d.day).sort()).toEqual([DAY, dushanbeDateString(next)].sort());
  });
});

describe("GET /market/history", () => {
  const get = (qs: string, auth = true) => {
    const r = request(app).get(`/api/v1/market/history?${qs}`);
    return auth ? r.set("Authorization", `Bearer ${token}`) : r;
  };

  it("без входа — 401, неверные параметры — 400", async () => {
    expect((await get("", false)).status).toBe(401);
    expect((await get("days=0")).status).toBe(400);
    expect((await get("audience=x")).status).toBe(400);
  });

  it("ряд по району и комнатам; owners — отдельный ряд; пустой район — пустой ряд", async () => {
    const d = encodeURIComponent(DISTRICT);
    const all = await get(`districtName=${d}&rooms=2&building=secondary&days=30`);
    expect(all.status).toBe(200);
    expect(all.body.minSample).toBe(MIN_SAMPLE);
    expect(all.body.points.length).toBeGreaterThanOrEqual(1);
    expect(all.body.points[0]).toMatchObject({ count: 12 });
    const days = all.body.points.map((p: { day: string }) => p.day);
    expect([...days].sort()).toEqual(days);
    const owners = await get(`districtName=${d}&rooms=2&building=secondary&audience=owners`);
    expect(owners.body.points[0].count).toBe(8);
    const limited = await get(`districtName=${d}&rooms=2&building=secondary&limit=1`);
    expect(limited.body.points).toHaveLength(1);
    const none = await get(`districtName=${encodeURIComponent("Нет-такого-района")}`);
    expect(none.body.points).toEqual([]);
  });
});
