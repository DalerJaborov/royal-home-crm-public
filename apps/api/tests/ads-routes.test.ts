import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * Роуты рекламного кабинета (/api/v1/ads) — деньги и OAuth, до 26.08.2026 без
 * единого теста.
 *
 * Что проверяется и почему именно это:
 *   1. ПРАВА. Читающие ручки открыты роли MARKETING и праву finance.view, пишущие —
 *      MARKETING и finance.manage. Ошибка здесь показывает расходы на рекламу
 *      любому агенту — это ровно те цифры, которые владелец просил не раздавать.
 *   2. OAUTH-CALLBACK. Возврат из Facebook приходит БЕЗ маркера CRM (роутер
 *      смонтирован до requireAuth) — единственная защита это одноразовый state.
 *      Чужой/битый state обязан приводить к отказу, а не к обмену кода на маркер.
 *   3. ВАЛИДАЦИЯ. Мусор в query/body отвечает 400, а не роняет процесс.
 *   4. HAPPY-PATH читающих ручек на замоканном Graph API — реальных походов
 *      в Meta из тестов быть не должно.
 *
 * Graph API замокан целиком (metaAdsApi, syncMetaAds, лента Instagram, ИИ-разбор):
 * сеть в этих тестах не нужна и не должна вызываться.
 */

/** Реквизиты кабинета, которые роуты «читают из Настроек», — правятся по ходу тестов. */
let creds: { enabled: boolean; token: string | null; adAccountIds: string[] } = {
  enabled: false,
  token: null,
  adAccountIds: [],
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
    parseAdAccountIds: (raw: string | null) =>
      (raw ?? "")
        .split(/[\s,;]+/)
        .filter(Boolean)
        .map((p) => `act_${p.replace(/\D/g, "")}`),
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
const metaAdsApi = await import("../src/lib/ads/metaAdsApi.js");
const syncModule = await import("../src/lib/ads/syncMetaAds.js");
const adInsightsModule = await import("../src/lib/ads/adInsights.js");

const runId = Date.now();
const password = "testpass123";

let adminToken = "";
let agentToken = "";
let marketingToken = "";
const agentIds: string[] = [];

let districtId = "";
let propertyId = "";
/** Объявления, заведённые тестами, — все удаляются в afterAll. */
const adIds: string[] = [];

/** Снимок затронутых полей Settings — вернуть как было: базу делят все файлы. */
let savedSettings: Record<string, unknown> = {};
const TOUCHED_SETTINGS = [
  "metaAdsEnabled",
  "metaAdsToken",
  "metaAdsTokenRefreshedAt",
  "metaAdsSyncedAt",
  "metaAdAccountId",
  "metaAppId",
  "metaAppSecret",
] as const;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken;
}

function get(path: string, token: string) {
  return request(app).get(path).set("Authorization", `Bearer ${token}`);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const [admin, agent, marketing] = await Promise.all([
    prisma.agent.create({
      data: { fullName: "Админ рекламы", phone: `+992961${runId}`, role: "ADMIN", passwordHash },
    }),
    prisma.agent.create({
      data: { fullName: "Агент без финансов", phone: `+992962${runId}`, role: "AGENT", passwordHash },
    }),
    prisma.agent.create({
      data: { fullName: "Маркетолог рекламы", phone: `+992963${runId}`, role: "MARKETING", passwordHash },
    }),
  ]);
  agentIds.push(admin.id, agent.id, marketing.id);
  adminToken = await login(admin.phone);
  agentToken = await login(agent.phone);
  marketingToken = await login(marketing.phone);

  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedSettings = Object.fromEntries(TOUCHED_SETTINGS.map((k) => [k, (settings as Record<string, unknown>)[k]]));
  // Чистое состояние: кабинет не подключён, приложение Meta не настроено. Иначе
  // тесты «не подключено → 400» зависели бы от содержимого локальной базы.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      metaAdsEnabled: false,
      metaAdsToken: null,
      metaAdsTokenRefreshedAt: null,
      metaAdsSyncedAt: null,
      metaAppId: null,
      metaAppSecret: null,
    },
  });
  // .env мог бы подставить реквизиты в обход базы — на время файла убираем
  // (tests/setup.ts вернёт окружение после файла).
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  delete process.env.META_ADS_TOKEN;
  delete process.env.META_AD_ACCOUNT_ID;
  delete process.env.CRM_PUBLIC_URL;

  districtId = (await prisma.district.create({ data: { name: `Тест-район-ads-routes-${runId}` } })).id;
  const property = await prisma.property.create({
    data: {
      title: `Тест-объект-ads-routes-${runId}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 60,
      price: 50000,
      currency: "USD",
      districtId,
      address: `Проверочная, ${runId % 100}`,
      condition: "GOOD",
    },
  });
  propertyId = property.id;
});

afterAll(async () => {
  await prisma.adSpendDaily.deleteMany({ where: { adId: { in: adIds } } });
  await prisma.ad.deleteMany({ where: { id: { in: adIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

async function makeAd(data: Record<string, unknown> = {}) {
  const ad = await prisma.ad.create({
    data: {
      platform: "META",
      externalId: `ads-routes-${runId}-${adIds.length}`,
      name: `Тестовое объявление ${adIds.length}`,
      lastSyncedAt: new Date(),
      ...data,
    },
  });
  adIds.push(ad.id);
  return ad;
}

describe("Доступ: деньги рекламы открыты только финансам и маркетингу", () => {
  it("без маркера — 401 на чтение и запись", async () => {
    expect((await request(app).get("/api/v1/ads/report")).status).toBe(401);
    expect((await request(app).post("/api/v1/ads/sync").send({})).status).toBe(401);
  });

  it("агенту без finance.view закрыты ВСЕ читающие ручки", async () => {
    for (const path of [
      "/api/v1/ads/report",
      "/api/v1/ads/unmatched",
      "/api/v1/ads/foreign",
      "/api/v1/ads/board",
      "/api/v1/ads/accounts",
      "/api/v1/ads/insights",
    ]) {
      const res = await get(path, agentToken);
      expect(res.status, path).toBe(403);
    }
  });

  it("агенту без finance.manage закрыты ВСЕ пишущие ручки", async () => {
    const auth = (r: request.Test) => r.set("Authorization", `Bearer ${agentToken}`);
    expect((await auth(request(app).post("/api/v1/ads/sync")).send({})).status).toBe(403);
    expect((await auth(request(app).post("/api/v1/ads/connect")).send({})).status).toBe(403);
    expect((await auth(request(app).post("/api/v1/ads/disconnect")).send({})).status).toBe(403);
    expect((await auth(request(app).patch(`/api/v1/ads/${propertyId}/property`)).send({ propertyId: null })).status).toBe(403);
    expect((await auth(request(app).patch(`/api/v1/ads/${propertyId}/ownership`)).send({ ours: true })).status).toBe(403);
  });

  it("роль MARKETING читает отчёт без права «Финансы» — так задумано", async () => {
    const res = await get("/api/v1/ads/report", marketingToken);
    expect(res.status).toBe(200);
  });

  it("плашка объекта открыта всем, но БЕЗ сумм расхода (аудит №4, 27.08)", async () => {
    // Роут намеренно остаётся под общим requireAuth: «продвигается ли объект» —
    // рабочая плашка карточки, её открывают агенты. А вот spendTjs и остальные
    // деньги компании закрыты тем же правом, что и весь раздел (finance.view /
    // роль MARKETING) — раньше агент читал их прямым запросом.
    const res = await get(`/api/v1/ads/property/${propertyId}`, agentToken);
    expect(res.status).toBe(200);
    expect(res.body.promoting).toBe(false);
    expect(res.body).not.toHaveProperty("spendTjs");
  });

  it("объект с расходами: агенту — только признак, финансам — суммы", async () => {
    const ad = await prisma.ad.create({
      data: {
        externalId: `ad-${Date.now()}`,
        name: "Тестовое объявление",
        status: "ACTIVE",
        propertyId,
        adAccountId: "act_test",
      },
    });
    await prisma.adSpendDaily.create({
      data: { adId: ad.id, date: new Date(), spend: 100, currency: "USD", impressions: 10, clicks: 2, conversations: 1 },
    });

    const asAgent = await get(`/api/v1/ads/property/${propertyId}`, agentToken);
    expect(asAgent.status).toBe(200);
    expect(asAgent.body.promoting).toBe(true);
    expect(asAgent.body).not.toHaveProperty("spendTjs");
    expect(asAgent.body).not.toHaveProperty("clicks");

    const asFinance = await get(`/api/v1/ads/property/${propertyId}`, adminToken);
    expect(asFinance.status).toBe(200);
    expect(asFinance.body.spendTjs).toBeGreaterThan(0);

    await prisma.adSpendDaily.deleteMany({ where: { adId: ad.id } });
    await prisma.ad.delete({ where: { id: ad.id } });
  });
});

describe("OAuth-подключение кабинета", () => {
  it("кнопка «Подключить» без реквизитов приложения Meta — 400 с внятным текстом", async () => {
    const res = await request(app)
      .post("/api/v1/ads/connect")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Meta");
  });

  it("callback без code/state — «передумал», редирект в Настройки без ошибки", async () => {
    // Роутер callback смонтирован ДО requireAuth — заходим без маркера, как Facebook.
    const res = await request(app).get("/api/v1/ads/callback");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("ads=cancelled");
    expect(res.headers.location).toContain("/settings?tab=channels");
  });

  it("отказ человека в окне Facebook доносит причину", async () => {
    const res = await request(app).get("/api/v1/ads/callback").query({ error: "access_denied" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("ads=cancelled");
    expect(res.headers.location).toContain("reason=access_denied");
  });

  it("чужой/битый state отвергается — CSRF-защита работает", async () => {
    // Защита есть: state сверяется с одноразовым реестром в памяти (metaAdsOAuth,
    // pending). Незнакомый state роняет completeConnect ДО какого-либо похода в
    // Facebook — код злоумышленника не обменивается, маркер не сохраняется.
    const res = await request(app)
      .get("/api/v1/ads/callback")
      .query({ code: "attacker-code", state: "a".repeat(48) });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("ads=error");
    expect(res.headers.location).not.toContain("ads=connected");

    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { metaAdsToken: true, metaAdsEnabled: true },
    });
    expect(settings?.metaAdsToken).toBeNull();
    expect(settings?.metaAdsEnabled).toBe(false);
  });

  it("«Отключить» стирает маркер и глушит синхронизацию, не трогая историю", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { metaAdsToken: "зашифрованный-маркер", metaAdsEnabled: true, metaAdsTokenRefreshedAt: new Date() },
    });
    const res = await request(app)
      .post("/api/v1/ads/disconnect")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { metaAdsToken: true, metaAdsTokenRefreshedAt: true, metaAdsEnabled: true },
    });
    expect(settings?.metaAdsToken).toBeNull();
    expect(settings?.metaAdsTokenRefreshedAt).toBeNull();
    expect(settings?.metaAdsEnabled).toBe(false);
  });
});

describe("Валидация: мусор на входе не даёт 500", () => {
  it("месяц не по формату — 400", async () => {
    expect((await get("/api/v1/ads/report?month=август", adminToken)).status).toBe(400);
    expect((await get("/api/v1/ads/insights?month=2026-8", adminToken)).status).toBe(400);
  });

  it("страница вне диапазона — 400", async () => {
    expect((await get("/api/v1/ads/unmatched?page=0", adminToken)).status).toBe(400);
    expect((await get("/api/v1/ads/unmatched?page=abc", adminToken)).status).toBe(400);
    expect((await get("/api/v1/ads/foreign?page=-1", adminToken)).status).toBe(400);
  });

  it("несуществующий пресет периода — 400", async () => {
    expect((await get("/api/v1/ads/board?preset=lastyear", adminToken)).status).toBe(400);
  });

  it("некалендарная дата периода — 400, а не 500", async () => {
    // Маску \d{4}-\d{2}-\d{2} «2026-13-99» проходит, но new Date даёт Invalid
    // Date — до 26.08.2026 он доживал до from.toISOString() и ронял роут
    // RangeError'ом (500). Теперь resolvePeriod отвечает null → честный 400.
    const res = await get("/api/v1/ads/board?from=2026-13-99&to=2026-13-99", adminToken);
    expect(res.status).toBe(400);
  });

  it("привязка: не-uuid и не-boolean в теле — 400, несуществующие записи — 404", async () => {
    const patch = (path: string, body: unknown) =>
      request(app).patch(path).set("Authorization", `Bearer ${adminToken}`).send(body as object);

    const ad = await makeAd();
    expect((await patch(`/api/v1/ads/${ad.id}/property`, { propertyId: "не-uuid" })).status).toBe(400);
    expect((await patch(`/api/v1/ads/${ad.id}/property`, {})).status).toBe(400);
    expect((await patch(`/api/v1/ads/${ad.id}/ownership`, { ours: "да" })).status).toBe(400);

    const ghostUuid = "00000000-0000-4000-8000-000000000000";
    expect((await patch(`/api/v1/ads/несуществующее/property`, { propertyId: null })).status).toBe(404);
    expect((await patch(`/api/v1/ads/${ad.id}/property`, { propertyId: ghostUuid })).status).toBe(404);
    expect((await patch(`/api/v1/ads/несуществующее/ownership`, { ours: true })).status).toBe(404);
  });
});

describe("Ручная привязка и вердикт «наше/чужое»", () => {
  it("привязка пишется источником MANUAL, отвязка возвращает объявление машине", async () => {
    const ad = await makeAd();
    const link = await request(app)
      .patch(`/api/v1/ads/${ad.id}/property`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ propertyId });
    expect(link.status).toBe(200);
    expect(link.body).toEqual({ id: ad.id, propertyId, matchSource: "MANUAL" });

    const unlink = await request(app)
      .patch(`/api/v1/ads/${ad.id}/property`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ propertyId: null });
    expect(unlink.status).toBe(200);
    // matchSource сброшен: следующая синхронизация вправе привязать заново.
    expect(unlink.body).toEqual({ id: ad.id, propertyId: null, matchSource: null });
  });

  it("маркетолог возвращает «чужое» объявление себе — и обратно", async () => {
    const ad = await makeAd({ excluded: true });
    const mine = await request(app)
      .patch(`/api/v1/ads/${ad.id}/ownership`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ ours: true });
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ id: ad.id, excluded: false });

    const alien = await request(app)
      .patch(`/api/v1/ads/${ad.id}/ownership`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ ours: false });
    expect(alien.status).toBe(200);
    expect(alien.body.excluded).toBe(true);
  });
});

describe("Синхронизация по кнопке", () => {
  it("кабинет не подключён — 400, сверка даже не запускается", async () => {
    creds = { enabled: false, token: null, adAccountIds: [] };
    const res = await request(app).post("/api/v1/ads/sync").set("Authorization", `Bearer ${adminToken}`).send({});
    expect(res.status).toBe(400);
    expect(vi.mocked(syncModule.syncMetaAds)).not.toHaveBeenCalled();
  });

  it("обычный запуск — окно по умолчанию, full:true — квартал (FULL_SYNC_DAYS)", async () => {
    creds = { enabled: true, token: "test-token", adAccountIds: ["act_1"] };
    vi.mocked(syncModule.syncMetaAds).mockResolvedValue({ days: 7, ads: 3, matched: 2, foreign: 0, spendRows: 5 });

    const usual = await request(app).post("/api/v1/ads/sync").set("Authorization", `Bearer ${adminToken}`).send({});
    expect(usual.status).toBe(200);
    expect(usual.body.ads).toBe(3);
    expect(vi.mocked(syncModule.syncMetaAds)).toHaveBeenLastCalledWith(undefined);

    const full = await request(app)
      .post("/api/v1/ads/sync")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ full: true });
    expect(full.status).toBe(200);
    expect(vi.mocked(syncModule.syncMetaAds)).toHaveBeenLastCalledWith(90);
  });

  it("кабинет не ответил — 502, а не 500", async () => {
    vi.mocked(syncModule.syncMetaAds).mockRejectedValueOnce(new Error("Meta вернула 500"));
    const res = await request(app).post("/api/v1/ads/sync").set("Authorization", `Bearer ${adminToken}`).send({});
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Meta вернула 500");
  });
});

describe("Отчёт и дашборд на замоканных данных", () => {
  it("/report: свежий кабинет — без фоновой сверки; протухший — сверка в фоне и refreshing:true", async () => {
    creds = { enabled: true, token: "test-token", adAccountIds: ["act_1"] };
    vi.mocked(syncModule.syncMetaAdsQuietly).mockClear();

    // Сверка была минуту назад — фон не трогаем.
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { metaAdsEnabled: true, metaAdsSyncedAt: new Date() },
    });
    const fresh = await get("/api/v1/ads/report", adminToken);
    expect(fresh.status).toBe(200);
    expect(fresh.body.enabled).toBe(true);
    expect(fresh.body.refreshing).toBe(false);
    expect(Array.isArray(fresh.body.rows)).toBe(true);
    expect(vi.mocked(syncModule.syncMetaAdsQuietly)).not.toHaveBeenCalled();

    // Сверка час назад — отвечаем сразу, но запускаем фоновую и честно говорим об этом.
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { metaAdsSyncedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const stale = await get("/api/v1/ads/report?month=2026-08", adminToken);
    expect(stale.status).toBe(200);
    expect(stale.body.refreshing).toBe(true);
    expect(vi.mocked(syncModule.syncMetaAdsQuietly)).toHaveBeenCalledTimes(1);

    // Возвращаем «выключено», чтобы остальные тесты фон не будили.
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaAdsEnabled: false, metaAdsSyncedAt: null } });
  });

  it("/board: у строки два счёта — за период и за всё время, итоги сходятся", async () => {
    const ad = await makeAd({
      propertyId,
      matchSource: "MANUAL",
      status: "ACTIVE",
      caption: "🏛🏛🏛\nПросторная квартира у парка",
    });
    await prisma.adSpendDaily.createMany({
      data: [
        { adId: ad.id, date: new Date("2026-08-10T00:00:00.000Z"), spend: 40, currency: "USD", impressions: 1000, clicks: 50, conversations: 4 },
        // Прошлый месяц: в период не входит, в lifetime входит.
        { adId: ad.id, date: new Date("2026-07-05T00:00:00.000Z"), spend: 10, currency: "USD", impressions: 200, clicks: 5, conversations: 1 },
      ],
    });

    const res = await get("/api/v1/ads/board?from=2026-08-01&to=2026-08-31", adminToken);
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { id: string }) => r.id === ad.id);
    expect(row).toBeTruthy();
    expect(row.period.spendOriginal).toBeCloseTo(40, 2);
    expect(row.lifetime.spendOriginal).toBeCloseTo(50, 2);
    expect(row.period.conversations).toBe(4);
    expect(row.activeDays).toBe(2);
    // Заголовок — первая содержательная строка подписи, а не эмодзи-шапка.
    expect(row.headline).toBe("Просторная квартира у парка");
    expect(row.property.id).toBe(propertyId);
    expect(res.body.totals.total).toBeGreaterThanOrEqual(1);
    expect(res.body.totals.periodTjs).toBeGreaterThan(0);
  });

  /**
   * «Продвигается сейчас» — по факту трат, а не по статусу Meta.
   *
   * У Meta завершённое объявление навсегда остаётся ACTIVE: на живых данных
   * агентства 03.09.2026 таких было 33 из 41, а деньги тратили шесть. Плашка в
   * карточке объекта горела зелёным на квартирах, которых не рекламировали с
   * весны, — поэтому статус здесь больше не решает ничего.
   */
  it("/property/:id: ACTIVE без свежих трат — это НЕ «продвигается сейчас»", async () => {
    const res = await get(`/api/v1/ads/property/${propertyId}`, adminToken);
    expect(res.status).toBe(200);
    // Объявление из /board-теста: статус ACTIVE, но последняя трата — в августе 2026.
    expect(res.body.promoting).toBe(false);
    expect(res.body.ads).toBeGreaterThanOrEqual(1);
    expect(res.body.impressions).toBeGreaterThanOrEqual(1200);
    expect(res.body.conversations).toBeGreaterThanOrEqual(5);
    expect(res.body.spendTjs).toBeGreaterThan(0);
  });

  it("/property/:id: потратило сегодня — «продвигается сейчас», даже если срок показа вышел", async () => {
    const ad = await makeAd({
      propertyId,
      matchSource: "MANUAL",
      status: "ACTIVE",
      // Срок показа по нашим данным вышел вчера — но деньги ушли сегодня: значит
      // в кабинете его продлили, и факт траты сильнее расписания.
      stopTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    const today = new Date();
    await prisma.adSpendDaily.create({
      data: {
        adId: ad.id,
        date: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())),
        spend: 5,
        currency: "USD",
        impressions: 100,
        clicks: 3,
        conversations: 1,
      },
    });

    const res = await get(`/api/v1/ads/property/${propertyId}`, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.promoting).toBe(true);

    // И тот же вывод в списке объявлений: строка помечена «идёт», итог совпадает.
    const board = await get("/api/v1/ads/board?preset=30d", adminToken);
    expect(board.status).toBe(200);
    const row = board.body.rows.find((r: { id: string }) => r.id === ad.id);
    expect(row.delivery).toBe("RUNNING");
    expect(board.body.totals.running).toBeGreaterThanOrEqual(1);
    // Завершённое объявление из соседнего теста в «идущие» не попало.
    expect(board.body.totals.running).toBeLessThan(board.body.totals.total);
  });

  it("/unmatched: непривязанное объявление приходит с подписью и без выдуманной привязки", async () => {
    const ad = await makeAd({
      caption: "проверочный текст без адресов и цен",
      lastSyncedAt: new Date(Date.now() + 1000), // гарантированно первым в списке
    });
    const res = await get("/api/v1/ads/unmatched", adminToken);
    expect(res.status).toBe(200);
    const item = res.body.items.find((i: { id: string }) => i.id === ad.id);
    expect(item).toBeTruthy();
    expect(item.caption).toBe("проверочный текст без адресов и цен");
    // В замоканной ленте публикации нет — «наш пост» утверждать нельзя.
    expect(item.isOurPost).toBe(false);
    expect(item.spendOriginal).toBe(0);
    expect(Array.isArray(item.candidates)).toBe(true);
  });

  it("/foreign: чужая реклама лежит отдельным списком со своей суммой", async () => {
    const ad = await makeAd({ excluded: true, lastSyncedAt: new Date(Date.now() + 2000) });
    await prisma.adSpendDaily.create({
      data: { adId: ad.id, date: new Date("2026-08-11T00:00:00.000Z"), spend: 77, currency: "USD" },
    });
    const res = await get("/api/v1/ads/foreign", adminToken);
    expect(res.status).toBe(200);
    const item = res.body.items.find((i: { id: string }) => i.id === ad.id);
    expect(item).toBeTruthy();
    expect(item.spendOriginal).toBeCloseTo(77, 2);
    expect(item.currency).toBe("USD");
  });
});

describe("Живые данные кабинета (Graph замокан)", () => {
  it("/accounts: не подключено — пустой список и ни одного похода в Graph", async () => {
    creds = { enabled: false, token: null, adAccountIds: [] };
    const res = await get("/api/v1/ads/accounts", adminToken);
    expect(res.status).toBe(200);
    expect(res.body.accounts).toEqual([]);
    expect(vi.mocked(metaAdsApi.fetchAdAccountDetails)).not.toHaveBeenCalled();
  });

  it("/accounts: реквизиты читаются по кабинетам и полчаса живут в кэше", async () => {
    creds = { enabled: true, token: "test-token", adAccountIds: ["act_1", "act_2"] };
    vi.mocked(metaAdsApi.fetchAdAccountDetails).mockImplementation(async (_c, id) => ({
      id,
      name: `Кабинет ${id}`,
      currency: "USD",
      fundingSource: "Visa •• 4242",
      balance: 12.5,
      spendCap: null,
      timezone: "Asia/Dushanbe",
    }));

    const first = await get("/api/v1/ads/accounts", adminToken);
    expect(first.status).toBe(200);
    expect(first.body.accounts).toHaveLength(2);
    expect(first.body.accounts[0].fundingSource).toBe("Visa •• 4242");
    expect(vi.mocked(metaAdsApi.fetchAdAccountDetails)).toHaveBeenCalledTimes(2);

    // Повторное открытие вкладки — из кэша, Graph не дёргаем.
    const second = await get("/api/v1/ads/accounts", adminToken);
    expect(second.status).toBe(200);
    expect(second.body.accounts).toHaveLength(2);
    expect(vi.mocked(metaAdsApi.fetchAdAccountDetails)).toHaveBeenCalledTimes(2);
  });

  it("/insights: пустого разбора две разные причины, готовый — отдаётся как есть", async () => {
    // reason обязателен: «расходов не было» и «модель не ответила» экран пишет
    // по-разному, а до 03.09.2026 на оба случая печаталось «расходов не было».
    const empty = await get("/api/v1/ads/insights", adminToken);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ text: null, reason: "empty" });

    vi.mocked(adInsightsModule.buildAdInsights).mockResolvedValueOnce({
      text: "Разбор: половина бюджета на остановленных объявлениях",
      month: "2026-08",
      generatedAt: new Date().toISOString(),
    } as Awaited<ReturnType<typeof adInsightsModule.buildAdInsights>>);
    const full = await get("/api/v1/ads/insights?month=2026-08&force=1", adminToken);
    expect(full.status).toBe(200);
    expect(full.body.text).toContain("Разбор");
    expect(vi.mocked(adInsightsModule.buildAdInsights)).toHaveBeenLastCalledWith("2026-08", true);
  });
});
