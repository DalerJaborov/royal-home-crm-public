import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents,
}));

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

beforeEach(() => sendPushToAgents.mockClear());

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
      { id: `m_${runId}_a1`, created_time: ago(30), message: "Салом", from: { id: `psid-${runId}-owner`, name: "Клиент Арван" } },
      { id: `m_${runId}_a2`, created_time: ago(20), message: "Ба ман хона лозим", from: { id: `psid-${runId}-owner`, name: "Клиент Арван" } },
      { id: `m_${runId}_b1`, created_time: ago(15), message: "Хонаи фуруши дорам", from: { id: `psid-${runId}-second` } },
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

  it("сетевой отказ не уносит ключ Страницы в журнал", () => {
    expect(withoutToken(new Error("GET https://graph.facebook.com/x?fields=a&access_token=SECRET123&limit=2 failed"))).not.toContain("SECRET123");
  });
});
