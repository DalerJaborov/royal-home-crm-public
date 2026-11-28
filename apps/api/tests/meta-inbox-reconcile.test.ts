import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents,
}));
const metaEnabled = vi.fn(async () => true);
const igChannelEnabled = vi.fn(async (_channel: string) => true);
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  isMetaEnabled: metaEnabled,
  isMetaChannelEnabled: igChannelEnabled,
}));
/** Instagram «через Страницу» для тестового аккаунта (предохранитель сверки, ревью #344). */
const routeOverride = { page: false };
vi.mock("../src/lib/metaEternalTokens.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/metaEternalTokens.js")>();
  return { ...actual, instagramRouteForToken: async (token: string) =>
    routeOverride.page && token === "ig-token-test"
      ? { kind: "page" as const, token: "page-token-test-ig", pageId: "page-of-ig", accountId: null }
      : actual.instagramRouteForToken(token) };
});
const recipientsOverride: { list: string[] | null } = { list: null };
vi.mock("../src/lib/recipients.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/recipients.js")>();
  return { ...actual, findAgentsWithPermission: async (p: Parameters<typeof actual.findAgentsWithPermission>[0]) =>
    recipientsOverride.list ?? actual.findAgentsWithPermission(p) };
});

const { prisma } = await import("../src/db.js");
const { encryptSecret } = await import("../src/crypto.js");
const { incomingFromGraph, runMetaInboxReconcile, withoutToken, automatedTexts, knownMessageIds, GRACE_MS, resetReconcileTimeoutStreakForTests } = await import("../src/lib/metaInboxReconcile.js");
const { customerPropertyEventKey, customerPropertyScopeKey } = await import("../src/lib/customerPropertyScope.js");

/**
 * СВЕРКА ПЕРЕПИСОК СТРАНИЦЫ С META (15.11.2026). Живой случай: Страница «Arvan
 * estate», за 13–14.11 написали 8 человек, в CRM дошёл один (администратор
 * приложения) — у приложения базовый доступ к Messenger чужой Страницы, Meta не
 * шлёт вебхук про людей без роли. Ни один сторож молчания этого не видел: их
 * вход — только то, что уже в CRM. Класс: «сообщение есть у Meta, нет в CRM».
 */

const runId = Date.now().toString(36);
/** Процесс работает давно — пауза «после старта» не мешает (её проверяет отдельный тест). */
const STARTED_LONG_AGO = { processStartedAt: 0 };
const pageId = `page-${runId}`;
const now = new Date("2026-11-14T16:30:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString().replace(".000Z", "+0000");
let accountId = "";
let igAccountId = "";
let staffId = "";
const igUserId = `ig-${runId}`, igScopedId = `igs-${runId}`;
let savedSwitches: { messengerInboxReconcileEnabled: boolean; instagramInboxReconcileEnabled: boolean } | null = null;

function graph(messages: Array<{ id: string; created_time: string; message?: string; from: { id: string; name?: string } }>) {
  return { data: [{ messages: { data: messages } }] };
}
function fakeFetch(body: unknown, igBody: unknown = { data: [] }) {
  const urls: string[] = [];
  const impl = async (url: string) => {
    urls.push(url);
    // Instagram читается маркером аккаунта по /me/conversations?platform=instagram.
    if (url.includes("platform=instagram")) return { json: async () => igBody };
    return { json: async () => (url.includes(encodeURIComponent(pageId)) ? body : { data: [] }) };
  };
  return { impl, urls };
}

beforeAll(async () => {
  accountId = (
    await prisma.messengerAccount.create({
      data: { channel: "FACEBOOK", externalId: pageId, title: "Arvan estate", token: encryptSecret("page-token-test"), enabled: true },
    })
  ).id;
  igAccountId = (
    await prisma.messengerAccount.create({
      data: { channel: "INSTAGRAM", externalId: igUserId, messagingId: igScopedId, title: "arvan.estate", token: encryptSecret("ig-token-test"), enabled: true },
    })
  ).id;
  savedSwitches = await prisma.settings.findUnique({ where: { id: "singleton" },
    select: { messengerInboxReconcileEnabled: true, instagramInboxReconcileEnabled: true } });
  staffId = (
    await prisma.agent.create({
      data: { fullName: `Читает переписки ${runId}`, phone: `+99294${String(Date.now()).slice(-7)}`, role: "DIRECTOR", passwordHash: "x" },
    })
  ).id;
});

beforeEach(() => { sendPushToAgents.mockClear(); metaEnabled.mockResolvedValue(true); recipientsOverride.list = null; routeOverride.page = false; });

afterAll(async () => {
  await prisma.processedMessage.deleteMany({ where: { messageId: { startsWith: `m_${runId}` } } });
  await prisma.botConversation.deleteMany({ where: { subscriberId: { startsWith: `psid-${runId}` } } });
  await prisma.messengerAccount.delete({ where: { id: accountId } }).catch(() => {});
  await prisma.messengerAccount.delete({ where: { id: igAccountId } }).catch(() => {});
  if (savedSwitches) await prisma.settings.update({ where: { id: "singleton" }, data: savedSwitches });
  await prisma.agent.delete({ where: { id: staffId } }).catch(() => {});
});

describe("incomingFromGraph — что считать входящим", () => {
  it("берёт только сообщения людей, старше паузы и не глубже окна", () => {
    const body = graph([
      { id: "m_page", created_time: ago(20), message: "Здравствуйте, ! Чем мы можем помочь?", from: { id: pageId } },
      { id: "m_fresh", created_time: ago(1), message: "только что", from: { id: "u1" } },
      { id: "m_due", created_time: ago(20), message: "Салом", from: { id: "u1", name: "Далер" } },
      { id: "m_old", created_time: ago(60 * 10), message: "давно", from: { id: "u2" } },
    ]);
    const got = incomingFromGraph(pageId, body, now, { graceMs: GRACE_MS, lookbackMs: 3 * 60 * 60_000, processStartedAt: 0 });
    expect(got.map((m) => m.mid)).toEqual(["m_due"]);
    expect(got[0]).toMatchObject({ fromId: "u1", fromName: "Далер", text: "Салом" });
    expect(GRACE_MS).toBeGreaterThan(0);
  });
});

describe("runMetaInboxReconcile", () => {
  it("сообщение, которого нет в CRM, — один пуш «Ответьте вручную» на человека, второй тик молчит", async () => {
    const body = graph([
      { id: `m_${runId}_a1`, created_time: ago(40), message: "Салом", from: { id: `psid-${runId}-owner`, name: "Клиент Арван" } },
      { id: `m_${runId}_a2`, created_time: ago(30), message: "Ба ман хона лозим", from: { id: `psid-${runId}-owner`, name: "Клиент Арван" } },
      { id: `m_${runId}_b1`, created_time: ago(20), message: "Хонаи фуруши дорам", from: { id: `psid-${runId}-second` } },
    ]);
    const { impl } = fakeFetch(body);
    const first = await runMetaInboxReconcile(now, impl, STARTED_LONG_AGO);
    expect(first).toMatchObject({ missed: 3, people: 2 });
    const pushes = sendPushToAgents.mock.calls.filter(([, p]) => String((p as { tag?: string }).tag).includes(pageId));
    expect(pushes).toHaveLength(2);
    const ownerPush = pushes.find(([, p]) => String((p as { tag?: string }).tag).endsWith(`psid-${runId}-owner`))![1] as {
      title: string; body: string; kind: string; level: string; url: string;
    };
    expect(ownerPush.title).toContain("Ответьте вручную");
    expect(ownerPush.title).toContain("Arvan estate");
    expect(ownerPush.body).toContain("Ба ман хона лозим"); // последнее сообщение человека
    expect(ownerPush.body).toContain("и ещё 1");
    expect(ownerPush).toMatchObject({ kind: "message", level: "CRITICAL", url: "/messages" });
    expect((pushes[0]![0] as string[])).toContain(staffId);

    sendPushToAgents.mockClear();
    const second = await runMetaInboxReconcile(now, impl, STARTED_LONG_AGO);
    expect(second).toMatchObject({ missed: 0, people: 0 });
    expect(sendPushToAgents).not.toHaveBeenCalled();
  });

  it("то, что дошло вебхуком или лежит в переписке CRM, тревоги не даёт", async () => {
    await prisma.processedMessage.create({ data: { channel: "FACEBOOK", messageId: `m_${runId}_w1`, completedAt: new Date() } });
    await prisma.botConversation.create({
      data: { channel: "FACEBOOK", subscriberId: `psid-${runId}-chat`, accountId,
        messages: [{ role: "user", content: "есть в чате", mid: `m_${runId}_c1`, at: ago(25) }] },
    });
    const { impl } = fakeFetch(graph([
      { id: `m_${runId}_w1`, created_time: ago(25), message: "дошло вебхуком", from: { id: `psid-${runId}-hook` } },
      { id: `m_${runId}_c1`, created_time: ago(25), message: "есть в чате", from: { id: `psid-${runId}-chat` } },
    ]));
    const result = await runMetaInboxReconcile(now, impl, STARTED_LONG_AGO);
    expect(result).toMatchObject({ missed: 0, people: 0 });
    expect(sendPushToAgents).not.toHaveBeenCalled();
  });

  it("Meta отказала в чтении — строка в журнале без ключа, остальные Страницы сверяются, пуша нет", async () => {
    const impl = async (url: string) => ({
      json: async () => (url.includes(encodeURIComponent(pageId)) ? { error: { code: 190, error_subcode: 463, message: "expired" } } : { data: [] }),
    });
    const result = await runMetaInboxReconcile(now, impl, STARTED_LONG_AGO);
    expect(result.failedPages).toBeGreaterThanOrEqual(1);
    expect(sendPushToAgents).not.toHaveBeenCalled();
    // Журнал пишется без ожидания (void) — ждём строку.
    const line = await vi.waitFor(async () => {
      const row = await prisma.errorLog.findFirst({ where: { dedupKey: `meta-inbox-read-failed:${pageId}` }, orderBy: { createdAt: "desc" } });
      if (!row) throw new Error("ещё нет");
      return row;
    }, { timeout: 5000, interval: 100 });
    expect(line.message).toContain("Arvan estate");
    expect(line.message).not.toContain("page-token-test");
  });

  it("журнал 28.11.2026: таймаут сверки — в журнал только с третьего прохода подряд, успешный проход обнуляет серию", async () => {
    resetReconcileTimeoutStreakForTests();
    await prisma.errorLog.deleteMany({ where: { dedupKey: `meta-inbox-reconcile-page-failed:${pageId}` } });
    const timeoutImpl = async (url: string) => {
      if (url.includes(encodeURIComponent(pageId))) throw new Error("The operation was aborted due to timeout");
      return { json: async () => ({ data: [] }) };
    };
    const okImpl = async () => ({ json: async () => ({ data: [] }) });
    const logged = () => prisma.errorLog.count({ where: { dedupKey: `meta-inbox-reconcile-page-failed:${pageId}` } });
    await runMetaInboxReconcile(now, timeoutImpl, STARTED_LONG_AGO);
    await runMetaInboxReconcile(now, timeoutImpl, STARTED_LONG_AGO);
    await new Promise((r) => setTimeout(r, 300));
    expect(await logged()).toBe(0);
    await runMetaInboxReconcile(now, okImpl, STARTED_LONG_AGO); // серия сброшена
    await runMetaInboxReconcile(now, timeoutImpl, STARTED_LONG_AGO);
    await runMetaInboxReconcile(now, timeoutImpl, STARTED_LONG_AGO);
    await new Promise((r) => setTimeout(r, 300));
    expect(await logged()).toBe(0);
    await runMetaInboxReconcile(now, timeoutImpl, STARTED_LONG_AGO); // третий подряд
    await vi.waitFor(async () => { if ((await logged()) < 1) throw new Error("ещё нет"); }, { timeout: 5000, interval: 100 });
    expect(await logged()).toBe(1);
  });

  it("192-3: сотрудник уже ответил в Business Suite — «ответьте вручную» не шлём", async () => {
    const { impl } = fakeFetch(graph([
      { id: `m_${runId}_r2`, created_time: ago(22), message: "Ассалому алейкум! Ҳозир мефиристем", from: { id: pageId } },
      { id: `m_${runId}_r1`, created_time: ago(25), message: "Нарх чанд?", from: { id: `psid-${runId}-replied` } },
    ]));
    expect(await runMetaInboxReconcile(now, impl, STARTED_LONG_AGO)).toMatchObject({ missed: 0, people: 0 });
    expect(sendPushToAgents).not.toHaveBeenCalled();
  });

  it("192-2: пуш не ушёл — отметка снята, следующий тик говорит снова", async () => {
    const { impl } = fakeFetch(graph([{ id: `m_${runId}_f1`, created_time: ago(25), message: "Хона лозим", from: { id: `psid-${runId}-fail` } }]));
    sendPushToAgents.mockImplementationOnce(async () => { throw new Error("push down"); });
    expect(await runMetaInboxReconcile(now, impl, STARTED_LONG_AGO)).toMatchObject({ people: 0 });
    expect(await prisma.processedMessage.count({ where: { channel: "meta-inbox-missed", messageId: `m_${runId}_f1` } })).toBe(0);
    expect(await runMetaInboxReconcile(now, impl, STARTED_LONG_AGO)).toMatchObject({ people: 1, missed: 1 });
  });

  it("192-2: некому сказать — отметку не ставим, появится получатель — сигнал уйдёт", async () => {
    const { impl } = fakeFetch(graph([{ id: `m_${runId}_n1`, created_time: ago(25), message: "Салом", from: { id: `psid-${runId}-nobody` } }]));
    recipientsOverride.list = [];
    expect(await runMetaInboxReconcile(now, impl, STARTED_LONG_AGO)).toMatchObject({ people: 0 });
    expect(await prisma.processedMessage.count({ where: { channel: "meta-inbox-missed", messageId: `m_${runId}_n1` } })).toBe(0);
    recipientsOverride.list = null;
    expect(await runMetaInboxReconcile(now, impl, STARTED_LONG_AGO)).toMatchObject({ people: 1 });
  });

  it("192-4: свежее сообщение (меньше 15 мин) — не тревожим, Meta ещё может дослать", async () => {
    const { impl } = fakeFetch(graph([{ id: `m_${runId}_g1`, created_time: ago(10), message: "только что", from: { id: `psid-${runId}-grace` } }]));
    expect(await runMetaInboxReconcile(now, impl, STARTED_LONG_AGO)).toMatchObject({ people: 0 });
    expect(sendPushToAgents).not.toHaveBeenCalled();
  });

  it("Н1: свежий 503 вебхука (любой Страницы) больше НЕ выключает сверку — при аварии сигнал идёт", async () => {
    const row = await prisma.errorLog.create({ data: { source: "meta", message: "Вебхук Meta ответил 503", dedupKey: "meta-webhook-503:dm:test", createdAt: new Date(now.getTime() - 5 * 60_000) } });
    try {
      const { impl } = fakeFetch(graph([{ id: `m_${runId}_o1`, created_time: ago(25), message: "во время аварии", from: { id: `psid-${runId}-outage` } }]));
      expect(await runMetaInboxReconcile(now, impl, STARTED_LONG_AGO)).toMatchObject({ people: 1 });
    } finally {
      await prisma.errorLog.delete({ where: { id: row.id } });
    }
  });

  it("Н1: сообщение пришло, пока процесс лежал — полчаса после старта ждём повтора Meta (ответит бот), потом зовём человека", async () => {
    const startedAt = now.getTime() - 10 * 60_000; // процесс поднялся 10 минут назад
    const { impl } = fakeFetch(graph([{ id: `m_${runId}_s1`, created_time: ago(40), message: "пока сервер лежал", from: { id: `psid-${runId}-down` } }]));
    expect(await runMetaInboxReconcile(now, impl, { processStartedAt: startedAt })).toMatchObject({ people: 0 });
    const later = new Date(startedAt + 31 * 60_000);
    expect(await runMetaInboxReconcile(later, impl, { processStartedAt: startedAt })).toMatchObject({ people: 1 });
  });

  it("Н2: мгновенный автоответ Страницы (через секунды) НЕ гасит сигнал; ответ человека через минуты — гасит", async () => {
    const auto = fakeFetch(graph([
      { id: `m_${runId}_a_auto`, created_time: new Date(now.getTime() - 25 * 60_000 + 3_000).toISOString().replace(".000Z", "+0000"),
        message: "Спасибо за сообщение! Мы скоро ответим.", from: { id: pageId } },
      { id: `m_${runId}_a_user`, created_time: ago(25), message: "Нарх чанд?", from: { id: `psid-${runId}-auto` } },
    ]));
    expect(await runMetaInboxReconcile(now, auto.impl, STARTED_LONG_AGO)).toMatchObject({ people: 1 });
    expect(incomingFromGraph(pageId, graph([
      { id: "u", created_time: ago(25), message: "Нарх чанд?", from: { id: "u1" } },
      { id: "p", created_time: ago(20), message: "Салом! 450 000", from: { id: pageId } },
    ]), now, { graceMs: GRACE_MS, lookbackMs: 3 * 60 * 60_000, processStartedAt: 0 })).toHaveLength(0);
  });

  it("192-9: канал Meta выключен в Настройках — сверка молчит", async () => {
    metaEnabled.mockResolvedValue(false);
    const { impl, urls } = fakeFetch(graph([{ id: `m_${runId}_d1`, created_time: ago(25), message: "x", from: { id: `psid-${runId}-off` } }]));
    expect(await runMetaInboxReconcile(now, impl, STARTED_LONG_AGO)).toMatchObject({ skipped: "meta_disabled" });
    expect(urls).toHaveLength(0);
  });

  it("сетевой отказ не уносит ключ Страницы в журнал", () => {
    expect(withoutToken(new Error("GET https://graph.facebook.com/x?fields=a&access_token=SECRET123&limit=2 failed"))).not.toContain("SECRET123");
  });
});

describe("В4: Instagram и автоответы (15.11.2026)", () => {
  it("Instagram: сообщение есть у Meta, нет в CRM — «Ответьте вручную» с названием аккаунта; свои сообщения (оба id) входящими не считаются", async () => {
    const ig = { data: [{ messages: { data: [
      { id: `m_${runId}_ig_own`, created_time: ago(30), message: "Салом! Чем помочь?", from: { id: igScopedId } },
      { id: `m_${runId}_ig_own2`, created_time: ago(29), message: "Пишите", from: { id: igUserId } },
      { id: `m_${runId}_ig1`, created_time: ago(25), message: "Нархи хона?", from: { id: `igsid-${runId}-1`, name: "client.tj" } },
    ] } }] };
    const { impl, urls } = fakeFetch({ data: [] }, ig);
    const result = await runMetaInboxReconcile(now, impl, STARTED_LONG_AGO);
    expect(result).toMatchObject({ people: 1, missed: 1 });
    expect(urls.some((u) => u.includes("platform=instagram"))).toBe(true);
    const push = sendPushToAgents.mock.calls.find(([, p]) => String((p as { tag?: string }).tag).includes(igUserId))![1] as { title: string; body: string };
    expect(push.title).toContain("Instagram «arvan.estate»");
    expect(push.body).toContain("Нархи хона?");
    expect(push.body).toContain("Direct");
    // Свои реплики аккаунта не стали «входящими»: missed ровно 1.
  });

  describe("массовая «потеря» Instagram: поломка сверки или настоящая потеря (ревью #344)", () => {
    const valveTag = `meta-inbox-mass-missed:${igUserId}`;
    const lostTag = `meta-inbox-ig-not-delivered:${igUserId}`;
    /** n входящих от людей; ours — наши ответы раньше их (старые, вне окна сверки). */
    const igOf = (tag: string, n: number, ours = 0) => ({ data: [{ messages: { data: [
      ...Array.from({ length: n }, (_, i) => (
        { id: `m_${runId}_${tag}_${i}`, created_time: ago(30 + i), message: `вопрос ${i}`, from: { id: `igsid-${runId}-${tag}` } })),
      ...Array.from({ length: ours }, (_, i) => (
        { id: `m_${runId}_${tag}_our_${i}`, created_time: ago(60 * 30 + i), message: `ответ бота ${i}`, from: { id: igUserId } })),
    ] } }] });
    const igPushes = () => sendPushToAgents.mock.calls.filter((c) => String(((c as unknown[])[1] as { title?: string }).title).includes("Instagram «arvan.estate»"));
    const alert = (tag: string) => prisma.pendingDirectorAlert.findFirst({ where: { tag } });
    beforeEach(async () => { await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: [valveTag, lostTag] } } }); });
    afterAll(async () => { await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: [valveTag, lostTag] } } }); });

    /** Реплика CRM этому человеку с ТЕМ ЖЕ текстом, но другим mid — так выглядели бы разошедшиеся id путей. */
    const crmChat = (tag: string, kind: "bot" | "manual") => prisma.botConversation.create({ data: { channel: "INSTAGRAM",
      subscriberId: `igsid-${runId}-${tag}`, messages: [{ role: "assistant", content: "ответ бота 0", by: { kind }, mid: `other-path-${runId}-${tag}` }] as never } });

    it("путь Страницы, все 4 входящих и ответы CRM не найдены по mid — поломка сверки: без пушей, тревога руководству", async () => {
      routeOverride.page = true;
      const conv = await crmChat("valve", "bot");
      const result = await runMetaInboxReconcile(now, fakeFetch({ data: [] }, igOf("valve", 4, 2)).impl, STARTED_LONG_AGO)
        .finally(() => prisma.botConversation.delete({ where: { id: conv.id } }));
      expect(result.massMissedPages).toBeGreaterThanOrEqual(1);
      expect(igPushes()).toHaveLength(0);
      expect((await alert(valveTag))?.recipientRoles.slice().sort()).toEqual(["ADMIN", "DIRECTOR", "HEAD_OF_SALES"]);
      expect(await alert(lostTag)).toBeNull();
      // Отметок «уже сказали» нет: если это не поломка сверки, люди узнают, когда её починят.
      expect(await prisma.processedMessage.count({ where: { channel: "meta-inbox-missed", messageId: { startsWith: `m_${runId}_valve_` } } })).toBe(0);
    });

    it("путь Страницы, входящих нет в CRM, а наш ответ есть — потеря настоящая (подписку выключили): пуши и тревога «проверьте подписку»", async () => {
      routeOverride.page = true;
      await prisma.processedMessage.create({ data: { channel: "out:meta", messageId: `m_${runId}_real_our_0`, completedAt: new Date() } });
      const result = await runMetaInboxReconcile(now, fakeFetch({ data: [] }, igOf("real", 4, 2)).impl, STARTED_LONG_AGO);
      expect(result.massMissedPages).toBe(0);
      expect(igPushes().length).toBeGreaterThanOrEqual(1);
      expect((await alert(lostTag))?.body).toContain("Подписка на Webhooks");
      expect(await alert(valveTag)).toBeNull();
    });

    it("наш ответ найден в ленте переписки CRM (mid реплики бота) — тоже «пути совпадают»", async () => {
      routeOverride.page = true;
      const conv = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `igsid-${runId}-chat`,
        messages: [{ role: "assistant", content: "ответ 0", mid: `m_${runId}_chat_our_0` }] as never } });
      try {
        const result = await runMetaInboxReconcile(now, fakeFetch({ data: [] }, igOf("chat", 4, 1)).impl, STARTED_LONG_AGO);
        expect(result.massMissedPages).toBe(0);
        expect(igPushes().length).toBeGreaterThanOrEqual(1);
      } finally {
        await prisma.botConversation.delete({ where: { id: conv.id } });
      }
    });

    it("в выборке только ручные ответы сотрудников (в CRM без mid, «вручную») — потеря настоящая, пуши не глушим", async () => {
      routeOverride.page = true;
      const conv = await crmChat("manual", "manual");
      const result = await runMetaInboxReconcile(now, fakeFetch({ data: [] }, igOf("manual", 4, 2)).impl, STARTED_LONG_AGO)
        .finally(() => prisma.botConversation.delete({ where: { id: conv.id } }));
      expect(result.massMissedPages).toBe(0);
      expect(igPushes().length).toBeGreaterThanOrEqual(1);
      expect(await alert(lostTag)).not.toBeNull();
    });

    it("наших ответов в выборке нет — доказать поломку нечем: пуши как раньше", async () => {
      routeOverride.page = true;
      const result = await runMetaInboxReconcile(now, fakeFetch({ data: [] }, igOf("noours", 4)).impl, STARTED_LONG_AGO);
      expect(result.massMissedPages).toBe(0);
      expect(igPushes().length).toBeGreaterThanOrEqual(1);
      expect(await alert(lostTag)).not.toBeNull();
    });

    it("«не дошло» 1 из 4 — обычный срочный пуш, без тревог руководству", async () => {
      routeOverride.page = true;
      const body = igOf("one", 4, 1);
      for (const m of body.data[0]!.messages.data.slice(1, 4)) {
        await prisma.processedMessage.create({ data: { channel: "INSTAGRAM", messageId: m.id, completedAt: new Date() } });
      }
      const result = await runMetaInboxReconcile(now, fakeFetch({ data: [] }, body).impl, STARTED_LONG_AGO);
      expect(result).toMatchObject({ massMissedPages: 0 });
      expect(igPushes().length).toBeGreaterThanOrEqual(1);
      expect(await alert(lostTag)).toBeNull();
      expect(await alert(valveTag)).toBeNull();
    });

    it("личный путь (не Страница), наших ответов в CRM нет — предохранитель не глушит", async () => {
      const result = await runMetaInboxReconcile(now, fakeFetch({ data: [] }, igOf("personal", 4, 2)).impl, STARTED_LONG_AGO);
      expect(result.massMissedPages).toBe(0);
      expect(igPushes().length).toBeGreaterThanOrEqual(1);
    });
  });

  it("Instagram: дошедшее вебхуком (ProcessedMessage INSTAGRAM) тревоги не даёт", async () => {
    await prisma.processedMessage.create({ data: { channel: "INSTAGRAM", messageId: `m_${runId}_ig_known`, completedAt: new Date() } });
    const ig = { data: [{ messages: { data: [
      { id: `m_${runId}_ig_known`, created_time: ago(25), message: "дошло", from: { id: `igsid-${runId}-2` } },
    ] } }] };
    expect(await runMetaInboxReconcile(now, fakeFetch({ data: [] }, ig).impl, STARTED_LONG_AGO)).toMatchObject({ people: 0 });
  });

  it("Н2: одинаковый текст Страницы в двух переписках — шаблон автоматизации, сигнал не гасит; уникальный ответ — гасит", () => {
    const greeting = "Здравствуйте, ! Чем мы можем помочь?";
    const body = { data: [
      { messages: { data: [
        { id: "c1u", created_time: ago(30), message: "Нарх?", from: { id: "u1" } },
        { id: "c1p", created_time: ago(27), message: greeting, from: { id: pageId } }, // через 3 минуты, но шаблон
      ] } },
      { messages: { data: [
        { id: "c2u", created_time: ago(40), message: "Салом", from: { id: "u2" } },
        { id: "c2p", created_time: ago(38), message: greeting + "  ", from: { id: pageId } },
      ] } },
      { messages: { data: [
        { id: "c3u", created_time: ago(30), message: "Есть 2-комн.?", from: { id: "u3" } },
        { id: "c3p", created_time: ago(25), message: "Да, есть в Сино, 450 000", from: { id: pageId } }, // живой ответ
      ] } },
    ] };
    expect(automatedTexts(new Set([pageId]), body).size).toBe(1);
    const got = incomingFromGraph(pageId, body, now, { graceMs: GRACE_MS, lookbackMs: 3 * 60 * 60_000, processStartedAt: 0 });
    expect(got.map((m) => m.mid).sort()).toEqual(["c1u", "c2u"]);
  });

  it("рубильники: выключен Instagram — его не читаем; выключены оба — сверка молчит", async () => {
    const { impl, urls } = fakeFetch({ data: [] }, { data: [] });
    try {
      await prisma.settings.update({ where: { id: "singleton" }, data: { instagramInboxReconcileEnabled: false } });
      await runMetaInboxReconcile(now, impl, STARTED_LONG_AGO);
      expect(urls.some((u) => u.includes("platform=instagram"))).toBe(false);
      expect(urls.some((u) => u.includes(encodeURIComponent(pageId)))).toBe(true);
      await prisma.settings.update({ where: { id: "singleton" }, data: { messengerInboxReconcileEnabled: false } });
      expect(await runMetaInboxReconcile(now, impl, STARTED_LONG_AGO)).toMatchObject({ skipped: "switched_off" });
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { messengerInboxReconcileEnabled: true, instagramInboxReconcileEnabled: true } });
    }
  });

  it("199-2: запасной id аккаунта и его ник — свои реплики, не клиент; ник клиента виден как @ник", async () => {
    await prisma.messengerAccount.update({ where: { id: igAccountId }, data: { extraExternalIds: [`igx-${runId}`], username: "arvan.estate" } });
    try {
      const ig = { data: [{ messages: { data: [
        { id: `m_${runId}_ig_x1`, created_time: ago(30), message: "Наш ответ со старого id", from: { id: `igx-${runId}` } },
        { id: `m_${runId}_ig_x2`, created_time: ago(29), message: "Наш ответ по нику", from: { id: `unknown-${runId}`, username: "Arvan.Estate" } },
        { id: `m_${runId}_ig_x3`, created_time: ago(25), message: "Нарх?", from: { id: `igsid-${runId}-x`, username: "client_tj" } },
      ] } }] };
      const result = await runMetaInboxReconcile(now, fakeFetch({ data: [] }, ig).impl, STARTED_LONG_AGO);
      expect(result).toMatchObject({ missed: 1, people: 1 });
      const push = sendPushToAgents.mock.calls.find(([, p]) => String((p as { tag?: string }).tag).includes(`igsid-${runId}-x`))![1] as { title: string };
      expect(push.title).toContain("@client_tj");
    } finally {
      await prisma.messengerAccount.update({ where: { id: igAccountId }, data: { extraExternalIds: [], username: null } });
    }
  });

  it("199-2: у аккаунта нет id для переписки — его не сверяем (иначе наши ответы стали бы «клиентами»)", async () => {
    await prisma.messengerAccount.update({ where: { id: igAccountId }, data: { messagingId: null } });
    try {
      const { impl, urls } = fakeFetch({ data: [] }, { data: [{ messages: { data: [
        { id: `m_${runId}_ig_nm`, created_time: ago(25), message: "Наш ответ", from: { id: igScopedId } },
      ] } }] });
      expect(await runMetaInboxReconcile(now, impl, STARTED_LONG_AGO)).toMatchObject({ people: 0 });
      expect(urls.some((u) => u.includes("platform=instagram"))).toBe(false);
    } finally {
      await prisma.messengerAccount.update({ where: { id: igAccountId }, data: { messagingId: igScopedId } });
    }
  });

  it("199-3: сообщение, которое держит ядро (есть тикет), — дошло до CRM, «не дошло» не шлём", async () => {
    const scope = await prisma.customerEndpointScope.create({ data: { realmKey: `realm-${runId}`, channel: "INSTAGRAM", transportKey: `tk-${runId}`,
      messengerAccountId: igAccountId } });
    const mid = `m_${runId}_core`, peer = `igsid-${runId}-core`;
    const eventKey = customerPropertyEventKey(customerPropertyScopeKey("INSTAGRAM", peer, igAccountId), "message", mid);
    await prisma.customerPropertyIngressTicket.create({ data: { eventKey, scopeKey: customerPropertyScopeKey("INSTAGRAM", peer, igAccountId),
      endpointScopeId: scope.id } });
    try {
      const known = await knownMessageIds([{ mid, createdAt: new Date(), fromId: peer, fromName: null, text: "x" }], "INSTAGRAM");
      expect(known.has(mid)).toBe(true);
    } finally {
      await prisma.customerPropertyIngressTicket.delete({ where: { eventKey } });
      await prisma.customerEndpointScope.delete({ where: { id: scope.id } });
    }
  });

  it("канал Instagram выключен в Настройках — Instagram не сверяем, Messenger сверяем", async () => {
    igChannelEnabled.mockResolvedValueOnce(false);
    const { impl, urls } = fakeFetch({ data: [] }, { data: [] });
    await runMetaInboxReconcile(now, impl, STARTED_LONG_AGO);
    expect(urls.some((u) => u.includes("platform=instagram"))).toBe(false);
  });
});
