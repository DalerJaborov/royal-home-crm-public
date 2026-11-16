import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { resetMetaAccountCredsCache } from "../src/messengers/meta.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { isHandedToStaff, setInboxGraphFetchForTests } from "../src/lib/metaInboxReconcile.js";

/**
 * ПОВТОР META ПОСЛЕ ПРОСТОЯ НЕ ДАЁТ ДВОЙНОГО ОТВЕТА (повторное ревью #192, Н1, 15.11.2026).
 * Сервер лежал → вебхук не дошёл → сверка Страниц сказала сотруднику «Ответьте вручную»
 * (отметка `meta-inbox-missed` на mid). Meta ретраит доставку до 36 часов (docs Graph API
 * Webhooks) — если бот потом ответит на тот же mid, клиент получит два ответа. Вебхук такой
 * повтор принимает (200) и ничего не делает: ни приёма, ни отметки обработки, ни бота.
 */
const tag = `handed-${randomUUID()}`;
const pageId = `${tag}-page`, secret = `${tag}-secret`, psid = `${tag}-psid`;
let accountId = "";
let staffId = "";
let saved: { metaEnabled: boolean; metaVerifyToken: string | null } | null = null;
const mids: string[] = [];

const body = (mid: string) => JSON.stringify({ object: "page", entry: [{ id: pageId, time: Date.now(),
  messaging: [{ sender: { id: psid }, recipient: { id: pageId }, timestamp: Date.now(), message: { mid, text: "Ба ман хона лозим" } }] }] });
const post = (raw: string) => request(app).post("/api/v1/webhooks/meta").set("Content-Type", "application/json")
  .set("x-hub-signature-256", `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`).send(raw);

beforeAll(async () => {
  saved = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { metaEnabled: true, metaVerifyToken: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { metaEnabled: true, metaVerifyToken: encryptSecret(`${tag}-verify`) } });
  accountId = (await prisma.messengerAccount.create({ data: { channel: "FACEBOOK", externalId: pageId, title: "Arvan test",
    enabled: true, token: encryptSecret(`${tag}-token`), appSecret: encryptSecret(secret) } })).id;
  resetMetaAccountCredsCache();
  staffId = (await prisma.agent.create({ data: { fullName: `Читает переписки ${tag}`, phone: `+99297${String(Date.now()).slice(-7)}`,
    role: "DIRECTOR", passwordHash: "x" } })).id;
});

/** Что Graph «покажет» про переписку: реплика клиента и (если answered) живой ответ Страницы через 10 минут. */
function graphShows(mid: string, from: string, own: string, answered: boolean) {
  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  setInboxGraphFetchForTests(async () => ({ json: async () => ({ data: [{ messages: { data: [
    { id: mid, created_time: at(20), message: "Ба ман хона лозим", from: { id: from } },
    ...(answered ? [{ id: `${mid}-reply`, created_time: at(10), message: "Салом! Ҳозир мефиристем", from: { id: own } }] : []),
  ] } }] }) }));
}

afterAll(async () => {
  setInboxGraphFetchForTests(null);
  await drainBackgroundTasks(15000);
  await prisma.processedMessage.deleteMany({ where: { messageId: { in: mids } } });
  await prisma.messengerAccount.delete({ where: { id: accountId } }).catch(() => {});
  await prisma.notification.deleteMany({ where: { agentId: staffId } }).catch(() => {});
  await prisma.agent.delete({ where: { id: staffId } }).catch(() => {});
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  resetMetaAccountCredsCache();
});

describe("повтор Meta по сообщению, уже отданному человеку", () => {
  it("сотрудник уже ответил (Graph) — вебхук отвечает 200 и не запускает ни приём, ни бота", async () => {
    const mid = `m_${tag}_1`; mids.push(mid);
    await prisma.processedMessage.create({ data: { channel: "meta-inbox-missed", messageId: mid, completedAt: new Date() } });
    graphShows(mid, psid, pageId, true);
    const res = await post(body(mid));
    expect(res.status).toBe(200);
    await drainBackgroundTasks(15000);
    // Ни отметки обработки старого пути, ни тикета нового ядра по этому mid.
    expect(await prisma.processedMessage.count({ where: { channel: "FACEBOOK", messageId: mid } })).toBe(0);
    expect(await prisma.botConversation.count({ where: { channel: "FACEBOOK", subscriberId: psid } })).toBe(0);
  });

  it("Instagram (В4, 15.11): повтор по сообщению, отданному человеку сверкой Direct, — тоже 200 без бота", async () => {
    const igUser = `${tag}-ig`, igSecret = `${tag}-igsecret`, igsid = `${tag}-igsid`;
    const ig = await prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId: igUser, messagingId: `${igUser}-m`, title: "Arvan IG test",
      enabled: true, token: encryptSecret(`${tag}-igtoken`), appSecret: encryptSecret(igSecret) } });
    resetMetaAccountCredsCache();
    try {
      const mid = `m_${tag}_ig1`; mids.push(mid);
      await prisma.processedMessage.create({ data: { channel: "meta-inbox-missed", messageId: mid, completedAt: new Date() } });
      graphShows(mid, igsid, igUser, true);
      const raw = JSON.stringify({ object: "instagram", entry: [{ id: igUser, time: Date.now(),
        messaging: [{ sender: { id: igsid }, recipient: { id: igUser }, timestamp: Date.now(), message: { mid, text: "Нархи хона?" } }] }] });
      const res = await request(app).post("/api/v1/webhooks/meta").set("Content-Type", "application/json")
        .set("x-hub-signature-256", `sha256=${createHmac("sha256", igSecret).update(raw).digest("hex")}`).send(raw);
      expect(res.status).toBe(200);
      await drainBackgroundTasks(15000);
      expect(await prisma.processedMessage.count({ where: { channel: "INSTAGRAM", messageId: mid } })).toBe(0);
      expect(await prisma.botConversation.count({ where: { channel: "INSTAGRAM", subscriberId: igsid } })).toBe(0);
    } finally {
      await prisma.messengerAccount.delete({ where: { id: ig.id } }).catch(() => {});
      resetMetaAccountCredsCache();
    }
  });

  it("199-1: человек ещё НЕ ответил (ночь, пуш ждёт утра) — сообщение идёт обычным путём, человеку «дошло, бот отвечает»", async () => {
    const mid = `m_${tag}_late`; mids.push(mid);
    await prisma.processedMessage.create({ data: { channel: "meta-inbox-missed", messageId: mid, completedAt: new Date() } });
    graphShows(mid, psid, pageId, false);
    const res = await post(body(mid));
    expect(res.status).toBe(200);
    await drainBackgroundTasks(15000);
    // Принято обычным путём: отметка приёма старого пути, тикет ядра или переписка — что-то из этого есть.
    const accepted = (await prisma.processedMessage.count({ where: { channel: "FACEBOOK", messageId: mid } })) +
      (await prisma.botConversation.count({ where: { channel: "FACEBOOK", subscriberId: psid } })) +
      (await prisma.customerPropertyIngressTicket.count({ where: { receivedAt: { gte: new Date(Date.now() - 60_000) } } }));
    expect(accepted).toBeGreaterThan(0);
    const note = await prisma.notification.findFirst({ where: { tag: `meta-inbox-missed-${pageId}-${psid}` }, orderBy: { createdAt: "desc" } });
    expect(note?.title).toContain("Дошло до CRM");
    expect(note?.body).toContain("Ба ман хона лозим");
  });

  it("смешанный запрос (одно отдано, другое нет) обрабатывается целиком — новое сообщение не теряется", async () => {
    const handed = `m_${tag}_2`, fresh = `m_${tag}_3`; mids.push(handed, fresh);
    await prisma.processedMessage.create({ data: { channel: "meta-inbox-missed", messageId: handed, completedAt: new Date() } });
    expect(await isHandedToStaff([handed])).toBe(true);
    expect(await isHandedToStaff([handed, fresh])).toBe(false);
    expect(await isHandedToStaff([])).toBe(false);
  });
});
