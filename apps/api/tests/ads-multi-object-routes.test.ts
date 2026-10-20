import bcrypt from "bcrypt";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Роуты рекламы про «одно объявление — несколько объектов» (03.10.2026):
 * PATCH /ads/:id/properties, /board с объектами, /property/:id долей, /trend,
 * /leaderboard, /reconcile и дедупликация записей сторожа.
 *
 * Деньги тестового объявления лежат в марте 2025: окно, в котором в общей базе
 * нет других данных, — иначе сверка итогов зависела бы от содержимого стенда.
 */

let creds: { enabled: boolean; token: string | null; adAccountIds: string[] } = {
  enabled: false,
  token: null,
  adAccountIds: [],
};
let metaTotal: number | Error = 0;

vi.mock("../src/lib/ads/metaAdsApi.js", async (importOriginal) => {
  class MetaAdsTokenError extends Error {}
  return {
    ...(await importOriginal<typeof import("../src/lib/ads/metaAdsApi.js")>()),
    loadMetaAdsCredentials: vi.fn(async () => creds),
    isMetaAdsConfigured: (c: { enabled: boolean; token: string | null; adAccountIds: string[] }) =>
      c.enabled && !!c.token && c.adAccountIds.length > 0,
    fetchAdAccountDetails: vi.fn(async () => null),
    fetchMetaAds: vi.fn(async () => []),
    fetchMetaAdSets: vi.fn(async () => ({ byId: new Map(), partial: false })),
    fetchMetaAdDailyStats: vi.fn(async () => []),
    fetchAdAccountCurrency: vi.fn(async () => "USD" as const),
    fetchAccountSpendTotal: vi.fn(async () => {
      if (metaTotal instanceof Error) throw metaTotal;
      return metaTotal;
    }),
    parseAdAccountIds: (raw: string | null) =>
      (raw ?? "").split(/[\s,;]+/).filter(Boolean).map((p) => `act_${p.replace(/\D/g, "")}`),
    MetaAdsTokenError,
  };
});

vi.mock("../src/lib/ads/syncMetaAds.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ads/syncMetaAds.js")>()),
  FULL_SYNC_DAYS: 90,
  syncMetaAds: vi.fn(async () => ({ days: 7, ads: 0, matched: 0, foreign: 0, spendRows: 0 })),
  // Крон-обёртку роут вызывает при протухших данных — в тестах синхронизации нет.
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
const { logAdIssues } = await import("../src/lib/ads/adReconcile.js");
const { centsToTjs, loadMoneyContext, toCents } = await import("../src/lib/money.js");

const runId = Date.now();
const password = "testpass123";
const FROM = "2025-03-01";
const TO = "2025-03-31";
const PERIOD = `from=${FROM}&to=${TO}`;

let adminToken = "";
let agentToken = "";
const agentIds: string[] = [];
let districtId = "";
const propertyIds: string[] = [];
const adIds: string[] = [];
let savedSyncedAt: Date | null = null;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken;
}
const get = (path: string, token: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);
const patch = (path: string, token: string, body: unknown) =>
  request(app).patch(path).set("Authorization", `Bearer ${token}`).send(body as object);

async function makeProperty(i: number) {
  const p = await prisma.property.create({
    data: {
      title: `Тест-мульти-роуты-${runId}-${i}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 55,
      price: 45000,
      currency: "USD",
      districtId,
      address: `Мультироуты, ${i}`,
      condition: "GOOD",
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function makeAd(extra: Record<string, unknown> = {}) {
  const ad = await prisma.ad.create({
    data: {
      platform: "META",
      externalId: `multi-routes-${runId}-${adIds.length}`,
      name: `Тест-мульти-объявление ${runId} ${adIds.length}`,
      adAccountId: "act_multi",
      status: "PAUSED",
      lastSyncedAt: new Date(),
      ...extra,
    },
  });
  adIds.push(ad.id);
  return ad;
}

async function addSpend(adId: string, rows: { date: string; spend: number; conversations: number; impressions: number }[]) {
  for (const r of rows) {
    await prisma.adSpendDaily.create({
      data: {
        adId,
        date: new Date(`${r.date}T00:00:00.000Z`),
        spend: r.spend,
        currency: "USD",
        impressions: r.impressions,
        clicks: 1,
        conversations: r.conversations,
      },
    });
  }
}

/** 10.01 + 20.02 + 5.03 = 35.06 доллара: в центах не делится на четыре и на три. */
const SPEND = [
  { date: "2025-03-10", spend: 10.01, conversations: 3, impressions: 101 },
  { date: "2025-03-12", spend: 20.02, conversations: 3, impressions: 202 },
  { date: "2025-03-15", spend: 5.03, conversations: 1, impressions: 303 },
];
const TOTAL_CONVERSATIONS = 7;
const TOTAL_IMPRESSIONS = 606;

let flexAdId = "";
let incompleteAdId = "";
let orphanAdId = "";
let props: { id: string; shortId: number }[] = [];
let expectedTjsCents = 0;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const [admin, agent] = await Promise.all([
    prisma.agent.create({ data: { fullName: "Админ мульти", phone: `+992971${runId}`, role: "ADMIN", passwordHash } }),
    prisma.agent.create({ data: { fullName: "Агент мульти", phone: `+992972${runId}`, role: "AGENT", passwordHash } }),
  ]);
  agentIds.push(admin.id, agent.id);
  adminToken = await login(admin.phone);
  agentToken = await login(agent.phone);

  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedSyncedAt = settings.metaAdsSyncedAt;

  districtId = (await prisma.district.create({ data: { name: `Тест-район-мульти-роуты-${runId}` } })).id;
  props = [await makeProperty(0), await makeProperty(1), await makeProperty(2), await makeProperty(3)];

  // Объявление «Умед хонахо»: один материал-объявление, четыре объекта.
  const flex = await makeAd({ assetCount: 4 });
  flexAdId = flex.id;
  await setAdProperties(flex.id, props.map((p) => ({ propertyId: p.id, weight: 1 })), "FEED_CAPTION");
  await addSpend(flex.id, SPEND);

  // Неполное: четыре материала, найдено два.
  const incomplete = await makeAd({ assetCount: 4 });
  incompleteAdId = incomplete.id;
  await setAdProperties(incomplete.id, [{ propertyId: props[0].id, weight: 1 }, { propertyId: props[1].id, weight: 1 }], "FEED_CAPTION");
  await addSpend(incomplete.id, [{ date: "2025-03-11", spend: 3, conversations: 0, impressions: 10 }]);

  // Тратит и никому не принадлежит.
  const orphan = await makeAd();
  orphanAdId = orphan.id;
  await addSpend(orphan.id, [{ date: "2025-03-11", spend: 2, conversations: 0, impressions: 5 }]);

  const money = await loadMoneyContext();
  expectedTjsCents = SPEND.reduce((acc, r) => acc + centsToTjs(toCents(r.spend), "USD", money), 0);
});

afterAll(async () => {
  await prisma.errorLog.deleteMany({ where: { source: "ads", message: { contains: String(runId) } } });
  await prisma.adSpendDaily.deleteMany({ where: { adId: { in: adIds } } });
  await prisma.ad.deleteMany({ where: { id: { in: adIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { metaAdsSyncedAt: savedSyncedAt } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

describe("PATCH /ads/:id/properties", () => {
  it("агенту без прав — 403; кривое тело — 400; неизвестный объект — 404; неизвестное объявление — 404", async () => {
    const items = [{ propertyId: props[0].id, weight: 1 }];
    expect((await patch(`/api/v1/ads/${flexAdId}/properties`, agentToken, { items })).status).toBe(403);
    expect((await patch(`/api/v1/ads/${flexAdId}/properties`, adminToken, { items: [{ propertyId: "не-uuid" }] })).status).toBe(400);
    expect((await patch(`/api/v1/ads/${flexAdId}/properties`, adminToken, { items: [{ propertyId: props[0].id, weight: -1 }] })).status).toBe(400);
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await patch(`/api/v1/ads/${flexAdId}/properties`, adminToken, { items: [{ propertyId: missing, weight: 1 }] })).status).toBe(404);
    expect((await patch(`/api/v1/ads/${missing}/properties`, adminToken, { items })).status).toBe(404);
  });

  it("раскладывает объявление по объектам с весами (MANUAL), пустой список снимает привязку", async () => {
    const ad = await makeAd();
    const res = await patch(`/api/v1/ads/${ad.id}/properties`, adminToken, {
      items: [
        { propertyId: props[0].id, weight: 1 },
        { propertyId: props[2].id, weight: 3 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.propertyId).toBe(props[2].id);
    expect(res.body.matchSource).toBe("MANUAL");
    expect(res.body.items.map((i: { propertyId: string }) => i.propertyId)).toEqual([props[2].id, props[0].id]);

    const cleared = await patch(`/api/v1/ads/${ad.id}/properties`, adminToken, { items: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ propertyId: null, matchSource: null, items: [] });
    expect(await prisma.adProperty.count({ where: { adId: ad.id } })).toBe(0);
  });

  it("старый PATCH /:id/property идёт через тот же хелпер: основной объект и доля совпадают", async () => {
    const ad = await makeAd();
    const res = await patch(`/api/v1/ads/${ad.id}/property`, adminToken, { propertyId: props[1].id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: ad.id, propertyId: props[1].id, matchSource: "MANUAL" });
    const rows = await prisma.adProperty.findMany({ where: { adId: ad.id } });
    expect(rows.map((r) => r.propertyId)).toEqual([props[1].id]);
  });
});

describe("деньги по объектам: расход объявления делится, а не дублируется", () => {
  it("/board: у строки четыре объекта, сумма их расхода и обращений равна объявлению до цента", async () => {
    const res = await get(`/api/v1/ads/board?${PERIOD}`, adminToken);
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { id: string }) => r.id === flexAdId);
    expect(row).toBeTruthy();

    expect(row.properties).toHaveLength(4);
    expect(row.assetCount).toBe(4);
    expect(row.needsReview).toBe(false);
    // Совместимость: property — основной объект (первый по весу).
    expect(row.property.id).toBe(row.properties[0].id);

    const spendCents = row.properties.reduce((acc: number, p: { spendTjs: number }) => acc + toCents(p.spendTjs), 0);
    expect(spendCents).toBe(toCents(row.period.spendTjs));
    expect(spendCents).toBe(expectedTjsCents);
    expect(row.properties.reduce((acc: number, p: { conversations: number }) => acc + p.conversations, 0)).toBe(TOTAL_CONVERSATIONS);
    expect(row.properties.reduce((acc: number, p: { share: number }) => acc + p.share, 0)).toBeCloseTo(1, 9);
    for (const p of row.properties) expect(p.share).toBeCloseTo(0.25, 9);
  });

  it("/board: неполное объявление помечено needsReview, ручная привязка — нет", async () => {
    const res = await get(`/api/v1/ads/board?${PERIOD}`, adminToken);
    const incomplete = res.body.rows.find((r: { id: string }) => r.id === incompleteAdId);
    expect(incomplete.properties).toHaveLength(2);
    expect(incomplete.assetCount).toBe(4);
    expect(incomplete.needsReview).toBe(true);

    await setAdProperties(incompleteAdId, [{ propertyId: props[0].id, weight: 1 }, { propertyId: props[1].id, weight: 1 }], "MANUAL");
    const after = await get(`/api/v1/ads/board?${PERIOD}`, adminToken);
    expect(after.body.rows.find((r: { id: string }) => r.id === incompleteAdId).needsReview).toBe(false);
    // Вернуть как было для следующих тестов.
    await setAdProperties(incompleteAdId, [{ propertyId: props[0].id, weight: 1 }, { propertyId: props[1].id, weight: 1 }], "FEED_CAPTION");
  });

  it("/report (по объектам): четыре строки в сумме дают расход объявления, объявление одно в каждой", async () => {
    const res = await get(`/api/v1/ads/report?${PERIOD}`, adminToken);
    expect(res.status).toBe(200);
    // Объекты 2 и 3 получают долю только от «Умед хонахо»; объекты 0 и 1 — ещё и от неполного.
    const only = res.body.rows.filter((r: { property: { id: string } | null }) => r.property && [props[2].id, props[3].id].includes(r.property.id));
    expect(only).toHaveLength(2);
    for (const r of only) expect(r.adsCount).toBe(1);

    const all = res.body.rows.filter((r: { property: { id: string } | null }) => r.property && props.some((p) => p.id === r.property!.id));
    const incompleteCents = centsToTjs(toCents(3), "USD", await loadMoneyContext());
    expect(all.reduce((acc: number, r: { spendTjs: number }) => acc + toCents(r.spendTjs), 0)).toBe(expectedTjsCents + incompleteCents);
  });

  it("/property/:id: карточка объекта видит долю, а не весь расход объявления", async () => {
    const own = await get(`/api/v1/ads/property/${props[3].id}`, adminToken);
    expect(own.status).toBe(200);
    expect(own.body.ads).toBe(1);
    // Доля четвёртого объекта — не весь расход и не нулевая; сумма долей четырёх — весь расход.
    const spends: number[] = [];
    for (const p of props) {
      const r = await get(`/api/v1/ads/property/${p.id}`, adminToken);
      spends.push(toCents(r.body.spendTjs));
    }
    const incompleteCents = centsToTjs(toCents(3), "USD", await loadMoneyContext());
    expect(spends[3]).toBeGreaterThan(0);
    expect(spends[3]).toBeLessThan(expectedTjsCents);
    expect(spends.reduce((a, b) => a + b, 0)).toBe(expectedTjsCents + incompleteCents);
    expect(own.body.conversations).toBeLessThanOrEqual(TOTAL_CONVERSATIONS);
  });

  it("/property/:id: adsOfProperty — объявление на 4 объекта, доли и деньги сходятся с расходом объявления", async () => {
    const own = await get(`/api/v1/ads/property/${props[3].id}`, adminToken);
    expect(own.body.adsOfProperty).toHaveLength(1);
    expect(own.body.adsOfProperty[0]).toMatchObject({ adId: flexAdId, objectsInAd: 4 });
    expect(typeof own.body.adsOfProperty[0].name).toBe("string");
    expect(own.body.adsOfProperty[0].share).toBeCloseTo(0.25, 9);

    // Сумма денег объявления по четырём объектам — весь его расход до цента.
    let sumCents = 0;
    for (const p of props) {
      const r = await get(`/api/v1/ads/property/${p.id}`, adminToken);
      const mine = r.body.adsOfProperty.find((a: { adId: string }) => a.adId === flexAdId);
      expect(mine.objectsInAd).toBe(4);
      sumCents += toCents(mine.spendTjs);
    }
    expect(sumCents).toBe(expectedTjsCents);

    // Объект двух общих объявлений видит оба; общие вперёд по числу объектов.
    const two = await get(`/api/v1/ads/property/${props[0].id}`, adminToken);
    const ids = two.body.adsOfProperty.map((a: { adId: string }) => a.adId);
    expect(ids).toEqual(expect.arrayContaining([flexAdId, incompleteAdId]));
    expect(two.body.adsOfProperty[0].adId).toBe(flexAdId);
  });

  it("/property/:id: без права на финансы суммы и доли не отдаются", async () => {
    const r = await get(`/api/v1/ads/property/${props[3].id}`, agentToken);
    expect(r.status).toBe(200);
    expect(r.body.adsOfProperty).toBeUndefined();
  });

  it("/report: sharedAdsCount — число общих объявлений объекта; объект без общих — 0", async () => {
    const solo = await makeProperty(9);
    const soloAd = await makeAd();
    await setAdProperties(soloAd.id, [{ propertyId: solo.id, weight: 1 }], "FEED_CAPTION");
    await addSpend(soloAd.id, [{ date: "2025-03-11", spend: 4, conversations: 1, impressions: 20 }]);

    const res = await get(`/api/v1/ads/report?${PERIOD}`, adminToken);
    expect(res.status).toBe(200);
    const rowOf = (id: string) => res.body.rows.find((r: { property: { id: string } | null }) => r.property?.id === id);
    expect(rowOf(solo.id).sharedAdsCount).toBe(0);
    expect(rowOf(solo.id).adsCount).toBe(1);
    expect(rowOf(props[2].id).sharedAdsCount).toBe(1);
    expect(rowOf(props[3].id).sharedAdsCount).toBe(1);
    // Объекты 0 и 1 — в «Умед хонахо» и в неполном объявлении, оба общие.
    expect(rowOf(props[0].id).sharedAdsCount).toBe(2);
    expect(rowOf(props[1].id).sharedAdsCount).toBe(2);
    // «Не привязано» — не объект, общих объявлений у него нет.
    expect(res.body.rows.find((r: { property: unknown }) => r.property === null)?.sharedAdsCount ?? 0).toBe(0);

    const soloCard = await get(`/api/v1/ads/property/${solo.id}`, adminToken);
    expect(soloCard.body.adsOfProperty).toEqual([
      expect.objectContaining({ adId: soloAd.id, objectsInAd: 1, share: 1 }),
    ]);

    // Деньги этого объявления не должны попасть в итоги окна соседних тестов (/trend, /reconcile).
    await prisma.adSpendDaily.deleteMany({ where: { adId: soloAd.id } });
  });
});

describe("/trend и /leaderboard", () => {
  it("/trend: ряд по дням до конца периода, сумма равна расходу в окне, пустые дни — нулями", async () => {
    const res = await get(`/api/v1/ads/trend?${PERIOD}`, adminToken);
    expect(res.status).toBe(200);
    const points = res.body as { date: string; spendTjs: number; conversations: number; impressions: number }[];
    expect(points[0].date).toBe("2025-03-10");
    expect(points[points.length - 1].date).toBe(TO);
    expect(points.find((p) => p.date === "2025-03-13")).toMatchObject({ spendTjs: 0, conversations: 0, impressions: 0 });
    const money = await loadMoneyContext();
    const windowCents = expectedTjsCents + centsToTjs(toCents(3), "USD", money) + centsToTjs(toCents(2), "USD", money);
    expect(points.reduce((acc, p) => acc + toCents(p.spendTjs), 0)).toBe(windowCents);
    expect(points.reduce((acc, p) => acc + p.impressions, 0)).toBe(TOTAL_IMPRESSIONS + 10 + 5);
  });

  it("/trend: за пустой период — пустой ряд; кривой период — 400; агенту — 403", async () => {
    expect((await get("/api/v1/ads/trend?from=2019-01-01&to=2019-01-31", adminToken)).body).toEqual([]);
    expect((await get("/api/v1/ads/trend?from=2026-13-99&to=2026-13-99", adminToken)).status).toBe(400);
    expect((await get(`/api/v1/ads/trend?${PERIOD}`, agentToken)).status).toBe(403);
  });

  it("/leaderboard: объекты с обращениями по возрастанию цены, без обращений — в конце", async () => {
    const res = await get(`/api/v1/ads/leaderboard?${PERIOD}&limit=100`, adminToken);
    expect(res.status).toBe(200);
    const mine = (res.body as { propertyId: string; costPerConversationTjs: number | null; spendTjs: number }[]).filter((r) =>
      props.some((p) => p.id === r.propertyId)
    );
    expect(mine.length).toBeGreaterThanOrEqual(2);
    const priced = mine.filter((r) => r.costPerConversationTjs != null).map((r) => r.costPerConversationTjs!);
    expect(priced).toEqual([...priced].sort((a, b) => a - b));
    const firstNull = mine.findIndex((r) => r.costPerConversationTjs == null);
    if (firstNull >= 0) expect(mine.slice(firstNull).every((r) => r.costPerConversationTjs == null)).toBe(true);
    expect((await get(`/api/v1/ads/leaderboard?${PERIOD}&limit=1000`, adminToken)).status).toBe(400);
    expect((await get(`/api/v1/ads/leaderboard?${PERIOD}`, agentToken)).status).toBe(403);
  });
});

describe("/reconcile и сторож", () => {
  it("находит объявление без объекта и неполное; без подключённого кабинета итог Meta — null", async () => {
    creds = { enabled: false, token: null, adAccountIds: [] };
    const res = await get(`/api/v1/ads/reconcile?${PERIOD}`, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.metaTotalTjs).toBeNull();
    expect(res.body.diffPct).toBeNull();
    const kinds = (res.body.issues as { kind: string; adId: string | null }[]).filter((i) => i.adId != null);
    expect(kinds).toContainEqual({ kind: "NO_OBJECT", adId: orphanAdId, text: expect.any(String) });
    expect(kinds.some((i) => i.kind === "ASSETS_NOT_LINKED" && i.adId === incompleteAdId)).toBe(true);
    // «Умед хонахо» с четырьмя объектами из четырёх — к нему претензий нет, и деньги по долям сходятся.
    expect(kinds.some((i) => i.adId === flexAdId)).toBe(false);
    expect(res.body.ok).toBe(false);
  });

  it("SPEND_MISMATCH: итог кабинета не сходится — проблема; сходится в допуск — тишина; Meta молчит — STALE_SYNC без падения", async () => {
    creds = { enabled: true, token: "t", adAccountIds: ["act_multi"] };
    const money = await loadMoneyContext();
    const crmUsd = 35.06 + 3 + 2;
    // Каждое объявление переводится в сомони само по себе — так считает и сверка.
    const crmTjs = (expectedTjsCents + centsToTjs(toCents(3), "USD", money) + centsToTjs(toCents(2), "USD", money)) / 100;

    metaTotal = crmUsd; // кабинет Meta в долларах, CRM — те же деньги
    const ok = await get(`/api/v1/ads/reconcile?${PERIOD}`, adminToken);
    expect(ok.status).toBe(200);
    expect(ok.body.crmTotalTjs).toBeCloseTo(crmTjs, 2);
    expect(ok.body.issues.some((i: { kind: string }) => i.kind === "SPEND_MISMATCH")).toBe(false);
    expect(Math.abs(ok.body.diffPct)).toBeLessThan(0.5);

    // Новый период запроса — свой ключ кэша итога Meta.
    metaTotal = crmUsd * 2;
    const bad = await get(`/api/v1/ads/reconcile?from=${FROM}&to=2025-03-30`, adminToken);
    expect(bad.status).toBe(200);
    expect(bad.body.issues.some((i: { kind: string }) => i.kind === "SPEND_MISMATCH")).toBe(true);
    expect(bad.body.diffPct).toBeLessThan(-40);
    expect(bad.body.ok).toBe(false);

    metaTotal = new Error("Marketing API: недоступно");
    const down = await get(`/api/v1/ads/reconcile?from=${FROM}&to=2025-03-29`, adminToken);
    expect(down.status).toBe(200);
    expect(down.body.metaTotalTjs).toBeNull();
    expect(down.body.issues.some((i: { kind: string }) => i.kind === "STALE_SYNC")).toBe(true);

    creds = { enabled: false, token: null, adAccountIds: [] };
    metaTotal = 0;
  });

  it("запись в журнал — ОДИН раз на объявление и вид; исчезнувшая проблема ничего не пишет", async () => {
    const issue = { kind: "NO_OBJECT" as const, adId: `dedup-${runId}`, text: `«тест ${runId}»: тратит деньги, а объекта нет` };
    await logAdIssues([issue]);
    await logAdIssues([issue]);
    await logAdIssues([issue, { ...issue, kind: "AD_REJECTED" }]);
    const rows = await prisma.errorLog.findMany({ where: { source: "ads", dedupKey: { startsWith: `ads-issue:` }, message: { contains: String(runId) } } });
    expect(rows.filter((r) => r.dedupKey === `ads-issue:NO_OBJECT:dedup-${runId}`)).toHaveLength(1);
    expect(rows.filter((r) => r.dedupKey === `ads-issue:AD_REJECTED:dedup-${runId}`)).toHaveLength(1);

    const before = await prisma.errorLog.count({ where: { source: "ads", message: { contains: String(runId) } } });
    await logAdIssues([]);
    expect(await prisma.errorLog.count({ where: { source: "ads", message: { contains: String(runId) } } })).toBe(before);
  });
});
