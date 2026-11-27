import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import type { MessengerTurnInput, MessengerTurnResult } from "../src/messengers/turnTypes.js";

/**
 * СЛУЖЕБНОЕ УВЕДОМЛЕНИЕ META В WHATSAPP — НЕ КЛИЕНТ (27.11.2026).
 *
 * Живой случай (прод, 26.11 22:56 UTC): обычный `type: "text"` от американского номера с именем
 * профиля «WhatsApp Business» — «Continue setting up your account … +992 87 791 4444 … Setup
 * guidance … business.facebook.com/…». Бот ответил «агент вам позвонит» и завёл заявку на номер из
 * уведомления (наш собственный). Теперь такое событие до бота не доходит.
 */

const { sendMessage, processTurn } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (..._args: unknown[]) => "wamid.out-fake"),
  processTurn: vi.fn<(input: MessengerTurnInput) => Promise<MessengerTurnResult>>(async () => ({
    reply: "",
    ready: false,
    accepted: false,
    shouldReply: false,
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
const { parseIncoming } = await import("../src/messengers/meta.js");
const { metaServiceNoticeReason } = await import("../src/messengers/metaServiceNotice.js");

const runId = Date.now();
const PHONE_ID = `wa-notice-${runId}`;

/** Текст и ссылка — дословно с прода (идентификаторы бизнеса и номера оставлены, секретов в них нет). */
const NOTICE_TEXT =
  "*Continue setting up your account*\n\nYou have a few steps left to get started with WhatsApp Business. " +
  "Get detailed instructions and track progress for your number +992 87 791 4444 in *WhatsApp Manager's* new *Setup guidance*.\n\n" +
  "Go to your *Setup guidance* on *desktop*: https://business.facebook.com/latest/whatsapp%5Fmanager/setup%5Fguidance" +
  "?nav%5Fref=nudge&business%5Fid=989422350585529&lang=en_US&asset%5Fid=1083086891349257&phone%5Fnumber%5Fid=1476112588909838";

function waBody(value: Record<string, unknown>, phoneId = PHONE_ID) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "waba-test", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: phoneId }, ...value } }] }],
  };
}

const textMessage = (from: string, id: string, body: string) => ({ from, id, timestamp: "1764197781", type: "text", text: { body } });

describe("metaServiceNoticeReason: что считается служебным уведомлением Meta", () => {
  it("живой текст с прода — служебный, даже от неизвестного номера и без имени профиля", () => {
    expect(metaServiceNoticeReason({ senderId: "15550001111", text: NOTICE_TEXT })).not.toBeNull();
  });

  it("служебный номер Meta — служебный при любом тексте", () => {
    expect(metaServiceNoticeReason({ senderId: "+1 (646) 589-4168", text: "Hi" })).not.toBeNull();
  });

  it("официальное имя профиля плюс ссылка на площадку Meta — служебное", () => {
    expect(
      metaServiceNoticeReason({ senderId: "15550001111", profileName: " WhatsApp  Business ", text: "Policy update: https://www.facebook.com/business/help/123" })
    ).not.toBeNull();
  });

  it("ОДНО имя профиля без ссылки — человек: имя задаёт сам пользователь", () => {
    expect(metaServiceNoticeReason({ senderId: "15550001111", profileName: "WhatsApp Business", text: "Здравствуйте, ищу квартиру" })).toBeNull();
    expect(metaServiceNoticeReason({ senderId: "15550001111", profileName: "Meta", text: "ищу квартиру https://olx.tj/ad/1" })).toBeNull();
  });

  it("клиент со своей ссылкой или с чужим кабинетом — человек", () => {
    expect(metaServiceNoticeReason({ senderId: "992900000001", profileName: "Алишер", text: "Вот такая: https://www.facebook.com/share/p/abc" })).toBeNull();
    // кабинет Meta, но не WhatsApp Manager: узкое правило не задевает
    expect(metaServiceNoticeReason({ senderId: "992900000001", text: "https://business.facebook.com/settings/people" })).toBeNull();
    // подделка хоста: facebook.com внутри чужого домена — не Meta
    expect(metaServiceNoticeReason({ senderId: "992900000001", text: "https://business.facebook.com.evil.example/whatsapp_manager" })).toBeNull();
    expect(metaServiceNoticeReason({ senderId: "992900000001", text: "Салом, 2-комнатная, 987654321" })).toBeNull();
    expect(metaServiceNoticeReason({})).toBeNull();
  });
});

describe("parseIncoming: служебный текст Meta отсекается, обычные сообщения идут", () => {
  it("уведомление от «WhatsApp Business» не даёт входящего", () => {
    const body = waBody({
      contacts: [{ wa_id: "16465894168", profile: { name: "WhatsApp Business" } }],
      messages: [textMessage("16465894168", "wamid.notice-1", NOTICE_TEXT)],
    });
    expect(parseIncoming(body)).toEqual([]);
  });

  it("то же от неизвестного номера и без имени (признак — сама ссылка)", () => {
    const body = waBody({ contacts: [{ wa_id: "15550001111", profile: { name: "X" } }], messages: [textMessage("15550001111", "wamid.notice-2", NOTICE_TEXT)] });
    expect(parseIncoming(body)).toEqual([]);
  });

  it("обычный клиент рядом в той же пачке — проходит", () => {
    const body = waBody({
      contacts: [
        { wa_id: "16465894168", profile: { name: "WhatsApp Business" } },
        { wa_id: "992900000001", profile: { name: "Алишер" } },
      ],
      messages: [textMessage("16465894168", "wamid.notice-3", NOTICE_TEXT), textMessage("992900000001", "wamid.client-3", "Салом, ищу 2-комнатную, 900000001")],
    });
    const out = parseIncoming(body);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ senderId: "992900000001", text: "Салом, ищу 2-комнатную, 900000001" });
  });
});

describe("вебхук целиком: уведомление Meta не будит бота, не отвечает и не заводит переписку", () => {
  let whatsapp: CustomerMessengerFixture;
  const saved: Record<string, unknown> = {};

  beforeAll(async () => {
    whatsapp = await createCustomerMessengerFixture("WHATSAPP");
    const row = await prisma.settings.upsert({
      where: { id: "singleton" },
      update: {},
      create: { id: "singleton" },
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

  it("текст «Continue setting up your account»: 200, ни хода бота, ни исходящего, ни BotConversation", async () => {
    const from = `1646${String(runId).slice(-7)}`;
    const body = waBody(
      { contacts: [{ wa_id: from, profile: { name: "WhatsApp Business" } }], messages: [textMessage(from, `wamid.notice-${runId}`, NOTICE_TEXT)] },
      whatsapp.externalId
    );
    const res = await request(app).post("/api/v1/webhooks/meta").set("x-hub-signature-256", whatsapp.sign(body)).send(body);
    expect(res.status).toBe(200);
    await drainBackgroundTasks(5_000);
    expect(processTurn).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await prisma.botConversation.count({ where: { channel: "WHATSAPP", subscriberId: from } })).toBe(0);
  });

  it("обычный клиент с тем же именем профиля, но без ссылки Meta — ход бота состоялся", async () => {
    const from = `1647${String(runId).slice(-7)}`;
    const body = waBody(
      { contacts: [{ wa_id: from, profile: { name: "WhatsApp Business" } }], messages: [textMessage(from, `wamid.human-${runId}`, "Здравствуйте, хочу купить квартиру")] },
      whatsapp.externalId
    );
    const res = await request(app).post("/api/v1/webhooks/meta").set("x-hub-signature-256", whatsapp.sign(body)).send(body);
    expect(res.status).toBe(200);
    await drainBackgroundTasks(5_000);
    expect(processTurn).toHaveBeenCalledTimes(1);
  });
});
