import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import type { TelegramIncomingMessage } from "../src/telegram/api.js";
import type { ModerationOutcome } from "../src/messengers/commentModerationOutcome.js";

/**
 * ОЧЕРЕДЬ КОММЕНТАРИЕВ TELEGRAM ПОМНИТ СВОЮ ГРУППУ (аудит CHANNEL-NEW-23, 04.10.2026).
 *
 * message_id в Telegram нумеруется внутри чата. Раньше строка очереди не хранила id
 * группы: messageId был уникален глобально, а ответ/удаление шли в ТЕКУЩУЮ группу из
 * Настроек. После смены группы обсуждения A на B комментарий B с message_id, уже
 * занятым в A, молча отбрасывался как «дубль», а ждущие строки A отвечали и удаляли
 * в B по чужому message_id. Теперь строка хранит groupChatId, уникален
 * (groupChatId, messageId), ответ идёт в группу строки, а строки чужой группы
 * закрываются SKIPPED group_changed. Старые строки (groupChatId NULL) работают как
 * раньше: дубль ловится запасным поиском по messageId, ответ идёт в текущую группу.
 */

const { sendMessage, deleteChannelCommentMessage } = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  deleteChannelCommentMessage: vi.fn(),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  deleteChannelCommentMessage,
}));
// Фича «ответы на комментарии» включена независимо от Настроек стенда.
vi.mock("../src/messengers/botCapabilities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/botCapabilities.js")>()),
  loadBotCapabilities: async () => ({ comments: true }),
}));
vi.mock("../src/messengers/botChannels.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/botChannels.js")>()),
  isBotEnabledForChannel: async () => true,
}));

const { handleTelegramComment, ingestGroupComment, processDueTelegramComments } = await import(
  "../src/messengers/telegramGroupComments.js"
);

const runId = Date.now();
// Короче 15 цифр: chat.id проходит через Number, длинная строка потеряла бы точность.
const GROUP_A = `-100${String(runId).slice(-8)}1`;
const GROUP_B = `-100${String(runId).slice(-8)}2`;
const POST = `post-${runId}-scope`;
const MSG = String(runId % 1_000_000_000);

function comment(chatId: string, messageId: string): TelegramIncomingMessage {
  return {
    message_id: Number(messageId),
    chat: { id: Number(chatId), type: "supergroup" },
    from: { id: 777_000 + (runId % 1000), username: "buyer" },
    text: "👍",
    reply_to_message: {
      message_id: Number(String(runId).slice(-6)),
      chat: { id: Number(chatId), type: "supergroup" },
      is_automatic_forward: true,
      text: POST,
    },
  } as TelegramIncomingMessage;
}

const rowsOf = (messageId: string) => prisma.telegramGroupComment.findMany({ where: { messageId } });

beforeEach(() => {
  sendMessage.mockReset();
  sendMessage.mockResolvedValue({ message_id: 999 });
  deleteChannelCommentMessage.mockReset();
  deleteChannelCommentMessage.mockResolvedValue({ outcome: "accepted", provider: "TELEGRAM", effect: "delete", reason: "provider_confirmed" } satisfies ModerationOutcome);
});

afterEach(async () => {
  await prisma.telegramGroupComment.deleteMany({ where: { OR: [{ messageId: { startsWith: MSG } }, { postMessageId: POST }] } });
});

describe("приём: уникальность в пределах группы", () => {
  it("тот же message_id в другой группе принимается второй строкой, повтор в своей группе отбрасывается", async () => {
    expect(await ingestGroupComment(comment(GROUP_A, MSG), GROUP_A)).toBe(true);
    expect(await ingestGroupComment(comment(GROUP_B, MSG), GROUP_B)).toBe(true);
    expect(await ingestGroupComment(comment(GROUP_A, MSG), GROUP_A)).toBe(false);

    const rows = await rowsOf(MSG);
    expect(rows.map((r) => r.groupChatId).sort()).toEqual([GROUP_A, GROUP_B].sort());
  });

  it("старая строка без группы (NULL) по-прежнему ловит повторную доставку", async () => {
    await prisma.telegramGroupComment.create({
      data: { messageId: MSG, postMessageId: POST, authorId: "1", text: "старый", replyDueAt: new Date() },
    });

    expect(await ingestGroupComment(comment(GROUP_A, MSG), GROUP_A)).toBe(false);
    expect(await rowsOf(MSG)).toHaveLength(1);
  });
});

describe("ответ идёт в группу строки, а не в текущую из Настроек", () => {
  it("handleTelegramComment отвечает в группу строки", async () => {
    const row = await prisma.telegramGroupComment.create({
      data: { messageId: MSG, groupChatId: GROUP_A, postMessageId: POST, authorId: "1", text: "👍", replyDueAt: new Date() },
    });

    await handleTelegramComment(row as never, GROUP_B);

    expect(sendMessage).toHaveBeenCalledWith(GROUP_A, expect.any(String), Number(MSG));
    expect(sendMessage).not.toHaveBeenCalledWith(GROUP_B, expect.anything(), expect.anything());
  });

  it("удаление тоже идёт в группу строки", async () => {
    const row = await prisma.telegramGroupComment.create({
      data: {
        messageId: MSG,
        groupChatId: GROUP_A,
        postMessageId: POST,
        authorId: "1",
        text: "купите дёшево крипту, пишите в личку https://spam.example",
        replyDueAt: new Date(),
      },
    });

    await handleTelegramComment(row as never, GROUP_B);

    expect(deleteChannelCommentMessage).toHaveBeenCalledWith(GROUP_A, Number(MSG));
    expect(deleteChannelCommentMessage).not.toHaveBeenCalledWith(GROUP_B, expect.anything());
    const saved = await prisma.telegramGroupComment.findUniqueOrThrow({ where: { id: row.id } });
    expect(saved.status).toBe("DELETED");
    expect(saved.note).toMatch(/^moderation_deleted(?:;|$)/);
  });

  it("старая строка без группы отвечает в текущую (запасной путь)", async () => {
    const row = await prisma.telegramGroupComment.create({
      data: { messageId: MSG, postMessageId: POST, authorId: "1", text: "👍", replyDueAt: new Date() },
    });

    await handleTelegramComment(row as never, GROUP_B);

    expect(sendMessage).toHaveBeenCalledWith(GROUP_B, expect.any(String), Number(MSG));
  });
});

describe("processDueTelegramComments после смены группы", () => {
  it("строка прежней группы закрывается group_changed без отправки, строка текущей отвечается", async () => {
    const saved = (
      await prisma.settings.findUnique({ where: { id: "singleton" }, select: { telegramDiscussionGroupId: true } })
    )?.telegramDiscussionGroupId ?? null;
    await prisma.settings.update({ where: { id: "singleton" }, data: { telegramDiscussionGroupId: GROUP_B } });
    try {
      const past = new Date(Date.now() - 60_000);
      const oldRow = await prisma.telegramGroupComment.create({
        data: { messageId: `${MSG}1`, groupChatId: GROUP_A, postMessageId: POST, authorId: "1", text: "👍", replyDueAt: past },
      });
      const freshRow = await prisma.telegramGroupComment.create({
        data: { messageId: `${MSG}2`, groupChatId: GROUP_B, postMessageId: POST, authorId: "2", text: "👍", replyDueAt: past },
      });

      await processDueTelegramComments();

      const oldAfter = await prisma.telegramGroupComment.findUniqueOrThrow({ where: { id: oldRow.id } });
      expect(oldAfter.status).toBe("SKIPPED");
      expect(oldAfter.note).toBe("group_changed");
      expect(sendMessage).not.toHaveBeenCalledWith(GROUP_A, expect.anything(), expect.anything());
      expect(sendMessage).not.toHaveBeenCalledWith(GROUP_B, expect.anything(), Number(`${MSG}1`));
      const freshAfter = await prisma.telegramGroupComment.findUniqueOrThrow({ where: { id: freshRow.id } });
      expect(freshAfter.status).toBe("REPLIED");
      expect(sendMessage).toHaveBeenCalledWith(GROUP_B, expect.any(String), Number(`${MSG}2`));
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { telegramDiscussionGroupId: saved } });
    }
  });
});
