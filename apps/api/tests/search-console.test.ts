import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * «САЙТ И ПОИСК» (24.09.2026) — lib/searchConsole.ts и routes/searchConsole.ts.
 *
 * Google подменён (fetchWithRetry отвечает по адресу), строка настроек — в
 * памяти этого файла: общую строку Settings трогать нельзя, её читают соседние
 * файлы того же прогона. Объекты — настоящие, в базе: проверяем, что страница
 * `/listing/<номер>` находит карточку.
 */

const google = vi.hoisted(() => ({
  sites: [] as { siteUrl: string; permissionLevel: string }[],
  queries: [] as { url: string; body: Record<string, unknown> }[],
  rowsFor: (_body: Record<string, unknown>): unknown[] => [],
  tokenOk: true,
}));

vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  fetchWithRetry: vi.fn(async (url: string, init: RequestInit) => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (url === "https://oauth2.googleapis.com/token") {
      return google.tokenOk
        ? json(200, { access_token: "at-1", refresh_token: "rt-new", scope: "https://www.googleapis.com/auth/webmasters.readonly" })
        : json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
    }
    if (url.endsWith("/sites")) return json(200, { siteEntry: google.sites });
    if (url.includes("/searchAnalytics/query")) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      google.queries.push({ url, body });
      return json(200, { rows: google.rowsFor(body) });
    }
    return json(404, { error: { message: `нет подмены для ${url}` } });
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
const lib = await import("../src/lib/searchConsole.js");
const { searchConsoleRouter, searchConsoleCallbackRouter } = await import("../src/routes/searchConsole.js");
const { signState } = await import("../src/lib/oauthState.js");

const settings: Record<string, unknown> = {};
const runId = Date.now();
const siteListingId = 900_000_000 + (runId % 99_999_999);
let districtId: string;
let propertyId: string;
let propertyShortId: number;

const app = express();
app.use(express.json());
app.use("/api/v1/search-console/oauth/callback", searchConsoleCallbackRouter);
app.use("/api/v1/search-console", searchConsoleRouter);

beforeAll(async () => {
  vi.spyOn(prisma.settings, "findUnique").mockImplementation((async () => ({ ...settings })) as never);
  vi.spyOn(prisma.settings, "update").mockImplementation((async ({ data }: { data: Record<string, unknown> }) => {
    Object.assign(settings, data);
    return { ...settings };
  }) as never);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-поиск-${runId}` } })).id;
  const p = await prisma.property.create({
    data: {
      title: `Поиск ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      siteListingId,
    },
  });
  propertyId = p.id;
  propertyShortId = p.shortId;
});

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  google.sites = [];
  google.queries = [];
  google.rowsFor = () => [];
  google.tokenOk = true;
  lib.resetSearchConsoleCache();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
  await prisma.$disconnect();
});

function withApp() {
  settings.youtubeClientId = "client-1.apps.googleusercontent.com";
  settings.youtubeClientSecret = encryptSecret("secret-1");
}

function connected() {
  withApp();
  settings.searchConsoleRefreshToken = encryptSecret("rt-1");
  settings.searchConsoleSiteUrl = "sc-domain:royalhome.tj";
}

describe("выбор ресурса и разбор адресов", () => {
  it("домен предпочтительнее префикса; чужой и неподтверждённый — мимо", () => {
    expect(
      lib.pickSite(
        [
          { siteUrl: "https://royalhome.tj/", permissionLevel: "siteOwner" },
          { siteUrl: "sc-domain:royalhome.tj", permissionLevel: "siteFullUser" },
        ],
        "royalhome.tj"
      )
    ).toBe("sc-domain:royalhome.tj");
    expect(lib.pickSite([{ siteUrl: "https://www.royalhome.tj/", permissionLevel: "siteOwner" }], "royalhome.tj")).toBe(
      "https://www.royalhome.tj/"
    );
    expect(lib.pickSite([{ siteUrl: "sc-domain:royalhome.tj", permissionLevel: "siteUnverifiedUser" }], "royalhome.tj")).toBeNull();
    expect(lib.pickSite([{ siteUrl: "sc-domain:other.tj", permissionLevel: "siteOwner" }], "royalhome.tj")).toBeNull();
  });

  it("страница объекта: номер на сайте или id карточки; остальное — не объект", () => {
    expect(lib.listingRef("https://royalhome.tj/listing/42")).toEqual({ siteListingId: 42 });
    expect(lib.listingRef("https://royalhome.tj/listing/by-crm/0b7c6d0e-1111-4222-8333-944455556666")).toEqual({
      crmId: "0b7c6d0e-1111-4222-8333-944455556666",
    });
    expect(lib.listingRef("https://royalhome.tj/listings")).toBeNull();
  });

  it("период кончается позавчера, прошлый — такой же длины сразу перед ним", () => {
    expect(lib.searchPeriods(7, new Date("2026-09-24T10:00:00Z"))).toEqual({
      start: "2026-09-16",
      end: "2026-09-22",
      prevStart: "2026-09-09",
      prevEnd: "2026-09-15",
    });
  });
});

describe("GET /search-console/overview", () => {
  it("не подключено — говорит, есть ли Google-приложение, и отдаёт адрес возврата", async () => {
    const res = await request(app).get("/api/v1/search-console/overview");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ connected: false, appConfigured: false });
    expect(res.body.redirectUri).toMatch(/\/api\/v1\/search-console\/oauth\/callback$/);

    withApp();
    expect((await request(app).get("/api/v1/search-console/overview")).body.appConfigured).toBe(true);
  });

  it("подключено — итоги, запросы, страницы с карточкой объекта, «почти в топе»", async () => {
    connected();
    const period = lib.searchPeriods(28, new Date());
    google.rowsFor = (body) => {
      const dims = body.dimensions as string[] | undefined;
      if (!dims) {
        return body.startDate === period.start
          ? [{ clicks: 100, impressions: 2000, ctr: 0.05, position: 9.44 }]
          : [{ clicks: 50, impressions: 1000, ctr: 0.05, position: 12 }];
      }
      if (dims[0] === "page") {
        return [
          { keys: [`https://royalhome.tj/listing/${siteListingId}`], clicks: 30, impressions: 300, ctr: 0.1, position: 3.2 },
          { keys: ["https://royalhome.tj/"], clicks: 20, impressions: 400, ctr: 0.05, position: 5 },
        ];
      }
      return [
        { keys: ["квартира душанбе"], clicks: 40, impressions: 900, ctr: 0.044, position: 7.8 },
        { keys: ["royal home"], clicks: 30, impressions: 60, ctr: 0.5, position: 1.1 },
        { keys: ["редкий запрос"], clicks: 0, impressions: 3, ctr: 0, position: 11 },
      ];
    };

    const res = await request(app).get("/api/v1/search-console/overview?days=28");
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.connected).toBe(true);
    expect(body.error).toBeNull();
    expect(body.start).toBe(period.start);
    expect(body.totals).toEqual({ clicks: 100, impressions: 2000, ctr: 0.05, position: 9.4 });
    expect(body.previous.clicks).toBe(50);
    expect(google.queries.every((q) => q.url.includes(encodeURIComponent("sc-domain:royalhome.tj")))).toBe(true);
    expect(body.queries[0]).toMatchObject({ query: "квартира душанбе", clicks: 40, position: 7.8 });
    expect(body.pages[0].property).toEqual({ shortId: propertyShortId, title: `Поиск ${runId}` });
    expect(body.pages[1]).toMatchObject({ path: "/", property: null });
    // Первое место и редкий запрос в «почти в топе» не попадают.
    expect(body.nearTop.map((r: { query: string }) => r.query)).toEqual(["квартира душанбе"]);
  });

  it("Google отказал — честная причина вместо пустоты, и отказ не кэшируется", async () => {
    connected();
    google.tokenOk = false;
    const bad = await request(app).get("/api/v1/search-console/overview");
    expect(bad.body.connected).toBe(true);
    expect(bad.body.error).toMatch(/подключите Search Console заново/);

    google.tokenOk = true;
    const good = await request(app).get("/api/v1/search-console/overview");
    expect(good.body.error).toBeNull();
  });

  it("неверный период — 400; не маркетинг — 403", async () => {
    expect((await request(app).get("/api/v1/search-console/overview?days=5")).status).toBe(400);
    expect((await request(app).get("/api/v1/search-console/overview").set("x-role", "AGENT")).status).toBe(403);
  });
});

describe("подключение", () => {
  it("без Google-приложения — понятный отказ; с ним — адрес входа с правом только на чтение", async () => {
    const no = await request(app).get("/api/v1/search-console/oauth/start");
    expect(no.status).toBe(400);
    expect(no.body.error).toContain("Client ID");

    withApp();
    const res = await request(app).get("/api/v1/search-console/oauth/start");
    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/webmasters.readonly");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("client_id")).toBe("client-1.apps.googleusercontent.com");
  });

  it("возврат из Google: токен шифруется, ресурс сайта выбирается сам", async () => {
    withApp();
    google.sites = [{ siteUrl: "sc-domain:royalhome.tj", permissionLevel: "siteOwner" }];
    const res = await request(app).get(`/api/v1/search-console/oauth/callback?code=c1&state=${encodeURIComponent(signState())}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/marketing\?tab=search&sc=ok$/);
    expect(settings.searchConsoleSiteUrl).toBe("sc-domain:royalhome.tj");
    expect(settings.searchConsoleRefreshToken).not.toBe("rt-new");
    expect(decryptSecretSafe(settings.searchConsoleRefreshToken as string)).toBe("rt-new");
  });

  it("вошли аккаунтом без нашего сайта — не сохраняем, говорим почему", async () => {
    withApp();
    google.sites = [{ siteUrl: "sc-domain:other.tj", permissionLevel: "siteOwner" }];
    const res = await request(app).get(`/api/v1/search-console/oauth/callback?code=c1&state=${encodeURIComponent(signState())}`);
    expect(res.headers.location).toMatch(/sc=error&reason=no-site$/);
    expect(settings.searchConsoleRefreshToken).toBeUndefined();
  });

  it("поддельный state или отмена — ничего не сохраняем", async () => {
    withApp();
    const forged = await request(app).get("/api/v1/search-console/oauth/callback?code=c1&state=1.2.3");
    expect(forged.headers.location).toMatch(/reason=state$/);
    const cancelled = await request(app).get("/api/v1/search-console/oauth/callback?error=access_denied");
    expect(cancelled.headers.location).toMatch(/reason=cancelled$/);
    expect(settings.searchConsoleRefreshToken).toBeUndefined();
  });

  it("«Отключить Google» — стирает токен и ресурс", async () => {
    connected();
    const res = await request(app).post("/api/v1/search-console/disconnect");
    expect(res.status).toBe(200);
    expect(settings.searchConsoleRefreshToken).toBeNull();
    expect(settings.searchConsoleSiteUrl).toBeNull();
  });
});
