import { useTelegramClientBot } from "./helpers/telegramClientBot.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// Клиентский путь Telegram — при выключенном «боте только для сотрудников» (27.11.2026).
useTelegramClientBot();

/**
 * ЧАТЫ TELEGRAM ИЗ НАСТРОЕК ПЕРЕЕЗЖАЮТ ВМЕСТЕ С ГРУППОЙ (20.11.2026, тот же класс, что #317 у групп помощницы).
 *
 * Обычную группу превратили в супергруппу — у неё новый chat id. В Настройках старый id лежал в группе комментариев
 * канала (комментарии клиентов переставали приниматься молча), в дополнительных чатах публикации и в основном канале.
 * Проверено на настоящей базе:
 *  1. дверь migrateSettingsTelegramChat: узко, «значение всё ещё старое», повтор и гонка безвредны;
 *  2. живое служебное сообщение migrate_to_chat_id / migrate_from_chat_id (telegram/bot.ts);
 *  3. почасовой сторож (settingsTelegramChatWatchdog.ts) — переезд, бота нет, обрыв связи, каналы;
 *  4. очередь комментариев: старые комментарии не переписываются на новый id и не остаются тихим провалом;
 *  5. суточная проверка чатов публикации (integrationHealth.ts).
 * Telegram подменён целиком: ничего не уходит на настоящий сервер.
 */

const tg = vi.hoisted(() => ({
  sendMessage: vi.fn(async (..._a: unknown[]) => ({ message_id: 999 })),
  sendHtmlMessage: vi.fn(async (..._a: unknown[]) => ({})),
  sendMessageWithButtons: vi.fn(async (..._a: unknown[]) => ({ message_id: 501 })),
  sendChatAction: vi.fn(async (..._a: unknown[]) => {}),
  setMessageReaction: vi.fn(async (..._a: unknown[]) => "sent"),
  deleteChannelCommentMessage: vi.fn(),
  getChatMemberStatus: vi.fn(),
  probeChatAction: vi.fn(),
  getChatTitle: vi.fn(async (_chatId: string) => "Обсуждение канала"),
  enabled: { value: true },
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/telegram/api.js")>();
  return {
    ...actual,
    sendMessage: tg.sendMessage,
    sendHtmlMessage: tg.sendHtmlMessage,
    sendMessageWithButtons: tg.sendMessageWithButtons,
    sendChatAction: tg.sendChatAction,
    setMessageReaction: tg.setMessageReaction,
    deleteChannelCommentMessage: tg.deleteChannelCommentMessage,
    getBotUsername: async () => "rh_test_bot",
    isTelegramEnabled: () => tg.enabled.value,
    getChatMemberStatus: tg.getChatMemberStatus,
    probeChatAction: tg.probeChatAction,
    getChatTitle: tg.getChatTitle,
  };
});
// Ответы на комментарии включены независимо от Настроек стенда.
vi.mock("../src/messengers/botCapabilities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/botCapabilities.js")>()),
  loadBotCapabilities: async () => ({ comments: true }),
}));
vi.mock("../src/messengers/botChannels.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/botChannels.js")>()),
  isBotEnabledForChannel: async () => true,
}));

delete process.env.TELEGRAM_BOT_TOKEN;

const { prisma } = await import("../src/db.js");
const { TelegramApiError } = await import("../src/telegram/api.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");
const { migrateSettingsTelegramChat, replaceChatIdInList } = await import("../src/lib/settingsTelegramChatMigration.js");
const { sweepSettingsTelegramChats } = await import("../src/lib/settingsTelegramChatWatchdog.js");
const { sweepAssistantGroups } = await import("../src/lib/assistantGroupWatchdog.js");
const { handleTelegramComment, processDueTelegramComments } = await import("../src/messengers/telegramGroupComments.js");
const { checkTelegramExtraChatsHealth } = await import("../src/lib/integrationHealth.js");
const { waitFor, waitForSettled } = await import("./helpers/waitFor.js");

const runId = String(Date.now()).slice(-8);
const UPGRADED = "Bad Request: group chat was upgraded to a supergroup chat";
let seq = 0;
/** Пара id одного сценария: обычная группа (без префикса -100) и супергруппа (-100…), обе короче 16 цифр. */
function ids() {
  seq += 1;
  const old = -(2_000_000_000 + Number(runId) * 10 + seq);
  const next = -Number(`100${runId}${String(seq).padStart(2, "0")}`);
  return { old, next, oldId: String(old), newId: String(next) };
}
const CHANNEL = `-100${runId}77`;
let nextUpdateId = Number(runId) * 100;

type ChatFields = { telegramDiscussionGroupId: string | null; telegramExtraChatIds: string | null; telegramChannelId: string | null };
let saved: ChatFields | null = null;
const readFields = async (): Promise<ChatFields> =>
  (await prisma.settings.findUniqueOrThrow({
    where: { id: "singleton" },
    select: { telegramDiscussionGroupId: true, telegramExtraChatIds: true, telegramChannelId: true },
  }));
const setFields = (data: Partial<ChatFields>) =>
  prisma.settings.update({ where: { id: "singleton" }, data: { telegramDiscussionGroupId: null, telegramExtraChatIds: null, telegramChannelId: null, ...data } });

const sentAnything = () => [tg.sendMessage, tg.sendHtmlMessage, tg.sendMessageWithButtons, tg.sendChatAction, tg.setMessageReaction]
  .reduce((sum, mock) => sum + mock.mock.calls.length, 0);

const serviceUpdate = (chat: { id: number; type: string }, extra: Record<string, unknown>) => ({
  update_id: nextUpdateId++,
  message: { message_id: 100 + (nextUpdateId % 1000), chat, date: Math.floor(Date.now() / 1000), ...extra },
});

function telegramSays(member: Record<string, () => unknown>, probe: Record<string, () => unknown> = {}) {
  tg.getChatMemberStatus.mockImplementation(async (chatId: string) => (member[chatId] ? member[chatId]() : { status: "administrator" }));
  tg.probeChatAction.mockImplementation(async (chatId: string) => { if (probe[chatId]) return probe[chatId](); });
}
const refuse = (error: Error) => () => { throw error; };
const migrated = (method: string, next: number) => new TelegramApiError(400, method, UPGRADED, { migrate_to_chat_id: next });

const dedupKeys = new Set<string>();
const logRows = (dedupKey: string) => { dedupKeys.add(dedupKey); return prisma.errorLog.findMany({ where: { dedupKey } }); };

beforeAll(async () => {
  await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = await readFields();
});

beforeEach(async () => {
  for (const mock of [tg.sendMessage, tg.sendHtmlMessage, tg.sendMessageWithButtons, tg.sendChatAction, tg.setMessageReaction, tg.deleteChannelCommentMessage, tg.getChatMemberStatus, tg.probeChatAction, tg.getChatTitle]) {
    mock.mockReset();
  }
  tg.sendMessage.mockResolvedValue({ message_id: 999 });
  tg.getChatTitle.mockResolvedValue("Обсуждение канала");
  tg.enabled.value = true;
  telegramSays({});
  await setFields({});
});

afterEach(async () => {
  await prisma.telegramGroupComment.deleteMany({ where: { postMessageId: { startsWith: `post-${runId}` } } });
  await prisma.errorLog.deleteMany({
    where: { OR: [{ dedupKey: { in: [...dedupKeys] } }, { dedupKey: { startsWith: "settings-discussion-bot-absent:" } }, { dedupKey: { startsWith: "telegram-comments-" } }] },
  });
  vi.restoreAllMocks();
});

afterAll(async () => {
  // Записи журнала действий пишутся «в отрыве»: дождаться последней, потом убрать все свои (действие новое, чужих нет).
  const mine = { action: "SETTINGS_TELEGRAM_CHAT_MIGRATED" };
  await waitForSettled(() => prisma.auditLog.count({ where: mine }));
  await prisma.auditLog.deleteMany({ where: mine });
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.$disconnect();
});

describe("дверь переноса адресов в Настройках", () => {
  it("группа комментариев переезжает; повтор безвреден и ничего не трогает", async () => {
    const { oldId, newId } = ids();
    await setFields({ telegramDiscussionGroupId: oldId, telegramChannelId: CHANNEL });

    expect(await migrateSettingsTelegramChat(oldId, newId)).toEqual({ kind: "done", moved: ["telegramDiscussionGroupId"] });
    expect(await migrateSettingsTelegramChat(oldId, newId)).toEqual({ kind: "done", moved: [] });

    expect(await readFields()).toEqual({ telegramDiscussionGroupId: newId, telegramExtraChatIds: null, telegramChannelId: CHANNEL });
  });

  it("в списке чатов публикации меняется только старый адрес, разделители и соседи на месте", async () => {
    const { oldId, newId } = ids();
    const list = `${CHANNEL}, ${oldId}\n@royal_test_chan  ${oldId}5`;
    await setFields({ telegramExtraChatIds: list });

    const outcome = await migrateSettingsTelegramChat(oldId, newId);

    expect(outcome).toEqual({ kind: "done", moved: ["telegramExtraChatIds"] });
    expect((await readFields()).telegramExtraChatIds).toBe(`${CHANNEL}, ${newId}\n@royal_test_chan  ${oldId}5`);
    expect(replaceChatIdInList("@a_chat, -5", "-55", "-1005")).toBeNull();
  });

  it("основной канал, если туда вписали обычную группу, переезжает тоже; запись в журнал действий есть", async () => {
    const { oldId, newId } = ids();
    await setFields({ telegramChannelId: ` ${oldId} ` });

    expect(await migrateSettingsTelegramChat(oldId, newId)).toEqual({ kind: "done", moved: ["telegramChannelId"] });
    expect((await readFields()).telegramChannelId).toBe(newId);
    // Запись идёт «в отрыве» (logSystemAudit), поэтому ждём именно свою, по старому id.
    const audit = await waitFor(() => prisma.auditLog.findFirst({ where: { action: "SETTINGS_TELEGRAM_CHAT_MIGRATED", meta: { path: ["oldChatId"], equals: oldId } } }));
    expect(audit?.meta).toMatchObject({ fields: ["telegramChannelId"], oldChatId: oldId, newChatId: newId });
  });

  it("в поле уже другое значение — дверь его не трогает", async () => {
    const { oldId, newId } = ids();
    const human = `-100${runId}55`;
    await setFields({ telegramDiscussionGroupId: human, telegramExtraChatIds: CHANNEL });

    expect(await migrateSettingsTelegramChat(oldId, newId)).toEqual({ kind: "done", moved: [] });
    expect(await readFields()).toEqual({ telegramDiscussionGroupId: human, telegramExtraChatIds: CHANNEL, telegramChannelId: null });
  });

  it("человек сохранил поле между чтением и записью — его правка не затирается", async () => {
    const { oldId, newId } = ids();
    const human = `-100${runId}56`;
    await setFields({ telegramDiscussionGroupId: human });
    // Дверь «прочитала» старое значение, а в базе уже правка человека: сравнение-и-замена её не перепишет.
    const real = prisma.settings.findUnique.bind(prisma.settings);
    const spy = vi.spyOn(prisma.settings, "findUnique");
    spy.mockImplementationOnce((async () => ({ telegramDiscussionGroupId: oldId, telegramExtraChatIds: null, telegramChannelId: null })) as never);
    spy.mockImplementation(real as never);

    const outcome = await migrateSettingsTelegramChat(oldId, newId);

    expect(outcome).toEqual({ kind: "done", moved: [] });
    expect((await readFields()).telegramDiscussionGroupId).toBe(human);
  });

  it("три процесса переносят одновременно: ошибки нет, перенос засчитан ровно один раз", async () => {
    const { oldId, newId } = ids();
    await setFields({ telegramDiscussionGroupId: oldId, telegramExtraChatIds: `${oldId},${CHANNEL}` });

    const outcomes = await Promise.all([1, 2, 3].map(() => migrateSettingsTelegramChat(oldId, newId)));

    const moved = outcomes.flatMap((o) => (o.kind === "done" ? o.moved : []));
    expect(moved.filter((f) => f === "telegramDiscussionGroupId")).toHaveLength(1);
    expect(moved.filter((f) => f === "telegramExtraChatIds")).toHaveLength(1);
    expect(await readFields()).toEqual({ telegramDiscussionGroupId: newId, telegramExtraChatIds: `${newId},${CHANNEL}`, telegramChannelId: null });
  });

  it("пара не похожа на переезд обычной группы в супергруппу — ничего не меняется", async () => {
    const { oldId } = ids();
    await setFields({ telegramDiscussionGroupId: oldId });
    for (const [from, to] of [[oldId, oldId], [oldId, "-5551234"], ["12345", `-100${runId}9`], ["@chan_name", `-100${runId}9`]]) {
      expect(await migrateSettingsTelegramChat(from, to)).toEqual({ kind: "invalid" });
    }
    expect((await readFields()).telegramDiscussionGroupId).toBe(oldId);
  });
});

describe("живое служебное сообщение о переезде", () => {
  it("migrate_to_chat_id из группы комментариев переносит адрес и ничего не пишет в чат", async () => {
    const { old, next, oldId, newId } = ids();
    await setFields({ telegramDiscussionGroupId: oldId });

    await handleTelegramUpdate(serviceUpdate({ id: old, type: "group" }, { migrate_to_chat_id: next }));

    expect((await readFields()).telegramDiscussionGroupId).toBe(newId);
    expect(sentAnything()).toBe(0);
  });

  it("migrate_from_chat_id в новой супергруппе переносит адрес чата публикации; повтор безвреден", async () => {
    const { old, next, oldId, newId } = ids();
    await setFields({ telegramExtraChatIds: `${CHANNEL} ${oldId}` });

    await handleTelegramUpdate(serviceUpdate({ id: next, type: "supergroup" }, { migrate_from_chat_id: old }));
    await handleTelegramUpdate(serviceUpdate({ id: old, type: "group" }, { migrate_to_chat_id: next }));

    expect((await readFields()).telegramExtraChatIds).toBe(`${CHANNEL} ${newId}`);
    expect(sentAnything()).toBe(0);
  });

  it("после переезда комментарий из новой супергруппы принимается", async () => {
    const { old, next, oldId, newId } = ids();
    await setFields({ telegramDiscussionGroupId: oldId });
    await handleTelegramUpdate(serviceUpdate({ id: old, type: "group" }, { migrate_to_chat_id: next }));

    const messageId = 4000 + seq;
    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: {
        message_id: messageId, date: Math.floor(Date.now() / 1000),
        chat: { id: next, type: "supergroup" },
        from: { id: 777_000_000 + seq, is_bot: false, first_name: "Покупатель", username: "buyer_test" },
        text: "Сколько стоит?",
        reply_to_message: { message_id: 3000 + seq, chat: { id: next, type: "supergroup" }, is_automatic_forward: true, text: `post-${runId}` },
      },
    } as never);

    const row = await prisma.telegramGroupComment.findFirst({ where: { groupChatId: newId, messageId: String(messageId) } });
    expect(row).not.toBeNull();
    await prisma.telegramGroupComment.deleteMany({ where: { groupChatId: newId } });
  });

  it("чужая группа: адреса в Настройках не меняются", async () => {
    const mine = ids();
    const other = ids();
    await setFields({ telegramDiscussionGroupId: mine.oldId });

    await handleTelegramUpdate(serviceUpdate({ id: other.old, type: "group" }, { migrate_to_chat_id: other.next }));

    expect((await readFields()).telegramDiscussionGroupId).toBe(mine.oldId);
  });
});

describe("почасовой сторож чатов из Настроек", () => {
  it("группа комментариев переехала: бот «left», проба отвечает «стала супергруппой» — адрес заменён", async () => {
    const { oldId, next, newId } = ids();
    await setFields({ telegramDiscussionGroupId: oldId });
    telegramSays({ [oldId]: () => ({ status: "left" }) }, { [oldId]: refuse(migrated("sendChatAction", next)) });

    const result = await sweepSettingsTelegramChats();

    expect(result.migrated).toBe(1);
    expect((await readFields()).telegramDiscussionGroupId).toBe(newId);
    expect(tg.probeChatAction).toHaveBeenCalledWith(oldId);
    expect(sentAnything()).toBe(0);
  });

  it("тем же проходом, что и группы помощницы: sweepAssistantGroups доходит до Настроек", async () => {
    const { oldId, next, newId } = ids();
    await setFields({ telegramExtraChatIds: oldId });
    telegramSays({ [oldId]: refuse(migrated("getChatMember", next)) });

    const result = await sweepAssistantGroups();

    expect(result.settingsChats?.migrated).toBe(1);
    expect((await readFields()).telegramExtraChatIds).toBe(newId);
    expect(tg.probeChatAction).not.toHaveBeenCalled();
  });

  it("бота нет в группе комментариев (супергруппа): проба не шлётся, в журнале одна понятная запись в сутки", async () => {
    const group = `-100${runId}31`;
    await setFields({ telegramDiscussionGroupId: group });
    telegramSays({ [group]: () => ({ status: "kicked" }) });

    const first = await sweepSettingsTelegramChats();
    await sweepSettingsTelegramChats();

    expect(first.botAbsent).toBe(1);
    expect(tg.probeChatAction).not.toHaveBeenCalled();
    const rows = await logRows(`settings-discussion-bot-absent:${group}`);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("telegram");
    expect(rows[0].message).toContain("Бот не состоит в группе комментариев канала «Обсуждение канала»");
    expect(rows[0].message).toContain("комментарии клиентов под постами не принимаются");
    expect((await readFields()).telegramDiscussionGroupId).toBe(group);
    expect(sentAnything()).toBe(0);
  });

  it("каналы и супергруппы в чатах публикации: бот на месте — ни пробы, ни записей; бота нет — тоже без пробы и без второй тревоги", async () => {
    const lost = `-100${runId}32`;
    await setFields({ telegramChannelId: CHANNEL, telegramExtraChatIds: `${lost} @royal_test_chan` });
    telegramSays({ [lost]: () => ({ status: "left" }) });

    const result = await sweepSettingsTelegramChats();

    expect(result.checked).toBe(2);
    expect(result.botAbsent).toBe(1);
    expect(tg.getChatMemberStatus).not.toHaveBeenCalledWith(CHANNEL);
    expect(tg.probeChatAction).not.toHaveBeenCalled();
    expect(await prisma.errorLog.count({ where: { message: { contains: lost }, createdAt: { gte: new Date(Date.now() - 60_000) } } })).toBe(0);
    expect(sentAnything()).toBe(0);
  });

  it("личный чат в чатах публикации не осматривается", async () => {
    await setFields({ telegramExtraChatIds: "123456789" });

    const result = await sweepSettingsTelegramChats();

    expect(result.checked).toBe(0);
    expect(tg.getChatMemberStatus).not.toHaveBeenCalled();
  });

  it("обрыв связи, 429 и 5xx — не ответ про чат: адрес цел, журнал молчит", async () => {
    const { oldId } = ids();
    await setFields({ telegramDiscussionGroupId: oldId });
    for (const failure of [new Error("The operation was aborted due to timeout"), new TelegramApiError(429, "getChatMember", "Too Many Requests: retry after 5"), new TelegramApiError(502, "getChatMember", "Bad Gateway")]) {
      telegramSays({ [oldId]: refuse(failure) });
      const result = await sweepSettingsTelegramChats();
      expect(result.unknown).toBe(1);
      expect(result.botAbsent).toBe(0);
    }
    telegramSays({ [oldId]: () => ({ status: "left" }) }, { [oldId]: refuse(new Error("socket hang up")) });
    expect((await sweepSettingsTelegramChats()).unknown).toBe(1);

    expect((await readFields()).telegramDiscussionGroupId).toBe(oldId);
    expect(await prisma.errorLog.count({ where: { dedupKey: `settings-discussion-bot-absent:${oldId}` } })).toBe(0);
  });

  it("без токена Telegram сторож ничего не делает", async () => {
    const { oldId } = ids();
    await setFields({ telegramDiscussionGroupId: oldId });
    tg.enabled.value = false;

    expect((await sweepSettingsTelegramChats()).checked).toBe(0);
    expect(tg.getChatMemberStatus).not.toHaveBeenCalled();
  });
});

describe("комментарии, пришедшие до переезда", () => {
  const POST = () => `post-${runId}-${seq}`;

  it("адрес уже на новой группе: старый комментарий закрыт без ответа, в журнале понятная запись", async () => {
    const { oldId, newId } = ids();
    await setFields({ telegramDiscussionGroupId: newId });
    const row = await prisma.telegramGroupComment.create({
      data: { messageId: `${runId}1`, groupChatId: oldId, postMessageId: POST(), authorId: "1", text: "👍", replyDueAt: new Date(Date.now() - 1000) },
    });

    await processDueTelegramComments();

    const after = await prisma.telegramGroupComment.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: "SKIPPED", note: "group_changed", groupChatId: oldId });
    expect(tg.sendMessage).not.toHaveBeenCalled();
    const logged = await waitFor(async () => (await logRows("telegram-comments-from-old-group"))[0]);
    expect(logged.message).toContain("закрыты без ответа");
    expect(logged.message).toContain("стала супергруппой");
  });

  it("ответ упал отказом «группа стала супергруппой»: комментарий закрыт, groupChatId НЕ переписан, адрес в Настройках заменён", async () => {
    const { oldId, next, newId } = ids();
    await setFields({ telegramDiscussionGroupId: oldId });
    const row = await prisma.telegramGroupComment.create({
      data: { messageId: `${runId}2`, groupChatId: oldId, postMessageId: POST(), authorId: "2", text: "👍", replyDueAt: new Date(Date.now() - 1000) },
    });
    tg.sendMessage.mockRejectedValue(migrated("sendMessage", next));

    await processDueTelegramComments();

    const after = await prisma.telegramGroupComment.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: "SKIPPED", note: "group_migrated", groupChatId: oldId });
    expect(tg.sendMessage).toHaveBeenCalledTimes(1);
    expect((await readFields()).telegramDiscussionGroupId).toBe(newId);
    const logged = await waitFor(async () => (await logRows("telegram-comments-group-migrated"))[0]);
    expect(logged.message).toContain("стала супергруппой");
    expect(logged.message).toContain("закрыт без ответа");
    expect(logged.message).toContain("заменён на новый автоматически");
  });

  it("удаление спама упало тем же отказом: комментарий закрыт без повторов, не как «не подтверждено»", async () => {
    const { oldId, next } = ids();
    await setFields({ telegramDiscussionGroupId: oldId });
    const row = await prisma.telegramGroupComment.create({
      data: {
        messageId: `${runId}3`, groupChatId: oldId, postMessageId: POST(), authorId: "3",
        text: "купите дёшево крипту, пишите в личку https://spam.example", replyDueAt: new Date(),
      },
    });
    tg.deleteChannelCommentMessage.mockRejectedValue(migrated("deleteMessage", next));

    const outcome = await handleTelegramComment(row as never, oldId);

    expect(outcome).toBe("skipped");
    expect(tg.deleteChannelCommentMessage).toHaveBeenCalledWith(oldId, Number(row.messageId));
    const after = await prisma.telegramGroupComment.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: "SKIPPED", note: "group_migrated", groupChatId: oldId });
    await waitFor(async () => (await logRows("telegram-comments-group-migrated"))[0]);
  });
});

describe("суточная проверка чатов публикации", () => {
  it("обычная группа стала супергруппой: адрес заменён, проверка зелёная, тревоги «бот не может писать» нет", async () => {
    const { oldId, next, newId } = ids();
    await setFields({ telegramChannelId: CHANNEL, telegramExtraChatIds: oldId });
    tg.getChatTitle.mockImplementation(async (chatId: string) => { if (chatId === oldId) throw migrated("getChat", next); return "Канал"; });
    telegramSays({ [oldId]: refuse(migrated("getChatMember", next)) });

    const results = await checkTelegramExtraChatsHealth();

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].detail).toContain("стала супергруппой");
    expect((await readFields()).telegramExtraChatIds).toBe(newId);
    expect(await prisma.errorLog.count({ where: { message: { contains: `Бот не может писать в чат ${oldId}` } } })).toBe(0);
  });

  it("канал без бота: прежний текст отказа, без проб и без переноса", async () => {
    const lost = `-100${runId}41`;
    await setFields({ telegramExtraChatIds: lost });
    tg.getChatTitle.mockResolvedValue("Канал");
    telegramSays({ [lost]: () => ({ status: "kicked" }) });

    const results = await checkTelegramExtraChatsHealth();

    expect(results[0].ok).toBe(false);
    expect(tg.probeChatAction).not.toHaveBeenCalled();
    const logged = await prisma.errorLog.findFirst({ where: { message: { contains: `Бот не может писать в чат ${lost}` } } });
    expect(logged).not.toBeNull();
    await prisma.errorLog.deleteMany({ where: { message: { contains: lost } } });
  });
});
