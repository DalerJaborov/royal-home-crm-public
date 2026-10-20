import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { markLastTelegramReplyUndelivered } from "../src/messengers/appendMessages.js";
import { parseStatusUpdates } from "../src/messengers/meta.js";

/**
 * ОТВЕТЫ, ТЕРЯЮЩИЕСЯ МОЛЧА (класс 4 разбора 21.09, docs/bot-audit-21-09.md).
 *
 * Общее у всех четырёх проверок ниже одно: поломка НЕ видна ни в журнале, ни в
 * интерфейсе, ни клиенту — она видна только тем, что человек остаётся без
 * ответа, а сотрудник об этом не знает.
 *
 *  1. упавшая отправка в Telegram оставляла в CRM ответ, которого клиент не
 *     видел: сотрудник открывал инбокс, видел «бот ответил» и сам не писал;
 *  2. отказ доставки WhatsApp был серой галочкой и больше ничем;
 *  3. чат на сайте пропускал к модели то, на что во всех остальных каналах бот
 *     обязан молчать (просьба о материальной помощи);
 *  4. лимит чата на сайте ключевался по IP, а схема межсерверная — потолок был
 *     общим на весь сайт.
 *
 * Идентификаторы одной длины из одной полосы и уборка за собой — известная
 * ловушка этого репозитория.
 */

const runId = Date.now();
const API_KEY = "test-silent-losses-key";
const SESSION_ID = `silentses${String(runId).slice(-8)}`;
const CHAT_ID = `-100777${String(runId).slice(-6)}`;
const TOPIC_ID = `4${String(runId).slice(-5)}`;

let savedBot = { botEnabled: false, botWebsiteChatEnabled: false };
let tgConversationId = "";
let directConversationId = "";

beforeAll(async () => {
  process.env.WEBSITE_LEAD_API_KEY = API_KEY;
  savedBot = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botEnabled: true, botWebsiteChatEnabled: true },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { botEnabled: true, botWebsiteChatEnabled: true },
  });

  const tg = await prisma.telegramConversation.create({
    data: {
      chatId: CHAT_ID,
      messages: [
        { role: "user", content: "Здравствуйте", at: new Date().toISOString() },
        { role: "assistant", content: "Здравствуйте! Чем помочь?", at: new Date().toISOString() },
      ] as object,
    },
    select: { id: true },
  });
  tgConversationId = tg.id;

  const direct = await prisma.telegramDirectConversation.create({
    data: {
      chatId: CHAT_ID,
      topicId: TOPIC_ID,
      messages: [
        { role: "user", content: "Салом", at: new Date().toISOString() },
        { role: "assistant", content: "Салом! Чӣ хизмат?", at: new Date().toISOString() },
      ] as object,
    },
    select: { id: true },
  });
  directConversationId = direct.id;
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: savedBot });
  await prisma.telegramConversation.deleteMany({ where: { chatId: CHAT_ID } });
  await prisma.telegramDirectConversation.deleteMany({ where: { chatId: CHAT_ID } });
  await prisma.botConversation.deleteMany({
    where: { channel: "WEBSITE", subscriberId: { startsWith: SESSION_ID } },
  });
});

/** Последняя реплика переписки — та, которую метит отметка «не доставлено». */
async function lastMessageOf(table: "telegram" | "telegram-direct"): Promise<Record<string, unknown>> {
  const row =
    table === "telegram"
      ? await prisma.telegramConversation.findUnique({ where: { id: tgConversationId }, select: { messages: true } })
      : await prisma.telegramDirectConversation.findUnique({
          where: { id: directConversationId },
          select: { messages: true },
        });
  const messages = (row!.messages as unknown as Record<string, unknown>[]) ?? [];
  return messages[messages.length - 1] ?? {};
}

describe("упавшая отправка в Telegram не выглядит отправленной", () => {
  it("личка: последняя реплика бота помечается «не доставлено»", async () => {
    await markLastTelegramReplyUndelivered("telegram", tgConversationId);
    expect((await lastMessageOf("telegram")).deliveryStatus).toBe("failed");
  });

  it("Direct Messages канала: то же самое, своя таблица", async () => {
    await markLastTelegramReplyUndelivered("telegram-direct", directConversationId);
    expect((await lastMessageOf("telegram-direct")).deliveryStatus).toBe("failed");
  });

  it("отметка не перекрывает уже проставленную и не трогает реплику клиента", async () => {
    // Второй вызов по тому же диалогу ничего не меняет: условие deliveryStatus
    // IS NULL. Иначе повтор хода переписал бы честный статус доставки.
    await markLastTelegramReplyUndelivered("telegram", tgConversationId);
    expect((await lastMessageOf("telegram")).deliveryStatus).toBe("failed");

    // Последняя реплика — клиента: метить нечего, ответа бота после неё нет.
    await prisma.telegramConversation.update({
      where: { id: tgConversationId },
      data: { messages: [{ role: "user", content: "Ещё вопрос", at: new Date().toISOString() }] as object },
    });
    await markLastTelegramReplyUndelivered("telegram", tgConversationId);
    const last = await lastMessageOf("telegram");
    expect(last.role).toBe("user");
    expect(last.deliveryStatus).toBeUndefined();
  });
});

describe("отказ доставки WhatsApp называет причину", () => {
  const bodyWith = (status: unknown) => ({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ value: { statuses: [status] } }] }],
  });

  it("причина из errors попадает в разобранный статус", () => {
    const [update] = parseStatusUpdates(
      bodyWith({
        id: "wamid.TEST",
        status: "failed",
        recipient_id: "992918000000",
        errors: [
          {
            code: 131047,
            title: "Re-engagement message",
            message: "Message failed to send",
            error_data: { details: "More than 24 hours have passed" },
          },
        ],
      })
    );
    expect(update.status).toBe("failed");
    expect(update.error).toContain("Re-engagement message");
    expect(update.error).toContain("More than 24 hours");
  });

  it("успешная доставка причины не несёт", () => {
    const [update] = parseStatusUpdates(bodyWith({ id: "wamid.OK", status: "delivered", recipient_id: "992918000001" }));
    expect(update.status).toBe("delivered");
    expect(update.error).toBeUndefined();
  });
});

describe("чат на сайте отсекает то же, что и остальные каналы", () => {
  it("просьба о материальной помощи — полное молчание, но запись в переписке есть", async () => {
    const session = `${SESSION_ID}m`;
    const res = await request(app)
      .post("/api/v1/webhooks/website-chat")
      .set("X-Api-Key", API_KEY)
      .send({ sessionId: session, text: "Помогите мне материально, очень нужны деньги на лечение" });
    expect(res.status).toBe(200);

    // Ход идёт в фоне — ждём появления записи, а не спим наугад.
    const started = Date.now();
    let messages: Record<string, unknown>[] = [];
    while (Date.now() - started < 15_000) {
      const row = await prisma.botConversation.findFirst({
        where: { channel: "WEBSITE", subscriberId: session },
        select: { messages: true },
      });
      messages = (row?.messages as unknown as Record<string, unknown>[]) ?? [];
      if (messages.length > 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    // Сообщение сохранено с пометкой — владелец видит, что обращение было.
    expect(messages.length).toBeGreaterThan(0);
    expect(String(messages[0].content)).toContain("бот молчит");
    // И ни одной реплики бота: молчание здесь и есть решение агентства.
    expect(messages.some((m) => m.role === "assistant")).toBe(false);
  }, 30_000);
});
