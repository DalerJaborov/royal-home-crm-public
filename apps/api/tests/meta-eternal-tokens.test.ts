import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "./helpers/waitFor.js";

/**
 * Вечные ключи Meta (12.11.2026) и правки по ревью #161. Живой случай: 11.11
 * владелец сменил пароль Instagram, личный маркер ответил 401, бот сутки молчал,
 * 91 строка в журнале никого не разбудила. Здесь: выбор пути и его запреты
 * (рубильник, App Review, права ключа, чужой Instagram, чужая Страница), откат на
 * личный ключ при отказе Страницы, отметка первой успешной отправки, реклама с
 * задачами кабинета, подписка без потери полей, самопроверка, сторож ключей.
 */
const { prisma } = await import("../src/db.js");
const { encryptSecret } = await import("../src/crypto.js");
const eternal = await import("../src/lib/metaEternalTokens.js");
const { callGraph, instagramApiUrl, GRAPH_VERSION, sendQuickReplies } = await import("../src/messengers/meta.js");
const { wasSentByUs } = await import("../src/messengers/outgoingMids.js");
const { checkInstagramAccountsHealth } = await import("../src/lib/integrationHealth.js");
const { isMetaAuthFailure, isMetaAuthFailureText, raiseChannelKeyAlarm, CHANNEL_KEY_ALERT_TAG_PREFIX } = await import("../src/lib/channelKeyAlarm.js");

const run = randomUUID().slice(0, 8);
const stamp = Date.now().toString().slice(-9);
const PAGE_ID = `9${stamp}1`;
const OTHER_PAGE = `9${stamp}2`;
const IG_ID = `178414${stamp}`;
const IG_LOGIN = `stand-ig-login-${run}`;
const SYSTEM = `stand-system-${run}`;
const PAGE_TOKEN = `stand-page-${run}`;
const FB_PERSONAL = `stand-fb-personal-${run}`;
const PEER = `igsid-${run}`;
const IG_MESSAGES = () => instagramApiUrl(`/${GRAPH_VERSION}/me/messages`);
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const ALL_SCOPES = ["instagram_basic", "instagram_manage_messages", "pages_manage_metadata", "pages_messaging", "ads_read", "ads_management"];

let accountId = "";
let before: Record<string, unknown> | null = null;
const tagsToClean: string[] = [];

/** Что «отвечает Meta» в этом тесте — меняется по ходу. */
const meta = {
  linkedIg: IG_ID,
  systemScopes: ALL_SCOPES,
  personalScopes: ["ads_read"],
  pageSend: (): Response => json({ recipient_id: PEER, message_id: `mid-page-${randomUUID()}` }),
  personalSend: (): Response => json({ recipient_id: PEER, message_id: `mid-personal-${randomUUID()}` }),
  personalMe: (): Response => json({ id: IG_ID }),
  adTasks: ["ADVERTISE"] as string[],
  appRead: (): Response => json({ id: "1684679092586215" }),
  subscribed: [{ id: "1684679092586215", subscribed_fields: ["feed", "messages"] }] as Array<{ id: string; subscribed_fields: string[] }>,
};
const fetchMock = vi.fn();
const calls = (pred: (url: string, init?: RequestInit) => boolean) => fetchMock.mock.calls.filter(([u, i]) => pred(String(u), i as RequestInit));
const authOf = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.Authorization;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function settings(patch: Record<string, unknown>) {
  await prisma.settings.update({ where: { id: "singleton" }, data: patch });
  eternal.resetMetaEternalCache();
}

beforeAll(async () => {
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {} });
  before = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaIgManageToken: true, metaPageId: true, metaPageToken: true, metaSystemTokenPreferred: true, metaAppReviewApproved: true, metaPageEternalLastSentAt: true, metaAdsEnabled: true, metaAdAccountId: true },
  });
  const row = await prisma.messengerAccount.create({
    data: { channel: "INSTAGRAM", externalId: IG_ID, title: `Вечный ${run}`, token: encryptSecret(IG_LOGIN), username: `eternal_${run}`, pageId: PAGE_ID },
  });
  accountId = row.id;
});

afterAll(async () => {
  await prisma.messengerAccount.deleteMany({ where: { id: accountId } });
  if (before) await prisma.settings.update({ where: { id: "singleton" }, data: before });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: tagsToClean } } });
  eternal.resetMetaEternalCache();
});

beforeEach(async () => {
  Object.assign(meta, {
    linkedIg: IG_ID,
    systemScopes: ALL_SCOPES,
    personalScopes: ["ads_read"],
    pageSend: () => json({ recipient_id: PEER, message_id: `mid-page-${randomUUID()}` }),
    personalSend: () => json({ recipient_id: PEER, message_id: `mid-personal-${randomUUID()}` }),
    personalMe: () => json({ id: IG_ID }),
    adTasks: ["ADVERTISE"],
    appRead: () => json({ id: "1684679092586215" }),
    subscribed: [{ id: "1684679092586215", subscribed_fields: ["feed", "messages"] }],
  });
  await prisma.messengerAccount.update({ where: { id: accountId }, data: { pageId: PAGE_ID, eternalLastSentAt: null } });
  await settings({
    metaIgManageToken: encryptSecret(SYSTEM),
    metaSystemTokenPreferred: true,
    metaAppReviewApproved: true,
    metaPageId: PAGE_ID,
    metaPageToken: encryptSecret(FB_PERSONAL),
    metaPageEternalLastSentAt: null,
  });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = authOf(init);
    if (url === `${GRAPH}/me/permissions`) {
      const list = auth === `Bearer ${SYSTEM}` ? meta.systemScopes : meta.personalScopes;
      return json({ data: list.map((permission) => ({ permission, status: "granted" })) });
    }
    if (url.startsWith(`${GRAPH}/${PAGE_ID}?fields=access_token`) || url.startsWith(`${GRAPH}/${OTHER_PAGE}?fields=access_token`)) {
      if (auth !== `Bearer ${SYSTEM}`) return json({ error: { code: 190, message: "bad token" } }, 400);
      return json({ id: PAGE_ID, access_token: PAGE_TOKEN, name: "Royal Home Page", instagram_business_account: { id: meta.linkedIg } });
    }
    if (url === `${GRAPH}/${PAGE_ID}/messages`) return meta.pageSend();
    if (url === IG_MESSAGES()) return meta.personalSend();
    if (url.startsWith(instagramApiUrl(`/${GRAPH_VERSION}/me?fields=id`))) return meta.personalMe();
    if (url === `${GRAPH}/me?fields=id,name`) return json({ id: "sys", name: "royalhome-crm" });
    if (url === `${GRAPH}/app?fields=id`) return meta.appRead();
    if (url === `${GRAPH}/${PAGE_ID}/subscribed_apps`) {
      if (init?.method === "POST") return json({ success: true });
      return json({ data: meta.subscribed });
    }
    if (/\/act_\d+\?fields=id,user_tasks$/.test(url)) return json({ id: "act", user_tasks: meta.adTasks });
    return json({ error: { message: `unexpected ${url}` } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("путь Instagram через Страницу и его запреты", () => {
  it("всё готово — /me/messages уходит на graph.facebook.com/{page}/messages маркером Страницы", async () => {
    const routed = await eternal.routeMetaMessagingCall(IG_MESSAGES(), IG_LOGIN, { recipient: { id: PEER }, message: { text: "Салом" } });
    expect(routed).toMatchObject({ route: "instagram_page", url: `${GRAPH}/${PAGE_ID}/messages`, token: PAGE_TOKEN, pageId: PAGE_ID, accountId });
    expect(routed.body).toEqual({ recipient: { id: PEER }, message: { text: "Салом" }, messaging_type: "RESPONSE" });
  });

  it("«печатает…» и ответ на комментарий — без messaging_type", async () => {
    const typing = await eternal.routeMetaMessagingCall(IG_MESSAGES(), IG_LOGIN, { recipient: { id: PEER }, sender_action: "typing_on" });
    expect(typing.body).toEqual({ recipient: { id: PEER }, sender_action: "typing_on" });
    const reply = await eternal.routeMetaMessagingCall(IG_MESSAGES(), IG_LOGIN, { recipient: { comment_id: "c1" }, message: { text: "x" } });
    expect(reply.body).toEqual({ recipient: { comment_id: "c1" }, message: { text: "x" } });
  });

  it("умолчание: рубильник и «App Review одобрен» выключены — и в схеме, и в миграции", async () => {
    const rows = await prisma.$queryRaw<Array<{ column_name: string; column_default: string }>>`
      SELECT column_name, column_default FROM information_schema.columns
      WHERE table_name = 'Settings' AND column_name IN ('metaSystemTokenPreferred', 'metaAppReviewApproved')`;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.column_default).toBe("false");
  });

  it("без отметки «App Review одобрен» путь закрыт (клиенты без роли не получили бы ответ)", async () => {
    await settings({ metaAppReviewApproved: false });
    const routed = await eternal.routeMetaMessagingCall(IG_MESSAGES(), IG_LOGIN, { recipient: { id: PEER }, message: { text: "x" } });
    expect(routed.route).toBe("unchanged");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("рубильник выключен — только личный ключ, Meta даже не спрашиваем", async () => {
    await settings({ metaSystemTokenPreferred: false });
    expect((await eternal.routeMetaMessagingCall(IG_MESSAGES(), IG_LOGIN, {})).route).toBe("unchanged");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("у ключа компании нет instagram_manage_messages (/me/permissions) — личный путь", async () => {
    meta.systemScopes = ALL_SCOPES.filter((s) => s !== "instagram_manage_messages");
    expect((await eternal.instagramRouteForToken(IG_LOGIN)).kind).toBe("instagram_login");
  });

  it("к Странице привязан другой Instagram — личный путь, ответ не уйдёт чужим аккаунтом", async () => {
    meta.linkedIg = "17841499999999999";
    expect((await eternal.instagramRouteForToken(IG_LOGIN)).kind).toBe("instagram_login");
  });

  it("нет Страницы или ключа компании — личный путь", async () => {
    await prisma.messengerAccount.update({ where: { id: accountId }, data: { pageId: null } });
    eternal.resetMetaEternalCache();
    expect((await eternal.instagramRouteForToken(IG_LOGIN)).kind).toBe("instagram_login");
    await prisma.messengerAccount.update({ where: { id: accountId }, data: { pageId: PAGE_ID } });
    await settings({ metaIgManageToken: null });
    expect((await eternal.instagramRouteForToken(IG_LOGIN)).kind).toBe("instagram_login");
  });

  it("профиль собеседника читается с graph.facebook.com маркером Страницы", async () => {
    const req = await eternal.instagramReadRequest(`/${GRAPH_VERSION}/${PEER}?fields=username`, IG_LOGIN);
    expect(req).toEqual({ url: `https://graph.facebook.com/${GRAPH_VERSION}/${PEER}?fields=username`, headers: { Authorization: `Bearer ${PAGE_TOKEN}` } });
  });
});

describe("откат на личный ключ и отметка отправки (callGraph)", () => {
  it("чёткий отказ Страницы (400, код 10) — ОДИН повтор личным ключом, тревога, следующие сразу личным", async () => {
    meta.pageSend = () => json({ error: { code: 10, message: "Application does not have permission for this action" } }, 400);
    const tag = `${CHANNEL_KEY_ALERT_TAG_PREFIX}page-route:${PAGE_ID}`;
    tagsToClean.push(tag);
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag } });
    const res = await callGraph<{ message_id?: string }>(IG_MESSAGES(), IG_LOGIN, { recipient: { id: PEER }, sender_action: "typing_on" });
    expect(res?.message_id).toMatch(/^mid-personal-/);
    expect(calls((u) => u === `${GRAPH}/${PAGE_ID}/messages`)).toHaveLength(1);
    const personal = calls((u) => u === IG_MESSAGES());
    expect(personal).toHaveLength(1);
    expect(authOf(personal[0][1] as RequestInit) ?? String(personal[0][0])).toContain(IG_LOGIN);
    await waitFor(() => prisma.pendingDirectorAlert.findFirst({ where: { tag } }));
    // Страница «на скамейке» 5 минут: следующее сообщение — сразу личным, без второй попытки.
    expect((await eternal.routeMetaMessagingCall(IG_MESSAGES(), IG_LOGIN, {})).route).toBe("unchanged");
  });

  it("5xx или ответ без тела ошибки — повтора нет (иначе можно задвоить сообщение)", async () => {
    meta.pageSend = () => new Response("upstream error", { status: 502 });
    await expect(callGraph(IG_MESSAGES(), IG_LOGIN, { recipient: { id: PEER }, sender_action: "typing_on" })).rejects.toThrow(/502/);
    expect(calls((u) => u === IG_MESSAGES())).toHaveLength(0);
  });

  it("190 на маркере Страницы — выдача забыта сразу, следующий вызов не берёт старый маркер", async () => {
    meta.pageSend = () => json({ error: { code: 190, message: "Error validating access token" } }, 400);
    tagsToClean.push(`${CHANNEL_KEY_ALERT_TAG_PREFIX}page-route:${PAGE_ID}`);
    await callGraph(IG_MESSAGES(), IG_LOGIN, { recipient: { id: PEER }, sender_action: "typing_on" });
    expect((await eternal.routeMetaMessagingCall(IG_MESSAGES(), PAGE_TOKEN, {})).route).toBe("unchanged");
    expect((await eternal.instagramRouteForToken(IG_LOGIN)).kind).toBe("instagram_login");
  });

  it("«работает» только после настоящей отправки с mid; эхо этой отправки — наше (wasSentByUs)", async () => {
    const mid = await sendQuickReplies("INSTAGRAM", PEER, "Выберите", [{ title: "Да", payload: "YES" }], IG_LOGIN);
    expect(mid).toMatch(/^mid-page-/);
    expect(await wasSentByUs(mid)).toBe(true);
    const row = await waitFor(async () => {
      const r = await prisma.messengerAccount.findUnique({ where: { id: accountId }, select: { eternalLastSentAt: true } });
      return r?.eternalLastSentAt ?? null;
    });
    expect(row).toBeInstanceOf(Date);
  });
});

describe("Facebook Messenger: только известная Страница и право pages_messaging", () => {
  it("личный маркер Страницы на адресе ЭТОЙ Страницы меняется на маркер от ключа компании", async () => {
    const routed = await eternal.routeMetaMessagingCall(`${GRAPH}/${PAGE_ID}/messages`, FB_PERSONAL, { recipient: { id: "psid" } });
    expect(routed).toMatchObject({ route: "facebook_page", token: PAGE_TOKEN });
  });

  it("адрес чужой Страницы или номера WhatsApp не трогаем", async () => {
    expect((await eternal.routeMetaMessagingCall(`${GRAPH}/${OTHER_PAGE}/messages`, FB_PERSONAL, {})).route).toBe("unchanged");
    expect((await eternal.routeMetaMessagingCall(`${GRAPH}/1129773893562843/messages`, "stand-wa-token", {})).route).toBe("unchanged");
  });

  it("без pages_messaging у ключа компании — личный маркер Страницы", async () => {
    meta.systemScopes = ALL_SCOPES.filter((s) => s !== "pages_messaging");
    expect((await eternal.routeMetaMessagingCall(`${GRAPH}/${PAGE_ID}/messages`, FB_PERSONAL, {})).route).toBe("unchanged");
  });
});

describe("реклама ключом компании", () => {
  const ACT = "act_1234567890";
  it("права не меньше и в кабинете задача ADVERTISE — ключ компании", async () => {
    expect(await eternal.eternalAdsToken("stand-ads-personal", [ACT])).toBe(SYSTEM);
  });

  it("в кабинете только просмотр (ANALYZE) — личный: стоп-лосс не сможет ставить паузу", async () => {
    meta.adTasks = ["ANALYZE"];
    expect(await eternal.eternalAdsToken("stand-ads-personal", [ACT])).toBe("stand-ads-personal");
  });

  it("у личного есть ads_management, у компании нет — личный", async () => {
    meta.systemScopes = ["ads_read"];
    meta.personalScopes = ["ads_read", "ads_management"];
    expect(await eternal.eternalAdsToken("stand-ads-personal", [ACT])).toBe("stand-ads-personal");
  });

  it("одновременные вызовы — одна проверка; отказ тоже кэшируется", async () => {
    meta.adTasks = ["ANALYZE"];
    const results = await Promise.all([1, 2, 3].map(() => eternal.eternalAdsToken("stand-ads-personal", [ACT])));
    expect(new Set(results)).toEqual(new Set(["stand-ads-personal"]));
    expect(calls((u) => u.includes("fields=id,user_tasks"))).toHaveLength(1);
    await eternal.eternalAdsToken("stand-ads-personal", [ACT]);
    expect(calls((u) => u.includes("fields=id,user_tasks"))).toHaveLength(1);
  });
});

describe("«Подписать Страницу»", () => {
  it("приложение не узнали — отказ без POST", async () => {
    meta.appRead = () => json({ error: { code: 1, message: "fail" } }, 500);
    const r = await eternal.subscribePageMessaging(PAGE_ID);
    expect(r.ok).toBe(false);
    expect(calls((u, i) => u.endsWith("/subscribed_apps") && i?.method === "POST")).toHaveLength(0);
  });

  it("поля объединяются: feed не снимается никогда", async () => {
    const r = await eternal.subscribePageMessaging(PAGE_ID);
    expect(r).toMatchObject({ ok: true });
    const post = calls((u, i) => u.endsWith("/subscribed_apps") && i?.method === "POST")[0];
    const fields = new URLSearchParams(String((post[1] as RequestInit).body)).get("subscribed_fields")!.split(",");
    expect(fields).toEqual(expect.arrayContaining(["feed", "messages", "messaging_postbacks"]));
  });
});

describe("самопроверка «Вечные ключи»", () => {
  const ourRow = (s: Awaited<ReturnType<typeof eternal.metaEternalStatus>>) => s.rows.find((r) => r.accountId === accountId)!;

  it("без отметки App Review — честное «ждёт одобрения Meta», даже когда всё остальное готово", async () => {
    await settings({ metaAppReviewApproved: false });
    expect(ourRow(await eternal.metaEternalStatus()).state).toBe("awaiting_review");
  });

  it("не хватает прав — называет какие", async () => {
    meta.systemScopes = ALL_SCOPES.filter((s) => s !== "pages_manage_metadata");
    const status = await eternal.metaEternalStatus();
    expect(ourRow(status).state).toBe("missing_scopes");
    expect(status.systemUser.missingScopes).toEqual(["pages_manage_metadata"]);
  });

  it("всё готово, но отправок не было — не «работает»; после отправки — «работает»", async () => {
    expect(ourRow(await eternal.metaEternalStatus()).state).toBe("pending_first_send");
    await prisma.messengerAccount.update({ where: { id: accountId }, data: { eternalLastSentAt: new Date() } });
    expect(ourRow(await eternal.metaEternalStatus()).state).toBe("ready");
  });
});

describe("суточная проверка при вечном пути", () => {
  it("мёртвый запасной личный ключ — предупреждение, не тревога директору", async () => {
    meta.personalMe = () => json({ error: { code: 190, message: "session has been invalidated" } }, 401);
    const [row] = await checkInstagramAccountsHealth([accountId]);
    expect(row.ok).toBe(true);
    expect(row.detail).toContain("предупреждение");
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `${CHANNEL_KEY_ALERT_TAG_PREFIX}account:${accountId}` } })).toBe(0);
  });
});

describe("сторож мёртвых ключей", () => {
  it("узнаёт 401, код 190/102 и текст «session has been invalidated»", () => {
    expect(isMetaAuthFailure(401, "")).toBe(true);
    expect(isMetaAuthFailure(400, JSON.stringify({ error: { code: 190, message: "x" } }))).toBe(true);
    expect(isMetaAuthFailure(400, "The session has been invalidated because the user changed their password")).toBe(true);
    expect(isMetaAuthFailure(400, JSON.stringify({ error: { code: 10, error_subcode: 2534022 } }))).toBe(false);
    expect(isMetaAuthFailure(500, "")).toBe(false);
    expect(isMetaAuthFailureText("HTTP 400 (code 190): expired")).toBe(true);
    expect(isMetaAuthFailureText("HTTP 400 код 102: x")).toBe(true);
    expect(isMetaAuthFailureText("HTTP 400 (code 1900): x")).toBe(false);
  });

  it("пять одновременных отказов одного ключа — ровно одна тревога (замок, без гонки)", async () => {
    const key = `test-${run}-race`;
    const tag = `${CHANNEL_KEY_ALERT_TAG_PREFIX}${key}`;
    tagsToClean.push(tag);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => raiseChannelKeyAlarm({ key, label: "Instagram «Тест»", detail: "HTTP 401" })));
    expect(results.filter((r) => r.alerted)).toHaveLength(1);
    const rows = await waitFor(async () => {
      const found = await prisma.pendingDirectorAlert.findMany({ where: { tag } });
      return found.length ? found : null;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].level).toBe("CRITICAL");
  });

  it("401 на отправке личным ключом — тревога с именем аккаунта, без маркера в тексте; работает и при выключенном рубильнике", async () => {
    await settings({ metaSystemTokenPreferred: false, metaAppReviewApproved: false });
    const tag = `${CHANNEL_KEY_ALERT_TAG_PREFIX}account:${accountId}`;
    tagsToClean.push(tag);
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag } });
    meta.personalSend = () => json({ error: { code: 190, message: "The session has been invalidated because the user changed their password" } }, 401);
    await expect(callGraph(IG_MESSAGES(), IG_LOGIN, { recipient: { id: PEER }, sender_action: "typing_on" })).rejects.toThrow(/401/);
    const alert = await waitFor(() => prisma.pendingDirectorAlert.findFirst({ where: { tag } }));
    expect(alert?.body).toContain(`Вечный ${run}`);
    expect(alert?.body).not.toContain(IG_LOGIN);
  });
});
