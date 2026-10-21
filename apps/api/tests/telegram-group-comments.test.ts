import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import type { TelegramIncomingMessage } from "../src/telegram/api.js";
import { CommentModerationError, telegramDeleteOutcome } from "../src/messengers/commentModerationOutcome.js";

/**
 * Комментарии в группе-обсуждении Telegram-канала — тот же принцип проверки,
 * что у instagram-comments.test.ts: модель подменена, база настоящая.
 *
 * sendMessage подменяется модулем целиком (как в telegram-album.test.ts), а не
 * перехватом fetch: telegram/api.ts читает TELEGRAM_BOT_TOKEN в константу
 * МОДУЛЯ при первом импорте, а не при каждом вызове — переменную окружения в
 * beforeEach менять уже поздно.
 */

const { decide } = vi.hoisted(() => ({ decide: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: decide }));
// Creating a seller legitimately schedules separate background lead scoring.
// This suite checks comment classification/moderation, not that asynchronous
// scorer; leave the comment-model spy strict and isolate only the unrelated job.
vi.mock("../src/ai/scoring.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/ai/scoring.js")>()),
  scoreClient: async () => null,
}));

const { sendMessage, deleteChannelCommentMessage } = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  deleteChannelCommentMessage: vi.fn(),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  deleteChannelCommentMessage,
}));

const { handleTelegramComment, ingestGroupComment, isCommentUnderPost, processDueTelegramComments } = await import(
  "../src/messengers/telegramGroupComments.js"
);

// Числовой суффикс: runId идёт прямо в chat.id через Number(...), base36 дал бы NaN.
const runId = Date.now();
const GROUP_CHAT_ID = `-100${runId}`;

beforeEach(() => {
  sendMessage.mockReset();
  sendMessage.mockResolvedValue({ message_id: 999 });
  deleteChannelCommentMessage.mockReset();
  deleteChannelCommentMessage.mockResolvedValue({ provider: "TELEGRAM", effect: "delete", outcome: "accepted", reason: "provider_confirmed" });
  decide.mockReset();
});

afterEach(async () => {
  await prisma.telegramGroupComment.deleteMany({ where: { postMessageId: { startsWith: `post-${runId}` } } });
});

function makeComment(overrides: Partial<TelegramIncomingMessage> = {}): TelegramIncomingMessage {
  return {
    message_id: Math.floor(Math.random() * 1_000_000),
    chat: { id: Number(GROUP_CHAT_ID), type: "supergroup" },
    from: { id: 12345, username: "buyer1" },
    text: "Привет",
    reply_to_message: {
      message_id: 500,
      chat: { id: Number(GROUP_CHAT_ID), type: "supergroup" },
      is_automatic_forward: true,
      text: `Двушка в Сино, 41000$ (${`post-${runId}`})`,
    },
    ...overrides,
  };
}

describe("isCommentUnderPost", () => {
  it("true только у ответа на зеркало поста (is_automatic_forward)", () => {
    expect(isCommentUnderPost(makeComment())).toBe(true);
    expect(isCommentUnderPost(makeComment({ reply_to_message: undefined }))).toBe(false);
    expect(
      isCommentUnderPost(
        makeComment({ reply_to_message: { message_id: 1, chat: { id: 1, type: "supergroup" } } as never })
      )
    ).toBe(false);
  });

  /**
   * ОТВЕТ ВНУТРИ ВЕТКИ — ТОЖЕ КОММЕНТАРИЙ (18.09.2026).
   *
   * Отвечая на чужой комментарий или на реплику самого бота, человек шлёт
   * reply_to_message на ЭТОТ комментарий, а не на зеркало поста — и такое
   * сообщение отбрасывалось молча. Уточнить под постом было нельзя вообще:
   * бот отвечал один раз и на «а в каком районе?» не отзывался никогда.
   */
  it("true у ответа на чужой комментарий и на реплику бота — по message_thread_id", () => {
    const nested = makeComment({
      message_thread_id: 500,
      reply_to_message: {
        message_id: 777,
        chat: { id: Number(GROUP_CHAT_ID), type: "supergroup" },
        text: "41 000$, Сино",
      },
    });
    expect(isCommentUnderPost(nested)).toBe(true);
  });

  it("само зеркало поста комментарием не считается", () => {
    const mirror = makeComment({
      message_id: 500,
      message_thread_id: 500,
      is_automatic_forward: true,
      reply_to_message: undefined,
    });
    expect(isCommentUnderPost(mirror)).toBe(false);
  });

  it("обычная реплика в открытом чате группы (без ветки) комментарием не считается", () => {
    const chatter = makeComment({
      reply_to_message: { message_id: 42, chat: { id: Number(GROUP_CHAT_ID), type: "supergroup" }, text: "ха" },
    });
    expect(isCommentUnderPost(chatter)).toBe(false);
  });
});

describe("ingestGroupComment", () => {
  it("вложенный комментарий привязывается к ПОСТУ (message_thread_id), а не к комментарию-родителю", async () => {
    const nested = makeComment({
      text: `а район? ${runId}`,
      message_thread_id: Number(String(runId).slice(-6)),
      reply_to_message: { message_id: 777, chat: { id: Number(GROUP_CHAT_ID), type: "supergroup" }, text: "41 000$" },
    });
    expect(await ingestGroupComment(nested, GROUP_CHAT_ID)).toBe(true);
    const stored = await prisma.telegramGroupComment.findFirst({ where: { messageId: String(nested.message_id) } });
    expect(stored?.postMessageId).toBe(String(nested.message_thread_id));
    expect(stored?.status).toBe("PENDING");
    await prisma.telegramGroupComment.deleteMany({ where: { messageId: String(nested.message_id) } });
  });

  it("бот выключен — комментарий сохраняется, но закрыт пометкой bot_off", async () => {
    const msg = makeComment({ text: `выключен ${runId}` });
    expect(await ingestGroupComment(msg, GROUP_CHAT_ID, false)).toBe(true);
    const stored = await prisma.telegramGroupComment.findFirst({ where: { messageId: String(msg.message_id) } });
    expect(stored?.status).toBe("SKIPPED");
    expect(stored?.note).toBe("bot_off");
    await prisma.telegramGroupComment.deleteMany({ where: { messageId: String(msg.message_id) } });
  });

  it("принимает комментарий и отбрасывает повторную доставку того же message_id", async () => {
    const msg = makeComment({ text: `цена? ${runId}` });
    const first = await ingestGroupComment(msg, GROUP_CHAT_ID);
    const second = await ingestGroupComment(msg, GROUP_CHAT_ID);
    expect(first).toBe(true);
    expect(second).toBe(false);

    const row = await prisma.telegramGroupComment.findFirst({ where: { messageId: String(msg.message_id) } });
    expect(row?.status).toBe("PENDING");
    expect(row?.postMessageId).toBe("500");
  });

  it("игнорирует сообщения не из настроенной группы и обычную реплику без ссылки на пост", async () => {
    const wrongGroup = await ingestGroupComment(makeComment(), "-100999999999");
    const notAReply = await ingestGroupComment(makeComment({ reply_to_message: undefined }), GROUP_CHAT_ID);
    expect(wrongGroup).toBe(false);
    expect(notAReply).toBe(false);
  });
});

describe("handleTelegramComment", () => {
  async function row(text: string, extra: Partial<Parameters<typeof prisma.telegramGroupComment.create>[0]["data"]> = {}) {
    return prisma.telegramGroupComment.create({
      data: {
        messageId: String(Math.floor(Math.random() * 1_000_000_000)),
        postMessageId: `post-${runId}`,
        authorId: "author-1",
        authorName: "buyer1",
        text,
        replyDueAt: new Date(),
        ...extra,
      },
    });
  }

  it("реакция-смайлик — отвечает смайликом, модель не зовётся", async () => {
    const c = await row("🔥🔥");
    const outcome = await handleTelegramComment(c as never, GROUP_CHAT_ID);
    expect(outcome).toBe("replied");
    expect(decide).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(GROUP_CHAT_ID, expect.any(String), Number(c.messageId));
  });

  it("грубый смайлик — молчит, не отвечает и не зовёт модель", async () => {
    const c = await row("🖕 обман");
    const outcome = await handleTelegramComment(c as never, GROUP_CHAT_ID);
    expect(outcome).toBe("skipped");
    expect(decide).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    const reloaded = await prisma.telegramGroupComment.findUnique({ where: { id: c.id } });
    expect(reloaded?.note).toBe("rude");
  });

  it("лимит ответов одному автору под одним постом — пять в сутки, шестой раз молчит", async () => {
    for (let i = 0; i < 5; i++) {
      await prisma.telegramGroupComment.create({
        data: {
          messageId: `done-${runId}-${i}`,
          postMessageId: `post-${runId}`,
          authorId: "author-1",
          text: "было",
          replyDueAt: new Date(),
          status: "REPLIED",
          repliedAt: new Date(),
        },
      });
    }
    const c = await row("а сколько метров?");
    const outcome = await handleTelegramComment(c as never, GROUP_CHAT_ID);
    expect(outcome).toBe("skipped");
    expect(decide).not.toHaveBeenCalled();
    const reloaded = await prisma.telegramGroupComment.findUnique({ where: { id: c.id } });
    expect(reloaded?.note).toBe("loop_guard");
  });

  it("модель отвечает по существу — публичный ответ уходит с привязкой к сообщению", async () => {
    decide.mockResolvedValueOnce({ action: "reply", reply: "41000 сомони, Сино." });
    const c = await row("Дар кучо? Чанд сомон?");
    const outcome = await handleTelegramComment(c as never, GROUP_CHAT_ID);
    expect(outcome).toBe("replied");
    expect(sendMessage).toHaveBeenCalledWith(GROUP_CHAT_ID, expect.stringContaining("41000"), Number(c.messageId));
  });

  it("реальный TG consumer передаёт модели общий публичный телефон только для звонков", async () => {
    decide.mockResolvedValueOnce({ action: "reply", reply: "Позвоните: +992 44 650 14 14." });
    const c = await row("Какой телефон вашего агентства?", { authorId: `author-contact-${runId}` });
    expect(await handleTelegramComment(c as never, GROUP_CHAT_ID)).toBe("replied");
    expect(decide).toHaveBeenCalledTimes(1);
    const call = decide.mock.calls[0][0] as { systemStable: string };
    expect(call.systemStable).toContain("+992 44 650 14 14");
    expect(call.systemStable).toContain("только для звонков");
    expect(call.systemStable).not.toContain("+992 777 77 60 01");
    expect(sendMessage).toHaveBeenCalledWith(GROUP_CHAT_ID, expect.stringContaining("+992 44 650 14 14"), Number(c.messageId));
  });

  it("модель не знает ответа — эскалация, публичного ответа не уходит", async () => {
    decide.mockResolvedValueOnce({ action: "escalate", reason: "спрашивают про рассрочку" });
    const c = await row("а рассрочка есть?");
    const outcome = await handleTelegramComment(c as never, GROUP_CHAT_ID);
    expect(outcome).toBe("escalated");
    expect(sendMessage).not.toHaveBeenCalled();
    const reloaded = await prisma.telegramGroupComment.findUnique({ where: { id: c.id } });
    expect(reloaded?.status).toBe("ESCALATED");
  });
});

/**
 * СПАМ И ЧАСТНЫЕ ОБЪЯВЛЕНИЯ В ОБСУЖДЕНИИ (24.09.2026, жалоба владельца: бот нигде
 * не убирает спам и объявления людей, продающих свою квартиру).
 *
 * До правки в Telegram не было ни проверки спама (`checkSpam: false` без запасной),
 * ни действия «убрать» вовсе: у модели были только reply/ignore/escalate. Реклама
 * висела в группе открытой, номер из неё никуда не ложился.
 */
describe("handleTelegramComment — модерация", () => {
  // Номера из одной формулы с разными второй-третьей цифрами — не сталкиваются
  // между собой и с соседними файлами (CLAUDE.md, «номера в тестах»).
  const phone = (prefix: string) => `${prefix}${String(runId).slice(-7)}`;

  async function row(text: string) {
    return prisma.telegramGroupComment.create({
      data: {
        messageId: String(Math.floor(Math.random() * 1_000_000_000)),
        postMessageId: `post-${runId}`,
        authorId: `author-mod-${Math.random()}`,
        authorName: `seller_${runId}`,
        text,
        replyDueAt: new Date(),
      },
    });
  }

  it("объявление о продаже своей квартиры с номером — удаляется без модели, номер ложится в «Продавцы»", async () => {
    const number = phone("93");
    const c = await row(
      `Хона дорем да Маладёжний, Хона 58квадрат, да 15 этаж доми 19 этажа. Нарх 580. Хазор сомон номер ${number} занг занед`
    );
    await prisma.client.deleteMany({ where: { phone: `+992${number}` } });
    try {
      expect(await handleTelegramComment(c as never, GROUP_CHAT_ID)).toBe("hidden");
      expect(decide).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(deleteChannelCommentMessage).toHaveBeenCalledWith(GROUP_CHAT_ID, Number(c.messageId));
      const reloaded = await prisma.telegramGroupComment.findUnique({ where: { id: c.id } });
      expect(reloaded?.status).toBe("DELETED");
      const client = await prisma.client.findFirst({ where: { phone: `+992${number}` } });
      expect(client?.kind).toBe("SELLER");
      expect(client?.source).toBe("TELEGRAM");
    } finally {
      await prisma.client.deleteMany({ where: { phone: `+992${number}` } });
    }
  });

  it("мат и реклама агентства — удаляются без модели", async () => {
    const hate = await row("пиздец цены у вас");
    expect(await handleTelegramComment(hate as never, GROUP_CHAT_ID)).toBe("hidden");
    const agency = await row("Агентство недвижимости, большой выбор квартир, подписывайтесь @dom_dushanbe");
    expect(await handleTelegramComment(agency as never, GROUP_CHAT_ID)).toBe("hidden");
    expect(decide).not.toHaveBeenCalled();
    expect(deleteChannelCommentMessage).toHaveBeenCalledTimes(2);
  });

  it("неподтверждённое удаление закрывает комментарий без DELETED и публичного ответа", async () => {
    deleteChannelCommentMessage.mockRejectedValueOnce(new CommentModerationError(telegramDeleteOutcome({ ok: true, result: false })));
    const c = await row("пиздец цены у вас");
    expect(await handleTelegramComment(c as never, GROUP_CHAT_ID)).toBe("skipped");
    expect(deleteChannelCommentMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    const saved = await prisma.telegramGroupComment.findUniqueOrThrow({ where: { id: c.id } });
    expect(saved.status).toBe("SKIPPED");
    expect(saved.note).toContain("moderation_unknown");
  });

  it("очевидный спам (крипта + ссылка) — удаляется без модели", async () => {
    const c = await row("Заработок на крипте каждый день, пассивный доход! Пиши https://bit.ly/xx");
    expect(await handleTelegramComment(c as never, GROUP_CHAT_ID)).toBe("hidden");
    expect(decide).not.toHaveBeenCalled();
    expect(deleteChannelCommentMessage).toHaveBeenCalledTimes(1);
  });

  it("модель велит удалить рекламу — сообщение удаляется, ответа нет", async () => {
    decide.mockResolvedValueOnce({ action: "delete", reason: "реклама чужой квартиры" });
    const c = await row("Продаю квартиру в Сино, пишите в личку");
    expect(await handleTelegramComment(c as never, GROUP_CHAT_ID)).toBe("hidden");
    expect(deleteChannelCommentMessage).toHaveBeenCalledWith(GROUP_CHAT_ID, Number(c.messageId));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("нет права удалять — не три повтора, а пометка и подсказка в «Здоровье системы»", async () => {
    deleteChannelCommentMessage.mockRejectedValueOnce(new Error("Telegram API deleteMessage: Bad Request: message can't be deleted"));
    const c = await row("Заработок на крипте каждый день, пассивный доход! Пиши https://bit.ly/xx");
    expect(await handleTelegramComment(c as never, GROUP_CHAT_ID)).toBe("skipped");
    const reloaded = await prisma.telegramGroupComment.findUnique({ where: { id: c.id } });
    expect(reloaded?.status).toBe("SKIPPED");
    expect(reloaded?.note).toMatch(/^cant_delete/);
  });

  it("промт знает, что объявление — не вопрос к нам, и умеет удалять", async () => {
    decide.mockResolvedValueOnce({ action: "ignore" });
    const c = await row("а сколько метров?");
    await handleTelegramComment(c as never, GROUP_CHAT_ID);
    const call = decide.mock.calls[0][0] as { system: string; schema: { properties: { action: { enum: string[] } } } };
    expect(call.schema.properties.action.enum).toContain("delete");
    expect(call.system).toContain("хона дорем, нарх 580, занг занед");
  });
});

describe("processDueTelegramComments", () => {
  /**
   * Очередь при выключенной фиче не разбирается — но и не копится (18.09.2026):
   * подошедшие строки закрываются пометкой "bot_off", иначе при обратном включении
   * бот отвечал бы на комментарии, которым уже несколько дней.
   */
  it("выключенная фича (нет discussionGroupId) — очередь не разбирается, подошедшее закрывается bot_off", async () => {
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { telegramDiscussionGroupId: true },
    });
    const savedGroupId = settings?.telegramDiscussionGroupId ?? null;
    await prisma.settings.update({ where: { id: "singleton" }, data: { telegramDiscussionGroupId: null } });
    try {
      await prisma.telegramGroupComment.create({
        data: { messageId: `due-${runId}`, postMessageId: `post-${runId}`, authorId: "a", text: "что угодно", replyDueAt: new Date() },
      });
      const stats = await processDueTelegramComments();
      // Ни ответов, ни эскалаций; сколько именно строк закрылось — зависит от
      // остатков соседних проверок, поэтому смотрим конкретную свою.
      expect(stats.replied).toBe(0);
      expect(stats.escalated).toBe(0);
      expect(stats.skipped).toBeGreaterThanOrEqual(1);
      const closed = await prisma.telegramGroupComment.findFirst({ where: { messageId: `due-${runId}` } });
      expect(closed?.status).toBe("SKIPPED");
      expect(closed?.note).toBe("bot_off");
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { telegramDiscussionGroupId: savedGroupId } });
    }
  });
});
