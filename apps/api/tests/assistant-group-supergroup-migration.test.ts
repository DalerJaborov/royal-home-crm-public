import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ГРУППА ПОМОЩНИЦЫ СТАЛА СУПЕРГРУППОЙ (прод 20.11.2026: Шабнам молчала в рабочей группе с 05.11).
 *
 * Telegram выдаёт переехавшей группе НОВЫЙ chat id; регистрация AssistantTelegramGroup стоит на старом, а
 * обработчик для незарегистрированного чата молча выходит. Три слоя, и каждый проверен на настоящей базе:
 *  1. дверь переноса (lib/assistantGroupMigration.ts): UPDATE ключа с сохранением настроек и контекста;
 *  2. живое служебное сообщение migrate_to_chat_id / migrate_from_chat_id (telegram/assistantBot.ts);
 *  3. сторож (lib/assistantGroupWatchdog.ts) для переезда, который уже прошёл мимо нас.
 * Telegram подменён целиком: тест не должен ничего отправлять и ни о чём спрашивать настоящий сервер.
 */

const tg = vi.hoisted(() => ({
  sendMessage: vi.fn(async (..._a: unknown[]) => ({})),
  sendHtmlMessage: vi.fn(async (..._a: unknown[]) => ({})),
  sendMessageWithButtons: vi.fn(async (..._a: unknown[]) => ({ message_id: 501 })),
  sendChatAction: vi.fn(async (..._a: unknown[]) => {}),
  setMessageReaction: vi.fn(async (..._a: unknown[]) => "sent"),
  getChatMemberStatus: vi.fn(),
  probeChatAction: vi.fn(),
  getChatTitle: vi.fn(async (_chatId: string) => "Рабочая группа"),
  enabled: { value: true },
  runner: vi.fn(),
  claimCap: vi.fn(),
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
    getBotUsername: async () => "rh_test_bot",
    isTelegramEnabled: () => tg.enabled.value,
    getChatMemberStatus: tg.getChatMemberStatus,
    probeChatAction: tg.probeChatAction,
    getChatTitle: tg.getChatTitle,
  };
});
vi.mock("../src/ai/assistant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/assistant.js")>()),
  isAiAssistantEnabled: async () => true,
  runAssistantDetailed: tg.runner,
}));
vi.mock("../src/lib/agentAiActionCap.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/agentAiActionCap.js")>()),
  claimAgentAiAction: tg.claimCap,
}));

delete process.env.TELEGRAM_BOT_TOKEN;

const { prisma } = await import("../src/db.js");
const { TelegramApiError } = await import("../src/telegram/api.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");
const { migrateAssistantGroupChat } = await import("../src/lib/assistantGroupMigration.js");
const { sweepAssistantGroups } = await import("../src/lib/assistantGroupWatchdog.js");
const { groupMigrationEvent } = await import("../src/telegram/assistantGroupParticipation.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = String(Date.now()).slice(-8);
const BOT = "rh_test_bot";
const UPGRADED = "Bad Request: group chat was upgraded to a supergroup chat";
let seq = 0;
/** Пара id одного сценария: обычная группа (короткий отрицательный) и супергруппа (префикс -100). */
function ids() {
  seq += 1;
  const old = -(2_000_000_000 + Number(runId) * 10 + seq);
  const next = -Number(`100${runId}${String(seq).padStart(2, "0")}`);
  return { old, next, oldId: String(old), newId: String(next) };
}
const touched = new Set<string>();
const track = (...chatIds: string[]) => chatIds.forEach((id) => touched.add(id));

let directorId = "";
let directorUserId = "";
let nextUpdateId = Number(runId) * 100;

const MUTED = new Date("2026-12-01T10:00:00.000Z");
const PROACTIVE = new Date("2026-11-19T08:30:00.000Z");
const WELCOME = new Date("2026-11-04T09:00:00.000Z");
const CONTEXT_ON = new Date("2026-11-05T07:00:00.000Z");
const CREATED = new Date("2026-11-04T08:00:00.000Z");

/** Группа со ВСЕМИ настройками, которые перенос не вправе потерять, и двумя строками контекста. */
async function registerGroup(chatId: string, withContext = true) {
  track(chatId);
  await prisma.assistantTelegramGroup.create({
    data: {
      chatId, registeredByAgentId: directorId, createdAt: CREATED, proactiveMutedUntil: MUTED,
      lastProactiveReplyAt: PROACTIVE, lastJoinWelcomeAt: WELCOME, contextEnabledAt: CONTEXT_ON, contextIncludeUnlinked: true,
    },
  });
  if (!withContext) return;
  const base = new Date("2026-11-10T10:00:00.000Z");
  for (const messageId of [11, 12]) {
    await prisma.assistantTelegramContext.create({
      data: {
        groupChatId: chatId, messageId, authorAgentId: directorId, occurredAt: base, sourceVersion: base,
        sourceUpdateId: BigInt(messageId), expiresAt: new Date("2099-01-01T00:00:00.000Z"), text: `Цена обновлена ${messageId}`, propertyRefs: [],
      },
    });
  }
}

const groupRow = (chatId: string) => prisma.assistantTelegramGroup.findUnique({ where: { chatId } });
const contextCount = (chatId: string) => prisma.assistantTelegramContext.count({ where: { groupChatId: chatId } });
const sentAnything = () => [tg.sendMessage, tg.sendHtmlMessage, tg.sendMessageWithButtons, tg.sendChatAction, tg.setMessageReaction]
  .reduce((sum, mock) => sum + mock.mock.calls.length, 0);

const serviceUpdate = (chat: { id: number; type: string }, extra: Record<string, unknown>) => ({
  update_id: nextUpdateId++,
  message: { message_id: 100 + nextUpdateId, chat, date: Math.floor(Date.now() / 1000), ...extra },
});

/** Ответы Telegram только по НАШИМ чатам; любая чужая группа в базе получает «бот на месте» и не трогается. */
function telegramSays(member: Record<string, () => unknown>, probe: Record<string, () => unknown> = {}) {
  tg.getChatMemberStatus.mockImplementation(async (chatId: string) => (member[chatId] ? member[chatId]() : { status: "member" }));
  tg.probeChatAction.mockImplementation(async (chatId: string) => { if (probe[chatId]) return probe[chatId](); });
}
const refuse = (error: Error) => () => { throw error; };

beforeAll(async () => {
  directorUserId = String(800_000_000 + Number(runId) % 100_000_000);
  const agent = await prisma.agent.create({
    data: {
      fullName: `Миграция группы ${runId}`, phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`,
      role: "DIRECTOR", passwordHash: "not-a-real-hash", telegramUserId: directorUserId, telegramChatId: directorUserId,
    },
  });
  directorId = agent.id;
});

beforeEach(() => {
  for (const mock of [tg.sendMessage, tg.sendHtmlMessage, tg.sendMessageWithButtons, tg.sendChatAction, tg.setMessageReaction, tg.getChatMemberStatus, tg.probeChatAction, tg.getChatTitle, tg.runner, tg.claimCap]) {
    mock.mockReset();
  }
  tg.sendMessage.mockResolvedValue({});
  tg.sendHtmlMessage.mockResolvedValue({});
  tg.sendMessageWithButtons.mockResolvedValue({ message_id: 501 });
  tg.getChatTitle.mockResolvedValue("Рабочая группа");
  tg.claimCap.mockResolvedValue({ allowed: true, usedToday: 1 });
  tg.enabled.value = true;
});

// Регистрации сценария не доживают до следующего: сторож обходит ВСЕ группы базы.
afterEach(async () => {
  await prisma.assistantTelegramGroup.deleteMany({ where: { chatId: { in: [...touched] } } });
});

afterAll(async () => {
  if (directorId) await deleteAgentsWithTraces([directorId]);
  await prisma.$disconnect();
});

describe("дверь переноса регистрации группы", () => {
  it("переносит строку на новый id, сохраняет все настройки и перевешивает контекст", async () => {
    const { oldId, newId } = ids();
    await registerGroup(oldId);
    track(newId);

    expect(await migrateAssistantGroupChat(oldId, newId)).toBe("moved");

    expect(await groupRow(oldId)).toBeNull();
    const moved = await groupRow(newId);
    expect(moved).not.toBeNull();
    // createdAt — «личность» регистрации (устаревшие кнопки, окна диалога, страницы объектов): менять нельзя.
    expect(moved!.createdAt.toISOString()).toBe(CREATED.toISOString());
    expect(moved!.registeredByAgentId).toBe(directorId);
    expect(moved!.proactiveMutedUntil?.toISOString()).toBe(MUTED.toISOString());
    expect(moved!.lastProactiveReplyAt?.toISOString()).toBe(PROACTIVE.toISOString());
    expect(moved!.lastJoinWelcomeAt?.toISOString()).toBe(WELCOME.toISOString());
    expect(moved!.contextEnabledAt?.toISOString()).toBe(CONTEXT_ON.toISOString());
    expect(moved!.contextIncludeUnlinked).toBe(true);
    expect(await contextCount(newId)).toBe(2);
    expect(await contextCount(oldId)).toBe(0);
  });

  it("повтор и двойная доставка события безвредны", async () => {
    const { oldId, newId } = ids();
    await registerGroup(oldId);
    track(newId);
    expect(await migrateAssistantGroupChat(oldId, newId)).toBe("moved");
    const before = await groupRow(newId);

    expect(await migrateAssistantGroupChat(oldId, newId)).toBe("absent");

    expect(await groupRow(newId)).toEqual(before);
    expect(await contextCount(newId)).toBe(2);
  });

  it("старой регистрации нет — ничего не создаётся", async () => {
    const { oldId, newId } = ids();
    track(newId);
    expect(await migrateAssistantGroupChat(oldId, newId)).toBe("absent");
    expect(await groupRow(newId)).toBeNull();
  });

  it("новая уже есть (помощницу включили заново): новая не тронута, старая и её контекст убраны", async () => {
    const { oldId, newId } = ids();
    await registerGroup(oldId);
    track(newId);
    await prisma.assistantTelegramGroup.create({ data: { chatId: newId, registeredByAgentId: "someone-else", createdAt: new Date("2026-11-19T12:00:00.000Z") } });
    await prisma.assistantTelegramContext.create({
      data: {
        groupChatId: newId, messageId: 99, occurredAt: CREATED, sourceVersion: CREATED, sourceUpdateId: 99n,
        expiresAt: new Date("2099-01-01T00:00:00.000Z"), text: "уже было здесь", propertyRefs: [],
      },
    });
    const kept = await groupRow(newId);

    expect(await migrateAssistantGroupChat(oldId, newId)).toBe("merged");

    expect(await groupRow(oldId)).toBeNull();
    expect(await groupRow(newId)).toEqual(kept);
    expect(await contextCount(oldId)).toBe(0);
    expect(await contextCount(newId)).toBe(1);
  });

  it("три процесса переносят одновременно: ошибки нет, строка ровно одна", async () => {
    const { oldId, newId } = ids();
    await registerGroup(oldId);
    track(newId);

    const outcomes = await Promise.all([migrateAssistantGroupChat(oldId, newId), migrateAssistantGroupChat(oldId, newId), migrateAssistantGroupChat(oldId, newId)]);

    expect(outcomes.filter((outcome) => outcome === "moved")).toHaveLength(1);
    expect(outcomes.every((outcome) => ["moved", "absent", "merged"].includes(outcome))).toBe(true);
    expect(await groupRow(oldId)).toBeNull();
    expect((await groupRow(newId))?.createdAt.toISOString()).toBe(CREATED.toISOString());
    expect(await contextCount(newId)).toBe(2);
  });

  it("гонка с /assistant_on в новой группе не роняет перенос", async () => {
    const { oldId, newId } = ids();
    await registerGroup(oldId);
    track(newId);

    const [outcome] = await Promise.all([
      migrateAssistantGroupChat(oldId, newId),
      prisma.assistantTelegramGroup.createMany({ data: { chatId: newId, registeredByAgentId: directorId }, skipDuplicates: true }),
    ]);

    expect(["moved", "merged"]).toContain(outcome);
    expect(await groupRow(oldId)).toBeNull();
    expect(await prisma.assistantTelegramGroup.count({ where: { chatId: newId } })).toBe(1);
  });

  it("столкновение ключей (P2002) повторяется и видит готовое состояние; чужая ошибка и три отказа подряд пробрасываются", async () => {
    const clash = () => Object.assign(new Error("Unique constraint failed on the fields: (`chatId`)"), { code: "P2002" });
    const first = ids();
    await registerGroup(first.oldId);
    track(first.newId);
    const spy = vi.spyOn(prisma, "$transaction");
    try {
      // Первый заход проиграл гонку: пока он шёл, в новой группе включили помощницу. Повтор сводит две записи в одну.
      spy.mockImplementationOnce(async () => {
        await prisma.assistantTelegramGroup.create({ data: { chatId: first.newId, registeredByAgentId: directorId } });
        throw clash();
      });
      expect(await migrateAssistantGroupChat(first.oldId, first.newId)).toBe("merged");
      expect(spy).toHaveBeenCalledTimes(2);
      expect(await groupRow(first.oldId)).toBeNull();

      const second = ids();
      await registerGroup(second.oldId, false);
      track(second.newId);
      spy.mockClear();
      spy.mockImplementationOnce(async () => { throw clash(); });
      expect(await migrateAssistantGroupChat(second.oldId, second.newId)).toBe("moved");
      expect(spy).toHaveBeenCalledTimes(2);

      const third = ids();
      await registerGroup(third.oldId, false);
      track(third.newId);
      spy.mockReset();
      spy.mockRejectedValueOnce(new Error("connection terminated"));
      await expect(migrateAssistantGroupChat(third.oldId, third.newId)).rejects.toThrow("connection terminated");
      expect(spy).toHaveBeenCalledTimes(1);

      spy.mockReset();
      spy.mockImplementation(async () => { throw clash(); });
      await expect(migrateAssistantGroupChat(third.oldId, third.newId)).rejects.toThrow("Unique constraint");
      expect(spy).toHaveBeenCalledTimes(3);
      expect(await groupRow(third.oldId)).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("пара id не похожа на переезд — ничего не меняется", async () => {
    const { oldId, newId } = ids();
    await registerGroup(oldId);
    track(newId);
    expect(await migrateAssistantGroupChat(oldId, oldId)).toBe("invalid");
    expect(await migrateAssistantGroupChat(oldId, "-12345")).toBe("invalid");
    expect(await migrateAssistantGroupChat("", newId)).toBe("invalid");
    expect(await groupRow(oldId)).not.toBeNull();
    expect(await groupRow(newId)).toBeNull();
  });
});

describe("разбор служебного сообщения о переезде", () => {
  it("migrate_to_chat_id в старой группе и migrate_from_chat_id в новой дают одну и ту же пару", () => {
    expect(groupMigrationEvent(-4_000_000_001, -1_001_234_567_890, undefined)).toEqual({ oldChatId: "-4000000001", newChatId: "-1001234567890" });
    expect(groupMigrationEvent(-1_001_234_567_890, undefined, -4_000_000_001)).toEqual({ oldChatId: "-4000000001", newChatId: "-1001234567890" });
  });

  it.each([
    ["обычное сообщение", -4_000_000_001, undefined, undefined],
    ["новый id без префикса -100", -4_000_000_001, -4_000_000_002, undefined],
    ["положительный id", -4_000_000_001, 1_001_234_567_890, undefined],
    ["дробь", -4_000_000_001, -1_001_234_567_890.5, undefined],
    ["строка вместо числа", -4_000_000_001, "-1001234567890", undefined],
    ["тот же id", -1_001_234_567_890, -1_001_234_567_890, undefined],
    ["слишком большое число", -4_000_000_001, -1e30, undefined],
  ])("не событие: %s", (_name, chatId, to, from) => {
    expect(groupMigrationEvent(chatId, to, from)).toBeNull();
  });
});

describe("живое служебное сообщение о переезде", () => {
  it("migrate_to_chat_id в старой группе переносит регистрацию и ничего не пишет в чат", async () => {
    const { old, next, oldId, newId } = ids();
    await registerGroup(oldId);
    track(newId);

    await handleTelegramUpdate(serviceUpdate({ id: old, type: "group" }, { migrate_to_chat_id: next }));

    expect(await groupRow(oldId)).toBeNull();
    expect((await groupRow(newId))?.createdAt.toISOString()).toBe(CREATED.toISOString());
    expect(await contextCount(newId)).toBe(2);
    expect(sentAnything()).toBe(0);
    expect(tg.runner).not.toHaveBeenCalled();
  });

  it("migrate_from_chat_id в новой супергруппе делает то же самое", async () => {
    const { old, next, oldId, newId } = ids();
    await registerGroup(oldId);
    track(newId);

    await handleTelegramUpdate(serviceUpdate({ id: next, type: "supergroup" }, { migrate_from_chat_id: old }));

    expect(await groupRow(oldId)).toBeNull();
    expect(await groupRow(newId)).not.toBeNull();
    expect(sentAnything()).toBe(0);
  });

  it("оба сообщения вместе и повтор (так Telegram их и присылает) дают одну строку", async () => {
    const { old, next, oldId, newId } = ids();
    await registerGroup(oldId);
    track(newId);

    await Promise.all([
      handleTelegramUpdate(serviceUpdate({ id: old, type: "group" }, { migrate_to_chat_id: next })),
      handleTelegramUpdate(serviceUpdate({ id: next, type: "supergroup" }, { migrate_from_chat_id: old })),
    ]);
    await handleTelegramUpdate(serviceUpdate({ id: next, type: "supergroup" }, { migrate_from_chat_id: old }));

    expect(await groupRow(oldId)).toBeNull();
    expect(await prisma.assistantTelegramGroup.count({ where: { chatId: newId } })).toBe(1);
    expect(await contextCount(newId)).toBe(2);
    expect(sentAnything()).toBe(0);
  });

  it("после переезда Шабнам отвечает в НОВОЙ группе и молчит в старой", async () => {
    const { old, next, oldId, newId } = ids();
    await registerGroup(oldId, false);
    track(newId);
    tg.runner.mockResolvedValue({ ok: true, reply: "Готово, цена 90000." });
    const ask = (chat: number, type: string) => handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: { message_id: 100 + nextUpdateId, chat: { id: chat, type }, from: { id: Number(directorUserId), username: "u" }, text: `@${BOT} цена ОБ-1?` },
    });

    // До починки (регистрация на старом id) обращение в новую группу глохнет молча — ровно то, что было на проде.
    await ask(next, "supergroup");
    expect(tg.runner).not.toHaveBeenCalled();

    await handleTelegramUpdate(serviceUpdate({ id: old, type: "group" }, { migrate_to_chat_id: next }));
    await ask(next, "supergroup");
    expect(tg.runner).toHaveBeenCalledTimes(1);
    const chatsAnswered = [tg.sendMessage, tg.sendHtmlMessage].flatMap((mock) => mock.mock.calls.map((call) => String(call[0])));
    expect(chatsAnswered.length).toBeGreaterThan(0);
    expect(new Set(chatsAnswered)).toEqual(new Set([newId]));

    tg.runner.mockClear();
    await ask(old, "group");
    expect(tg.runner).not.toHaveBeenCalled();
  });

  it("чужая группа без регистрации: перенос ничего не создаёт", async () => {
    const { old, next, newId } = ids();
    track(newId);

    await handleTelegramUpdate(serviceUpdate({ id: old, type: "group" }, { migrate_to_chat_id: next }));

    expect(await groupRow(newId)).toBeNull();
    expect(sentAnything()).toBe(0);
  });

  it("новый id без префикса -100 не принимается", async () => {
    const { old, oldId } = ids();
    await registerGroup(oldId, false);

    await handleTelegramUpdate(serviceUpdate({ id: old, type: "group" }, { migrate_to_chat_id: old - 7 }));

    expect(await groupRow(oldId)).not.toBeNull();
  });
});

describe("сторож подключённых групп", () => {
  it("бот «left», Telegram отвечает «группа стала супергруппой» — регистрация переезжает, в чат ничего не уходит", async () => {
    const { oldId, next, newId } = ids();
    await registerGroup(oldId);
    track(newId);
    telegramSays({ [oldId]: () => ({ status: "left" }) }, { [oldId]: refuse(new TelegramApiError(400, "sendChatAction", UPGRADED, { migrate_to_chat_id: next })) });

    const result = await sweepAssistantGroups();

    expect(result.migrated).toBe(1);
    expect(await groupRow(oldId)).toBeNull();
    expect((await groupRow(newId))?.createdAt.toISOString()).toBe(CREATED.toISOString());
    expect(await contextCount(newId)).toBe(2);
    expect(tg.probeChatAction).toHaveBeenCalledWith(oldId);
    expect(sentAnything()).toBe(0);
  });

  it("параметр переезда принимается от ЛЮБОГО метода: и когда getChatMember сам отказал с ним", async () => {
    const { oldId, next, newId } = ids();
    await registerGroup(oldId, false);
    track(newId);
    telegramSays({ [oldId]: refuse(new TelegramApiError(400, "getChatMember", UPGRADED, { migrate_to_chat_id: next })) });

    await sweepAssistantGroups();

    expect(await groupRow(oldId)).toBeNull();
    expect(await groupRow(newId)).not.toBeNull();
    expect(tg.probeChatAction).not.toHaveBeenCalled();
  });

  it("бот на месте — ничего не меняется, дополнительных вопросов Telegram нет", async () => {
    const { oldId } = ids();
    await registerGroup(oldId);
    telegramSays({ [oldId]: () => ({ status: "administrator" }) });

    await sweepAssistantGroups();

    expect(await groupRow(oldId)).not.toBeNull();
    expect(tg.probeChatAction).not.toHaveBeenCalled();
    expect(sentAnything()).toBe(0);
  });

  it("отказ без параметра переезда не переносит ничего, даже если слова в нём похожие", async () => {
    const { oldId, newId } = ids();
    await registerGroup(oldId, false);
    track(newId);
    const dedupKey = `assistant-group-bot-absent:${oldId}`;
    telegramSays({ [oldId]: () => ({ status: "left" }) }, { [oldId]: refuse(new TelegramApiError(400, "sendChatAction", UPGRADED)) });

    const result = await sweepAssistantGroups();

    expect(result.migrated).toBe(0);
    expect(result.botAbsent).toBe(1);
    expect(await groupRow(oldId)).not.toBeNull();
    expect(await groupRow(newId)).toBeNull();
    await prisma.errorLog.deleteMany({ where: { dedupKey } });
  });

  it("бота в группе правда нет: регистрация цела, в журнале одна понятная запись в сутки", async () => {
    const { oldId } = ids();
    await registerGroup(oldId);
    telegramSays({ [oldId]: () => ({ status: "kicked" }) }, { [oldId]: refuse(new TelegramApiError(403, "sendChatAction", "Forbidden: bot is not a member of the group chat")) });
    const dedupKey = `assistant-group-bot-absent:${oldId}`;

    const first = await sweepAssistantGroups();
    await sweepAssistantGroups();

    expect(first.botAbsent).toBe(1);
    expect(await groupRow(oldId)).not.toBeNull();
    const rows = await prisma.errorLog.findMany({ where: { dedupKey } });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("telegram");
    expect(rows[0].message).toContain("Шабнам не состоит в подключённой группе «Рабочая группа»");
    expect(rows[0].message).toContain("верните бота");
    expect(sentAnything()).toBe(0);
    await prisma.errorLog.deleteMany({ where: { dedupKey } });
  });

  it("обрыв связи, таймаут, 429 и 5xx — не ответ про группу: ничего не меняется, журнал и директор не тревожатся", async () => {
    const { oldId } = ids();
    await registerGroup(oldId);
    const dedupKey = `assistant-group-bot-absent:${oldId}`;
    for (const failure of [new Error("The operation was aborted due to timeout"), new TelegramApiError(429, "getChatMember", "Too Many Requests: retry after 5"), new TelegramApiError(502, "getChatMember", "Bad Gateway")]) {
      telegramSays({ [oldId]: refuse(failure) });

      const result = await sweepAssistantGroups();

      expect(result.unknown).toBe(1);
      expect(result.botAbsent).toBe(0);
    }
    // Тот же обрыв уже ПОСЛЕ «left»: вторая проба тоже не повод считать, что бота нет.
    telegramSays({ [oldId]: () => ({ status: "left" }) }, { [oldId]: refuse(new Error("socket hang up")) });
    expect((await sweepAssistantGroups()).unknown).toBe(1);

    expect(await groupRow(oldId)).not.toBeNull();
    expect(await prisma.errorLog.count({ where: { dedupKey } })).toBe(0);
    expect(tg.getChatTitle).not.toHaveBeenCalled();
  });

  it("отказ одной группы не мешает проверить остальные", async () => {
    const broken = ids();
    const healthy = ids();
    await registerGroup(broken.oldId, false);
    await registerGroup(healthy.oldId, false);
    track(healthy.newId);
    telegramSays(
      { [broken.oldId]: refuse(new Error("socket hang up")), [healthy.oldId]: () => ({ status: "left" }) },
      { [healthy.oldId]: refuse(new TelegramApiError(400, "sendChatAction", UPGRADED, { migrate_to_chat_id: healthy.next })) },
    );

    await sweepAssistantGroups();

    expect(await groupRow(broken.oldId)).not.toBeNull();
    expect(await groupRow(healthy.oldId)).toBeNull();
    expect(await groupRow(healthy.newId)).not.toBeNull();
  });

  it("не может записать перенос в базу — журнал, а не падение", async () => {
    const { oldId, next, newId } = ids();
    await registerGroup(oldId, false);
    track(newId);
    telegramSays({ [oldId]: () => ({ status: "left" }) }, { [oldId]: refuse(new TelegramApiError(400, "sendChatAction", UPGRADED, { migrate_to_chat_id: next })) });
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValue(new Error("connection terminated"));
    try {
      const result = await sweepAssistantGroups();
      expect(result.unknown).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(await groupRow(oldId)).not.toBeNull();
    const dedupKey = `assistant-group-check-failed:${oldId}`;
    const logged = await prisma.errorLog.findFirst({ where: { dedupKey } });
    expect(logged?.message).toContain("проверка подключённой группы не удалась");
    expect(logged?.message).toContain("connection terminated");
    await prisma.errorLog.deleteMany({ where: { dedupKey } });
  });

  it("без токена Telegram сторож ничего не делает", async () => {
    const { oldId } = ids();
    await registerGroup(oldId, false);
    tg.enabled.value = false;

    const result = await sweepAssistantGroups();

    expect(result.checked).toBe(0);
    expect(tg.getChatMemberStatus).not.toHaveBeenCalled();
    expect(await groupRow(oldId)).not.toBeNull();
  });
});
