import bcrypt from "bcrypt";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Рейтинг креативов (03.10.2026, GET /ads/creatives): чистая свёртка (пороги значимости,
 * основание рейтинга, лучшие/худшие) и роут на настоящей базе — объявление на четыре
 * объекта считается ОДИН раз, бренд и чужое в рейтинг не идут, агент без права не получает
 * сумм. Деньги и клиенты лежат в июне 2024 — окно, где в общей базе нет чужих данных.
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
const {
  rankCreatives,
  CREATIVE_MIN_SPEND_TJS,
  CREATIVE_MIN_IMPRESSIONS,
  CREATIVE_CLIENT_BASIS_MIN_ADS,
} = await import("../src/lib/ads/adCreativeRank.js");
const { adSpendToTjsCents, fromCents, loadMoneyContext } = await import("../src/lib/money.js");

import type { CreativeInput } from "../src/lib/ads/adCreativeRank.js";

/** Фикстура чистой свёртки: расход 500 с., 5000 показов — выше обоих порогов. */
function input(id: string, extra: Partial<CreativeInput> = {}): CreativeInput {
  return {
    adId: id,
    title: `Креатив ${id}`,
    campaignName: null,
    thumbnailUrl: null,
    postUrl: null,
    delivery: "RUNNING",
    activeDays: 10,
    spendCents: 500_00,
    impressions: 5000,
    reach: 2500,
    conversations: 0,
    leads: 0,
    showings: 0,
    objectsCount: 1,
    brand: false,
    ...extra,
  };
}

describe("rankCreatives — пороги значимости", () => {
  it("расход ниже порога, показов ниже порога и оба сразу — «мало данных» с причиной", () => {
    const cents = CREATIVE_MIN_SPEND_TJS * 100;
    const { rows } = rankCreatives([
      input("lowSpend", { spendCents: cents - 1, conversations: 3 }),
      input("lowImp", { impressions: CREATIVE_MIN_IMPRESSIONS - 1, conversations: 3 }),
      input("both", { spendCents: 10_00, impressions: 50, conversations: 1 }),
      input("edge", { spendCents: cents, impressions: CREATIVE_MIN_IMPRESSIONS, conversations: 3 }),
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.adId, r]));
    expect(by.lowSpend).toMatchObject({ mark: "lowData", lowDataReason: "spend" });
    expect(by.lowImp).toMatchObject({ mark: "lowData", lowDataReason: "impressions" });
    expect(by.both).toMatchObject({ mark: "lowData", lowDataReason: "both" });
    // Ровно на пороге — ещё значимо.
    expect(by.edge.mark).not.toBe("lowData");
    expect(by.edge.lowDataReason).toBeNull();
  });

  it("«мало данных» не получает мест, даже когда у него самая дешёвая цена", () => {
    const { rows } = rankCreatives([
      input("tiny", { spendCents: 5_00, impressions: 100, conversations: 5 }), // 1 с. за обращение
      input("a", { conversations: 5 }),
      input("b", { conversations: 2 }),
    ]);
    expect(rows.find((r) => r.adId === "tiny")).toMatchObject({ mark: "lowData", rankPosition: null });
    expect(rows.filter((r) => r.mark === "best").map((r) => r.adId)).toEqual(["a"]);
  });
});

describe("rankCreatives — основание рейтинга", () => {
  const withClients = (n: number, leadsEach: number) =>
    Array.from({ length: n }, (_, i) =>
      input(`c${i}`, { leads: leadsEach, conversations: 4, spendCents: (400 + i * 50) * 100 })
    );

  it("клиентов хватает (4 объявления и 5 клиентов) — ранжируем по цене клиента", () => {
    const list = [...withClients(CREATIVE_CLIENT_BASIS_MIN_ADS - 1, 1), input("c3", { leads: 2, conversations: 4 })];
    const r = rankCreatives(list);
    expect(r.rankedBy).toBe("client");
    expect(r.rankedByNote).toMatch(/цене клиента/);
  });

  it("клиентов мало — честный запасной путь по обращениям Meta, и это сказано в подписи", () => {
    const r = rankCreatives([
      input("a", { leads: 1, conversations: 4 }),
      input("b", { conversations: 2 }),
      input("c", { conversations: 6 }),
    ]);
    expect(r.rankedBy).toBe("conversation");
    expect(r.rankedByNote).toMatch(/обращени/);
    expect(r.rankedByNote).toMatch(/клиентов в CRM/i);
  });

  it("мало и клиентов, и обращений — рейтинга нет, мест нет", () => {
    const r = rankCreatives([input("a", { conversations: 1 }), input("b")]);
    expect(r.rankedBy).toBe("none");
    expect(r.rows.every((row) => row.mark === "middle" && row.rankPosition === null)).toBe(true);
  });

  it("четыре объявления с клиентами, но клиентов всего три — это ещё не основание (одиночки решают цену)", () => {
    const list = Array.from({ length: 4 }, (_, i) => input(`x${i}`, { leads: 1, conversations: 3 }));
    list[0].leads = 1;
    // Сумма клиентов 4 < 5.
    expect(rankCreatives(list).rankedBy).toBe("conversation");
  });
});

describe("rankCreatives — лучшие и худшие", () => {
  it("по цене клиента: три лучших, три худших, середина между ними; без клиентов — среди худших", () => {
    // Цена клиента = 500 / leads: больше клиентов — дешевле.
    const list = [
      input("l6", { leads: 6, conversations: 9 }), // 83,3
      input("l5", { leads: 5, conversations: 9 }), // 100
      input("l4", { leads: 4, conversations: 9 }), // 125
      input("l3", { leads: 3, conversations: 9 }), // 166,7
      input("l2", { leads: 2, conversations: 9 }), // 250
      input("l1", { leads: 1, conversations: 9 }), // 500
      input("zero", { leads: 0, conversations: 9 }), // клиентов нет — хуже всех
    ];
    const r = rankCreatives(list);
    expect(r.rankedBy).toBe("client");
    const best = r.rows.filter((x) => x.mark === "best");
    const worst = r.rows.filter((x) => x.mark === "worst");
    expect(best.map((x) => x.adId)).toEqual(["l6", "l5", "l4"]);
    expect(best.map((x) => x.rankPosition)).toEqual([1, 2, 3]);
    // Худшее — первым: расход без единого клиента хуже самой дорогой цены.
    expect(worst.map((x) => x.adId)).toEqual(["zero", "l1", "l2"]);
    expect(worst.map((x) => x.rankPosition)).toEqual([1, 2, 3]);
    expect(r.rows.find((x) => x.adId === "l3")!.mark).toBe("middle");
    // Порядок строк: лучшие → середина → худшие.
    expect(r.rows.map((x) => x.adId)).toEqual(["l6", "l5", "l4", "l3", "zero", "l1", "l2"]);
  });

  it("объявление без результата не бывает лучшим; на двух объявлениях одно лучшее и одно худшее", () => {
    const r = rankCreatives([
      input("none", { conversations: 0, leads: 0 }),
      input("ok", { conversations: 4 }),
      input("ok2", { conversations: 3 }),
    ]);
    expect(r.rankedBy).toBe("conversation");
    expect(r.rows.find((x) => x.adId === "none")).toMatchObject({ mark: "worst", rankPosition: 1 });
    expect(r.rows.find((x) => x.adId === "ok")!.mark).toBe("best");
    // Один и тот же креатив не может быть и в лучших, и в худших.
    const ids = r.rows.filter((x) => x.mark === "best" || x.mark === "worst").map((x) => x.adId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ровно одно значимое объявление — рейтинга нет: оно не «худшее»", () => {
    const r = rankCreatives([input("alone", { conversations: 4 }), input("small", { spendCents: 1_00, impressions: 10 })]);
    expect(r.rows.find((x) => x.adId === "alone")!.mark).toBe("middle");
  });

  it("реклама агентства уходит в отдельный список и мест не получает", () => {
    const r = rankCreatives([
      input("brand", { brand: true, conversations: 100, spendCents: 50_00_00 }),
      input("a", { conversations: 5 }),
      input("b", { conversations: 2 }),
    ]);
    expect(r.rows.map((x) => x.adId)).not.toContain("brand");
    expect(r.brand.map((x) => x.adId)).toEqual(["brand"]);
    expect(r.brand[0].mark).not.toBe("best");
    expect(r.brand[0].rankPosition).toBeNull();
  });

  it("цены: нули не печатаются ценой, частота показов приблизительная и пустая без охвата", () => {
    const r = rankCreatives([
      input("a", { conversations: 5, reach: 2500 }),
      input("b", { conversations: 0, reach: 0 }),
    ]);
    const a = r.rows.find((x) => x.adId === "a")!;
    const b = r.rows.find((x) => x.adId === "b")!;
    expect(a.costPerConversationTjs).toBe(100);
    expect(a.frequencyApprox).toBe(2);
    expect(b.costPerConversationTjs).toBeNull();
    expect(b.costPerLeadTjs).toBeNull();
    expect(b.frequencyApprox).toBeNull();
  });
});

// ---------- роут на настоящей базе ----------

const runId = Date.now();
const password = "testpass123";
const PERIOD = "from=2024-06-01&to=2024-06-30";
const JUNE = new Date("2024-06-15T08:00:00.000Z");

const agentIds: string[] = [];
const adIds: string[] = [];
const propertyIds: string[] = [];
const clientIds: string[] = [];
let districtId = "";
let adminToken = "";
let agentToken = "";
let marketingToken = "";
let multiAdId = "";
let singleAdId = "";
let brandAdId = "";
let foreignAdId = "";
let tinyAdId = "";

const get = (path: string, token: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);

async function login(role: "ADMIN" | "AGENT" | "MARKETING", n: number): Promise<string> {
  const passwordHash = await bcrypt.hash(password, 10);
  const a = await prisma.agent.create({
    data: { fullName: `Креативы ${role}`, phone: `+992978${runId}${n}`, role, passwordHash },
  });
  agentIds.push(a.id);
  const res = await request(app).post("/api/v1/auth/login").send({ phone: a.phone, password });
  return res.body.accessToken;
}

async function makeAd(key: string, extra: Record<string, unknown> = {}) {
  const ad = await prisma.ad.create({
    data: {
      platform: "META",
      externalId: `creatives-${key}-${runId}`,
      name: `Тест-креатив ${key} ${runId}`,
      adAccountId: "act_creatives",
      status: "PAUSED",
      lastSyncedAt: new Date(),
      ...extra,
    },
  });
  adIds.push(ad.id);
  return ad;
}

async function spend(adId: string, day: string, amount: number, currency: "USD" | "TJS", rest: Record<string, number> = {}) {
  await prisma.adSpendDaily.create({
    data: { adId, date: new Date(`${day}T00:00:00.000Z`), spend: amount, currency, ...rest },
  });
}

beforeAll(async () => {
  adminToken = await login("ADMIN", 1);
  agentToken = await login("AGENT", 2);
  marketingToken = await login("MARKETING", 3);

  districtId = (await prisma.district.create({ data: { name: `Тест-район-креативы-${runId}` } })).id;
  const props: { id: string }[] = [];
  for (let i = 0; i < 4; i++) {
    const p = await prisma.property.create({
      data: {
        title: `Тест-креативы-${runId}-${i}`,
        type: "APARTMENT",
        rooms: 2,
        areaSqm: 55,
        price: 45000,
        currency: "USD",
        districtId,
        address: `Креативы, ${i}`,
        condition: "GOOD",
      },
    });
    propertyIds.push(p.id);
    props.push(p);
  }

  // Объявление на ЧЕТЫРЕ объекта: расход один, доллары (две строки в разные дни).
  const multi = await makeAd("multi", {
    thumbnailUrl: "https://example.test/thumb-multi.jpg",
    caption: "Продаётся квартира в центре\nАдрес: Рудаки 1",
    assetCount: 4,
  });
  multiAdId = multi.id;
  await setAdProperties(multi.id, props.map((p, i) => ({ propertyId: p.id, weight: 4 - i })), "FEED_CAPTION");
  await spend(multi.id, "2024-06-10", 20, "USD", { impressions: 2000, reach: 1000, conversations: 3, clicks: 10 });
  await spend(multi.id, "2024-06-11", 10, "USD", { impressions: 1000, reach: 500, conversations: 2, clicks: 5 });

  // Обычное объявление в сомони, обращения без клиентов.
  const single = await makeAd("single", { caption: "Продаётся дом\nАдрес: Айни 5" });
  singleAdId = single.id;
  await setAdProperties(single.id, [{ propertyId: props[0].id, weight: 1 }], "FEED_CAPTION");
  await spend(single.id, "2024-06-12", 200, "TJS", { impressions: 5000, reach: 4000, conversations: 2 });

  // Реклама агентства.
  const brand = await makeAd("brand", { brand: true });
  brandAdId = brand.id;
  await spend(brand.id, "2024-06-12", 300, "TJS", { impressions: 9000, conversations: 20 });

  // Чужая реклама — ни в рейтинге, ни в расходе.
  const foreign = await makeAd("foreign", { excluded: true });
  foreignAdId = foreign.id;
  await spend(foreign.id, "2024-06-12", 999, "TJS", { impressions: 99999, conversations: 99 });

  // Копеечное объявление.
  const tiny = await makeAd("tiny");
  tinyAdId = tiny.id;
  await spend(tiny.id, "2024-06-12", 20, "TJS", { impressions: 100, conversations: 1 });

  // Два клиента CRM с multi-объявления (один вне периода не считается).
  for (let i = 1; i <= 3; i++) {
    const c = await prisma.client.create({
      data: {
        fullName: `Тест-креатив-клиент-${runId}-${i}`,
        phone: `+992979${runId}${i}`,
        source: "INSTAGRAM",
        kind: "BUYER",
        currency: "TJS",
        sourceAdId: multi.externalId,
        createdAt: i === 3 ? new Date("2024-05-10T08:00:00.000Z") : JUNE,
      },
    });
    clientIds.push(c.id);
  }
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.adSpendDaily.deleteMany({ where: { adId: { in: adIds } } });
  await prisma.ad.deleteMany({ where: { id: { in: adIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.$disconnect();
});

describe("GET /ads/creatives", () => {
  it("объявление на четыре объекта — ОДНА строка, расход один раз, в сомони единым правилом", async () => {
    const res = await get(`/api/v1/ads/creatives?${PERIOD}`, adminToken);
    expect(res.status).toBe(200);
    const matches = res.body.rows.filter((r: { adId: string }) => r.adId === multiAdId);
    expect(matches).toHaveLength(1);
    const row = matches[0];

    const money = await loadMoneyContext();
    // 20 + 10 долларов: курс применяется к сумме по валюте один раз.
    const expected = fromCents(adSpendToTjsCents([{ spend: 20, currency: "USD" }, { spend: 10, currency: "USD" }], money));
    expect(row.spendTjs).toBe(expected);
    expect(row.objectsCount).toBe(4);
    expect(row.impressions).toBe(3000);
    expect(row.conversations).toBe(5);
    // Клиент мая вне периода: клиентов 2.
    expect(row.leads).toBe(2);
    expect(row.costPerLeadTjs).toBe(fromCents(Math.round(Math.round(expected * 100) / 2)));
    expect(row.costPerConversationTjs).toBe(fromCents(Math.round(Math.round(expected * 100) / 5)));
    expect(row.activeDays).toBe(2);
    expect(row.thumbnailUrl).toBe("https://example.test/thumb-multi.jpg");
    expect(row.title).toBe("Продаётся квартира в центре");
    // Охват суммируется по дням: 3000 / 1500 = 2.
    expect(row.frequencyApprox).toBe(2);

    // Сумма расхода по строкам не больше суммы по объявлениям: никакого размножения по объектам.
    const total = res.body.rows.reduce((acc: number, r: { spendTjs: number }) => acc + r.spendTjs, 0);
    const single = res.body.rows.find((r: { adId: string }) => r.adId === singleAdId);
    const tiny = res.body.rows.find((r: { adId: string }) => r.adId === tinyAdId);
    expect(Math.round(total * 100)).toBe(Math.round((expected + single.spendTjs + tiny.spendTjs) * 100));
  });

  it("клиентов мало — ранжируем по обращениям Meta, об этом сказано; бренд отдельно, чужое не видно", async () => {
    const res = await get(`/api/v1/ads/creatives?${PERIOD}`, adminToken);
    expect(res.body.rankedBy).toBe("conversation");
    expect(res.body.rankedByNote).toMatch(/Клиентов в CRM/i);
    const by = Object.fromEntries(res.body.rows.map((r: { adId: string }) => [r.adId, r]));
    // multi: ≈ 60 с. за обращение — дешевле single (100 с.).
    expect(by[multiAdId].mark).toBe("best");
    expect(by[singleAdId].mark).toBe("worst");
    expect(by[tinyAdId]).toMatchObject({ mark: "lowData", lowDataReason: "both" });
    expect(by[brandAdId]).toBeUndefined();
    expect(by[foreignAdId]).toBeUndefined();
    expect(res.body.brand.map((r: { adId: string }) => r.adId)).toEqual([brandAdId]);
    expect(res.body.foreignCount).toBeGreaterThanOrEqual(1);
    expect(res.body.thresholds).toEqual({ minSpendTjs: CREATIVE_MIN_SPEND_TJS, minImpressions: CREATIVE_MIN_IMPRESSIONS });
  });

  it("пустой период — пустой рейтинг без ошибки", async () => {
    const res = await get("/api/v1/ads/creatives?from=2024-01-01&to=2024-01-31", adminToken);
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.rankedBy).toBe("none");
  });

  it("неверный период — 400", async () => {
    expect((await get("/api/v1/ads/creatives?preset=bogus", adminToken)).status).toBe(400);
    expect((await get("/api/v1/ads/creatives?from=2024-13-99&to=2024-13-99", adminToken)).status).toBe(400);
  });

  it("деньги по праву: агент без «Финансов» получает 403 и ни одной суммы; маркетолог — читает", async () => {
    const denied = await get(`/api/v1/ads/creatives?${PERIOD}`, agentToken);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toMatch(/spendTjs|costPer/);
    expect((await get(`/api/v1/ads/creatives?${PERIOD}`, marketingToken)).status).toBe(200);
    expect((await request(app).get(`/api/v1/ads/creatives?${PERIOD}`)).status).toBe(401);
  });
});
