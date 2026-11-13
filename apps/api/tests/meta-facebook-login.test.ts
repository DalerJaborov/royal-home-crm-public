import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * «Войти через Facebook» в Настройках → Каналы (13.11.2026). Просьба владельца:
 * «чтобы любую страницу подключали с настроек CRM: нажать „Войти через
 * Facebook“, дать разрешения — и всё, без игры с токенами».
 *
 * Что здесь держится:
 *  - вход один на рекламу и на Страницы (lib/metaLogin.ts): права на старте и
 *    ЗАНОВО в колбэке, одноразовый state, рекламная кнопка ведёт себя как раньше;
 *  - сессия выбора привязана к сотруднику, маркеры наружу не уходят;
 *  - Страница подключается общей дверью (lib/metaPageConnect.ts): без второй
 *    строки, без основной Страницы из Настроек, подписка не снимает feed;
 *  - новый Instagram с маркером Страницы говорит только через Страницу — без
 *    рубильников — и не роняет проверки, которые ходят на graph.instagram.com;
 *  - кабинеты дописываются, маркер рекламы не меняется, если вход не видит старые.
 * Meta подменена целиком (fetch), сеть не нужна.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { encryptSecret, decryptSecretSafe } = await import("../src/crypto.js");
const { grantElevation, revokeElevation } = await import("../src/lib/stepUp.js");
const { invalidateAgentAccess } = await import("../src/auth/middleware.js");
const { resetMetaLoginStates } = await import("../src/lib/metaLogin.js");
const { resetMetaLoginSessions } = await import("../src/lib/metaLoginAssets.js");
const eternal = await import("../src/lib/metaEternalTokens.js");
const { ADS_GRAPH_VERSION } = await import("../src/lib/ads/adsGraphVersion.js");
const { GRAPH_VERSION, instagramApiUrl, instagramRequest, instagramTokenIdentity } = await import("../src/messengers/meta.js");
const { checkInstagramAccountsHealth } = await import("../src/lib/integrationHealth.js");
const { checkInstagramSubscriptions } = await import("../src/lib/instagramWebhookSubscription.js");
const { resetAccountsCache } = await import("../src/messengers/accounts.js");

const run = randomUUID().slice(0, 8);
const stamp = Date.now().toString().slice(-9);
const password = "testpass123";
const APP_ID = `77${stamp}`;
const PAGE_A = `81${stamp}1`;
const PAGE_C = `81${stamp}3`;
const PAGE_NO_TASK = `81${stamp}4`;
const MAIN_PAGE = `81${stamp}9`;
const IG_A = `178414${stamp}1`;
const IG_C = `178414${stamp}3`;
const SHORT = `EAAshort-${run}`;
const LONG = `EAAlong-${run}`;
const PT_A = `EAApageA-${run}`;
const PT_C = `EAApageC-${run}`;
const PT_MAIN = `EAApageMain-${run}`;
const OLD_ADS = `EAAold-ads-${run}`;
const IGAA_C = `IGAAexisting-${run}`;
const AD_1 = "1111111";
const AD_2 = "2222222";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const ADS_GRAPH = `https://graph.facebook.com/${ADS_GRAPH_VERSION}`;
const SECRETS = [SHORT, LONG, PT_A, PT_C, PT_MAIN, OLD_ADS, IGAA_C, `app-secret-${run}`];

let adminId = "";
let adminToken = "";
let otherAdminId = "";
let otherAdminToken = "";
let agentToken = "";
const agentIds: string[] = [];
const accountIds: string[] = [];
let savedSettings: Record<string, unknown> | null = null;
const TOUCHED = [
  "metaAppId",
  "metaAppSecret",
  "metaLoginConfigId",
  "metaPageId",
  "metaAdAccountId",
  "metaAdsToken",
  "metaAdsEnabled",
  "metaAdsTokenRefreshedAt",
  "metaIgManageToken",
  "metaSystemTokenPreferred",
  "metaAppReviewApproved",
] as const;
const savedEnv: Record<string, string | undefined> = {};

/** Что «отвечает Meta». */
const meta = {
  visibleAds: new Set([AD_1, AD_2]),
  subscribed: [{ id: APP_ID, subscribed_fields: ["feed"] }] as Array<{ id: string; subscribed_fields: string[] }>,
  subscribePosts: [] as string[],
};
const fetchMock = vi.fn();
const authOf = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.Authorization;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const pageTokens: Record<string, string> = { [PAGE_A]: PT_A, [PAGE_C]: PT_C, [MAIN_PAGE]: PT_MAIN };
const igOfToken: Record<string, { page: string; ig: string; username: string }> = {
  [PT_A]: { page: PAGE_A, ig: IG_A, username: `arvan_${run}` },
  [PT_C]: { page: PAGE_C, ig: IG_C, username: `royal_${run}` },
};

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

const as = (token: string) => ({
  get: (path: string) => request(app).get(path).set("Authorization", `Bearer ${token}`),
  post: (path: string, body: unknown = {}) => request(app).post(path).set("Authorization", `Bearer ${token}`).send(body as object),
});

/** Пройти весь вход: старт → «Facebook вернул код» → id сессии выбора. */
async function loginSession(token = adminToken, agentId = adminId): Promise<string> {
  grantElevation(agentId);
  const start = await as(token).post("/api/v1/settings/meta-eternal/login");
  expect(start.status).toBe(200);
  const state = new URL(start.body.url).searchParams.get("state")!;
  const back = await request(app).get("/api/v1/ads/callback").query({ code: "good-code", state });
  expect(back.status).toBe(302);
  const id = new URL(back.headers.location).searchParams.get("metaLogin");
  expect(id).toMatch(/^[a-f0-9]{36}$/);
  return id!;
}

function noSecretsIn(body: unknown) {
  const text = JSON.stringify(body);
  for (const s of SECRETS) expect(text).not.toContain(s);
}

beforeAll(async () => {
  for (const k of ["META_APP_ID", "META_APP_SECRET", "META_PAGE_ID", "META_ADS_TOKEN", "CRM_PUBLIC_URL"]) savedEnv[k] = process.env[k];
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  delete process.env.META_PAGE_ID;
  delete process.env.META_ADS_TOKEN;
  process.env.CRM_PUBLIC_URL = "https://crm.example.test";

  const passwordHash = await bcrypt.hash(password, 4);
  const [admin, other, agent] = await Promise.all([
    prisma.agent.create({ data: { fullName: "Директор входа", phone: `+992971${stamp}`, role: "ADMIN", passwordHash } }),
    prisma.agent.create({ data: { fullName: "Второй директор", phone: `+992972${stamp}`, role: "ADMIN", passwordHash } }),
    prisma.agent.create({ data: { fullName: "Агент без настроек", phone: `+992973${stamp}`, role: "AGENT", passwordHash } }),
  ]);
  agentIds.push(admin.id, other.id, agent.id);
  adminId = admin.id;
  otherAdminId = other.id;
  adminToken = await login(admin.phone);
  otherAdminToken = await login(other.phone);
  agentToken = await login(agent.phone);

  const s = await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {} });
  savedSettings = Object.fromEntries(TOUCHED.map((k) => [k, (s as Record<string, unknown>)[k]]));
});

afterAll(async () => {
  await prisma.messengerAccount.deleteMany({ where: { OR: [{ id: { in: accountIds } }, { externalId: { in: [PAGE_A, PAGE_C, IG_A, IG_C] } }] } });
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetAccountsCache();
});

beforeEach(async () => {
  meta.visibleAds = new Set([AD_1, AD_2]);
  meta.subscribed = [{ id: APP_ID, subscribed_fields: ["feed"] }];
  meta.subscribePosts = [];
  resetMetaLoginStates();
  resetMetaLoginSessions();
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      metaAppId: APP_ID,
      metaAppSecret: encryptSecret(`app-secret-${run}`),
      metaLoginConfigId: null,
      metaPageId: MAIN_PAGE,
      metaAdAccountId: null,
      metaAdsToken: null,
      metaAdsEnabled: false,
      // Ключа компании нет и рубильники выключены: путь Страницы для аккаунта с
      // маркером Страницы обязан работать и так.
      metaIgManageToken: null,
      metaSystemTokenPreferred: false,
      metaAppReviewApproved: false,
    },
  });
  eternal.resetMetaEternalCache();
  resetAccountsCache();

  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = authOf(init);
    if (url.startsWith(`${ADS_GRAPH}/oauth/access_token?`)) {
      const q = new URL(url).searchParams;
      if (q.get("grant_type") === "fb_exchange_token") return json({ access_token: LONG });
      if (q.get("code") === "good-code") return json({ access_token: SHORT });
      return json({ error: { message: "Invalid verification code format." } }, 400);
    }
    if (url.startsWith("https://graph.instagram.com") || url.includes("/refresh_access_token")) {
      return json({ error: { message: "Cannot parse access token" } }, 400);
    }
    if (url.startsWith(`${GRAPH}/me/accounts?`)) {
      if (auth !== `Bearer ${LONG}`) return json({ error: { code: 190, message: "bad" } }, 400);
      return json({
        data: [
          { id: PAGE_A, name: "Arvan Estate", tasks: ["MESSAGING", "ADVERTISE"], access_token: PT_A, instagram_business_account: { id: IG_A, username: `arvan_${run}` } },
          { id: PAGE_C, name: "Royal Home Info", tasks: ["MANAGE"], access_token: PT_C, instagram_business_account: { id: IG_C, username: `royal_${run}` } },
          { id: MAIN_PAGE, name: "Royal Home", tasks: ["MANAGE"], access_token: PT_MAIN },
          { id: PAGE_NO_TASK, name: "Чужая", tasks: ["ANALYZE"], access_token: `EAAnotask-${run}` },
        ],
      });
    }
    if (url.startsWith(`${GRAPH}/me/adaccounts?`)) {
      return json({ data: [{ account_id: AD_1, name: "Кабинет один", account_status: 1 }, { account_id: AD_2, name: "Кабинет два", account_status: 1 }] });
    }
    const act = /\/act_(\d+)\?fields=id$/.exec(url);
    if (act) return meta.visibleAds.has(act[1]) && auth === `Bearer ${LONG}` ? json({ id: `act_${act[1]}` }) : json({ error: { code: 100, message: "no access" } }, 400);
    const sub = /^https:\/\/graph\.facebook\.com\/v[\d.]+\/(\d+)\/subscribed_apps$/.exec(url);
    if (sub) {
      if (auth !== `Bearer ${pageTokens[sub[1]]}`) return json({ error: { code: 190, message: "bad page token" } }, 400);
      if (init?.method === "POST") {
        meta.subscribePosts.push(String(init.body));
        return json({ success: true });
      }
      return json({ data: meta.subscribed });
    }
    if (url.startsWith(`${GRAPH}/me?fields=id,instagram_business_account`)) {
      const who = igOfToken[(auth ?? "").replace("Bearer ", "")];
      return who ? json({ id: who.page, instagram_business_account: { id: who.ig, username: who.username } }) : json({ error: { code: 190 } }, 400);
    }
    const pageRead = /^https:\/\/graph\.facebook\.com\/v[\d.]+\/(\d+)\?fields=id&access_token=(.+)$/.exec(url);
    if (pageRead) return decodeURIComponent(pageRead[2]) === pageTokens[pageRead[1]] ? json({ id: pageRead[1] }) : json({ error: { code: 190, message: "bad" } }, 400);
    if (url === `${GRAPH}/${PAGE_A}/messages`) return json({ recipient_id: "peer", message_id: `mid-${randomUUID()}` });
    return json({ error: { message: `unexpected ${url}` } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("старт входа: права и подтверждение личности", () => {
  it("сотрудник без права менять настройки — 403", async () => {
    expect((await as(agentToken).post("/api/v1/settings/meta-eternal/login")).status).toBe(403);
  });

  it("без подтверждения личности — 428, адрес не выдан", async () => {
    revokeElevation(adminId);
    const res = await as(adminToken).post("/api/v1/settings/meta-eternal/login");
    expect(res.status).toBe(428);
    expect(res.body.url).toBeUndefined();
  });

  it("без номера конфигурации — окно со списком прав, возврат на общий адрес рекламы", async () => {
    grantElevation(adminId);
    const res = await as(adminToken).post("/api/v1/settings/meta-eternal/login");
    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    expect(url.searchParams.get("redirect_uri")).toBe("https://crm.example.test/api/v1/ads/callback");
    expect(url.searchParams.get("client_id")).toBe(APP_ID);
    expect(url.searchParams.get("scope")?.split(",")).toEqual(
      expect.arrayContaining(["pages_show_list", "pages_manage_metadata", "pages_messaging", "instagram_manage_messages", "ads_read", "business_management"])
    );
    expect(url.searchParams.get("config_id")).toBeNull();
    noSecretsIn(res.body);
  });

  it("с номером конфигурации — config_id и код вместо маркера, без списка прав", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaLoginConfigId: "998877665544" } });
    grantElevation(adminId);
    const url = new URL((await as(adminToken).post("/api/v1/settings/meta-eternal/login")).body.url);
    expect(url.searchParams.get("config_id")).toBe("998877665544");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("override_default_response_type")).toBe("true");
    expect(url.searchParams.get("scope")).toBeNull();
  });
});

describe("колбэк: одна дверь на две цели", () => {
  it("цель «Страницы» ведёт на выбор ?metaLogin=<id>, код обменян на долгий маркер", async () => {
    await loginSession();
    const exchanges = fetchMock.mock.calls.filter(([u]) => String(u).includes("/oauth/access_token"));
    expect(exchanges).toHaveLength(2);
    expect(String(exchanges[1][0])).toContain("grant_type=fb_exchange_token");
  });

  it("повтор того же state не открывает вторую сессию", async () => {
    grantElevation(adminId);
    const state = new URL((await as(adminToken).post("/api/v1/settings/meta-eternal/login")).body.url).searchParams.get("state")!;
    await request(app).get("/api/v1/ads/callback").query({ code: "good-code", state });
    const again = await request(app).get("/api/v1/ads/callback").query({ code: "good-code", state });
    expect(again.headers.location).not.toMatch(/metaLogin=[a-f0-9]{36}/);
    expect(again.headers.location).toContain("error");
  });

  it("чужой state — отказ без обмена кода", async () => {
    const res = await request(app).get("/api/v1/ads/callback").query({ code: "good-code", state: "f".repeat(48) });
    expect(res.headers.location).toContain("ads=error");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/oauth/access_token"))).toBe(false);
  });

  it("просроченный state (больше 10 минут) — отказ", async () => {
    grantElevation(adminId);
    const state = new URL((await as(adminToken).post("/api/v1/settings/meta-eternal/login")).body.url).searchParams.get("state")!;
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60 * 1000);
    const res = await request(app).get("/api/v1/ads/callback").query({ code: "good-code", state });
    expect(res.headers.location).not.toMatch(/metaLogin=[a-f0-9]{36}/);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/oauth/access_token"))).toBe(false);
  });

  it("право проверяется заново в колбэке: роль сменили, пока окно Facebook открыто", async () => {
    grantElevation(otherAdminId);
    const state = new URL((await as(otherAdminToken).post("/api/v1/settings/meta-eternal/login")).body.url).searchParams.get("state")!;
    await prisma.agent.update({ where: { id: otherAdminId }, data: { role: "AGENT" } });
    invalidateAgentAccess(otherAdminId);
    try {
      const res = await request(app).get("/api/v1/ads/callback").query({ code: "good-code", state });
      const loc = new URL(res.headers.location);
      expect(loc.searchParams.get("metaLogin")).toBe("error");
      expect(loc.searchParams.get("message")).toContain("правом менять настройки");
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/oauth/access_token"))).toBe(false);
    } finally {
      await prisma.agent.update({ where: { id: otherAdminId }, data: { role: "ADMIN" } });
      invalidateAgentAccess(otherAdminId);
    }
  });

  it("«Отмена» в окне Facebook возвращает к кнопке входа, а не к рекламе", async () => {
    grantElevation(adminId);
    const state = new URL((await as(adminToken).post("/api/v1/settings/meta-eternal/login")).body.url).searchParams.get("state")!;
    const res = await request(app).get("/api/v1/ads/callback").query({ error: "access_denied", state });
    const loc = new URL(res.headers.location);
    expect(loc.searchParams.get("metaLogin")).toBe("error");
    expect(loc.searchParams.get("message")).toContain("отменён");
  });

  it("рекламная кнопка по-прежнему: ads=connected, маркер в Настройках, отчёт включён", async () => {
    const start = await as(adminToken).post("/api/v1/ads/connect");
    expect(start.status).toBe(200);
    const url = new URL(start.body.url);
    expect(url.searchParams.get("scope")).toBe("ads_read");
    const res = await request(app).get("/api/v1/ads/callback").query({ code: "good-code", state: url.searchParams.get("state")! });
    expect(res.headers.location).toContain("ads=connected");
    const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaAdsToken: true, metaAdsEnabled: true } });
    expect(decryptSecretSafe(s?.metaAdsToken ?? null)).toBe(LONG);
    expect(s?.metaAdsEnabled).toBe(true);
  });
});

describe("выбор после входа", () => {
  it("сессия чужого сотрудника — 404, и на чтение, и на подключение", async () => {
    const id = await loginSession();
    expect((await as(otherAdminToken).get(`/api/v1/settings/meta-eternal/login/${id}`)).status).toBe(404);
    grantElevation(otherAdminId);
    expect((await as(otherAdminToken).post(`/api/v1/settings/meta-eternal/login/${id}/connect`, { pageIds: [PAGE_A] })).status).toBe(404);
    expect(await prisma.messengerAccount.count({ where: { channel: "FACEBOOK", externalId: PAGE_A } })).toBe(0);
  });

  it("находит Страницы, их Instagram и кабинеты; маркеры в ответ не попадают", async () => {
    const id = await loginSession();
    const res = await as(adminToken).get(`/api/v1/settings/meta-eternal/login/${id}`);
    expect(res.status).toBe(200);
    noSecretsIn(res.body);
    const byId = Object.fromEntries((res.body.pages as Array<{ id: string }>).map((p) => [p.id, p]));
    expect(byId[MAIN_PAGE]).toMatchObject({ connected: "settings" });
    expect(byId[PAGE_A]).toMatchObject({ canMessage: true, connected: null, ig: { id: IG_A, username: `arvan_${run}` } });
    expect(byId[PAGE_NO_TASK]).toMatchObject({ canMessage: false });
    expect(res.body.instagram.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining([IG_A, IG_C]));
    expect(res.body.adAccounts.map((a: { id: string }) => a.id)).toEqual([`act_${AD_1}`, `act_${AD_2}`]);
  });

  it("неверный выбор — 400", async () => {
    const id = await loginSession();
    grantElevation(adminId);
    expect((await as(adminToken).post(`/api/v1/settings/meta-eternal/login/${id}/connect`, { pageIds: ["abc"] })).status).toBe(400);
    expect((await as(adminToken).post(`/api/v1/settings/meta-eternal/login/${id}/connect`, { evil: true })).status).toBe(400);
  });
});

describe("Страница — общая дверь подключения", () => {
  it("создаёт Messenger Страницы, не делает «по умолчанию», подписка дополняет feed; повтор — без второй строки", async () => {
    const id = await loginSession();
    grantElevation(adminId);
    const first = await as(adminToken).post(`/api/v1/settings/meta-eternal/login/${id}/connect`, { pageIds: [PAGE_A] });
    expect(first.status).toBe(200);
    noSecretsIn(first.body);
    expect(first.body.results).toEqual([expect.objectContaining({ kind: "page", id: PAGE_A, ok: true })]);
    const rows = await prisma.messengerAccount.findMany({ where: { channel: "FACEBOOK", externalId: PAGE_A } });
    expect(rows).toHaveLength(1);
    accountIds.push(rows[0].id);
    expect(rows[0].isDefault).toBe(false);
    expect(decryptSecretSafe(rows[0].token)).toBe(PT_A);
    expect(meta.subscribePosts).toHaveLength(1);
    const fields = new URLSearchParams(meta.subscribePosts[0]).get("subscribed_fields")!.split(",");
    expect(fields).toEqual(expect.arrayContaining(["feed", "messages", "messaging_postbacks"]));

    const again = await as(adminToken).post(`/api/v1/settings/meta-eternal/login/${id}/connect`, { pageIds: [PAGE_A] });
    expect(again.body.results[0]).toMatchObject({ ok: true, message: expect.stringContaining("Ключ обновлён") });
    expect(await prisma.messengerAccount.count({ where: { channel: "FACEBOOK", externalId: PAGE_A } })).toBe(1);
  });

  it("основную Страницу из Настроек второй раз не подключить; без задачи «Сообщения» — отказ словами", async () => {
    const id = await loginSession();
    grantElevation(adminId);
    const res = await as(adminToken).post(`/api/v1/settings/meta-eternal/login/${id}/connect`, { pageIds: [MAIN_PAGE, PAGE_NO_TASK] });
    const [main, noTask] = res.body.results;
    expect(main).toMatchObject({ ok: false, message: expect.stringContaining("основные настройки") });
    expect(noTask).toMatchObject({ ok: false, message: expect.stringContaining("Сообщения") });
    expect(await prisma.messengerAccount.count({ where: { channel: "FACEBOOK", externalId: { in: [MAIN_PAGE, PAGE_NO_TASK] } } })).toBe(0);
  });
});

describe("Instagram через Страницу", () => {
  it("новый: маркер Страницы, Страница записана, отвечает через неё без рубильников", async () => {
    const id = await loginSession();
    grantElevation(adminId);
    const res = await as(adminToken).post(`/api/v1/settings/meta-eternal/login/${id}/connect`, { instagramIds: [IG_A] });
    expect(res.body.results[0]).toMatchObject({ kind: "instagram", ok: true });
    noSecretsIn(res.body);
    const row = await prisma.messengerAccount.findFirstOrThrow({ where: { channel: "INSTAGRAM", externalId: IG_A } });
    accountIds.push(row.id);
    expect(row).toMatchObject({ pageId: PAGE_A, isDefault: false, username: `arvan_${run}` });
    expect(decryptSecretSafe(row.token)).toBe(PT_A);

    // Рубильник «ключ компании» выключен, ключа компании нет — путь всё равно через Страницу.
    eternal.resetMetaEternalCache();
    const route = await eternal.instagramRouteForToken(PT_A);
    expect(route).toMatchObject({ kind: "page", pageId: PAGE_A, accountId: row.id, pageOnly: true, token: PT_A });
    const routed = await eternal.routeMetaMessagingCall(instagramApiUrl(`/${GRAPH_VERSION}/me/messages`), PT_A, { recipient: { id: "peer" }, message: { text: "Салом" } });
    expect(routed).toMatchObject({ url: `${GRAPH}/${PAGE_A}/messages`, token: PT_A, route: "instagram_page", pageOnly: true });
    // Отказ Страницы: повторять «личным» нечем — callGraph не должен уходить на graph.instagram.com.
    expect(eternal.pageRouteFailed(routed, 400, JSON.stringify({ error: { code: 10, message: "x" } }))).toBe(false);
  });

  it("существующий Instagram (свой ключ): только привязка к Странице, маркер не тронут", async () => {
    const existing = await prisma.messengerAccount.create({
      data: { channel: "INSTAGRAM", externalId: IG_C, title: `Royal Info ${run}`, token: encryptSecret(IGAA_C), username: `royal_${run}` },
    });
    accountIds.push(existing.id);
    resetAccountsCache();
    const id = await loginSession();
    grantElevation(adminId);
    const res = await as(adminToken).post(`/api/v1/settings/meta-eternal/login/${id}/connect`, { instagramIds: [IG_C] });
    expect(res.body.results[0]).toMatchObject({ ok: true, message: expect.stringContaining("привязан к Странице") });
    const row = await prisma.messengerAccount.findUniqueOrThrow({ where: { id: existing.id } });
    expect(row.pageId).toBe(PAGE_C);
    expect(decryptSecretSafe(row.token)).toBe(IGAA_C);
    expect(await prisma.messengerAccount.count({ where: { channel: "INSTAGRAM", externalId: IG_C } })).toBe(1);
    expect(meta.subscribePosts).toHaveLength(0);
  });

  it("аккаунт с маркером Страницы не роняет проверки graph.instagram.com (весь класс)", async () => {
    const row = await prisma.messengerAccount.findFirst({ where: { channel: "INSTAGRAM", externalId: IG_A } });
    const accountId =
      row?.id ??
      (await prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId: IG_A, title: "@arvan", token: encryptSecret(PT_A), pageId: PAGE_A } })).id;
    accountIds.push(accountId);
    resetAccountsCache();

    // Кто он — спрашиваем Страницу, а не graph.instagram.com/me.
    const identity = await instagramTokenIdentity(PT_A);
    expect(identity).toMatchObject({ ok: true, id: IG_A, username: `arvan_${run}`, pageId: PAGE_A });

    // Суточная проверка ключей: жив по Странице, без «запасной личный не работает».
    const [check] = await checkInstagramAccountsHealth([accountId]);
    expect(check).toMatchObject({ ok: true, detail: expect.stringContaining(PAGE_A) });

    // Самопроверка «Вечные ключи» не пугает «нет ключа компании»: у аккаунта свой ключ Страницы.
    const status = await eternal.metaEternalStatus();
    expect(status.rows.find((r) => r.accountId === accountId)).toMatchObject({ state: "pending_first_send", pageId: PAGE_A });

    // Проверка подписки Instagram этот аккаунт пропускает (его сообщения — по подписке Страницы).
    await checkInstagramSubscriptions();

    // Чтение объектов Instagram маркером Страницы — на graph.facebook.com; `/me` — не переносится.
    expect(instagramRequest(`https://graph.instagram.com/${GRAPH_VERSION}/1784/media?fields=id`, PT_A).url).toBe(`${GRAPH}/1784/media?fields=id`);
    expect(instagramRequest(`https://graph.instagram.com/${GRAPH_VERSION}/me?fields=id`, PT_A).url).toContain("graph.instagram.com");
    expect(instagramRequest(`https://graph.instagram.com/${GRAPH_VERSION}/1784/media`, IGAA_C).url).toContain("graph.instagram.com");
    // Ни одного похода на graph.instagram.com с маркером Страницы — за весь тест.
    // (Другие аккаунты общей базы стенда туда ходят — это не наш аккаунт.)
    const withPageToken = fetchMock.mock.calls.filter(
      ([u, i]) => String(u).startsWith("https://graph.instagram.com") && (authOf(i as RequestInit) === `Bearer ${PT_A}` || String(u).includes(encodeURIComponent(PT_A)))
    );
    expect(withPageToken).toHaveLength(0);
  });
});

describe("рекламные кабинеты", () => {
  it("дописываются без дублей, маркер рекламы — из входа, отчёт включён", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaAdAccountId: `act_${AD_1}`, metaAdsToken: encryptSecret(OLD_ADS) } });
    const id = await loginSession();
    grantElevation(adminId);
    const res = await as(adminToken).post(`/api/v1/settings/meta-eternal/login/${id}/connect`, { adAccountIds: [`act_${AD_2}`, AD_1] });
    expect(res.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    noSecretsIn(res.body);
    const s = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { metaAdAccountId: true, metaAdsToken: true, metaAdsEnabled: true } });
    expect(s.metaAdAccountId).toBe(`act_${AD_1}, act_${AD_2}`);
    expect(decryptSecretSafe(s.metaAdsToken)).toBe(LONG);
    expect(s.metaAdsEnabled).toBe(true);
  });

  it("вход не видит уже подключённый кабинет — ничего не меняем и говорим почему", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaAdAccountId: "act_9999999", metaAdsToken: encryptSecret(OLD_ADS), metaAdsEnabled: true } });
    const id = await loginSession();
    grantElevation(adminId);
    const res = await as(adminToken).post(`/api/v1/settings/meta-eternal/login/${id}/connect`, { adAccountIds: [`act_${AD_2}`] });
    expect(res.body.results[0]).toMatchObject({ ok: false, message: expect.stringContaining("act_9999999") });
    const s = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { metaAdAccountId: true, metaAdsToken: true } });
    expect(s.metaAdAccountId).toBe("act_9999999");
    expect(decryptSecretSafe(s.metaAdsToken)).toBe(OLD_ADS);
  });
});
