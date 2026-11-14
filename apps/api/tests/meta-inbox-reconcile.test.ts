import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents,
}));
const metaEnabled = vi.fn(async () => true);
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  isMetaEnabled: metaEnabled,
}));
const recipientsOverride: { list: string[] | null } = { list: null };
vi.mock("../src/lib/recipients.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/recipients.js")>();
  return { ...actual, findAgentsWithPermission: async (p: Parameters<typeof actual.findAgentsWithPermission>[0]) =>
    recipientsOverride.list ?? actual.findAgentsWithPermission(p) };
});

const { prisma } = await import("../src/db.js");
const { encryptSecret } = await import("../src/crypto.js");
const { incomingFromGraph, runMetaInboxReconcile, withoutToken, GRACE_MS } = await import("../src/lib/metaInboxReconcile.js");

/**
 * СВЕРКА ПЕРЕПИСОК СТРАНИЦЫ С META (15.11.2026). Живой случай: Страница «Arvan
 * estate», за 13–14.11 написали 8 человек, в CRM дошёл один (администратор
 * приложения) — у приложения базовый доступ к Messenger чужой Страницы, Meta не
 * шлёт вебхук про людей без роли. Ни один сторож молчания этого не видел: их
 * вход — только то, что уже в CRM. Класс: «сообщение есть у Meta, нет в CRM».
 */

const runId = Date.now().toString(36);
const pageId = `page-${runId}`;
const now = new Date("2026-11-14T16:30:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString().replace(".000Z", "+0000");
let accountId = "";
let staffId = "";

function graph(messages: Array<{ id: string; created_time: string; message?: string; from: { id: string; name?: string } }>) {
  return { data: [{ messages: { data: messages } }] };
}
function fakeFetch(body: unknown) {
  const urls: string[] = [];
  const impl = async (url: string) => {
    urls.push(url);
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
  staffId = (
    await prisma.agent.create({
      data: { fullName: `Читает переписки ${runId}`, phone: `+99294${String(Date.now()).slice(-7)}`, role: "DIRECTOR", passwordHash: "x" },
    })
  ).id;
});

beforeEach(() => { sendPushToAgents.mockClear(); metaEnabled.mockResolvedValue(true); recipientsOverride.list = null; });

afterAll(async () => {
  await prisma.processedMessage.deleteMany({ where: { messageId: { startsWith: `m_${runId}` } } });
  await prisma.botConversation.deleteMany({ where: { subscriberId: { startsWith: `psid-${runId}` } } });
  await prisma.messengerAccount.delete({ where: { id: accountId } }).catch(() => {});
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
    const got = incomingFromGraph(pageId, body, now);
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
    const first = await runMetaInboxReconcile(now, impl);
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
    const second = await runMetaInboxReconcile(now, impl);
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
    const result = await runMetaInboxReconcile(now, impl);
    expect(result).toMatchObject({ missed: 0, people: 0 });
    expect(sendPushToAgents).not.toHaveBeenCalled();
  });

  it("Meta отказала в чтении — строка в журнале без ключа, остальные Страницы сверяются, пуша нет", async () => {
    const impl = async (url: string) => ({
      json: async () => (url.includes(encodeURIComponent(pageId)) ? { error: { code: 190, error_subcode: 463, message: "expired" } } : { data: [] }),
    });
    const result = await runMetaInboxReconcile(now, impl);
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

  it("192-3: сотрудник уже ответил в Business Suite — «ответьте вручную» не шлём", async () => {
    const { impl } = fakeFetch(graph([
      { id: `m_${runId}_r2`, created_time: ago(22), message: "Ассалому алейкум! Ҳозир мефиристем", from: { id: pageId } },
      { id: `m_${runId}_r1`, created_time: ago(25), message: "Нарх чанд?", from: { id: `psid-${runId}-replied` } },
    ]));
    expect(await runMetaInboxReconcile(now, impl)).toMatchObject({ missed: 0, people: 0 });
    expect(sendPushToAgents).not.toHaveBeenCalled();
  });

  it("192-2: пуш не ушёл — отметка снята, следующий тик говорит снова", async () => {
    const { impl } = fakeFetch(graph([{ id: `m_${runId}_f1`, created_time: ago(25), message: "Хона лозим", from: { id: `psid-${runId}-fail` } }]));
    sendPushToAgents.mockImplementationOnce(async () => { throw new Error("push down"); });
    expect(await runMetaInboxReconcile(now, impl)).toMatchObject({ people: 0 });
    expect(await prisma.processedMessage.count({ where: { channel: "meta-inbox-missed", messageId: `m_${runId}_f1` } })).toBe(0);
    expect(await runMetaInboxReconcile(now, impl)).toMatchObject({ people: 1, missed: 1 });
  });

  it("192-2: некому сказать — отметку не ставим, появится получатель — сигнал уйдёт", async () => {
    const { impl } = fakeFetch(graph([{ id: `m_${runId}_n1`, created_time: ago(25), message: "Салом", from: { id: `psid-${runId}-nobody` } }]));
    recipientsOverride.list = [];
    expect(await runMetaInboxReconcile(now, impl)).toMatchObject({ people: 0 });
    expect(await prisma.processedMessage.count({ where: { channel: "meta-inbox-missed", messageId: `m_${runId}_n1` } })).toBe(0);
    recipientsOverride.list = null;
    expect(await runMetaInboxReconcile(now, impl)).toMatchObject({ people: 1 });
  });

  it("192-4: свежее сообщение (меньше 15 мин) и недавний 503 вебхука — не тревожим, Meta ещё дошлёт", async () => {
    const { impl } = fakeFetch(graph([{ id: `m_${runId}_g1`, created_time: ago(10), message: "только что", from: { id: `psid-${runId}-grace` } }]));
    expect(await runMetaInboxReconcile(now, impl)).toMatchObject({ people: 0 });
    const late = fakeFetch(graph([{ id: `m_${runId}_g2`, created_time: ago(25), message: "после сбоя", from: { id: `psid-${runId}-retry` } }]));
    const row = await prisma.errorLog.create({ data: { source: "meta", message: "Вебхук Meta ответил 503", dedupKey: "meta-webhook-503:dm:test", createdAt: new Date(now.getTime() - 5 * 60_000) } });
    expect(await runMetaInboxReconcile(now, late.impl)).toMatchObject({ skipped: "webhook_retrying", people: 0 });
    await prisma.errorLog.delete({ where: { id: row.id } });
    expect(sendPushToAgents).not.toHaveBeenCalled();
  });

  it("192-9: канал Meta выключен в Настройках — сверка молчит", async () => {
    metaEnabled.mockResolvedValue(false);
    const { impl, urls } = fakeFetch(graph([{ id: `m_${runId}_d1`, created_time: ago(25), message: "x", from: { id: `psid-${runId}-off` } }]));
    expect(await runMetaInboxReconcile(now, impl)).toMatchObject({ skipped: "meta_disabled" });
    expect(urls).toHaveLength(0);
  });

  it("сетевой отказ не уносит ключ Страницы в журнал", () => {
    expect(withoutToken(new Error("GET https://graph.facebook.com/x?fields=a&access_token=SECRET123&limit=2 failed"))).not.toContain("SECRET123");
  });
});
