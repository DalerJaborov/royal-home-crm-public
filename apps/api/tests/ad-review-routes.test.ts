import bcrypt from "bcrypt";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setAdPropertiesBodySchema } from "@royal-home/shared";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * РЕВЬЮ СЕРВЕРНОЙ ЧАСТИ РЕКЛАМЫ (03.10.2026), часть на роутах: удаление объекта навсегда
 * не перекладывает долю на соседей (п. 3), отклик по комментариям считает только
 * содержательные статусы (п. 4), доска и отчёт переводят валюту одним правилом (п. 10),
 * вес связи не ниже точности колонки (п. 11).
 *
 * Деньги тестовых объявлений лежат в апреле 2025 — окне без чужих данных.
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
const { grantElevation } = await import("../src/lib/stepUp.js");
const { setAdProperties } = await import("../src/lib/ads/adAllocation.js");
const { adSpendToTjsCents, centsToTjs, toCents } = await import("../src/lib/money.js");

const runId = Date.now();
const password = "testpass123";
const PERIOD = "from=2025-04-01&to=2025-04-30";

let adminToken = "";
const agentIds: string[] = [];
let districtId = "";
const propertyIds: string[] = [];
const adIds: string[] = [];
const commentIds: string[] = [];

const get = (path: string) => request(app).get(path).set("Authorization", `Bearer ${adminToken}`);

async function makeProperty(i: number, extra: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Тест-ревью-роуты-${runId}-${i}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 55,
      price: 45000,
      currency: "USD",
      districtId,
      address: `Ревью-роуты, ${runId} ${i}`,
      condition: "GOOD",
      ...extra,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function makeAd(tag: string, extra: Record<string, unknown> = {}) {
  const ad = await prisma.ad.create({
    data: {
      platform: "META",
      externalId: `review-routes-${runId}-${tag}`,
      name: `Тест-ревью-роуты ${runId} ${tag}`,
      adAccountId: "act_review_routes",
      status: "PAUSED",
      lastSyncedAt: new Date(),
      ...extra,
    },
  });
  adIds.push(ad.id);
  return ad;
}

beforeAll(async () => {
  const admin = await prisma.agent.create({
    data: {
      fullName: "Админ ревью рекламы",
      phone: `+992977${String(runId).slice(-7)}`,
      role: "ADMIN",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  agentIds.push(admin.id);
  const login = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  expect(login.status).toBe(200);
  adminToken = login.body.accessToken;
  grantElevation(admin.id);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-ревью-роуты-${runId}` } })).id;
});

afterAll(async () => {
  await prisma.instagramComment.deleteMany({ where: { id: { in: commentIds } } });
  await prisma.adSpendDaily.deleteMany({ where: { adId: { in: adIds } } });
  await prisma.ad.deleteMany({ where: { id: { in: adIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.$disconnect();
});

describe("п. 3 — удаление объекта навсегда не переписывает деньги соседей молча", () => {
  it("объявление на 3 объекта: остаются 2 связи, основной пересчитан, assetCount цел → «нужна проверка», запись в аудите", async () => {
    const [p0, p1, p2] = [await makeProperty(0), await makeProperty(1), await makeProperty(2)];
    const ad = await makeAd("purge", { assetCount: 3 });
    await setAdProperties(
      ad.id,
      [
        { propertyId: p0.id, weight: 3 },
        { propertyId: p1.id, weight: 2 },
        { propertyId: p2.id, weight: 1 },
      ],
      "FEED_CAPTION"
    );
    expect((await prisma.ad.findUniqueOrThrow({ where: { id: ad.id } })).propertyId).toBe(p0.id);

    // Основной объект (самый тяжёлый) уходит в Корзину и удаляется навсегда.
    await prisma.property.update({ where: { id: p0.id }, data: { deletedAt: new Date() } });
    const res = await request(app).delete(`/api/v1/properties/${p0.id}/permanent`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(204);

    const after = await prisma.ad.findUniqueOrThrow({ where: { id: ad.id }, include: { properties: true } });
    // Остальные связи сохранены КАК БЫЛИ (веса прежние), а не пересчитаны на соседей.
    expect(after.properties.map((r) => [r.propertyId, Number(r.weight)]).sort()).toEqual(
      [
        [p1.id, 2],
        [p2.id, 1],
      ].sort()
    );
    // Ad.propertyId не обнулился при живых связях: основной — самый тяжёлый из оставшихся.
    expect(after.propertyId).toBe(p1.id);
    // Материалов по-прежнему 3, объектов 2 → объявление встаёт в «нужна проверка».
    expect(after.assetCount).toBe(3);
    const board = await get(`/api/v1/ads/board?${PERIOD}`);
    expect(board.body.rows.find((r: { id: string }) => r.id === ad.id).needsReview).toBe(true);

    const audit = await waitFor(() =>
      prisma.auditLog.findFirst({ where: { entityType: "Ad", entityId: ad.id, action: "UPDATE" } })
    );
    expect(JSON.stringify(audit?.meta ?? null)).toContain("property-purged");
  });

  it("единственный объект объявления удалён: объявление без объекта (а не с висящим propertyId)", async () => {
    const solo = await makeProperty(3);
    const ad = await makeAd("purge-solo", { assetCount: 1 });
    await setAdProperties(ad.id, [{ propertyId: solo.id, weight: 1 }], "FEED_CAPTION");
    await prisma.property.update({ where: { id: solo.id }, data: { deletedAt: new Date() } });
    const res = await request(app).delete(`/api/v1/properties/${solo.id}/permanent`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(204);
    const after = await prisma.ad.findUniqueOrThrow({ where: { id: ad.id }, include: { properties: true } });
    expect(after.propertyId).toBeNull();
    expect(after.properties).toHaveLength(0);
    expect(after.matchSource).toBeNull();
  });

  it("ручная привязка остаётся ручной: связи соседей целы, matchSource = MANUAL", async () => {
    const [a, b] = [await makeProperty(4), await makeProperty(5)];
    const ad = await makeAd("purge-manual", { assetCount: 2 });
    await setAdProperties(ad.id, [{ propertyId: a.id, weight: 2 }, { propertyId: b.id, weight: 1 }], "MANUAL");
    await prisma.property.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
    const res = await request(app).delete(`/api/v1/properties/${a.id}/permanent`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(204);
    const after = await prisma.ad.findUniqueOrThrow({ where: { id: ad.id }, include: { properties: true } });
    expect(after.matchSource).toBe("MANUAL");
    expect(after.propertyId).toBe(b.id);
    expect(after.properties.map((r) => r.propertyId)).toEqual([b.id]);
  });
});

describe("п. 4 — отклик по комментариям: только REPLIED и ESCALATED", () => {
  it("SKIPPED, HIDDEN и DELETED с propertyId в «комментарии» отчёта не входят", async () => {
    const p = await makeProperty(6);
    const ad = await makeAd("comments");
    await setAdProperties(ad.id, [{ propertyId: p.id, weight: 1 }], "FEED_CAPTION");
    await prisma.adSpendDaily.create({
      data: { adId: ad.id, date: new Date("2025-04-10T00:00:00.000Z"), spend: 5, currency: "USD", impressions: 10, clicks: 1, conversations: 1 },
    });
    let n = 0;
    for (const status of ["REPLIED", "ESCALATED", "SKIPPED", "HIDDEN", "DELETED", "FAILED", "PENDING"]) {
      const row = await prisma.instagramComment.create({
        data: {
          commentId: `review-routes-${runId}-c${n++}`,
          mediaId: `media-${runId}`,
          authorId: `author-${runId}`,
          text: `Комментарий ${status}`,
          replyDueAt: new Date(),
          status,
          propertyId: p.id,
        },
      });
      commentIds.push(row.id);
    }
    const res = await get(`/api/v1/ads/report?${PERIOD}`);
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { property: { id: string } | null }) => r.property?.id === p.id);
    expect(row.comments).toBe(2);
  });
});

describe("п. 10 — доска и отчёт переводят валюту одним правилом", () => {
  it("adSpendToTjsCents: курс к сумме по валюте, а не к каждой дневной строке", () => {
    const rows = [0.05, 0.05, 0.05].map((spend) => ({ spend, currency: "USD" }));
    const ctx = { usdToTjs: 10.9 };
    // Было: каждая строка 5 центов × 10,9 = 54,5 → 55, трижды = 165. Стало: 15 центов × 10,9 = 163,5 → 164.
    const perRow = rows.reduce((acc, r) => acc + centsToTjs(toCents(r.spend), r.currency, ctx), 0);
    expect(perRow).toBe(165);
    expect(adSpendToTjsCents(rows, ctx)).toBe(centsToTjs(toCents(0.15), "USD", ctx));
    // Две валюты складываются после перевода каждой по своей сумме.
    expect(adSpendToTjsCents([...rows, { spend: 2.5, currency: "TJS" }], ctx)).toBe(
      centsToTjs(toCents(0.15), "USD", ctx) + 250
    );
  });

  it("строка объекта в отчёте и расход объявления на доске — одно и то же число до цента", async () => {
    const p = await makeProperty(7);
    const ad = await makeAd("rate");
    await setAdProperties(ad.id, [{ propertyId: p.id, weight: 1 }], "FEED_CAPTION");
    // Семь дней по 7 центов: на «нечётных» курсах перевод по строке и по сумме расходится.
    for (let day = 11; day < 18; day++) {
      await prisma.adSpendDaily.create({
        data: { adId: ad.id, date: new Date(`2025-04-${day}T00:00:00.000Z`), spend: 0.07, currency: "USD", impressions: 1, clicks: 1, conversations: 0 },
      });
    }
    const [board, report] = await Promise.all([get(`/api/v1/ads/board?${PERIOD}`), get(`/api/v1/ads/report?${PERIOD}`)]);
    const boardRow = board.body.rows.find((r: { id: string }) => r.id === ad.id);
    const reportRow = report.body.rows.find((r: { property: { id: string } | null }) => r.property?.id === p.id);
    expect(toCents(boardRow.period.spendTjs)).toBe(toCents(reportRow.spendTjs));
    expect(toCents(boardRow.lifetime.spendTjs)).toBe(toCents(reportRow.spendTjs));
  });
});

describe("п. 11 — вес связи не ниже точности колонки", () => {
  it("0.0004 отклоняется схемой (adAllocation округлил бы его до нуля и молча снял объект); 0.001 проходит", () => {
    const id = "6f1c3a52-8f0e-4b8a-9f58-7d4a6a3c9b11";
    expect(setAdPropertiesBodySchema.safeParse({ items: [{ propertyId: id, weight: 0.0004 }] }).success).toBe(false);
    expect(setAdPropertiesBodySchema.safeParse({ items: [{ propertyId: id, weight: 0.001 }] }).success).toBe(true);
    expect(setAdPropertiesBodySchema.safeParse({ items: [{ propertyId: id }] }).success).toBe(true);
  });
});
