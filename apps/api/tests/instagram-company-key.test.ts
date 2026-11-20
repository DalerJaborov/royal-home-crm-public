import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";

/**
 * Instagram на постоянный ключ Meta (владелец 21.11.2026: «Да, переводи»).
 *
 * Живые случаи: 11.11 смена пароля Instagram заглушила бота Royal Home; 20.11 Meta
 * закрыла аккаунт Arvan («You cannot access the app till you log in to
 * www.instagram.com…»), а входящие Arvan встали ещё 17.11 — и об этом знал только
 * журнал. Здесь: Страницу CRM находит сама; лента идёт тем же путём; закрытый Meta
 * аккаунт — одна отметка и одна тревога, проверки его не дёргают, новый маркер или
 * успешный ответ снимают отметку.
 */
const { prisma } = await import("../src/db.js");
const { encryptSecret } = await import("../src/crypto.js");
const eternal = await import("../src/lib/metaEternalTokens.js");
const { callGraph, instagramApiUrl, GRAPH_VERSION } = await import("../src/messengers/meta.js");
const { checkInstagramAccountsHealth } = await import("../src/lib/integrationHealth.js");
const { saveAccount, resetAccountsCache } = await import("../src/messengers/accounts.js");
const { isInstagramAccountLockedText } = await import("../src/lib/instagramAccountAccess.js");
const { CHANNEL_KEY_ALERT_TAG_PREFIX } = await import("../src/lib/channelKeyAlarm.js");

const run = randomUUID().slice(0, 8);
const stamp = Date.now().toString().slice(-9);
const PAGE_ID = `8${stamp}1`;
const IG_ID = `178415${stamp}`;
const IG_LOCKED = `178416${stamp}`;
const PERSONAL = `stand-ig-personal-${run}`;
const LOCKED_TOKEN = `stand-ig-locked-${run}`;
const SYSTEM = `stand-system-ck-${run}`;
const PAGE_TOKEN = `stand-page-ck-${run}`;
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const LOCKED_TEXT = "Error validating access token: You cannot access the app till you log in to www.instagram.com and follow the instructions given.";

let accountId = "";
let lockedId = "";
let before: Record<string, unknown> | null = null;

const meta = { linkedIg: IG_ID, personalMeOk: false, lockedMeOk: false };
const fetchMock = vi.fn();
const authOf = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function settings(patch: Record<string, unknown>) {
  await prisma.settings.update({ where: { id: "singleton" }, data: patch });
  eternal.resetMetaEternalCache();
}

const lockTags = () => [`ig-account-locked:${lockedId}`, `${CHANNEL_KEY_ALERT_TAG_PREFIX}account:${lockedId}`];

beforeAll(async () => {
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {} });
  before = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaIgManageToken: true, instagramCompanyKeyEnabled: true },
  });
  accountId = (await prisma.messengerAccount.create({
    data: { channel: "INSTAGRAM", externalId: IG_ID, title: `Ключ ${run}`, token: encryptSecret(PERSONAL), username: `ck_${run}` },
  })).id;
  lockedId = (await prisma.messengerAccount.create({
    data: { channel: "INSTAGRAM", externalId: IG_LOCKED, title: `Закрыт ${run}`, token: encryptSecret(LOCKED_TOKEN) },
  })).id;
});

afterAll(async () => {
  await prisma.messengerAccount.deleteMany({ where: { id: { in: [accountId, lockedId] } } });
  if (before) await prisma.settings.update({ where: { id: "singleton" }, data: before });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: lockTags() } } });
  eternal.resetMetaEternalCache();
  resetAccountsCache();
});

beforeEach(async () => {
  Object.assign(meta, { linkedIg: IG_ID, personalMeOk: false, lockedMeOk: false });
  await prisma.messengerAccount.update({ where: { id: accountId }, data: { pageId: null, accessLostAt: null, accessLostReason: null } });
  await prisma.messengerAccount.update({ where: { id: lockedId }, data: { pageId: null, accessLostAt: null, accessLostReason: null } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: lockTags() } } });
  await settings({ metaIgManageToken: encryptSecret(SYSTEM), instagramCompanyKeyEnabled: true });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = authOf(init);
    if (url === `${GRAPH}/me/permissions`) {
      return json({ data: ["instagram_basic", "instagram_manage_messages", "pages_manage_metadata", "pages_messaging"].map((permission) => ({ permission, status: "granted" })) });
    }
    if (url.startsWith(`${GRAPH}/me/accounts`)) {
      if (auth !== `Bearer ${SYSTEM}`) return json({ error: { code: 190, message: "bad" } }, 400);
      return json({ data: [{ id: PAGE_ID, name: "Royal.home.tj", instagram_business_account: { id: meta.linkedIg } }] });
    }
    if (url.startsWith(`${GRAPH}/${PAGE_ID}?fields=access_token`)) {
      return json({ id: PAGE_ID, access_token: PAGE_TOKEN, name: "Royal.home.tj", instagram_business_account: { id: meta.linkedIg } });
    }
    if (url.startsWith(`${GRAPH}/${IG_ID}/media`)) return json({ data: [{ id: "m1", permalink: "https://instagram.com/p/x", timestamp: "2026-11-21T00:00:00+0000" }] });
    // graph.instagram.com (личные маркеры). Через прокси маркер — в адресе, без прокси — в заголовке.
    const carries = (token: string) => auth === `Bearer ${token}` || url.includes(`access_token=${token}`);
    if (url.includes("/me?fields=id")) {
      if (carries(LOCKED_TOKEN)) return meta.lockedMeOk ? json({ id: IG_LOCKED, username: "locked" }) : json({ error: { code: 190, message: LOCKED_TEXT } }, 401);
      return meta.personalMeOk ? json({ id: IG_ID, username: "ok" }) : json({ error: { code: 190, message: "session has been invalidated" } }, 401);
    }
    if (url.includes("/me/messages")) {
      if (carries(LOCKED_TOKEN)) return json({ error: { code: 190, message: LOCKED_TEXT } }, 401);
      return json({ recipient_id: "x", message_id: `mid-${randomUUID()}` });
    }
    return json({ error: { message: `unexpected ${url}` } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("Страницу CRM находит сама", () => {
  it("Страница ключа компании с этим Instagram — pageId записан, ответ дальше идёт через Страницу", async () => {
    const result = await eternal.autoLinkInstagramPages();
    expect(result.linked).toContain(accountId);
    const row = await prisma.messengerAccount.findUnique({ where: { id: accountId }, select: { pageId: true } });
    expect(row?.pageId).toBe(PAGE_ID);
    const route = await eternal.instagramRouteForToken(PERSONAL);
    expect(route).toMatchObject({ kind: "page", pageId: PAGE_ID, token: PAGE_TOKEN, igId: IG_ID });
  });

  it("к Странице привязан другой Instagram — ничего не пишет", async () => {
    meta.linkedIg = "17841499999999999";
    const result = await eternal.autoLinkInstagramPages();
    expect(result.linked).not.toContain(accountId);
    expect((await prisma.messengerAccount.findUnique({ where: { id: accountId }, select: { pageId: true } }))?.pageId).toBeNull();
  });

  it("закрытый Meta аккаунт не трогает", async () => {
    await prisma.messengerAccount.update({ where: { id: accountId }, data: { accessLostAt: new Date() } });
    const result = await eternal.autoLinkInstagramPages();
    expect(result.linked).not.toContain(accountId);
    expect(result.notFound).not.toContain(accountId);
  });
});

describe("лента тем же путём", () => {
  it("через Страницу — graph.facebook.com/{ig}/media маркером Страницы", async () => {
    await prisma.messengerAccount.update({ where: { id: accountId }, data: { pageId: PAGE_ID } });
    eternal.resetMetaEternalCache();
    const req = await eternal.instagramMediaRequest(PERSONAL, "fields=id&limit=5");
    expect(req).toEqual({ url: `${GRAPH}/${IG_ID}/media?fields=id&limit=5`, headers: { Authorization: `Bearer ${PAGE_TOKEN}` } });
  });

  it("рубильник выключен — прежний graph.instagram.com/me/media личным маркером", async () => {
    await prisma.messengerAccount.update({ where: { id: accountId }, data: { pageId: PAGE_ID } });
    await settings({ instagramCompanyKeyEnabled: false });
    const req = await eternal.instagramMediaRequest(PERSONAL, "fields=id&limit=5");
    expect(req.url).toContain("/me/media");
    expect(req.url).not.toContain("graph.facebook.com");
  });
});

describe("Meta закрыла доступ к аккаунту — одна отметка, одна тревога", () => {
  it("узнаёт текст Meta", () => {
    expect(isInstagramAccountLockedText(LOCKED_TEXT)).toBe(true);
    expect(isInstagramAccountLockedText("The session has been invalidated because the user changed their password")).toBe(false);
  });

  it("отказ на отправке: отметка, одна тревога руководству; повтор — ни новой тревоги, ни «ключ умер»", async () => {
    const url = instagramApiUrl(`/${GRAPH_VERSION}/me/messages`);
    await expect(callGraph(url, LOCKED_TOKEN, { recipient: { id: "x" }, sender_action: "typing_on" })).rejects.toThrow(/401/);
    const row = await waitFor(() => prisma.messengerAccount.findFirst({ where: { id: lockedId, accessLostAt: { not: null } } }));
    expect(row?.accessLostReason).toContain("cannot access the app");
    const alert = await waitFor(() => prisma.pendingDirectorAlert.findFirst({ where: { tag: `ig-account-locked:${lockedId}` } }));
    expect(alert?.recipientRoles.slice().sort()).toEqual(["ADMIN", "DIRECTOR", "HEAD_OF_SALES"]);
    expect(alert?.body).not.toContain(LOCKED_TOKEN);
    eternal.resetMetaEternalCache();
    await expect(callGraph(url, LOCKED_TOKEN, { recipient: { id: "x" }, sender_action: "typing_on" })).rejects.toThrow(/401/);
    const count = await waitForSettled(() => prisma.pendingDirectorAlert.count({ where: { tag: { in: lockTags() } } }));
    expect(count).toBe(1);
  });

  it("суточная проверка: ставит отметку один раз, дальше молчит; ответ вернулся — отметка снята", async () => {
    const [first] = await checkInstagramAccountsHealth([lockedId]);
    expect(first.ok).toBeNull();
    expect((await prisma.messengerAccount.findUnique({ where: { id: lockedId }, select: { accessLostAt: true } }))?.accessLostAt).not.toBeNull();
    await checkInstagramAccountsHealth([lockedId]);
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: { in: lockTags() } } })).toBe(1);
    meta.lockedMeOk = true;
    const [back] = await checkInstagramAccountsHealth([lockedId]);
    expect(back.ok).toBe(true);
    expect((await prisma.messengerAccount.findUnique({ where: { id: lockedId }, select: { accessLostAt: true } }))?.accessLostAt).toBeNull();
  });

  it("обычный 401 (смена пароля) — не «закрыт», а тревога руководству раз в сутки", async () => {
    const tag = `${CHANNEL_KEY_ALERT_TAG_PREFIX}account:${accountId}`;
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag } });
    await settings({ instagramCompanyKeyEnabled: false });
    const [row] = await checkInstagramAccountsHealth([accountId]);
    expect(row.ok).toBe(false);
    expect((await prisma.messengerAccount.findUnique({ where: { id: accountId }, select: { accessLostAt: true } }))?.accessLostAt).toBeNull();
    const alert = await waitFor(() => prisma.pendingDirectorAlert.findFirst({ where: { tag } }));
    expect(alert?.recipientRoles).toContain("HEAD_OF_SALES");
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag } });
  });

  it("новый маркер («Заменить маркер») снимает отметку сразу", async () => {
    await prisma.messengerAccount.update({ where: { id: lockedId }, data: { accessLostAt: new Date(), accessLostReason: "HTTP 401" } });
    await saveAccount({ id: lockedId, channel: "INSTAGRAM", externalId: IG_LOCKED, title: `Закрыт ${run}`, token: `${LOCKED_TOKEN}-new` });
    const row = await prisma.messengerAccount.findUnique({ where: { id: lockedId }, select: { accessLostAt: true, accessLostReason: true } });
    expect(row).toEqual({ accessLostAt: null, accessLostReason: null });
    await prisma.messengerAccount.update({ where: { id: lockedId }, data: { token: encryptSecret(LOCKED_TOKEN) } });
  });
});
