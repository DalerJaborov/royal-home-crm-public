import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "./helpers/waitFor.js";

/**
 * Вечные ключи Meta (12.11.2026). Живой случай: 11.11 владелец сменил пароль
 * Instagram, личный маркер ответил 401 «session has been invalidated», и бот
 * сутки молчал, а 91 строка в журнале никого не разбудила. Здесь проверяем:
 * выбор пути (Страница или личный маркер), адрес и тело запроса, отказ от
 * Страницы с чужим Instagram, рубильник, Facebook и рекламу, тревогу на 401.
 */
const { prisma } = await import("../src/db.js");
const { encryptSecret } = await import("../src/crypto.js");
const eternal = await import("../src/lib/metaEternalTokens.js");
const { callGraph, instagramApiUrl, GRAPH_VERSION } = await import("../src/messengers/meta.js");
const { isMetaAuthFailure, isMetaAuthFailureText, raiseChannelKeyAlarm, CHANNEL_KEY_ALERT_TAG_PREFIX } = await import("../src/lib/channelKeyAlarm.js");

const run = randomUUID().slice(0, 8);
const PAGE_ID = `9${Date.now().toString().slice(-10)}1`;
const IG_ID = `178414${Date.now().toString().slice(-10)}`;
const IG_LOGIN = `stand-ig-login-${run}`;
const SYSTEM = `stand-system-${run}`;
const PAGE_TOKEN = `stand-page-${run}`;
const FB_PERSONAL = `stand-fb-personal-${run}`;
const IG_MESSAGES = () => instagramApiUrl(`/${GRAPH_VERSION}/me/messages`);
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

let accountId = "";
let before: { metaIgManageToken: string | null; metaPageId: string | null; metaPageToken: string | null; metaSystemTokenPreferred: boolean } | null = null;
let linkedIg = IG_ID;
const fetchMock = vi.fn();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeAll(async () => {
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {} });
  before = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaIgManageToken: true, metaPageId: true, metaPageToken: true, metaSystemTokenPreferred: true },
  });
  const row = await prisma.messengerAccount.create({
    data: { channel: "INSTAGRAM", externalId: IG_ID, title: `Вечный ${run}`, token: encryptSecret(IG_LOGIN), username: `eternal_${run}`, pageId: PAGE_ID },
  });
  accountId = row.id;
});

afterAll(async () => {
  await prisma.messengerAccount.deleteMany({ where: { id: accountId } });
  if (before) await prisma.settings.update({ where: { id: "singleton" }, data: before });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { startsWith: `${CHANNEL_KEY_ALERT_TAG_PREFIX}test-${run}` } } });
  eternal.resetMetaEternalCache();
});

beforeEach(async () => {
  linkedIg = IG_ID;
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { metaIgManageToken: encryptSecret(SYSTEM), metaSystemTokenPreferred: true, metaPageId: PAGE_ID, metaPageToken: encryptSecret(FB_PERSONAL) },
  });
  await prisma.messengerAccount.update({ where: { id: accountId }, data: { pageId: PAGE_ID } });
  eternal.resetMetaEternalCache();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (url.startsWith(`${GRAPH}/${PAGE_ID}?fields=access_token`)) {
      if (auth !== `Bearer ${SYSTEM}`) return json({ error: { code: 190, message: "bad token" } }, 400);
      return json({ id: PAGE_ID, access_token: PAGE_TOKEN, name: "Royal Home Page", instagram_business_account: { id: linkedIg } });
    }
    if (url === `${GRAPH}/${PAGE_ID}/messages`) return json({ recipient_id: "igsid", message_id: `mid-${run}` });
    return json({ error: { message: `unexpected ${url}` } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("Instagram через Страницу", () => {
  it("адрес /me/messages личного маркера уходит на graph.facebook.com/{page}/messages маркером Страницы", async () => {
    const routed = await eternal.routeMetaMessagingCall(IG_MESSAGES(), IG_LOGIN, { recipient: { id: "igsid" }, message: { text: "Салом" } });
    expect(routed.route).toBe("instagram_page");
    expect(routed.url).toBe(`${GRAPH}/${PAGE_ID}/messages`);
    expect(routed.token).toBe(PAGE_TOKEN);
    // Send API Messenger Platform требует тип сообщения у обычного ответа.
    expect(routed.body).toEqual({ recipient: { id: "igsid" }, message: { text: "Салом" }, messaging_type: "RESPONSE" });
  });

  it("«печатает…» и ответ на комментарий идут без messaging_type", async () => {
    const typing = await eternal.routeMetaMessagingCall(IG_MESSAGES(), IG_LOGIN, { recipient: { id: "igsid" }, sender_action: "typing_on" });
    expect(typing.body).toEqual({ recipient: { id: "igsid" }, sender_action: "typing_on" });
    const privateReply = await eternal.routeMetaMessagingCall(IG_MESSAGES(), IG_LOGIN, { recipient: { comment_id: "c1" }, message: { text: "x" } });
    expect(privateReply.body).toEqual({ recipient: { comment_id: "c1" }, message: { text: "x" } });
    expect(privateReply.url).toBe(`${GRAPH}/${PAGE_ID}/messages`);
  });

  it("callGraph сам отправляет через Страницу — любой путь отправки получает вечный ключ", async () => {
    await callGraph(IG_MESSAGES(), IG_LOGIN, { recipient: { id: "igsid" }, sender_action: "mark_seen" });
    const sent = fetchMock.mock.calls.find(([u]) => String(u) === `${GRAPH}/${PAGE_ID}/messages`);
    expect(sent).toBeTruthy();
    expect((sent![1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${PAGE_TOKEN}` });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("graph.instagram.com"))).toBe(false);
  });

  it("к Странице привязан ДРУГОЙ Instagram — остаётся личный путь, ответ не уйдёт чужим аккаунтом", async () => {
    linkedIg = "17841499999999999";
    const routed = await eternal.routeMetaMessagingCall(IG_MESSAGES(), IG_LOGIN, { recipient: { id: "igsid" }, message: { text: "x" } });
    expect(routed.route).toBe("unchanged");
    expect(routed.url).toBe(IG_MESSAGES());
    expect(routed.token).toBe(IG_LOGIN);
  });

  it("рубильник выключен — только личный маркер, Meta даже не спрашиваем", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaSystemTokenPreferred: false } });
    eternal.resetMetaEternalCache();
    const routed = await eternal.routeMetaMessagingCall(IG_MESSAGES(), IG_LOGIN, { recipient: { id: "igsid" }, message: { text: "x" } });
    expect(routed.route).toBe("unchanged");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("у аккаунта нет Страницы или нет ключа компании — личный путь", async () => {
    await prisma.messengerAccount.update({ where: { id: accountId }, data: { pageId: null } });
    eternal.resetMetaEternalCache();
    expect((await eternal.instagramRouteForToken(IG_LOGIN)).kind).toBe("instagram_login");
    await prisma.messengerAccount.update({ where: { id: accountId }, data: { pageId: PAGE_ID } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaIgManageToken: null } });
    eternal.resetMetaEternalCache();
    expect((await eternal.instagramRouteForToken(IG_LOGIN)).kind).toBe("instagram_login");
  });

  it("Страница не выдана системному пользователю — личный путь, без исключения", async () => {
    fetchMock.mockImplementation(async () => json({ id: PAGE_ID, name: "без доступа" }));
    expect((await eternal.instagramRouteForToken(IG_LOGIN)).kind).toBe("instagram_login");
  });

  it("профиль собеседника читается с graph.facebook.com маркером Страницы", async () => {
    const req = await eternal.instagramReadRequest(`/${GRAPH_VERSION}/igsid?fields=username`, IG_LOGIN);
    expect(req.url).toBe(`https://graph.facebook.com/${GRAPH_VERSION}/igsid?fields=username`);
    expect(req.headers).toEqual({ Authorization: `Bearer ${PAGE_TOKEN}` });
  });

  it("чужой адрес (комментарии) не трогаем", async () => {
    const url = instagramApiUrl(`/${GRAPH_VERSION}/123/replies`);
    const routed = await eternal.routeMetaMessagingCall(url, IG_LOGIN, { message: "x" });
    expect(routed).toMatchObject({ url, token: IG_LOGIN, route: "unchanged" });
  });
});

describe("Facebook Messenger через ключ компании", () => {
  it("личный маркер Страницы из Настроек меняется на маркер от системного пользователя", async () => {
    const routed = await eternal.routeMetaMessagingCall(`${GRAPH}/${PAGE_ID}/messages`, FB_PERSONAL, { recipient: { id: "psid" } });
    expect(routed).toMatchObject({ route: "facebook_page", token: PAGE_TOKEN, url: `${GRAPH}/${PAGE_ID}/messages` });
    expect(await eternal.facebookPageTokenFor("stand-unknown-token")).toBe("stand-unknown-token");
  });
});

describe("Реклама через ключ компании", () => {
  const ACT = "act_1234567890";
  function adsFetch(system: string[], personal: string[], readable = true) {
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (url === `${GRAPH}/me/permissions`) {
        const list = auth === `Bearer ${SYSTEM}` ? system : personal;
        return json({ data: list.map((permission) => ({ permission, status: "granted" })) });
      }
      if (url === `${GRAPH}/${ACT}?fields=id`) return readable ? json({ id: ACT }) : json({ error: { code: 200, message: "no access" } }, 403);
      return json({}, 404);
    });
  }

  it("у системного прав не меньше и кабинет читается — берём его", async () => {
    adsFetch(["ads_read", "ads_management"], ["ads_read"]);
    expect(await eternal.eternalAdsToken("stand-ads-personal", [ACT])).toBe(SYSTEM);
  });

  it("у системного нет права, которое есть у личного, — личный (не ломаем рабочее)", async () => {
    adsFetch(["ads_read"], ["ads_read", "ads_management"]);
    expect(await eternal.eternalAdsToken("stand-ads-personal", [ACT])).toBe("stand-ads-personal");
  });

  it("кабинет не выдан системному пользователю — личный", async () => {
    adsFetch(["ads_read", "ads_management"], ["ads_read"], false);
    expect(await eternal.eternalAdsToken("stand-ads-personal", [ACT])).toBe("stand-ads-personal");
  });
});

describe("Сторож мёртвых ключей", () => {
  it("узнаёт 401, код 190/102 и текст «session has been invalidated»", () => {
    expect(isMetaAuthFailure(401, "")).toBe(true);
    expect(isMetaAuthFailure(400, JSON.stringify({ error: { code: 190, message: "x" } }))).toBe(true);
    expect(isMetaAuthFailure(400, "Error validating access token: The session has been invalidated because the user changed their password")).toBe(true);
    expect(isMetaAuthFailure(400, JSON.stringify({ error: { code: 10, error_subcode: 2534022 } }))).toBe(false);
    expect(isMetaAuthFailure(500, "")).toBe(false);
    expect(isMetaAuthFailureText("HTTP 400 (code 190): expired")).toBe(true);
    expect(isMetaAuthFailureText("HTTP 400 код 102: x")).toBe(true);
    expect(isMetaAuthFailureText("HTTP 400 (code 1900): x")).toBe(false);
  });

  it("одна тревога директору на ключ за окно, повтор не будит", async () => {
    const key = `test-${run}-dedup`;
    const first = await raiseChannelKeyAlarm({ key, label: "Instagram «Тест»", detail: "HTTP 401" });
    const second = await raiseChannelKeyAlarm({ key, label: "Instagram «Тест»", detail: "HTTP 401" });
    expect(first.alerted).toBe(true);
    expect(second.alerted).toBe(false);
    const rows = await prisma.pendingDirectorAlert.findMany({ where: { tag: `${CHANNEL_KEY_ALERT_TAG_PREFIX}${key}` } });
    expect(rows).toHaveLength(1);
    expect(rows[0].level).toBe("CRITICAL");
    expect(rows[0].body).not.toContain("stand-");
  });

  it("401 на отправке поднимает тревогу с именем аккаунта, без маркера в тексте", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaSystemTokenPreferred: false } });
    eternal.resetMetaEternalCache();
    const tag = `${CHANNEL_KEY_ALERT_TAG_PREFIX}account:${accountId}`;
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag } });
    fetchMock.mockImplementation(async () =>
      json({ error: { code: 190, message: "Error validating access token: The session has been invalidated because the user changed their password" } }, 401)
    );
    await expect(callGraph(IG_MESSAGES(), IG_LOGIN, { recipient: { id: "igsid" }, sender_action: "typing_on" })).rejects.toThrow(/401/);
    const alert = await waitFor(() => prisma.pendingDirectorAlert.findFirst({ where: { tag } }));
    expect(alert?.body).toContain(`Вечный ${run}`);
    expect(alert?.body).not.toContain(IG_LOGIN);
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag } });
  });
});
