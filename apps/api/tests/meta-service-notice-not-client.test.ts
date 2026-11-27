import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import type { MessengerTurnInput, MessengerTurnResult } from "../src/messengers/turnTypes.js";

/**
 * УВЕДОМЛЕНИЕ META — НЕ КЛИЕНТ (27.11.2026). Живой случай: на втором номере WhatsApp (Arvan) пришло
 * «Continue setting up your account…» (напоминание Meta о настройке Business-аккаунта, обычный type=text),
 * бот ответил «номер получил, агент позвонит» и завёл карточку покупателя. Решение — в одной двери
 * parseIncoming (вебхук и ядро клиентского бота): ни хода бота, ни ответа, ни переписки, ни заявки.
 */

const { sendMessage, processTurn } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (..._args: unknown[]) => "wamid.out-fake"),
  processTurn: vi.fn<(input: MessengerTurnInput) => Promise<MessengerTurnResult>>(async () => ({
    reply: "", ready: false, accepted: false, shouldReply: false,
  })),
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  sendMessage,
}));
vi.mock("../src/messengers/conversation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/conversation.js")>()),
  processMessengerTurn: processTurn,
}));

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { encryptSecret } = await import("../src/crypto.js");
const { drainBackgroundTasks } = await import("../src/lib/shutdownState.js");
const { parseIncoming, metaServiceNoticeReason } = await import("../src/messengers/meta.js");

const runId = Date.now();
const NOTICE = "Continue setting up your account to start messaging your customers on WhatsApp Business.";

function waBody(messages: unknown[], phoneId: string) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "waba-test", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: phoneId }, messages } }] }],
  };
}
const igBody = (text: string) => ({
  object: "instagram",
  entry: [{ id: "ig-acc", messaging: [{ sender: { id: "ig-user-1" }, recipient: { id: "ig-acc" }, message: { mid: "m.1", text } }] }],
});

describe("metaServiceNoticeReason: только точные известные уведомления Meta", () => {
  it("узнаёт уведомление и не трогает реальных клиентов", () => {
    expect(metaServiceNoticeReason(NOTICE)).not.toBeNull();
    expect(metaServiceNoticeReason("  continue setting up your account")).not.toBeNull();
    expect(metaServiceNoticeReason("Здравствуйте, хочу купить квартиру")).toBeNull();
    expect(metaServiceNoticeReason("Салом, 2-хонагӣ доред?")).toBeNull();
    // фраза внутри текста клиента (не в начале) — не уведомление
    expect(metaServiceNoticeReason("мне пришло: Continue setting up your account, что это?")).toBeNull();
    expect(metaServiceNoticeReason("")).toBeNull();
    expect(metaServiceNoticeReason(undefined)).toBeNull();
  });
});

describe("parseIncoming: уведомление Meta отсекается во всех каналах", () => {
  it("WhatsApp: уведомление мимо, обычный клиент проходит", () => {
    const out = parseIncoming(waBody([
      { from: "16505551111", id: "wamid.N", type: "text", text: { body: NOTICE } },
      { from: "79160000001", id: "wamid.C", type: "text", text: { body: "Есть 2-комнатная?" } },
    ], "pid-1"));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ channel: "WHATSAPP", senderId: "79160000001", text: "Есть 2-комнатная?" });
  });
  it("Instagram/Messenger: то же уведомление мимо, клиент проходит", () => {
    expect(parseIncoming(igBody(NOTICE))).toEqual([]);
    expect(parseIncoming(igBody("Здравствуйте, цена?"))).toHaveLength(1);
    expect(parseIncoming({ ...igBody(NOTICE), object: "page" })).toEqual([]);
  });
});

describe("вебхук целиком: «Continue setting up your account» не создаёт клиента", () => {
  let whatsapp: CustomerMessengerFixture;
  const saved: Record<string, unknown> = {};

  beforeAll(async () => {
    whatsapp = await createCustomerMessengerFixture("WHATSAPP");
    const row = await prisma.settings.upsert({
      where: { id: "singleton" }, update: {}, create: { id: "singleton" },
      select: { metaEnabled: true, botEnabled: true, botWhatsappEnabled: true, metaVerifyToken: true },
    });
    Object.assign(saved, row);
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { metaEnabled: true, botEnabled: true, botWhatsappEnabled: true, metaVerifyToken: encryptSecret(`verify-${runId}`) },
    });
  });
  afterAll(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: saved });
    await whatsapp?.dispose();
  });
  beforeEach(() => vi.clearAllMocks());

  it("уведомление: 200, ни хода бота, ни исходящего, ни переписки, ни клиента", async () => {
    const from = `1650${String(runId).slice(-7)}`;
    const body = waBody([{ from, id: `wamid.notice-${runId}`, type: "text", text: { body: NOTICE } }], whatsapp.externalId);
    const res = await request(app).post("/api/v1/webhooks/meta").set("x-hub-signature-256", whatsapp.sign(body)).send(body);
    expect(res.status).toBe(200);
    await drainBackgroundTasks(5_000);
    expect(processTurn).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await prisma.botConversation.count({ where: { channel: "WHATSAPP", subscriberId: from } })).toBe(0);
    expect(await prisma.client.count({ where: { phone: { contains: from } } })).toBe(0);
  });

  it("обычное сообщение клиента на том же номере по-прежнему доходит до бота", async () => {
    const from = `7918${String(runId).slice(-7)}`;
    const body = waBody([{ from, id: `wamid.real-${runId}`, type: "text", text: { body: "Здравствуйте, ищу квартиру" } }], whatsapp.externalId);
    const res = await request(app).post("/api/v1/webhooks/meta").set("x-hub-signature-256", whatsapp.sign(body)).send(body);
    expect(res.status).toBe(200);
    await drainBackgroundTasks(5_000);
    expect(processTurn).toHaveBeenCalledTimes(1);
  });
});
