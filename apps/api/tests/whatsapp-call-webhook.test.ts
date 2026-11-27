import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import type { MessengerTurnInput, MessengerTurnResult } from "../src/messengers/turnTypes.js";

/**
 * ЗВОНКИ WHATSAPP В ВЕБХУКЕ И СЛУЖЕБНЫЕ СОБЫТИЯ МИМО БОТА (18.11.2026).
 *
 * 1) Поле `calls` (connect/terminate, статусы звонка) — одна строка в журнал,
 *    ни сообщения, ни статуса доставки.
 * 2) Живой случай с прода: после голосового звонка Meta прислала
 *    `interactive.call_permission_reply` с `context.id = wacid.…`; бот получил
 *    «[вложение: interactive]» и ответил «не получается открыть вложение». Такие
 *    события (и system / request_welcome / unsupported) до бота не доходят.
 * 3) Ответ кнопкой и строкой списка — слова человека, как и раньше кнопка шаблона.
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
const { parseIncoming, parseStatusUpdates } = await import("../src/messengers/meta.js");
const { parseWhatsappCallEvents, handleWhatsappCallEvents } = await import("../src/messengers/whatsappCalls.js");

const runId = Date.now();
const PHONE_ID = `wa-calls-${runId}`;

function waBody(value: Record<string, unknown>, field = "messages", phoneId = PHONE_ID) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "waba-test", changes: [{ field, value: { messaging_product: "whatsapp", metadata: { phone_number_id: phoneId }, ...value } }] }],
  };
}

/** Форма события звонка — по примерам Meta (calling/user-initiated-calls), значения синтетические. */
const connectBody = () =>
  waBody(
    {
      contacts: [{ profile: { name: "Клиент" }, wa_id: "79160000001" }],
      calls: [
        {
          id: "wacid.TEST-CONNECT",
          to: "992000000000",
          from: "79160000001",
          event: "connect",
          timestamp: "1763452635",
          direction: "USER_INITIATED",
        },
      ],
    },
    "calls"
  );
const terminateBody = () =>
  waBody(
    {
      calls: [
        {
          id: "wacid.TEST-TERM",
          to: "992000000000",
          from: "79160000001",
          event: "terminate",
          direction: "USER_INITIATED",
          timestamp: "1763452700",
          status: "COMPLETED",
          start_time: "1763452640",
          end_time: "1763452700",
          duration: 60,
        },
      ],
    },
    "calls"
  );

/** Ответ на запрос разрешения звонить — ровно та форма, что пришла на проде 18.11 (номера синтетические). */
const permissionReplyMessage = (from: string, mid: string) => ({
  from,
  id: mid,
  timestamp: "1763456235",
  type: "interactive",
  context: { from: "992000000000", id: "wacid.ABC" },
  interactive: {
    type: "call_permission_reply",
    call_permission_reply: { response: "accept", expiration_timestamp: 1764000000, response_source: "user_action" },
  },
});

describe("поле calls: разбор событий звонка", () => {
  it("connect и terminate разбираются, номер в журнал — маской, сообщений и статусов доставки нет", () => {
    expect(parseWhatsappCallEvents(connectBody())).toEqual([
      expect.objectContaining({ callId: "wacid.TEST-CONNECT", event: "connect", from: "79160000001", direction: "USER_INITIATED", phoneNumberId: PHONE_ID }),
    ]);
    const [term] = parseWhatsappCallEvents(terminateBody());
    expect(term).toMatchObject({ callId: "wacid.TEST-TERM", event: "terminate", status: "COMPLETED", durationSec: 60 });

    const lines: string[] = [];
    expect(handleWhatsappCallEvents(terminateBody(), (l) => lines.push(l))).toBe(1);
    expect(lines[0]).toContain("событие=terminate");
    expect(lines[0]).toContain("id=wacid.TEST-TERM");
    expect(lines[0]).toContain("длительность=60с");
    expect(lines[0]).not.toContain("79160000001");

    expect(parseIncoming(connectBody())).toEqual([]);
    expect(parseIncoming(terminateBody())).toEqual([]);
  });

  it("статус звонка (value.statuses, type call) — событие звонка, а не доставка сообщения", () => {
    const body = waBody({ statuses: [{ id: "wacid.TEST-RING", timestamp: "1", type: "call", status: "RINGING", recipient_id: "79160000001" }] }, "calls");
    expect(parseStatusUpdates(body)).toEqual([]);
    expect(parseWhatsappCallEvents(body)).toEqual([expect.objectContaining({ callId: "wacid.TEST-RING", event: "status", status: "RINGING" })]);
    // Обычный статус доставки сообщения не задет.
    const delivery = waBody({ statuses: [{ id: "wamid.OUT", status: "delivered", recipient_id: "79160000001" }] });
    expect(parseStatusUpdates(delivery)).toEqual([expect.objectContaining({ mid: "wamid.OUT", status: "delivered" })]);
  });

  it("кривое тело и чужой продукт — пусто, без исключения", () => {
    expect(parseWhatsappCallEvents(null)).toEqual([]);
    expect(parseWhatsappCallEvents({ object: "instagram", entry: [{ changes: [{ field: "calls", value: { calls: [{ id: "x" }] } }] }] })).toEqual([]);
    expect(parseWhatsappCallEvents({ object: "whatsapp_business_account", entry: "мусор" })).toEqual([]);
    expect(parseWhatsappCallEvents(waBody({ calls: ["мусор", 5] }, "calls"))).toEqual([]);
  });
});

describe("служебные события WhatsApp мимо бота", () => {
  it("ответ на разрешение звонить и пустой ответ на звонок (context wacid.) — не реплика", () => {
    expect(parseIncoming(waBody({ messages: [permissionReplyMessage("79160000002", "wamid.X")] }))).toEqual([]);
    // Тот же ответ без поля interactive.type, только по ссылке на звонок.
    const bareOnCall = { from: "79160000002", id: "wamid.Z", type: "interactive", context: { id: "wacid.ABC" }, interactive: {} };
    expect(parseIncoming(waBody({ messages: [bareOnCall] }))).toEqual([]);
  });

  it("слова человека «ответом» на пузырь звонка — обычная реплика, текстом", () => {
    const textOnCall = { from: "79160000002", id: "wamid.Y", type: "text", text: { body: "Почему не берёте?" }, context: { id: "wacid.ABC" } };
    const [reply] = parseIncoming(waBody({ messages: [textOnCall] }));
    expect(reply).toMatchObject({ text: "Почему не берёте?", attachmentType: undefined, replyToMessageId: "wacid.ABC" });
    const voiceOnCall = { from: "79160000002", id: "wamid.V", type: "audio", audio: { id: "media-1" }, context: { id: "wacid.ABC" } };
    expect(parseIncoming(waBody({ messages: [voiceOnCall] }))).toEqual([expect.objectContaining({ attachmentType: "audio", mediaId: "media-1" })]);
  });

  it.each([
    ["system", { type: "system", system: { body: "Пользователь сменил номер", type: "user_changed_number" } }],
    ["request_welcome", { type: "request_welcome" }],
    ["reaction", { type: "reaction", reaction: { message_id: "wamid.OUT", emoji: "❤️" } }],
  ])("%s — не реплика", (_name, extra) => {
    expect(parseIncoming(waBody({ messages: [{ from: "79160000003", id: `wamid.${_name}`, ...extra }] }))).toEqual([]);
  });

  it("unsupported — остаётся событием с пометкой «только записать» (след в переписке без хода бота)", () => {
    const [msg] = parseIncoming(waBody({ messages: [{ from: "79160000003", id: "wamid.unsup", type: "unsupported", errors: [{ code: 131051, title: "Message type unknown" }] }] }));
    expect(msg).toMatchObject({ recordOnly: true, attachmentType: "unsupported", text: "" });
  });

  it("ответ кнопкой/строкой списка и кнопка шаблона — слова человека, не вложение", () => {
    const [button] = parseIncoming(
      waBody({ messages: [{ from: "79160000004", id: "wamid.B", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "yes", title: "Да, звоните" } } }] })
    );
    expect(button).toMatchObject({ text: "Да, звоните", attachmentType: undefined });
    const [list] = parseIncoming(
      waBody({ messages: [{ from: "79160000004", id: "wamid.L", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "2", title: "2 комнаты", description: "Сино" } } }] })
    );
    expect(list).toMatchObject({ text: "2 комнаты. Сино", attachmentType: undefined });
    const [template] = parseIncoming(waBody({ messages: [{ from: "79160000004", id: "wamid.T", type: "button", button: { text: "Да, присылайте" } }] }));
    expect(template).toMatchObject({ text: "Да, присылайте", attachmentType: undefined });
    const [order] = parseIncoming(
      waBody({ messages: [{ from: "79160000004", id: "wamid.O", type: "order", order: { catalog_id: "c", text: "Хочу эту", product_items: [{ product_retailer_id: "OB-000164", quantity: 1 }] } }] })
    );
    expect(order).toMatchObject({ text: "Хочу эту · 🛒 Заказ из каталога: OB-000164", attachmentType: undefined });
  });
});

describe("вебхук целиком: ответ на разрешение звонить не будит бота", () => {
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
    // isMetaEnabled требует ключ рукопожатия; сам вебхук подписан секретом аккаунта-фикстуры.
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { metaEnabled: true, botEnabled: true, botWhatsappEnabled: true, metaVerifyToken: encryptSecret(`verify-${runId}`) },
    });
  });

  afterAll(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: saved });
    // С 27.11.2026 разрешение звонить заводит просьбу о звонке (messengers/whatsappServiceEvents.ts) — убрать за собой.
    await prisma.callbackRequest.deleteMany({ where: { phone: { contains: String(runId).slice(-7) } } });
    await whatsapp?.dispose();
  });

  beforeEach(() => vi.clearAllMocks());

  it("call_permission_reply: 200, ни хода бота, ни исходящего, переписка не заводится", async () => {
    const from = `7916${String(runId).slice(-7)}`;
    const body = waBody({ contacts: [{ wa_id: from, profile: { name: "Клиент" } }], messages: [permissionReplyMessage(from, `wamid.perm-${runId}`)] }, "messages", whatsapp.externalId);
    const res = await request(app).post("/api/v1/webhooks/meta").set("x-hub-signature-256", whatsapp.sign(body)).send(body);
    expect(res.status).toBe(200);
    await drainBackgroundTasks(5_000);
    expect(processTurn).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await prisma.botConversation.count({ where: { channel: "WHATSAPP", subscriberId: from } })).toBe(0);
  });

  it("unsupported: 200, ход только «записать» (silent), исходящего нет", async () => {
    const from = `7917${String(runId).slice(-7)}`;
    const body = waBody({ contacts: [{ wa_id: from, profile: { name: "Клиент" } }], messages: [{ from, id: `wamid.unsup-${runId}`, type: "unsupported", errors: [{ code: 131051, title: "Message type unknown" }] }] }, "messages", whatsapp.externalId);
    const res = await request(app).post("/api/v1/webhooks/meta").set("x-hub-signature-256", whatsapp.sign(body)).send(body);
    expect(res.status).toBe(200);
    await drainBackgroundTasks(5_000);
    expect(processTurn).toHaveBeenCalledTimes(1);
    expect(processTurn.mock.calls[0]![0]).toMatchObject({ silent: true });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("событие звонка terminate: 200, ни хода бота, ни исходящего", async () => {
    const body = waBody(terminateBody().entry[0]!.changes[0]!.value as Record<string, unknown>, "calls", whatsapp.externalId);
    const res = await request(app).post("/api/v1/webhooks/meta").set("x-hub-signature-256", whatsapp.sign(body)).send(body);
    expect(res.status).toBe(200);
    await drainBackgroundTasks(5_000);
    expect(processTurn).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
