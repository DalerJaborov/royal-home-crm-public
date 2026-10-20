import bcrypt from "bcrypt";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Серверная часть «компактной Рекламы» (13.10.2026):
 *   1. /board — поле todayTjs (сегодня по Душанбе) и порядок строк: идут → живые без трат → остальные;
 *   2. /sync — флаг skipped;
 *   3. автопривязка по публикациям CRM (CRM_MEDIA): Property.publishedPostIds, фото-посты, истории;
 *   4. suggestProperties — комнаты, номер «№NNN» и цена как отдельные числа;
 *   5. заголовок креатива при одинаковой первой строке подписи.
 *
 * Graph API и лента Instagram замоканы.
 */

let creds: { enabled: boolean; token: string | null; adAccountIds: string[] } = {
  enabled: true,
  token: "test-token",
  adAccountIds: ["act_1"],
};

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
    fetchAccountSpendTotal: vi.fn(async () => 0),
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
const { boardGroupOf, suggestProperties } = await import("../src/routes/ads.js");
const { buildAdMatcher } = await import("../src/lib/ads/adMatching.js");
const { buildCreativeRanking, creativeTitle } = await import("../src/lib/ads/adCreativeRank.js");
const { setAdProperties } = await import("../src/lib/ads/adAllocation.js");
const { syncMetaAds } = await import("../src/lib/ads/syncMetaAds.js");
const { adSpendToTjsCents, fromCents, loadMoneyContext } = await import("../src/lib/money.js");
const { dushanbeDateString } = await import("../src/lib/dushanbeTime.js");

const runId = Date.now();
const password = "testpass123";

let adminToken = "";
let districtId = "";
let savedSyncedAt: Date | null = null;
const agentIds: string[] = [];
const propertyIds: string[] = [];
const adIds: string[] = [];

const get = (path: string, token: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);

/** Календарная дата «ГГГГ-ММ-ДД» со сдвигом в днях от даты по Душанбе. */
function dayShift(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function makeProperty(extra: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Тест-компакт-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 55,
      price: 45000,
      currency: "USD",
      districtId,
      address: `Компактная, ${propertyIds.length}`,
      condition: "GOOD",
      ...extra,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function makeAd(extra: Record<string, unknown> = {}) {
  const ad = await prisma.ad.create({
    data: {
      platform: "META",
      externalId: `compact-${runId}-${adIds.length}`,
      name: `Тест-компакт ${runId} ${adIds.length}`,
      adAccountId: "act_compact",
      status: "ACTIVE",
      lastSyncedAt: new Date(),
      ...extra,
    },
  });
  adIds.push(ad.id);
  return ad;
}

async function addSpend(adId: string, rows: { date: string; spend: number }[]) {
  for (const r of rows) {
    await prisma.adSpendDaily.create({
      data: {
        adId,
        date: new Date(`${r.date}T00:00:00.000Z`),
        spend: r.spend,
        currency: "USD",
        impressions: 100,
        clicks: 1,
        conversations: 1,
      },
    });
  }
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ компакт", phone: `+992981${String(runId).slice(-9)}`, role: "ADMIN", passwordHash },
  });
  agentIds.push(admin.id);
  const login = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  expect(login.status).toBe(200);
  adminToken = login.body.accessToken;

  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedSyncedAt = settings.metaAdsSyncedAt;
  districtId = (await prisma.district.create({ data: { name: `Тест-район-компакт-${runId}` } })).id;
});

afterAll(async () => {
  await prisma.propertyStoryPost.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyPhotoPost.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.adSpendDaily.deleteMany({ where: { adId: { in: adIds } } });
  await prisma.ad.deleteMany({ where: { id: { in: adIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { metaAdsSyncedAt: savedSyncedAt } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

describe("GET /ads/board: todayTjs и порядок", () => {
  it("todayTjs — расход за сегодня по Душанбе; строки: идут → живые без трат → остальные", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaAdsSyncedAt: new Date() } });
    const today = dushanbeDateString();

    const running = await makeAd({ matchSource: "CRM_MEDIA" });
    await addSpend(running.id, [
      { date: today, spend: 7 },
      { date: dayShift(today, -1), spend: 3 },
    ]);
    // Включено, но восемь дней не тратит, при этом в периоде потратило больше всех «живых».
    const stalled = await makeAd();
    await addSpend(stalled.id, [{ date: dayShift(today, -8), spend: 50 }]);
    // На проверке у Meta, трат нет.
    const review = await makeAd({ status: "PENDING_REVIEW" });
    // Выключено руками, но потратило больше всех: всё равно ниже живых.
    const paused = await makeAd({ status: "PAUSED" });
    await addSpend(paused.id, [{ date: dayShift(today, -5), spend: 500 }]);
    // Включено, но не потратило ни разу.
    const never = await makeAd();

    const res = await get(`/api/v1/ads/board?from=${dayShift(today, -30)}&to=${today}`, adminToken);
    expect(res.status).toBe(200);
    const rows = res.body.rows as { id: string; delivery: string; todayTjs: number; matchSource: string | null }[];

    const mine = rows.filter((r) => adIds.includes(r.id)).map((r) => r.id);
    expect(mine).toEqual([running.id, stalled.id, review.id, paused.id, never.id]);

    // Порядок групп по всей доске не убывает.
    const groups = rows.map((r) => boardGroupOf(r.delivery as Parameters<typeof boardGroupOf>[0]));
    expect(groups).toEqual([...groups].sort((a, b) => a - b));

    const money = await loadMoneyContext();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(running.id)?.delivery).toBe("RUNNING");
    expect(byId.get(running.id)?.matchSource).toBe("CRM_MEDIA");
    expect(byId.get(running.id)?.todayTjs).toBe(fromCents(adSpendToTjsCents([{ spend: 7, currency: "USD" }], money)));
    expect(byId.get(stalled.id)?.todayTjs).toBe(0);
    expect(byId.get(paused.id)?.todayTjs).toBe(0);
  });

  it("boardGroupOf: RUNNING=0, STALLED/REVIEW=1, остальное=2", () => {
    expect(boardGroupOf("RUNNING")).toBe(0);
    expect(boardGroupOf("STALLED")).toBe(1);
    expect(boardGroupOf("REVIEW")).toBe(1);
    for (const d of ["FINISHED", "PAUSED", "REJECTED", "NEVER"] as const) expect(boardGroupOf(d)).toBe(2);
  });
});

describe("POST /ads/sync: skipped", () => {
  it("прогон уже шёл (skipped: true) — ответ несёт skipped: true; обычный — skipped: false", async () => {
    vi.mocked(syncMetaAds).mockResolvedValueOnce({
      days: 7,
      ads: 0,
      matched: 0,
      unmatched: 0,
      brand: 0,
      foreign: 0,
      spendRows: 0,
      skipped: true,
    } as Awaited<ReturnType<typeof syncMetaAds>>);
    const skipped = await request(app).post("/api/v1/ads/sync").set("Authorization", `Bearer ${adminToken}`).send({});
    expect(skipped.status).toBe(200);
    expect(skipped.body.skipped).toBe(true);

    vi.mocked(syncMetaAds).mockResolvedValueOnce({ days: 7, ads: 3, matched: 2, foreign: 0, spendRows: 5 } as Awaited<
      ReturnType<typeof syncMetaAds>
    >);
    const done = await request(app).post("/api/v1/ads/sync").set("Authorization", `Bearer ${adminToken}`).send({});
    expect(done.status).toBe(200);
    expect(done.body.skipped).toBe(false);
    expect(done.body.ads).toBe(3);
  });
});

describe("Автопривязка по публикациям CRM (CRM_MEDIA)", () => {
  it("находит объект по publishedPostIds, фото-посту и истории; хвост storyId; неоднозначное и снятое — нет", async () => {
    const tag = String(runId);
    const video = await makeProperty({
      publishedPostIds: { INSTAGRAM: `ig${tag}`, FACEBOOK: `fbv${tag}`, FACEBOOK_POST: `7777_fbp${tag}` },
    });
    const photo = await makeProperty();
    const story = await makeProperty();
    await prisma.propertyPhotoPost.createMany({
      data: [
        { propertyId: photo.id, channel: "INSTAGRAM", status: "PUBLISHED", mediaId: `ph${tag}` },
        { propertyId: photo.id, channel: "INSTAGRAM", status: "REMOVED", mediaId: `phrem${tag}` },
        { propertyId: photo.id, channel: "FACEBOOK", status: "PUBLISHED", mediaId: `dup${tag}` },
      ],
    });
    await prisma.propertyStoryPost.createMany({
      data: [
        { propertyId: story.id, channel: "INSTAGRAM", mediaId: `st${tag}` },
        { propertyId: story.id, channel: "INSTAGRAM", mediaId: `dup${tag}`, partIndex: 1 },
      ],
    });

    const matcher = await buildAdMatcher({ heal: false });

    expect(await matcher.match({ mediaId: `ig${tag}` })).toEqual({ propertyId: video.id, source: "CRM_MEDIA" });
    expect(await matcher.match({ mediaId: `fbv${tag}` })).toEqual({ propertyId: video.id, source: "CRM_MEDIA" });
    // Хвост storyId («{страница}_{пост}») совпадает с постом Facebook, страница может быть любой.
    expect(await matcher.match({ storyId: `9999_fbp${tag}` })).toEqual({ propertyId: video.id, source: "CRM_MEDIA" });
    expect(await matcher.match({ mediaId: `ph${tag}` })).toEqual({ propertyId: photo.id, source: "CRM_MEDIA" });
    expect(await matcher.match({ mediaId: `st${tag}` })).toEqual({ propertyId: story.id, source: "CRM_MEDIA" });

    // Снятый фото-пост — не доказательство; один id у двух объектов — гадать нельзя.
    expect(await matcher.match({ mediaId: `phrem${tag}` })).toBeNull();
    expect(await matcher.match({ mediaId: `dup${tag}` })).toBeNull();
    expect(await matcher.match({ mediaId: `unknown${tag}` })).toBeNull();

    // К публикации добавляется объект из названия: основной — тот, что доказан публикацией.
    const all = await matcher.matchAll({ mediaId: `ig${tag}`, name: `Кампания №${story.shortId}` });
    expect(all.matches.map((m) => [m.propertyId, m.source])).toEqual([
      [video.id, "CRM_MEDIA"],
      [story.id, "ENTITY_NAME"],
    ]);
    expect(matcher.isOurs({ mediaId: `st${tag}` })).toBe(true);
  });

  it("источник CRM_MEDIA записывается в базу", async () => {
    const property = await makeProperty();
    const ad = await makeAd();
    await setAdProperties(ad.id, [{ propertyId: property.id, weight: 1 }], "CRM_MEDIA");
    const saved = await prisma.ad.findUniqueOrThrow({ where: { id: ad.id }, select: { matchSource: true, propertyId: true } });
    expect(saved).toEqual({ matchSource: "CRM_MEDIA", propertyId: property.id });
  });
});

describe("suggestProperties", () => {
  const base = {
    title: "т",
    address: null as string | null,
    price: 1,
    currency: "USD",
    rooms: null as number | null,
    status: "AVAILABLE",
    district: null as { name: string } | null,
    photos: [] as { thumbUrl: string }[],
  };

  it("признак «комнаты» срабатывает («3-комнатная» + район = кандидат)", () => {
    const p = { ...base, id: "p1", shortId: 7001, rooms: 3, district: { name: "Сино" } };
    expect(suggestProperties("Продаётся 3-комнатная квартира в Сино", [p]).map((c) => c.id)).toEqual(["p1"]);
    // «13 комнат» — не три комнаты.
    expect(suggestProperties("Продаётся 13 комнат в Сино", [p])).toEqual([]);
  });

  it("номер объекта — только «№NNN»/«#NNN» с границей: число в цене и телефоне номером не считается", () => {
    const p = { ...base, id: "p2", shortId: 131 };
    expect(suggestProperties("цена 105131 сомони, звоните 900131131", [p])).toEqual([]);
    expect(suggestProperties("Объект №1310", [p])).toEqual([]);
    expect(suggestProperties("Объект №131.", [p]).map((c) => c.id)).toEqual(["p2"]);
    expect(suggestProperties("объект #131 в центре", [p]).map((c) => c.id)).toEqual(["p2"]);
    expect(suggestProperties("Объект № 131", [p]).map((c) => c.id)).toEqual(["p2"]);
  });

  it("цена — отдельное число, а не кусок чужого", () => {
    const p = { ...base, id: "p3", shortId: 9003, price: 105000 };
    expect(suggestProperties("тел 7105000999", [p])).toEqual([]);
    expect(suggestProperties("Цена 105 000 $", [p]).map((c) => c.id)).toEqual(["p3"]);
    expect(suggestProperties("Цена 105000", [p]).map((c) => c.id)).toEqual(["p3"]);
  });
});

describe("Заголовок креатива при одинаковой первой строке", () => {
  it("creativeTitle: номер объекта, а без объекта — название кампании", () => {
    expect(creativeTitle("Продаётся квартира:", 12, "Кампания")).toBe("Продаётся квартира: · №12");
    expect(creativeTitle("Продаётся квартира:", undefined, "Кампания")).toBe("Продаётся квартира: · Кампания");
  });

  it("рейтинг: повторяющаяся строка получает суффикс, уникальная остаётся как есть", async () => {
    const from = new Date("2025-04-01T00:00:00.000Z");
    const to = new Date("2025-04-30T00:00:00.000Z");
    const property = await makeProperty();
    const line = `Продаётся квартира:`;

    const withObject = await makeAd({ caption: `${line}\nУлица ${runId}`, campaignName: `Камп-А ${runId}` });
    await setAdProperties(withObject.id, [{ propertyId: property.id, weight: 1 }], "MANUAL");
    const noObject = await makeAd({ caption: `${line}\nДругая ${runId}`, campaignName: `Камп-Б ${runId}` });
    const unique = await makeAd({ caption: `Уникальная строка ${runId}`, campaignName: `Камп-В ${runId}` });
    for (const ad of [withObject, noObject, unique]) await addSpend(ad.id, [{ date: "2025-04-10", spend: 20 }]);

    const ranking = await buildCreativeRanking({ from, to, label: "апрель 2025" });
    const titleOf = (id: string) => ranking.rows.find((r) => r.adId === id)?.title;
    expect(titleOf(withObject.id)).toBe(`${line} · №${property.shortId}`);
    expect(titleOf(noObject.id)).toBe(`${line} · Камп-Б ${runId}`);
    expect(titleOf(unique.id)).toBe(`Уникальная строка ${runId}`);
  });
});
