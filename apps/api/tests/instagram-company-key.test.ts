import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";
import { createCustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

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
const access = await import("../src/lib/instagramAccountAccess.js");
const { isInstagramAccountLockedText } = access;
const { wasRecentlySentText, resetOutgoingMids } = await import("../src/messengers/outgoingMids.js");
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

const meta = { linkedIg: IG_ID, personalMeOk: false, lockedMeOk: false, pageSendError: null as null | { status: number; code: number; subcode?: number }, personalSendError: null as null | { status: number; code: number; subcode?: number; message?: string } };
const pageSends: string[] = [];
const personalSends: string[] = [];
const fetchMock = vi.fn();
const authOf = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function settings(patch: Record<string, unknown>) {
  await prisma.settings.update({ where: { id: "singleton" }, data: patch });
  eternal.resetMetaEternalCache();
}

/** Тревоги этого файла: эпизод «закрыт» ключуется временем отметки, поэтому по началу метки. */
const alertWhere = () => ({ OR: [
  { tag: { startsWith: `ig-account-locked:${lockedId}` } }, { tag: { startsWith: `ig-account-locked:${accountId}` } },
  { tag: `${CHANNEL_KEY_ALERT_TAG_PREFIX}account:${lockedId}` }, { tag: `${CHANNEL_KEY_ALERT_TAG_PREFIX}account:${accountId}` },
  { tag: `ig-backup-key-dead:${accountId}` }, { tag: `ig-both-routes-failed:${accountId}` }, { tag: `${CHANNEL_KEY_ALERT_TAG_PREFIX}page-route:${PAGE_ID}` },
] });
const lockAlerts = () => ({ OR: [{ tag: { startsWith: `ig-account-locked:${lockedId}` } }, { tag: `${CHANNEL_KEY_ALERT_TAG_PREFIX}account:${lockedId}` }] });

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
  await prisma.pendingDirectorAlert.deleteMany({ where: alertWhere() });
  await prisma.metaSendBlock.deleteMany({ where: { accountId: { in: [accountId, lockedId] } } });
  eternal.resetMetaEternalCache();
  resetAccountsCache();
});

beforeEach(async () => {
  Object.assign(meta, { linkedIg: IG_ID, personalMeOk: false, lockedMeOk: false, pageSendError: null, personalSendError: null });
  pageSends.length = 0;
  personalSends.length = 0;
  resetOutgoingMids();
  await prisma.messengerAccount.update({ where: { id: accountId }, data: { pageId: null, accessLostAt: null, accessLostReason: null, eternalLastSentAt: null } });
  await prisma.messengerAccount.update({ where: { id: lockedId }, data: { pageId: null, accessLostAt: null, accessLostReason: null } });
  await prisma.pendingDirectorAlert.deleteMany({ where: alertWhere() });
  await prisma.metaSendBlock.deleteMany({ where: { accountId: { in: [accountId, lockedId] } } });
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
    if (url === `${GRAPH}/${PAGE_ID}/messages`) {
      pageSends.push(String(init?.body ?? ""));
      const e = meta.pageSendError;
      return e ? json({ error: { code: e.code, error_subcode: e.subcode, message: "page route refused" } }, e.status) : json({ recipient_id: "x", message_id: `mid-page-${randomUUID()}` });
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
      personalSends.push(String(init?.body ?? ""));
      const e = meta.personalSendError;
      if (e) return json({ error: { code: e.code, error_subcode: e.subcode, message: e.message ?? "personal refused" } }, e.status);
      return json({ recipient_id: "x", message_id: `mid-${randomUUID()}` });
    }
    return json({ error: { message: `unexpected ${url}` } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

// Общий ключ компании и рубильник — только на время теста (ревью #344): соседние файлы,
// идущие параллельно на той же базе, не должны получать чужой путь через Страницу.
afterEach(async () => {
  vi.unstubAllGlobals();
  if (before) await prisma.settings.update({ where: { id: "singleton" }, data: before });
  eternal.resetMetaEternalCache();
});

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
    expect(req?.url).toContain("/me/media");
    expect(req?.url).not.toContain("graph.facebook.com");
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
    const alert = await waitFor(() => prisma.pendingDirectorAlert.findFirst({ where: { tag: { startsWith: `ig-account-locked:${lockedId}:` } } }));
    expect(alert?.recipientRoles.slice().sort()).toEqual(["ADMIN", "DIRECTOR", "HEAD_OF_SALES"]);
    expect(alert?.body).not.toContain(LOCKED_TOKEN);
    eternal.resetMetaEternalCache();
    await expect(callGraph(url, LOCKED_TOKEN, { recipient: { id: "x" }, sender_action: "typing_on" })).rejects.toThrow(/401/);
    const count = await waitForSettled(() => prisma.pendingDirectorAlert.count({ where: lockAlerts() }));
    expect(count).toBe(1);
  });

  it("суточная проверка: ставит отметку один раз, дальше молчит; ответ вернулся — отметка снята", async () => {
    const [first] = await checkInstagramAccountsHealth([lockedId]);
    expect(first.ok).toBeNull();
    expect((await prisma.messengerAccount.findUnique({ where: { id: lockedId }, select: { accessLostAt: true } }))?.accessLostAt).not.toBeNull();
    await checkInstagramAccountsHealth([lockedId]);
    expect(await prisma.pendingDirectorAlert.count({ where: lockAlerts() })).toBe(1);
    meta.lockedMeOk = true;
    const [back] = await checkInstagramAccountsHealth([lockedId]);
    expect(back.ok).toBe(true);
    expect((await prisma.messengerAccount.findUnique({ where: { id: lockedId }, select: { accessLostAt: true } }))?.accessLostAt).toBeNull();
  });

  // 25.11.2026 (прод 24.11, Arvan): мёртвый после смены пароля ключ метится той же дверью, что «закрыт», своим текстом
  // («Заменить маркер»), одна тревога руководству на эпизод; второй тревоги «Ключ не работает» нет. До этого здесь было
  // «не «закрыт», тревога раз в сутки» — и остальные пути (отправка, повтор, профиль) били в мёртвый ключ сотнями строк.
  it("обычный 401 (смена пароля) — та же отметка своим текстом, одна тревога руководству, без «Ключ не работает»", async () => {
    const keyTag = `${CHANNEL_KEY_ALERT_TAG_PREFIX}account:${accountId}`;
    const lockTag = { tag: { startsWith: `ig-account-locked:${accountId}` } };
    await prisma.pendingDirectorAlert.deleteMany({ where: { OR: [{ tag: keyTag }, lockTag] } });
    await settings({ instagramCompanyKeyEnabled: false });
    const [row] = await checkInstagramAccountsHealth([accountId]);
    expect(row.ok).toBeNull();
    expect(row.detail).toMatch(/не принимает ключ/);
    expect((await prisma.messengerAccount.findUnique({ where: { id: accountId }, select: { accessLostAt: true } }))?.accessLostAt).not.toBeNull();
    const alert = await waitFor(() => prisma.pendingDirectorAlert.findFirst({ where: lockTag }));
    expect(alert?.recipientRoles).toContain("HEAD_OF_SALES");
    expect(alert?.title).toMatch(/ключ аккаунта больше не принимается/);
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: keyTag } })).toBe(0);
    await prisma.pendingDirectorAlert.deleteMany({ where: { OR: [{ tag: keyTag }, lockTag] } });
    await prisma.messengerAccount.update({ where: { id: accountId }, data: { accessLostAt: null, accessLostReason: null } });
  });

  it("новый маркер («Заменить маркер») снимает отметку сразу", async () => {
    await prisma.messengerAccount.update({ where: { id: lockedId }, data: { accessLostAt: new Date(), accessLostReason: "HTTP 401" } });
    await saveAccount({ id: lockedId, channel: "INSTAGRAM", externalId: IG_LOCKED, title: `Закрыт ${run}`, token: `${LOCKED_TOKEN}-new` });
    const row = await prisma.messengerAccount.findUnique({ where: { id: lockedId }, select: { accessLostAt: true, accessLostReason: true } });
    expect(row).toEqual({ accessLostAt: null, accessLostReason: null });
    await prisma.messengerAccount.update({ where: { id: lockedId }, data: { token: encryptSecret(LOCKED_TOKEN) } });
  });
});

describe("ревью #344: путь Страницы и запасной личный ключ", () => {
  const send = (text = "Салом, нархаш 450 000") =>
    callGraph(instagramApiUrl(`/${GRAPH_VERSION}/me/messages`), PERSONAL, { recipient: { id: `igsid-${run}` }, message: { text } });
  const routed = async () => {
    await prisma.messengerAccount.update({ where: { id: accountId }, data: { pageId: PAGE_ID } });
    eternal.resetMetaEternalCache();
  };

  it("отправка через Страницу помнит «кому + что» — эхо без знакомого mid узнается своим", async () => {
    await routed();
    await send("Хона дар Сино");
    expect(pageSends).toHaveLength(1);
    expect(await wasRecentlySentText({ channel: "INSTAGRAM", peer: `igsid-${run}`, content: "Хона дар Сино" })).toBe(true);
  });

  it.each([
    { code: 10, subcode: 2018278, what: "вне окна 24 часов" },
    { code: 10, subcode: 2534022, what: "вне окна (Instagram)" },
  ])("окно 24 часов ($what) — не отказ пути: без повтора, паузы и тревоги", async ({ code, subcode }) => {
    await routed();
    meta.pageSendError = { status: 400, code, subcode };
    await expect(send()).rejects.toThrow();
    expect(personalSends).toHaveLength(0);
    expect((await eternal.instagramRouteForToken(PERSONAL)).kind).toBe("page");
    const alarm = await waitForSettled(() => prisma.pendingDirectorAlert.count({ where: { tag: `${CHANNEL_KEY_ALERT_TAG_PREFIX}page-route:${PAGE_ID}` } }));
    expect(alarm).toBe(0);
  });

  it.each([
    { code: 551, subcode: 1545041, what: "человек недоступен" },
    { code: 100, subcode: 2534014, what: "нет такого собеседника" },
  ])("отказ про собеседника ($what) — один повтор личным ключом, Страница без паузы, без тревоги", async ({ code, subcode }) => {
    await routed();
    meta.pageSendError = { status: 400, code, subcode };
    await send();
    expect(personalSends).toHaveLength(1);
    expect((await eternal.instagramRouteForToken(PERSONAL)).kind).toBe("page");
    const alarm = await waitForSettled(() => prisma.pendingDirectorAlert.count({ where: { tag: `${CHANNEL_KEY_ALERT_TAG_PREFIX}page-route:${PAGE_ID}` } }));
    expect(alarm).toBe(0);
  });

  it.each([
    { code: 10, subcode: 2018300 },
    { code: 100, subcode: 2534037 },
  ])("переписку ведёт другое приложение ($code/$subcode) — без повтора, без паузы Страницы и тревоги; бот в переписке на паузе", async ({ code, subcode }) => {
    const fixture = await createCustomerMessengerFixture("INSTAGRAM");
    try {
      await prisma.messengerAccount.update({ where: { id: fixture.id }, data: { pageId: PAGE_ID } });
      meta.linkedIg = fixture.externalId;
      eternal.resetMetaEternalCache();
      const peer = `igsid-owner-${run}`;
      const conv = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", accountId: fixture.id,
        endpointScopeId: fixture.transport.endpointScopeId, subscriberId: peer, messages: [{ role: "user", content: "Салом" }] as never } });
      meta.pageSendError = { status: 400, code, subcode };
      await expect(callGraph(instagramApiUrl(`/${GRAPH_VERSION}/me/messages`), fixture.token, { recipient: { id: peer }, message: { text: "Ответ бота" } }))
        .rejects.toThrow();
      expect(pageSends).toHaveLength(1);
      expect(personalSends).toHaveLength(0);
      expect((await eternal.instagramRouteForToken(fixture.token)).kind).toBe("page");
      const row = await prisma.botConversation.findUnique({ where: { id: conv.id }, select: { pausedUntil: true } });
      expect(row?.pausedUntil?.getTime()).toBeGreaterThan(Date.now());
      const alarm = await waitForSettled(() => prisma.pendingDirectorAlert.count({ where: { tag: `${CHANNEL_KEY_ALERT_TAG_PREFIX}page-route:${PAGE_ID}` } }));
      expect(alarm).toBe(0);
    } finally {
      await fixture.cleanupConversations();
      await fixture.dispose();
    }
  });

  it("лимит частоты (613) — про приложение и Страницу: пауза Страницы, повтор личным, без тревоги о ключе", async () => {
    await routed();
    meta.pageSendError = { status: 400, code: 613, subcode: 2534040 };
    await send();
    expect(personalSends).toHaveLength(1);
    expect((await eternal.instagramRouteForToken(PERSONAL)).kind).toBe("instagram_login");
    const alarm = await waitForSettled(() => prisma.pendingDirectorAlert.count({ where: { tag: `${CHANNEL_KEY_ALERT_TAG_PREFIX}page-route:${PAGE_ID}` } }));
    expect(alarm).toBe(0);
  });

  it("путь Страницы отказал, повтор личным ключом — «проверка безопасности»: не «закрыт», а «запасной ключ» (через callGraph)", async () => {
    await routed();
    meta.pageSendError = { status: 400, code: 200 };
    meta.personalSendError = { status: 401, code: 190, message: LOCKED_TEXT };
    await expect(send()).rejects.toThrow(/401/);
    expect(personalSends).toHaveLength(1);
    // Страница отказала как путь, личный ключ — тоже: честный текст «отказывают оба пути», не «бот отвечает через Страницу».
    const both = await waitFor(() => prisma.pendingDirectorAlert.findFirst({ where: { tag: `ig-both-routes-failed:${accountId}` } }));
    expect(both?.body).toContain("Meta отказывает обоим путям");
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `ig-backup-key-dead:${accountId}` } })).toBe(0);
    const lost = await waitForSettled(() => prisma.messengerAccount.count({ where: { id: accountId, accessLostAt: { not: null } } }));
    expect(lost).toBe(0);
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: { startsWith: `ig-account-locked:${accountId}` } } })).toBe(0);
    // Страница ещё на паузе: сейчас отвечает личный путь, но путь Страницы у аккаунта настроен — «закрыт» не ставится.
    expect((await eternal.instagramRouteForToken(PERSONAL)).kind).toBe("instagram_login");
    expect(await access.instagramAccountPageRouted(accountId)).toBe(true);
    expect(await access.noteInstagramAccountLocked(accountId, `HTTP 401: ${LOCKED_TEXT}`)).toEqual({ marked: false, backupOnly: true });
  });

  /**
   * Вердикт «ключ канала мёртв» для повтора ответа бота (ревью #423, второй круг): выносит callGraph, про ТОТ ключ, которым
   * шла отправка, и только если он не запасной. Иначе минутная пауза Страницы глушила бы переписку на весь день.
   */
  it("запасной ключ мёртв, Страница на паузе: отправка личным, 401 — НЕ «ключ канала мёртв»", async () => {
    await routed();
    meta.pageSendError = { status: 400, code: 613, subcode: 2534040 };
    await send();
    expect(pageSends).toHaveLength(1);
    // Страница на паузе: следующая отправка сразу личным ключом (не повтор после отказа Страницы), и он мёртв.
    meta.personalSendError = { status: 401, code: 190, message: "Error validating access token: session has been invalidated" };
    const err = await send().catch((e: unknown) => e);
    expect(pageSends).toHaveLength(1);
    expect(err).toBeInstanceOf((await import("../src/lib/metaSendBlock.js")).MetaGraphCallError);
    expect((err as { channelKeyDead: unknown }).channelKeyDead).toBeNull();
  });

  it("без пути Страницы единственный ключ отвечает 401 — «ключ канала мёртв» с отпечатком именно этого ключа", async () => {
    meta.personalSendError = { status: 401, code: 190, message: "Error validating access token: session has been invalidated" };
    const err = await send().catch((e: unknown) => e) as { channelKeyDead: { fingerprint: string } | null };
    const { createHash } = await import("node:crypto");
    expect(err.channelKeyDead).toEqual({ fingerprint: createHash("sha256").update(PERSONAL).digest("hex").slice(0, 12) });
  });

  it("код 190 не про ключ («окно ответа истекло») — ни «ключ мёртв», ни тревоги о ключе руководству", async () => {
    const { isMetaAuthFailure } = await import("../src/lib/channelKeyAlarm.js");
    const windowBody = JSON.stringify({ error: { code: 190, message: "The comment reply window has expired" } });
    expect(isMetaAuthFailure(400, windowBody)).toBe(false);
    expect(isMetaAuthFailure(400, JSON.stringify({ error: { code: 190, message: "Error validating access token: Session has expired" } }))).toBe(true);
    expect(isMetaAuthFailure(401, "{}")).toBe(true);
    // Тревога соседнего теста по этому же аккаунту может дописаться «в отрыве» (void) уже после его конца:
    // дожидаемся тишины и убираем её ДО действия, иначе счёт ниже считает чужую запись (флак #344, 26.11.2026).
    const accountAlarmTag = `${CHANNEL_KEY_ALERT_TAG_PREFIX}account:${accountId}`;
    await waitForSettled(() => prisma.pendingDirectorAlert.count({ where: { tag: accountAlarmTag } }));
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag: accountAlarmTag } });
    meta.personalSendError = { status: 400, code: 190, message: "The comment reply window has expired" };
    const err = await send().catch((e: unknown) => e) as { channelKeyDead: unknown };
    expect(err.channelKeyDead).toBeNull();
    const alarm = await waitForSettled(() => prisma.pendingDirectorAlert.count({ where: { tag: accountAlarmTag } }));
    expect(alarm).toBe(0);
  });

  it("200 без подкода (нет App Review) — отказ пути: повтор личным, Страница на скамейке, тревога", async () => {
    await routed();
    meta.pageSendError = { status: 400, code: 200 };
    await send();
    expect(personalSends).toHaveLength(1);
    expect((await eternal.instagramRouteForToken(PERSONAL)).kind).toBe("instagram_login");
    await waitFor(() => prisma.pendingDirectorAlert.findFirst({ where: { tag: `${CHANNEL_KEY_ALERT_TAG_PREFIX}page-route:${PAGE_ID}` } }));
  });

  it("запрет Meta (100/2534029) на пути Страницы — откат на личный ключ, аккаунт не метится", async () => {
    await routed();
    meta.pageSendError = { status: 400, code: 100, subcode: 2534029 };
    await send();
    expect(personalSends).toHaveLength(1);
    expect(await waitForSettled(() => prisma.metaSendBlock.count({ where: { accountId, liftedAt: null } }))).toBe(0);
  });

  it("запрет на обоих путях — метка «Meta не пропускает отправку» ставится", async () => {
    await routed();
    meta.pageSendError = { status: 400, code: 100, subcode: 2534029 };
    meta.personalSendError = { status: 400, code: 100, subcode: 2534029 };
    await expect(send()).rejects.toThrow();
    expect(personalSends).toHaveLength(1);
    await waitFor(() => prisma.metaSendBlock.findFirst({ where: { accountId, liftedAt: null } }));
  });

  it("личный ключ «закрыт Meta», а путь Страницы работает — не «закрыт», а «запасной ключ не работает»", async () => {
    await routed();
    const res = await access.noteInstagramAccountLocked(accountId, `HTTP 401: ${LOCKED_TEXT}`);
    expect(res).toEqual({ marked: false, backupOnly: true });
    expect((await prisma.messengerAccount.findUnique({ where: { id: accountId }, select: { accessLostAt: true } }))?.accessLostAt).toBeNull();
    const alert = await waitFor(() => prisma.pendingDirectorAlert.findFirst({ where: { tag: `ig-backup-key-dead:${accountId}` } }));
    expect(alert?.title).toBe("Instagram: переподключите аккаунт");
    // Через Страницу за сутки отправок не было — не утверждаем, что «бот отвечает через Страницу».
    expect(alert?.body).toContain("за сутки ответов через него не было");
  });

  it("через Страницу за сутки была успешная отправка — «бот отвечает через Страницу, но личный ключ не работает»", async () => {
    await routed();
    await prisma.messengerAccount.update({ where: { id: accountId }, data: { eternalLastSentAt: new Date(Date.now() - 60 * 60_000) } });
    eternal.resetMetaEternalCache();
    await access.noteInstagramBackupKeyDead(accountId, "HTTP 401");
    const alert = await waitFor(() => prisma.pendingDirectorAlert.findFirst({ where: { tag: `ig-backup-key-dead:${accountId}` } }));
    expect(alert?.body).toContain("бот отвечает через Страницу");
    await prisma.messengerAccount.update({ where: { id: accountId }, data: { eternalLastSentAt: null } });
  });

  it("старая отметка «закрыт» у аккаунта с рабочим путём Страницы: экран её не показывает, суточная проверка снимает", async () => {
    await routed();
    await prisma.messengerAccount.update({ where: { id: accountId }, data: { accessLostAt: new Date(), accessLostReason: "HTTP 401" } });
    eternal.resetMetaEternalCache();
    const status = await eternal.metaEternalStatus();
    const row = status.rows.find((r) => r.accountId === accountId);
    expect(row?.state).not.toBe("locked");
    expect(row?.route).toBe("page");
    const [health] = await checkInstagramAccountsHealth([accountId]);
    expect(health.ok).toBe(true);
    expect((await prisma.messengerAccount.findUnique({ where: { id: accountId }, select: { accessLostAt: true } }))?.accessLostAt).toBeNull();
  });

  it("новый эпизод «закрыт» после снятия отметки — снова запись и тревога", async () => {
    expect((await access.noteInstagramAccountLocked(lockedId, "HTTP 401 первый")).marked).toBe(true);
    await access.clearInstagramAccountLocked(lockedId, "probe_ok");
    await new Promise((r) => setTimeout(r, 5));
    expect((await access.noteInstagramAccountLocked(lockedId, "HTTP 401 второй")).marked).toBe(true);
    const alerts = await prisma.pendingDirectorAlert.count({ where: { tag: { startsWith: `ig-account-locked:${lockedId}:` } } });
    expect(alerts).toBe(2);
  });

  it("ссылка следующей страницы ленты: ключ по хосту ссылки, а не по нынешнему пути", async () => {
    await routed();
    const fb = `${GRAPH}/${IG_ID}/media?after=x`;
    const ig = `https://graph.instagram.com/${GRAPH_VERSION}/me/media?after=y`;
    expect(await eternal.instagramMediaRequest(PERSONAL, "q", fb)).toEqual({ url: fb, headers: { Authorization: `Bearer ${PAGE_TOKEN}` } });
    expect((await eternal.instagramMediaRequest(PERSONAL, "q", ig))?.url).not.toContain("graph.facebook.com");
    await settings({ instagramCompanyKeyEnabled: false });
    expect(await eternal.instagramMediaRequest(PERSONAL, "q", fb)).toBeNull();
  });
});
