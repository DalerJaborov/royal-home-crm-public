import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "./helpers/waitFor.js";

/**
 * «ОДИН МОЗГ» ДЛЯ TELEGRAM (Dan, тред «Ревизия бота», 03.10.2026; аудит
 * audit-1-one-brain). Личка бота (telegram/bot.ts) и Direct Messages канала
 * (messengers/telegramDirectMessages.ts) отвечают по тем же правилам, что каналы
 * Meta и сайт (messengers/conversation.ts):
 *  - заявка с парой канал+собеседник уходит агенту присланного объекта;
 *  - «заявка принята» — на языке клиента, без обещания звонка для «прочего»;
 *  - на «Ок» после реплики без вопроса — ни хода модели, ни текста;
 *  - ответ вычистили наши проверки — нейтральная реплика на языке клиента
 *    (с 10.10.2026, аудит ботов P0-1), русской заглушки «не расслышал» нет;
 *  - /start не стирает переписку;
 *  - реплика сотрудника в теме Direct Messages — не слова клиента.
 *
 * Транспорт и ИИ подменены — тест не ходит ни в Telegram, ни к модели.
 */

const {
  sendMessage,
  requestContact,
  removeKeyboard,
  sendMessageWithButtons,
  setMessageReaction,
  callAiText,
} = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string, _replyTo?: number, _topicId?: number) => {}),
  requestContact: vi.fn(async (_chatId: string, _text: string) => {}),
  removeKeyboard: vi.fn(async (_chatId: string, _text: string) => {}),
  sendMessageWithButtons: vi.fn(async (_chatId: string, _text: string, _buttons: unknown) => {}),
  setMessageReaction: vi.fn(async (_chatId: string, _messageId: number, _emoji: string) => {}),
  callAiText: vi.fn(),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  requestContact,
  removeKeyboard,
  sendMessageWithButtons,
  setMessageReaction,
}));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));

delete process.env.TELEGRAM_BOT_TOKEN;

const { prisma } = await import("../src/db.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");
const { NEUTRAL_FIRST_REPLY } = await import("../src/ai/intentDirectionGuard.js");
const { FALLBACK_ACCEPTED, otherCityAcceptedReply } = await import("../src/messengers/leadAcceptedReply.js");
const { instantBotReplyWindow } = await import("./helpers/botReplyWindow.js");
const { NEUTRAL_REPLIES } = await import("../src/messengers/replyChain.js");

const runId = Date.now();
const tail = String(runId).slice(-6);
let nextUpdateId = runId % 1_000_000_000;
let nextMessageId = 1000;

type SettingsSnapshot = {
  botEnabled: boolean;
  botTelegramEnabled: boolean;
  telegramOwnerChatId: string | null;
  telegramDirectMessagesEnabled: boolean;
  workHoursStart: string;
  workHoursEnd: string;
};
const SELECT = {
  botEnabled: true,
  botTelegramEnabled: true,
  telegramOwnerChatId: true,
  telegramDirectMessagesEnabled: true,
  workHoursStart: true,
  workHoursEnd: true,
} as const;
let savedSettings: SettingsSnapshot;
let restoreReplyWindow: (() => Promise<void>) | undefined;

const chatIds: string[] = [];
const DM_CHAT_ID = -(2_100_000_000_000 + (runId % 1_000_000_000));
let ownerId: string;
let propertyId: string;
let propertyShortId: number;
let districtId: string;

/** Девять цифр, разные на каждый тест и на каждый прогон (CLAUDE.md: номера из runId). */
function phoneFor(n: number): string {
  return `90${n}${tail}`.slice(0, 9);
}

function textUpdate(chatId: string, username: string, text: string) {
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++,
      chat: { id: Number(chatId), type: "private" },
      from: { id: Number(chatId), username, first_name: "Фарход" },
      text,
    },
  };
}

function dmUpdate(topicId: number, fromId: number, text: string, extra: Record<string, unknown> = {}) {
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++,
      chat: { id: DM_CHAT_ID, type: "supergroup", is_direct_messages: true },
      from: { id: fromId, username: `dm_${fromId}` },
      text,
      direct_messages_topic: { topic_id: topicId, user: { id: topicId, is_bot: false, username: `dm_user_${topicId}` } },
      ...extra,
    },
  };
}

function newChatId(offset: number): string {
  const id = String(783000000 + offset * 100000 + (runId % 100000));
  chatIds.push(id);
  return id;
}

beforeAll(async () => {
  savedSettings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: SELECT,
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      botEnabled: true,
      botTelegramEnabled: true,
      telegramOwnerChatId: null,
      telegramDirectMessagesEnabled: true,
      // Круглые сутки — "00:00"–"24:00" (не "23:59", см.
      // docs/journal/2026-09-24-krugolosutochnoe-okno-24-00.md): вне окна заявка
      // уходит в общую очередь без агента, и тест краснел бы вечером.
      workHoursStart: "00:00",
      workHoursEnd: "24:00",
    },
  });
  restoreReplyWindow = await instantBotReplyWindow();

  districtId = (await prisma.district.create({ data: { name: `ТГ-один-мозг-${runId}` } })).id;
  ownerId = (
    await prisma.agent.create({
      data: { fullName: `Умед Хозяинов ${runId}`, phone: `+992907${tail}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  const property = (
    await prisma.property.create({
      data: {
        title: `Объект один мозг ${runId}`,
        type: "APARTMENT",
        areaSqm: 60,
        rooms: 2,
        price: 500_000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 3",
        condition: "GOOD",
        status: "AVAILABLE",
        assignedAgentId: ownerId,
      },
    })
  );
  propertyId = property.id;
  propertyShortId = property.shortId;
});

afterAll(async () => {
  await restoreReplyWindow?.();
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  const convs = await prisma.telegramConversation.findMany({
    where: { chatId: { in: chatIds } },
    select: { id: true, clientId: true },
  });
  const dms = await prisma.telegramDirectConversation.findMany({
    where: { chatId: String(DM_CHAT_ID) },
    select: { id: true, clientId: true },
  });
  const clientIds = [...convs, ...dms].map((c) => c.clientId).filter((id): id is string => !!id);
  await prisma.backgroundJob.deleteMany({
    where: { dedupeKey: { in: convs.map((c) => `telegram-reply-retry:${c.id}`) } },
  });
  await prisma.telegramConversation.deleteMany({ where: { chatId: { in: chatIds } } });
  await prisma.telegramDirectConversation.deleteMany({ where: { chatId: String(DM_CHAT_ID) } });
  await prisma.propertyExposure.deleteMany({ where: { propertyId } });
  if (clientIds.length > 0) {
    await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  }
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: ownerId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

beforeEach(() => {
  for (const fn of [sendMessage, requestContact, removeKeyboard, sendMessageWithButtons, setMessageReaction]) {
    fn.mockReset();
    fn.mockResolvedValue(undefined);
  }
  callAiText.mockReset();
});

type Msg = { role: string; content: string; by?: { kind: string } };
async function tgMessages(chatId: string): Promise<Msg[]> {
  const row = await prisma.telegramConversation.findUnique({ where: { chatId }, select: { messages: true } });
  return (row?.messages as unknown as Msg[]) ?? [];
}

describe("Telegram: заявка уходит агенту присланного объекта (channel + recipientId)", () => {
  it("клиент прислал наш объект, потом номер — карточка у хозяина объекта по правилу «свой объект»", async () => {
    const chatId = newChatId(1);
    // Тот же след, что пишет sharedMediaHint на ссылку на наш объект: пара
    // (TELEGRAM, chatId). Раньше createLeadFromChannel в личке её не получал.
    await prisma.propertyExposure.create({
      data: { channel: "TELEGRAM", recipientId: chatId, propertyId, shortId: propertyShortId, kind: "CLIENT_SHARED" },
    });
    await prisma.telegramConversation.create({
      data: {
        chatId,
        username: `shown_${runId}`,
        leadDraft: { stage: "awaiting_phone", intent: "buy", confident: true } as any,
        messages: [
          { role: "user", content: "Хочу купить вот эту квартиру, она ещё свободна?" },
          { role: "assistant", content: "Да, свободна. Оставьте номер, агент расскажет подробнее." },
        ] as any,
        lastMessageAt: new Date(),
      },
    });
    callAiText.mockImplementation(async (params: { endpoint: string }) =>
      params.endpoint === "lead-closing"
        ? { reply: "Спасибо! Вам позвонит наш агент." }
        : { reply: ["Хорошо, записал."], ready: false, intent: "buy", confident: true }
    );
    await handleTelegramUpdate(textUpdate(chatId, `shown_${runId}`, `Мой номер ${phoneFor(1)}`));

    const conv = await prisma.telegramConversation.findUnique({ where: { chatId }, select: { clientId: true } });
    expect(conv?.clientId).toBeTruthy();
    const client = await prisma.client.findUniqueOrThrow({ where: { id: conv!.clientId! } });
    expect(client.assignReason).toBe("own_property_shown");
    expect(client.assignedAgentId).toBe(ownerId);
  }, 20_000);
});

describe("Telegram: «заявка принята» — на языке клиента и честно для «прочего»", () => {
  it("таджику — по-таджикски (модель не дала текста → заготовка на его языке), и в переписку", async () => {
    const chatId = newChatId(2);
    await prisma.telegramConversation.create({
      data: {
        chatId,
        username: `tj_${runId}`,
        leadDraft: { stage: "awaiting_phone", intent: "buy", confident: true } as any,
        messages: [
          { role: "user", content: "Салом, хонаи дуҳуҷрагӣ дар Сино мехарам" },
          { role: "assistant", content: "Хуб, рақаматонро нависед." },
        ] as any,
        lastMessageAt: new Date(),
      },
    });
    callAiText.mockImplementation(async (params: { endpoint: string }) =>
      params.endpoint === "lead-closing" ? { reply: "" } : { reply: ["Хуб"], ready: false }
    );
    await handleTelegramUpdate(textUpdate(chatId, `tj_${runId}`, `Рақамам ${phoneFor(2)}`));

    const sent = removeKeyboard.mock.calls.map((c) => c[1]);
    expect(sent).toEqual([FALLBACK_ACCEPTED.tg]);
    expect(sent.join(" ")).not.toMatch(/Спасибо|Заявка принята/);
    // Сама модель получила указание с реальным сроком звонка (lib/handoffPromise.ts).
    const closingCall = callAiText.mock.calls.find((c) => (c[0] as { endpoint: string }).endpoint === "lead-closing");
    expect((closingCall?.[0] as { system: string }).system).toMatch(/клиенту позвонит наш агент/);
    const messages = await tgMessages(chatId);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: FALLBACK_ACCEPTED.tg });
    expect(messages.some((m) => m.role === "user" && m.content.includes(phoneFor(2)))).toBe(true);
  }, 20_000);

  it("другой город (kind=OTHER) — без обещания звонка и без хода модели на подтверждение", async () => {
    const chatId = newChatId(3);
    await prisma.telegramConversation.create({
      data: {
        chatId,
        username: `bokhtar_${runId}`,
        leadDraft: { stage: "awaiting_phone", intent: "buy", confident: true } as any,
        messages: [
          { role: "user", content: "дар Бохтар хона мехарам" },
          { role: "assistant", content: "Хуб, рақаматонро нависед." },
        ] as any,
        lastMessageAt: new Date(),
      },
    });
    callAiText.mockResolvedValue({ reply: ["Хуб"], ready: false });
    await handleTelegramUpdate(textUpdate(chatId, `bokhtar_${runId}`, `Рақамам ${phoneFor(3)}`));

    const sent = removeKeyboard.mock.calls.map((c) => c[1]);
    expect(sent).toEqual([otherCityAcceptedReply("tg")]);
    expect(sent[0]).not.toMatch(/тамос мегирад|свяжется|позвонит/);
    expect(callAiText.mock.calls.some((c) => (c[0] as { endpoint: string }).endpoint === "lead-closing")).toBe(false);
    const conv = await prisma.telegramConversation.findUnique({ where: { chatId }, select: { clientId: true } });
    const client = await prisma.client.findUniqueOrThrow({ where: { id: conv!.clientId! } });
    expect(client.kind).toBe("OTHER");
  }, 20_000);
});

describe("Telegram: «Ок» после реплики без вопроса — без хода модели", () => {
  it("ни вызова модели, ни текста; реакция 👍 на сообщение, слова клиента в переписке", async () => {
    const chatId = newChatId(4);
    await prisma.telegramConversation.create({
      data: {
        chatId,
        username: `ack_${runId}`,
        leadDraft: { stage: "chatting", intent: "buy", confident: true } as any,
        messages: [
          { role: "user", content: "Хона дар Сино мехарам" },
          { role: "assistant", content: "Хуб, агенти мо имрӯз занг мезанад." },
        ] as any,
        lastMessageAt: new Date(),
      },
    });
    await handleTelegramUpdate(textUpdate(chatId, `ack_${runId}`, "Ок"));

    expect(callAiText).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(setMessageReaction).toHaveBeenCalledWith(chatId, expect.any(Number), "👍");
    const messages = await tgMessages(chatId);
    expect(messages.at(-1)).toMatchObject({ role: "user", content: "Ок" });
  }, 20_000);
});

describe("Заглушка «не расслышал» — только когда модель сама ничего не сказала", () => {
  /**
   * С 10.10.2026 (аудит ботов, P0-1) «вычистили — молчим» заменено: клиент получает
   * короткую нейтральную реплику на своём языке (messengers/replyChain.ts::
   * finalizeBotReply), не тишину и не заглушку про сбой.
   */
  it("личка: проверки вычистили ответ (предел просьб номера) — нейтральная реплика по-таджикски, не заглушка", async () => {
    const chatId = newChatId(5);
    await prisma.telegramConversation.create({
      data: {
        chatId,
        username: `ate_${runId}`,
        leadDraft: { stage: "awaiting_phone", intent: "buy", confident: true } as any,
        phoneAsksSent: 3,
        messages: [
          { role: "user", content: "Хона мехоҳам" },
          { role: "assistant", content: "Рақами телефонатонро нависед?" },
        ] as any,
        lastMessageAt: new Date(),
      },
    });
    callAiText.mockResolvedValue({ reply: ["Рақамро нависед?"], ready: false, intent: "buy", confident: true });
    await handleTelegramUpdate(textUpdate(chatId, `ate_${runId}`, "Майлаш, баъдтар"));

    expect(callAiText).toHaveBeenCalled();
    const sent = [...sendMessage.mock.calls, ...requestContact.mock.calls].map((c) => c[1]);
    expect(sent).toEqual([NEUTRAL_REPLIES.statement.tg]);
    expect(sent[0]).not.toMatch(/Бубахшед|не расслышал|Рақам/);
    const messages = await tgMessages(chatId);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: NEUTRAL_REPLIES.statement.tg });
  }, 20_000);

  it("личка: пустой ответ модели отклоняется целиком, входящее сохраняется и ставится повтор", async () => {
    const chatId = newChatId(6);
    await prisma.telegramConversation.create({
      data: {
        chatId,
        username: `empty_${runId}`,
        leadDraft: { stage: "chatting" } as any,
        messages: [
          { role: "user", content: "Салом" },
          { role: "assistant", content: "Ассалому алейкум! Чӣ хизмат карда метавонем?" },
        ] as any,
        lastMessageAt: new Date(),
      },
    });
    callAiText.mockResolvedValue({ reply: [], ready: false, confident: true });
    await handleTelegramUpdate(textUpdate(chatId, `empty_${runId}`, "Хона дар Сино мехарам"));

    expect(callAiText).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(requestContact).not.toHaveBeenCalled();
    expect(removeKeyboard).not.toHaveBeenCalled();
    expect(sendMessageWithButtons).not.toHaveBeenCalled();
    const conversation = await prisma.telegramConversation.findUniqueOrThrow({ where: { chatId } });
    const messages = conversation.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(3);
    expect(messages.at(-1)).toMatchObject({ role: "user", content: "Хона дар Сино мехарам" });
    expect(conversation.clientId).toBeNull();
    const job = await waitFor(() => prisma.backgroundJob.findUnique({
      where: { dedupeKey: `telegram-reply-retry:${conversation.id}` },
    }), { label: "повтор Telegram после пустого ответа модели" });
    expect(job!.type).toBe("telegram-reply-retry");
    expect(job!.payload).toMatchObject({ conversationId: conversation.id });
  }, 20_000);

  it("Direct Messages: проверки вычистили ответ — нейтральная реплика, заглушки нет", async () => {
    const topic = 610000000 + (runId % 100000);
    await prisma.telegramDirectConversation.create({
      data: {
        chatId: String(DM_CHAT_ID),
        topicId: String(topic),
        fromUserId: String(topic),
        leadDraft: { stage: "awaiting_phone", intent: "buy", confident: true } as any,
        phoneAsksSent: 3,
        messages: [
          { role: "user", content: "Хона мехоҳам" },
          { role: "assistant", content: "Рақами телефонатонро нависед?" },
        ] as any,
        lastMessageAt: new Date(),
      },
    });
    callAiText.mockResolvedValue({ reply: ["Рақамро нависед?"], ready: false, intent: "buy", confident: true });
    await handleTelegramUpdate(dmUpdate(topic, topic, "Майлаш, баъдтар"));

    expect(callAiText).toHaveBeenCalled();
    const sent = sendMessage.mock.calls.map((c) => c[1]);
    expect(sent).toEqual([NEUTRAL_REPLIES.statement.tg]);
    expect(sent[0]).not.toMatch(/Бубахшед|не расслышал/);
  }, 20_000);
});

describe("Telegram: /start не стирает переписку", () => {
  it("прошлые реплики остаются, нейтральное приветствие дописано в конец, кнопки на месте", async () => {
    const chatId = newChatId(7);
    const before: Msg[] = [
      { role: "user", content: "Ищу квартиру в Сино, бюджет 50 тысяч" },
      { role: "assistant", content: "Сколько комнат вам нужно?" },
    ];
    await prisma.telegramConversation.create({
      data: {
        chatId,
        username: `start_${runId}`,
        leadDraft: { stage: "chatting", intent: "buy", budgetMax: 50000 } as any,
        messages: before as any,
        lastMessageAt: new Date(),
      },
    });
    await handleTelegramUpdate(textUpdate(chatId, `start_${runId}`, "/start"));

    const messages = await tgMessages(chatId);
    expect(messages.slice(0, 2).map((m) => m.content)).toEqual(before.map((m) => m.content));
    // Язык — по прошлым словам человека: он писал по-русски.
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: NEUTRAL_FIRST_REPLY.ru });
    expect(sendMessageWithButtons).toHaveBeenCalledWith(chatId, NEUTRAL_FIRST_REPLY.ru, expect.any(Array));
    const row = await prisma.telegramConversation.findUnique({ where: { chatId }, select: { leadDraft: true } });
    expect((row?.leadDraft as { budgetMax?: number }).budgetMax).toBe(50000);
  }, 20_000);
});

describe("Direct Messages: реплика не от человека темы — не слова клиента", () => {
  it("администратор канала ответил в теме — не сохраняется как клиент, бот молчит и встаёт на паузу", async () => {
    const topic = 620000000 + (runId % 100000);
    callAiText.mockResolvedValue({ reply: ["Здравствуйте! Чем можем помочь?"], ready: false, confident: true });
    await handleTelegramUpdate(dmUpdate(topic, topic, "Здравствуйте"));
    callAiText.mockReset();
    sendMessage.mockReset();

    const adminId = 555000000 + (runId % 100000);
    await handleTelegramUpdate(dmUpdate(topic, adminId, "Добрый день, это менеджер канала, сейчас подскажу"));
    // И «от лица канала» — sender_chat.
    await handleTelegramUpdate(
      dmUpdate(topic, adminId, "Пришлём варианты сегодня", { sender_chat: { id: DM_CHAT_ID, type: "channel" } })
    );

    expect(callAiText).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    const row = await prisma.telegramDirectConversation.findUnique({
      where: { chatId_topicId: { chatId: String(DM_CHAT_ID), topicId: String(topic) } },
      select: { messages: true, pausedUntil: true },
    });
    const messages = (row?.messages as unknown as Msg[]) ?? [];
    expect(messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["Здравствуйте"]);
    expect(messages.some((m) => m.role === "assistant" && m.by?.kind === "manual" && m.content.includes("менеджер канала"))).toBe(true);
    expect(row?.pausedUntil && row.pausedUntil.getTime() > Date.now()).toBe(true);
  }, 20_000);
});
