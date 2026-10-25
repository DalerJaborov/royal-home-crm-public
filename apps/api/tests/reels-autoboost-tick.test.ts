import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * Автопродвижение роликов: исполнитель (runReelsAutoBoostTick) и роуты настроек.
 * Решения проверены отдельно (reels-autoboost-decide.test.ts) — здесь:
 *   - выключено → не делает ничего;
 *   - пробный режим → пишет PLANNED/PAUSED и НИ РАЗУ не обращается к Meta;
 *   - боевой режим → создаёт креатив и объявление один раз на публикацию, пауза и стоп-лосс
 *     доходят до Meta, отказ по одному ролику не валит остальные, нехватка настроек — в журнал, а не в падение;
 *   - права и проверка настроек в роуте.
 * Вызовы Meta замоканы целиком: сеть не нужна и не должна вызываться.
 */

const meta = vi.hoisted(() => ({
  creds: { enabled: true, token: "test-token" as string | null, adAccountIds: ["act_1"] },
  fetchAdSetInfo: vi.fn(async () => ({ accountId: "act_1", effectiveStatus: "ACTIVE" })),
  fetchAccountCurrency: vi.fn(async () => "USD" as string | null),
  fetchConnectedInstagramUserId: vi.fn(async () => "ig-user-1" as string | null),
  fetchBoostEligibility: vi.fn(async () => ({ eligible: true as boolean | null, reason: null as string | null })),
  createBoostCreative: vi.fn(async (_c: unknown, p: { mediaId: string }) => `creative-${p.mediaId}`),
  createBoostAd: vi.fn(async (_c: unknown, p: { creativeId: string }) => `ad-${p.creativeId}`),
  findAdByMediaId: vi.fn(async () => null as string | null),
  setAdStatus: vi.fn(async () => undefined),
  fetchAdSetAdStats: vi.fn(async () => new Map<string, { spend: number; conversations: number }>()),
}));

vi.mock("../src/lib/ads/metaAdsApi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ads/metaAdsApi.js")>()),
  loadMetaAdsCredentials: vi.fn(async () => meta.creds),
}));
vi.mock("../src/lib/ads/reelsAutoBoostMeta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ads/reelsAutoBoostMeta.js")>()),
  fetchAdSetInfo: meta.fetchAdSetInfo,
  fetchAccountCurrency: meta.fetchAccountCurrency,
  fetchConnectedInstagramUserId: meta.fetchConnectedInstagramUserId,
  fetchBoostEligibility: meta.fetchBoostEligibility,
  createBoostCreative: meta.createBoostCreative,
  createBoostAd: meta.createBoostAd,
  findAdByMediaId: meta.findAdByMediaId,
  setAdStatus: meta.setAdStatus,
  fetchAdSetAdStats: meta.fetchAdSetAdStats,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { runReelsAutoBoostTick } = await import("../src/lib/ads/reelsAutoBoost.js");

const runId = Date.now();
const password = "testpass123";
const NOW = new Date();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const TOUCHED = [
  "reelsAutoBoostEnabled",
  "reelsAutoBoostDryRun",
  "reelsAutoBoostAdSetId",
  "reelsAutoBoostMaxActive",
  "reelsAutoBoostMaxAgeDays",
  "reelsAutoBoostStopLossSpendUsd",
  "reelsAutoBoostCtaType",
  "metaPageId",
] as const;
let saved: Record<string, unknown> = {};
let districtId = "";
const propertyIds: string[] = [];
const agentIds: string[] = [];
let agentToken = "";
let marketingToken = "";

const media = (tag: string) => `igm-${runId}-${tag}`;

async function makeProperty(tag: string, over: Record<string, unknown> = {}, publishedHoursAgo = 2) {
  const p = await prisma.property.create({
    data: {
      title: `Тест-ролик-${tag}-${runId}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 60,
      price: 50000,
      currency: "USD",
      districtId,
      address: `Проверочная, ${tag}`,
      condition: "GOOD",
      status: "AVAILABLE",
      publishedOnSite: true,
      offSite: false,
      publishedChannels: ["INSTAGRAM"],
      publishedPostIds: { INSTAGRAM: media(tag), RAW_VIDEO_PUBLISHED_AT: hoursAgo(publishedHoursAgo).toISOString() },
      ...over,
    } as never,
  });
  propertyIds.push(p.id);
  return p;
}

const row = (tag: string) => prisma.reelAutoBoostAd.findUnique({ where: { instagramMediaId: media(tag) } });

async function configure(over: Record<string, unknown>) {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      reelsAutoBoostEnabled: true,
      reelsAutoBoostDryRun: true,
      reelsAutoBoostAdSetId: "120000000000001",
      reelsAutoBoostMaxActive: 200,
      reelsAutoBoostMaxAgeDays: 10,
      reelsAutoBoostStopLossSpendUsd: 4,
      reelsAutoBoostCtaType: "WHATSAPP_MESSAGE",
      metaPageId: "page-1",
      ...over,
    },
  });
}

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken;
}

beforeAll(async () => {
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = Object.fromEntries(TOUCHED.map((k) => [k, (settings as Record<string, unknown>)[k]]));
  districtId = (await prisma.district.create({ data: { name: `Тест-район-reels-boost-${runId}` } })).id;
  const passwordHash = await bcrypt.hash(password, 10);
  const [agent, marketing] = await Promise.all([
    prisma.agent.create({ data: { fullName: "Агент ролики", phone: `+992971${runId}`, role: "AGENT", passwordHash } }),
    prisma.agent.create({ data: { fullName: "Маркетолог ролики", phone: `+992972${runId}`, role: "MARKETING", passwordHash } }),
  ]);
  agentIds.push(agent.id, marketing.id);
  agentToken = await login(agent.phone);
  marketingToken = await login(marketing.phone);
});

afterAll(async () => {
  await prisma.reelAutoBoostAd.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

beforeEach(() => {
  vi.clearAllMocks();
  meta.creds = { enabled: true, token: "test-token", adAccountIds: ["act_1"] };
  meta.fetchAccountCurrency.mockResolvedValue("USD");
  meta.fetchConnectedInstagramUserId.mockResolvedValue("ig-user-1");
  meta.fetchBoostEligibility.mockResolvedValue({ eligible: true, reason: null });
  meta.createBoostCreative.mockImplementation(async (_c, p) => `creative-${p.mediaId}`);
  meta.createBoostAd.mockImplementation(async (_c, p) => `ad-${p.creativeId}`);
  meta.findAdByMediaId.mockResolvedValue(null);
  meta.fetchAdSetAdStats.mockResolvedValue(new Map());
});

const metaCalls = () =>
  Object.values(meta)
    .filter((v): v is ReturnType<typeof vi.fn> => typeof v === "function")
    .reduce((n, fn) => n + fn.mock.calls.length, 0);

describe("выключено", () => {
  it("ничего не делает: ни строк, ни обращений к Meta", async () => {
    const p = await makeProperty("off");
    await configure({ reelsAutoBoostEnabled: false });
    const res = await runReelsAutoBoostTick();
    expect(res).toMatchObject({ ran: false, note: "выключено" });
    expect(await row("off")).toBeNull();
    expect(metaCalls()).toBe(0);
    expect(p.id).toBeTruthy();
  });
});

describe("пробный режим", () => {
  it("пишет PLANNED, повтор не дублирует, в Meta не ходит; проданный объект → PAUSED", async () => {
    const p = await makeProperty("dry");
    await configure({ reelsAutoBoostDryRun: true });

    const first = await runReelsAutoBoostTick();
    expect(first.ran).toBe(true);
    const planned = await row("dry");
    expect(planned).toMatchObject({ status: "PLANNED", propertyId: p.id, metaAdId: null });
    expect(planned?.reason).toMatch(/пробный режим/);

    await runReelsAutoBoostTick();
    expect(await prisma.reelAutoBoostAd.count({ where: { instagramMediaId: media("dry") } })).toBe(1);

    await prisma.property.update({ where: { id: p.id }, data: { status: "SOLD" } });
    await runReelsAutoBoostTick();
    const paused = await row("dry");
    expect(paused?.status).toBe("PAUSED");
    expect(paused?.reason).toMatch(/продан/);
    expect(metaCalls()).toBe(0);
  });

  it("ролик без даты публикации не планируется (нет данных — нет решения)", async () => {
    await makeProperty("nodate", { publishedPostIds: { INSTAGRAM: media("nodate") } });
    await configure({ reelsAutoBoostDryRun: true });
    await runReelsAutoBoostTick();
    expect(await row("nodate")).toBeNull();
  });

  it("ролик старше срока не планируется", async () => {
    await makeProperty("stale", {}, 24 * 11);
    await configure({ reelsAutoBoostDryRun: true });
    await runReelsAutoBoostTick();
    expect(await row("stale")).toBeNull();
  });
});

describe("боевой режим", () => {
  it("создаёт креатив и объявление один раз; повтор тика ничего не создаёт", async () => {
    const p = await makeProperty("live");
    await configure({ reelsAutoBoostDryRun: false });

    await runReelsAutoBoostTick();
    const ad = await row("live");
    expect(ad).toMatchObject({ status: "ACTIVE", propertyId: p.id, metaCreativeId: `creative-${media("live")}`, metaAdId: `ad-creative-${media("live")}` });
    expect(meta.createBoostCreative).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mediaId: media("live"), pageId: "page-1", instagramUserId: "ig-user-1", accountId: "act_1", cta: "WHATSAPP_MESSAGE" })
    );
    expect(meta.createBoostAd).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ adSetId: "120000000000001", status: "ACTIVE" }));

    meta.createBoostCreative.mockClear();
    await runReelsAutoBoostTick();
    expect(meta.createBoostCreative.mock.calls.filter((c) => c[1].mediaId === media("live"))).toHaveLength(0);
  });

  it("Meta считает публикацию непригодной → SKIPPED, объявление не создаётся", async () => {
    await makeProperty("skip");
    await configure({ reelsAutoBoostDryRun: false });
    meta.fetchBoostEligibility.mockImplementation(async () => ({ eligible: false, reason: "лицензионная музыка" }));
    await runReelsAutoBoostTick();
    const r = await row("skip");
    expect(r?.status).toBe("SKIPPED");
    expect(r?.reason).toMatch(/лицензионная музыка/);
    expect(meta.createBoostCreative.mock.calls.filter((c) => c[1].mediaId === media("skip"))).toHaveLength(0);
  });

  it("отказ Meta по одному ролику → FAILED у него, остальные созданы", async () => {
    await makeProperty("bad");
    await makeProperty("good");
    await configure({ reelsAutoBoostDryRun: false });
    meta.createBoostCreative.mockImplementation(async (_c, p) => {
      if (p.mediaId === media("bad")) throw new Error("Marketing API: (#200) нет права ads_management");
      return `creative-${p.mediaId}`;
    });
    const res = await runReelsAutoBoostTick();
    expect(res.failed).toBeGreaterThanOrEqual(1);
    const bad = await row("bad");
    expect(bad?.status).toBe("FAILED");
    expect(bad?.reason).toMatch(/ads_management/);
    expect((await row("good"))?.status).toBe("ACTIVE");
    const err = await prisma.errorLog.findFirst({ where: { message: { contains: "объявление для" }, source: "ads" } });
    expect(err).not.toBeNull();
  });

  it("стоп-лосс: расход ≥ порога при нуле переписок → пауза в Meta и в журнале", async () => {
    const p = await makeProperty("loss");
    await configure({ reelsAutoBoostDryRun: false });
    await prisma.reelAutoBoostAd.create({
      data: { propertyId: p.id, instagramMediaId: media("loss"), status: "ACTIVE", metaAdId: "ad-loss", reason: "тест", attempts: 1 },
    });
    meta.fetchAdSetAdStats.mockResolvedValue(new Map([["ad-loss", { spend: 4.5, conversations: 0 }]]));
    await runReelsAutoBoostTick();
    const r = await row("loss");
    expect(r?.status).toBe("PAUSED");
    expect(r?.reason).toMatch(/стоп-лосс/);
    expect(Number(r?.spendUsd)).toBe(4.5);
    expect(meta.setAdStatus).toHaveBeenCalledWith(expect.anything(), "ad-loss", "PAUSED");
  });

  it("есть переписки → продолжает идти, цифры обновлены", async () => {
    const p = await makeProperty("win");
    await configure({ reelsAutoBoostDryRun: false });
    await prisma.reelAutoBoostAd.create({
      data: { propertyId: p.id, instagramMediaId: media("win"), status: "ACTIVE", metaAdId: "ad-win", reason: "тест", attempts: 1 },
    });
    meta.fetchAdSetAdStats.mockResolvedValue(new Map([["ad-win", { spend: 9, conversations: 3 }]]));
    await runReelsAutoBoostTick();
    const r = await row("win");
    expect(r).toMatchObject({ status: "ACTIVE", conversations: 3 });
    expect(meta.setAdStatus).not.toHaveBeenCalledWith(expect.anything(), "ad-win", "PAUSED");
  });

  it("нет номера группы объявлений → понятная запись в журнал, без падения и без обращений к Meta", async () => {
    await makeProperty("noset");
    await configure({ reelsAutoBoostDryRun: false, reelsAutoBoostAdSetId: null });
    const res = await runReelsAutoBoostTick();
    expect(res).toMatchObject({ ran: false });
    expect(res.note).toMatch(/группы объявлений/);
    expect(metaCalls()).toBe(0);
    expect(await row("noset")).toBeNull();
  });

  it("нет маркера → в журнал, не падает", async () => {
    await configure({ reelsAutoBoostDryRun: false });
    meta.creds = { enabled: true, token: null, adAccountIds: [] };
    const res = await runReelsAutoBoostTick();
    expect(res.ran).toBe(false);
    expect(res.note).toMatch(/ads_management/);
  });

  it("кабинет не в долларах → боевой режим не включается", async () => {
    await configure({ reelsAutoBoostDryRun: false });
    meta.fetchAccountCurrency.mockResolvedValue("TJS");
    const res = await runReelsAutoBoostTick();
    expect(res.ran).toBe(false);
    expect(res.note).toMatch(/TJS/);
    expect(meta.createBoostCreative).not.toHaveBeenCalled();
  });

  it("PLANNED из пробного режима при переходе в боевой получает настоящее объявление", async () => {
    await makeProperty("promote");
    await configure({ reelsAutoBoostDryRun: true });
    await runReelsAutoBoostTick();
    expect((await row("promote"))?.status).toBe("PLANNED");
    await configure({ reelsAutoBoostDryRun: false });
    await runReelsAutoBoostTick();
    const r = await row("promote");
    expect(r?.status).toBe("ACTIVE");
    expect(r?.metaAdId).toBeTruthy();
  });
});

describe("роуты /ads/reels-autoboost", () => {
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it("агент без финансов — 403, без маркера — 401", async () => {
    expect((await request(app).get("/api/v1/ads/reels-autoboost")).status).toBe(401);
    expect((await request(app).get("/api/v1/ads/reels-autoboost").set(auth(agentToken))).status).toBe(403);
    expect((await request(app).patch("/api/v1/ads/reels-autoboost").set(auth(agentToken)).send({ enabled: true })).status).toBe(403);
  });

  it("маркетолог читает статус и меняет настройки", async () => {
    await configure({ reelsAutoBoostEnabled: false, reelsAutoBoostDryRun: true });
    const got = await request(app).get("/api/v1/ads/reels-autoboost").set(auth(marketingToken));
    expect(got.status).toBe(200);
    expect(got.body.settings).toMatchObject({ enabled: false, dryRun: true, ctaType: "WHATSAPP_MESSAGE" });
    expect(Object.keys(got.body.counts).sort()).toEqual(["ACTIVE", "FAILED", "PAUSED", "PLANNED", "SKIPPED"]);

    const patched = await request(app)
      .patch("/api/v1/ads/reels-autoboost")
      .set(auth(marketingToken))
      .send({ maxActive: 12, stopLossSpendUsd: 2.5, adSetId: " 120000000000009 ".trim(), ctaType: "INSTAGRAM_DIRECT" });
    expect(patched.status).toBe(200);
    expect(patched.body.settings).toMatchObject({ maxActive: 12, stopLossSpendUsd: 2.5, adSetId: "120000000000009", ctaType: "INSTAGRAM_DIRECT" });
  });

  it("мусор в настройках → 400", async () => {
    for (const bad of [{ maxActive: 0 }, { maxAgeDays: 999 }, { ctaType: "CALL_NOW" }, { adSetId: "abc" }, { unknown: 1 }]) {
      const res = await request(app).patch("/api/v1/ads/reels-autoboost").set(auth(marketingToken)).send(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("боевой режим без номера группы объявлений не включается", async () => {
    await configure({ reelsAutoBoostEnabled: false, reelsAutoBoostDryRun: true, reelsAutoBoostAdSetId: null });
    const res = await request(app)
      .patch("/api/v1/ads/reels-autoboost")
      .set(auth(marketingToken))
      .send({ enabled: true, dryRun: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/группы объявлений/);
    const ok = await request(app).patch("/api/v1/ads/reels-autoboost").set(auth(marketingToken)).send({ enabled: true, dryRun: true });
    expect(ok.status).toBe(200);
  });

  it("«проверить сейчас» в пробном режиме отвечает результатом и обзором", async () => {
    await configure({ reelsAutoBoostEnabled: true, reelsAutoBoostDryRun: true });
    const res = await request(app).post("/api/v1/ads/reels-autoboost/run").set(auth(marketingToken)).send({});
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ ran: true, dryRun: true });
    expect(res.body.overview.rows).toBeInstanceOf(Array);
  });
});
