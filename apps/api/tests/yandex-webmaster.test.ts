import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * «САЙТ И ПОИСК» → ЯНДЕКС (24.09.2026) — lib/yandexWebmaster.ts и маршруты
 * /search-console/yandex/* в routes/searchConsole.ts.
 *
 * Яндекс подменён (fetchWithRetry отвечает по адресу), строка настроек — в
 * памяти этого файла: общую строку Settings читают соседние файлы прогона.
 */

const ya = vi.hoisted(() => ({
  hosts: [] as { host_id: string; ascii_host_url: string; verified: boolean }[],
  tokenOk: true,
  summaryOk: true,
  historyFail: false,
  calls: [] as string[],
  tokenBodies: [] as string[],
}));

vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  fetchWithRetry: vi.fn(async (url: string, init: RequestInit) => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    ya.calls.push(url);
    if (url === "https://oauth.yandex.ru/token") {
      ya.tokenBodies.push(String(init.body));
      return ya.tokenOk
        ? json(200, { access_token: "ya-at", refresh_token: "ya-rt-new", expires_in: 31536000 })
        : json(400, { error: "invalid_grant", error_description: "Refresh token expired" });
    }
    if (url.endsWith("/v4/user")) return json(200, { user_id: 777 });
    if (url.endsWith("/user/777/hosts")) return json(200, { hosts: ya.hosts });
    if (url.includes("/search-queries/all/history")) {
      if (ya.historyFail) return json(403, { error_code: "ACCESS_FORBIDDEN", error_message: "Нет доступа к сайту" });
      // Текущий период — с 2026-09-01, прошлый — раньше; отличаем по дате начала.
      const current = decodeURIComponent(url).includes("date_from=2026-08-25");
      return json(200, {
        indicators: current
          ? {
              TOTAL_SHOWS: [
                { date: "2026-08-25", value: 100 },
                { date: "2026-08-26", value: 300 },
              ],
              TOTAL_CLICKS: [
                { date: "2026-08-25", value: 10 },
                { date: "2026-08-26", value: 30 },
              ],
              AVG_SHOW_POSITION: [
                { date: "2026-08-25", value: 8 },
                { date: "2026-08-26", value: 4 },
              ],
            }
          : { TOTAL_SHOWS: [{ date: "2026-08-20", value: 200 }], TOTAL_CLICKS: [{ date: "2026-08-20", value: 10 }], AVG_SHOW_POSITION: [] },
      });
    }
    if (url.includes("/search-queries/popular")) {
      return json(200, {
        queries: [
          { query_text: "квартира душанбе", indicators: { TOTAL_SHOWS: 200, TOTAL_CLICKS: 20, AVG_SHOW_POSITION: 6.5 } },
          { query_text: "royal home", indicators: { TOTAL_SHOWS: 50, TOTAL_CLICKS: 30, AVG_SHOW_POSITION: 1.1 } },
          { query_text: "редкий запрос", indicators: { TOTAL_SHOWS: 3, TOTAL_CLICKS: 0, AVG_SHOW_POSITION: 9 } },
        ],
      });
    }
    if (url.endsWith("/summary")) {
      return ya.summaryOk
        ? json(200, {
            sqi: 40,
            searchable_pages_count: 350,
            excluded_pages_count: 12,
            site_problems: { FATAL: 0, CRITICAL: 1, POSSIBLE_PROBLEM: 2, RECOMMENDATION: 5 },
          })
        : json(500, {});
    }
    return json(404, { error_message: `нет подмены для ${url}` });
  }),
}));
vi.mock("../src/auth/middleware.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth/middleware.js")>()),
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { agent: { id: string; role: string } }).agent = { id: "a1", role: String(req.headers["x-role"] ?? "ADMIN") };
    next();
  },
}));

const { prisma } = await import("../src/db.js");
const { encryptSecret, decryptSecretSafe } = await import("../src/crypto.js");
const lib = await import("../src/lib/yandexWebmaster.js");
const { searchConsoleRouter, yandexCallbackRouter } = await import("../src/routes/searchConsole.js");
const { signState } = await import("../src/lib/oauthState.js");

const settings: Record<string, unknown> = {};

const app = express();
app.use(express.json());
app.use("/api/v1/search-console/yandex/oauth/callback", yandexCallbackRouter);
app.use("/api/v1/search-console", searchConsoleRouter);

beforeAll(() => {
  vi.spyOn(prisma.settings, "findUnique").mockImplementation((async () => ({ ...settings })) as never);
  vi.spyOn(prisma.settings, "update").mockImplementation((async ({ data }: { data: Record<string, unknown> }) => {
    Object.assign(settings, data);
    return { ...settings };
  }) as never);
});

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  ya.hosts = [];
  ya.tokenOk = true;
  ya.summaryOk = true;
  ya.historyFail = false;
  ya.calls = [];
  ya.tokenBodies = [];
  lib.resetYandexWebmasterCache();
});

afterAll(() => {
  vi.restoreAllMocks();
});

function withApp() {
  settings.yandexWebmasterClientId = "ya-client-123";
  settings.yandexWebmasterClientSecret = encryptSecret("ya-secret-456");
}

function connected() {
  withApp();
  settings.yandexWebmasterRefreshToken = encryptSecret("ya-rt-1");
  settings.yandexWebmasterUserId = "777";
  settings.yandexWebmasterHostId = "https:royalhome.tj:443";
}

describe("разбор ответов Вебмастера", () => {
  it("сайт: тот же домен, подтверждён, https первым; чужой и неподтверждённый — мимо", () => {
    const hosts = [
      { host_id: "http:royalhome.tj:80", ascii_host_url: "http://royalhome.tj/", verified: true },
      { host_id: "https:www.royalhome.tj:443", ascii_host_url: "https://www.royalhome.tj/", verified: true },
    ];
    expect(lib.pickYandexHost(hosts, "royalhome.tj")?.host_id).toBe("https:www.royalhome.tj:443");
    expect(lib.pickYandexHost([{ host_id: "https:royalhome.tj:443", ascii_host_url: "https://royalhome.tj/", verified: false }], "royalhome.tj")).toBeNull();
    expect(lib.pickYandexHost([{ host_id: "https:other.tj:443", ascii_host_url: "https://other.tj/", verified: true }], "royalhome.tj")).toBeNull();
  });

  it("итог периода из дневной истории: место взвешено показами", () => {
    const t = lib.totalsFromHistory({
      TOTAL_SHOWS: [
        { date: "d1", value: 100 },
        { date: "d2", value: 300 },
      ],
      TOTAL_CLICKS: [
        { date: "d1", value: 10 },
        { date: "d2", value: 30 },
      ],
      AVG_SHOW_POSITION: [
        { date: "d1", value: 8 },
        { date: "d2", value: 4 },
      ],
    });
    expect(t).toEqual({ clicks: 40, impressions: 400, ctr: 0.1, position: 5 });
    expect(lib.totalsFromHistory({})).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: null });
  });
});

describe("GET /search-console/yandex/overview", () => {
  it("не подключено — говорит, внесено ли приложение, и отдаёт адрес возврата", async () => {
    const res = await request(app).get("/api/v1/search-console/yandex/overview");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ connected: false, appConfigured: false });
    expect(res.body.redirectUri).toMatch(/\/api\/v1\/search-console\/yandex\/oauth\/callback$/);
    withApp();
    expect((await request(app).get("/api/v1/search-console/yandex/overview")).body.appConfigured).toBe(true);
  });

  it("подключено — итоги к прошлому периоду, запросы, «почти в топе», ИКС и проблемы", async () => {
    connected();
    const overview = await lib.loadYandexOverview(2, { now: new Date("2026-08-28T12:00:00Z") });
    expect(overview.connected).toBe(true);
    if (!overview.connected) return;
    expect(overview.hostUrl).toBe("https://royalhome.tj/");
    expect(overview.totals).toEqual({ clicks: 40, impressions: 400, ctr: 0.1, position: 5 });
    expect(overview.previous.clicks).toBe(10);
    // Главный список — по кликам.
    expect(overview.queries.map((q) => q.query)).toEqual(["royal home", "квартира душанбе", "редкий запрос"]);
    // «Почти в топе»: 4–20 место и не меньше 10 показов.
    expect(overview.nearTop.map((q) => q.query)).toEqual(["квартира душанбе"]);
    // Рекомендации — не проблемы.
    expect(overview.summary).toEqual({ sqi: 40, searchablePages: 350, excludedPages: 12, problems: 3 });
    expect(overview.error).toBeNull();
    // Запросы идут к нашему сайту и с токеном из refresh.
    expect(ya.calls.some((u) => u.includes("/user/777/hosts/https%3Aroyalhome.tj%3A443/search-queries/popular"))).toBe(true);
    expect(ya.tokenBodies[0]).toContain("grant_type=refresh_token");
  });

  it("сводка не отдалась — числа поиска всё равно есть", async () => {
    connected();
    ya.summaryOk = false;
    const overview = await lib.loadYandexOverview(28);
    expect(overview.connected && overview.summary).toBeNull();
    expect(overview.connected && overview.error).toBeNull();
  });

  it("Яндекс отказал — честная причина, и отказ не кэшируется", async () => {
    connected();
    ya.historyFail = true;
    const bad = await lib.loadYandexOverview(28);
    expect(bad.connected && bad.error).toContain("Нет доступа к сайту");
    ya.historyFail = false;
    const good = await lib.loadYandexOverview(28);
    expect(good.connected && good.error).toBeNull();
  });

  it("неверный период — 400; не маркетинг — 403", async () => {
    expect((await request(app).get("/api/v1/search-console/yandex/overview?days=5")).status).toBe(400);
    expect((await request(app).get("/api/v1/search-console/yandex/overview").set("x-role", "AGENT")).status).toBe(403);
  });
});

describe("подключение Яндекса", () => {
  it("приложение: пароль шифруется, прежний вход стирается; пустые поля — 400", async () => {
    connected();
    expect((await request(app).put("/api/v1/search-console/yandex/app").send({ clientId: "x", clientSecret: "" })).status).toBe(400);
    const res = await request(app)
      .put("/api/v1/search-console/yandex/app")
      .send({ clientId: " new-client-id ", clientSecret: "new-secret-value" });
    expect(res.status).toBe(200);
    expect(settings.yandexWebmasterClientId).toBe("new-client-id");
    expect(settings.yandexWebmasterClientSecret).not.toBe("new-secret-value");
    expect(decryptSecretSafe(settings.yandexWebmasterClientSecret as string)).toBe("new-secret-value");
    expect(settings.yandexWebmasterRefreshToken).toBeNull();
    expect(settings.yandexWebmasterHostId).toBeNull();
  });

  it("без приложения — понятный отказ; с ним — адрес входа Яндекса", async () => {
    const no = await request(app).get("/api/v1/search-console/yandex/oauth/start");
    expect(no.status).toBe(400);
    withApp();
    const res = await request(app).get("/api/v1/search-console/yandex/oauth/start");
    const url = new URL(res.body.url);
    expect(url.hostname).toBe("oauth.yandex.ru");
    expect(url.searchParams.get("client_id")).toBe("ya-client-123");
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/yandex\/oauth\/callback$/);
  });

  it("возврат из Яндекса: токен шифруется, пользователь и сайт находятся сами", async () => {
    withApp();
    ya.hosts = [{ host_id: "https:royalhome.tj:443", ascii_host_url: "https://royalhome.tj/", verified: true }];
    const res = await request(app).get(
      `/api/v1/search-console/yandex/oauth/callback?code=c1&state=${encodeURIComponent(signState())}`
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/marketing\?tab=search&engine=yandex&sc=ok$/);
    expect(settings.yandexWebmasterUserId).toBe("777");
    expect(settings.yandexWebmasterHostId).toBe("https:royalhome.tj:443");
    expect(decryptSecretSafe(settings.yandexWebmasterRefreshToken as string)).toBe("ya-rt-new");
    expect(ya.tokenBodies[0]).toContain("grant_type=authorization_code");
  });

  it("аккаунт без нашего сайта, поддельный state, отмена — ничего не сохраняем", async () => {
    withApp();
    ya.hosts = [{ host_id: "https:other.tj:443", ascii_host_url: "https://other.tj/", verified: true }];
    const noSite = await request(app).get(
      `/api/v1/search-console/yandex/oauth/callback?code=c1&state=${encodeURIComponent(signState())}`
    );
    expect(noSite.headers.location).toMatch(/reason=no-site$/);
    const forged = await request(app).get("/api/v1/search-console/yandex/oauth/callback?code=c1&state=1.2.3");
    expect(forged.headers.location).toMatch(/reason=state$/);
    const cancelled = await request(app).get("/api/v1/search-console/yandex/oauth/callback?error=access_denied");
    expect(cancelled.headers.location).toMatch(/reason=cancelled$/);
    expect(settings.yandexWebmasterRefreshToken).toBeUndefined();
  });

  it("«Отключить Яндекс» — стирает вход, приложение остаётся", async () => {
    connected();
    const res = await request(app).post("/api/v1/search-console/yandex/disconnect");
    expect(res.status).toBe(200);
    expect(settings.yandexWebmasterRefreshToken).toBeNull();
    expect(settings.yandexWebmasterHostId).toBeNull();
    expect(settings.yandexWebmasterClientId).toBe("ya-client-123");
  });
});
