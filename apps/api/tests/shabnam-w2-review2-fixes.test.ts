import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { handleAssistantCallback, handleAssistantPrivate } from "../src/telegram/assistantBot.js";
import { previousListChatRef, rememberExpensePhoto } from "../src/telegram/assistantExpenseFollowup.js";
import { mergeAssistantDialog, userTurnRecord } from "../src/telegram/assistantDialogState.js";
import { noteSentMessage, resetSentMessageLogForTests } from "../src/telegram/sentMessageLog.js";
import type { TelegramIncomingMessage, TelegramInlineButton } from "../src/telegram/api.js";

/**
 * Повторное ревью волны 2 «Шабнам» (22.11.2026): ключ списка из прошлого сообщения навсегда «уже записан»,
 * запись состояния разговора мимо одной двери, подсказки «удали последнее/всё» не понимались, намерение
 * «внеси расходы» терялось после записанной карточки, одна строка «такси 20» глоталась прошлой карточкой.
 * Модель и отправка в Telegram подменены; запись расходов — настоящая (брокер подтверждений).
 */

const io = vi.hoisted(() => ({
  extract: vi.fn(),
  chunk: vi.fn(),
  download: vi.fn(),
  media: vi.fn(),
  model: vi.fn(),
  del: vi.fn(async (_chatId: string, _id: number) => true),
  html: vi.fn(async (_chatId: string, _html: string, _reply?: number, _buttons?: TelegramInlineButton[][]) => ({ message_id: 901 })),
  editHtml: vi.fn(async (_chatId: string, _id: number, _html: string, _buttons?: TelegramInlineButton[][] | null) => {}),
  text: vi.fn(async (_chatId: string, _text: string, _reply?: number) => ({})),
  ack: vi.fn(async (_id: string, _text?: string) => ({})),
  edit: vi.fn(async (_chatId: string, _id: number, _text: string, _buttons?: TelegramInlineButton[][] | null) => {}),
}));
vi.mock("../src/ai/assistant/expenseReceiptExtraction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/assistant/expenseReceiptExtraction.js")>()),
  extractExpenseReceipt: io.extract,
  extractExpenseTableChunk: io.chunk,
}));
vi.mock("../src/telegram/assistantMedia.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/assistantMedia.js")>()),
  downloadAssistantMedia: io.download,
  handleAssistantMedia: io.media,
}));
vi.mock("../src/ai/assistant/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/assistant/runtime.js")>()),
  loadAssistantSettings: async () => ({ enabled: true, groundedSearchEnabled: false, semanticSearchEnabled: false }),
}));
vi.mock("../src/ai/assistant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/assistant.js")>()),
  isAiAssistantEnabled: async () => true,
  runAssistantDetailed: io.model,
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendHtmlMessage: io.html,
  editHtmlMessage: io.editHtml,
  sendMessage: io.text,
  deletePrivateMessage: io.del,
  answerCallbackQuery: io.ack,
  editMessageText: io.edit,
  setMessageReaction: async () => "sent",
  sendChatAction: async () => {},
}));

const stamp = String(Date.now()).slice(-8);
/** Метка прогона буквами: цифра в названии строки сделала бы его «суммой». */
const tag = stamp.replace(/\d/gu, (d) => "абвгдежзик"[Number(d)]!);
type Writer = { id: string; chat: number };
const writers: Writer[] = [];
let seq = 300;
let oldSettings: { aiAssistantEnabled: boolean } | null = null;

async function makeWriter(base: number, label: string): Promise<Writer> {
  const chat = base + Number(stamp);
  const agent = await prisma.agent.create({ data: { fullName: `Review Two ${label} Fixture`, phone: `+99293${label}${stamp}`, passwordHash: "x",
    role: "ADMIN", telegramChatId: String(chat), telegramUserId: String(chat) } });
  const writer = { id: agent.id, chat };
  writers.push(writer);
  return writer;
}
const textMsg = (w: Writer, text: string): TelegramIncomingMessage =>
  ({ message_id: ++seq, chat: { id: w.chat, type: "private" }, from: { id: w.chat }, text });
const photoMsg = (w: Writer): TelegramIncomingMessage =>
  ({ message_id: ++seq, chat: { id: w.chat, type: "private" }, from: { id: w.chat }, photo: [{ file_id: `r2-photo-${stamp}-${seq}` }] });
const click = (w: Writer, data: string) => handleAssistantCallback({
  id: `r2-${stamp}-${++seq}`, from: { id: w.chat }, message: { chat: { id: w.chat, type: "private" }, message_id: 901 }, data,
});
const button = (prefix: string) =>
  io.html.mock.calls.at(-1)![3]!.flat().find((b) => "callback_data" in b && b.callback_data!.startsWith(prefix))!.callback_data!;
const pendingCards = (w: Writer) => prisma.assistantAction.findMany({ where: { agentId: w.id, tool: "add_expenses", status: "PENDING" }, orderBy: { createdAt: "desc" } });
const recorded = (w: Writer) => prisma.expense.count({ where: { createdById: w.id, deletedAt: null } });
/** История, как после хода модели; `messageId` — номер сообщения последней реплики человека (так пишет saveHistory). */
async function setHistory(w: Writer, messages: { role: "user" | "assistant"; content: string }[], messageId?: number, extra: Record<string, unknown> = {}) {
  const lastUser = messages.slice().reverse().find((m) => m.role === "user");
  const payload = { messages, ...(messageId && lastUser ? { lastUserTurn: userTurnRecord(lastUser.content, messageId) } : {}), ...extra };
  const data = { agentId: w.id, kind: "assistant", payload, expiresAt: new Date(Date.now() + 10 * 60_000) };
  await prisma.telegramDialogState.upsert({ where: { chatId: String(w.chat) }, create: { chatId: String(w.chat), ...data }, update: data });
}
const dialogPayload = async (w: Writer) =>
  (await prisma.telegramDialogState.findUniqueOrThrow({ where: { chatId: String(w.chat) } })).payload as Record<string, unknown>;
const photosInMemory = async (w: Writer) => ((await dialogPayload(w)).expenseMemory as { photos?: unknown[] } | undefined)?.photos?.length ?? 0;
/** Отодвинуть исполненные карточки в прошлое (как будто запись была вчера). */
const ageActions = (w: Writer, ms: number) => prisma.$executeRaw`
  UPDATE "AssistantAction" SET "createdAt" = "createdAt" - (${ms} * interval '1 millisecond') WHERE "agentId" = ${w.id}`;
const otherAction = (w: Writer) => prisma.assistantAction.create({ data: {
  agentId: w.id, channel: "telegram", tool: "create_task", args: {}, argsHash: `r2-${stamp}-${++seq}`, preview: {}, snapshotBefore: {},
  status: "CANCELLED", expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(Date.now() + 2_000),
} });

describe("п.1: ключ списка из прошлого сообщения — номер исходного сообщения, а не текст", () => {
  it("тот же список, присланный заново другим сообщением, записывается; повтор того же сообщения — нет", async () => {
    const w = await makeWriter(9_110_000_000, "71");
    const list = `расходы\nСвет ${tag} 180\nВода ${tag} 40`;
    await setHistory(w, [{ role: "user", content: list }, { role: "assistant", content: "Уточните месяц." }], 5501);
    await handleAssistantPrivate(textMsg(w, "дуруст ворид кун"), w);
    const [card] = await pendingCards(w);
    expect((card!.args as { chatRef?: string }).chatRef).toBe(`tg:${w.chat}:5501`);
    await click(w, button("as:ok:"));
    expect(await recorded(w)).toBe(2);
    // Повтор просьбы про то же сообщение — второй записи нет.
    await handleAssistantPrivate(textMsg(w, "запиши"), w);
    expect(await recorded(w)).toBe(2);
    // «Завтра» тот же текст пришёл НОВЫМ сообщением: это новые расходы, а не «уже записаны» навсегда.
    await ageActions(w, 26 * 60 * 60_000);
    await setHistory(w, [{ role: "user", content: list }, { role: "assistant", content: "Уточните месяц." }], 5777);
    await handleAssistantPrivate(textMsg(w, "дуруст ворид кун"), w);
    const [next] = await pendingCards(w);
    expect((next!.args as { chatRef?: string }).chatRef).toBe(`tg:${w.chat}:5777`);
    await click(w, button("as:ok:"));
    expect(await recorded(w)).toBe(4);
  });

  it("без номера сообщения — отпечаток текста и день по Душанбе: завтра ключ другой", () => {
    const today = new Date("2026-11-22T10:00:00Z");
    const tomorrow = new Date("2026-11-23T10:00:00Z");
    const a = previousListChatRef("77", "Свет 180\nВода 40", undefined, today);
    expect(a).toMatch(/^list:[0-9a-f]{32}:2026-11-22$/u);
    expect(previousListChatRef("77", "Свет 180\nВода 40", undefined, tomorrow)).not.toBe(a);
    // Граница суток — по Душанбе (UTC+5): 20:00 UTC — уже завтра.
    expect(previousListChatRef("77", "Свет 180\nВода 40", undefined, new Date("2026-11-22T20:00:00Z"))).toMatch(/:2026-11-23$/u);
    expect(previousListChatRef("77", "x", 42)).toBe("tg:77:42");
  });
});

describe("п.2: запись состояния разговора — одна дверь, поля не стираются", () => {
  it("«Править → строка» и поправка не стирают запомненные фото и историю", async () => {
    const w = await makeWriter(9_120_000_000, "72");
    await handleAssistantPrivate(textMsg(w, `расходы\nМыло ${tag} 15\nГубка ${tag} 25`), w);
    const [card] = await pendingCards(w);
    io.download.mockResolvedValue(Buffer.from("x"));
    await rememberExpensePhoto(photoMsg(w), w.id);
    await mergeAssistantDialog({ chatId: String(w.chat), agentId: w.id, change: (p) => ({ ...p, messages: [{ role: "user", content: "привет" }] }), expiresAt: () => new Date(Date.now() + 600_000) });
    await click(w, `ax:rw:${card!.bundleId}:0`);
    let payload = await dialogPayload(w);
    expect(payload.expenseFix).toBeTruthy();
    expect(await photosInMemory(w)).toBe(1);
    expect(JSON.stringify(payload.messages)).toContain("привет");
    await handleAssistantPrivate(textMsg(w, `Мыло ${tag} 20`), w);
    payload = await dialogPayload(w);
    expect(payload.expenseFix).toBeUndefined();
    expect(await photosInMemory(w)).toBe(1);
  });

  it("«удали всё»: фото, запомненные во время удаления, не затираются старым состоянием", async () => {
    const w = await makeWriter(9_130_000_000, "73");
    resetSentMessageLogForTests();
    await setHistory(w, [{ role: "user", content: "привет" }, { role: "assistant", content: "Здравствуйте." }]);
    noteSentMessage(w.chat, 6001); noteSentMessage(w.chat, 6002);
    io.del.mockImplementation(async (_chat: string, id: number) => {
      await rememberExpensePhoto({ message_id: 8000 + id, chat: { id: w.chat, type: "private" }, photo: [{ file_id: `r2-del-${stamp}-${id}` }] } as TelegramIncomingMessage, w.id);
      return true;
    });
    await handleAssistantPrivate(textMsg(w, "удали всё, что прислала"), w);
    expect(io.del).toHaveBeenCalledTimes(2);
    expect(await photosInMemory(w)).toBe(2);
    expect((await dialogPayload(w)).sent).toEqual([]);
  });

  // Страховка поведения после переноса на дверь (не доказательство гонки: нажатия в этом пути уже идут по очереди).
  it("два нажатия «Нет» на вопрос про файл — файл снимается один раз, история цела", async () => {
    const w = await makeWriter(9_140_000_000, "74");
    await setHistory(w, [{ role: "user", content: "привет" }], undefined, {
      expenseFile: { messageId: 4242, fileId: `r2-file-${stamp}`, fileSize: 10, kind: "csv", until: Date.now() + 600_000, lang: "ru" },
    });
    await Promise.all([click(w, "ay:n:4242"), click(w, "ay:n:4242")]);
    const cancelled = io.edit.mock.calls.filter((c) => c[2] === "Хорошо, файл не трогаю.");
    expect(cancelled).toHaveLength(1);
    const payload = await dialogPayload(w);
    expect(payload.expenseFile).toBeUndefined();
    expect(JSON.stringify(payload.messages)).toContain("привет");
  });

  it("первая запись в пустой чат: параллельные писатели не затирают друг друга", async () => {
    const w = await makeWriter(9_150_000_000, "75");
    const chatId = String(w.chat);
    await prisma.telegramDialogState.deleteMany({ where: { chatId } });
    await Promise.all(Array.from({ length: 5 }, (_, i) => mergeAssistantDialog({
      chatId, agentId: w.id, change: (p) => ({ ...p, [`field${i}`]: i }), expiresAt: () => new Date(Date.now() + 600_000),
    })));
    const payload = await dialogPayload(w);
    expect(Object.keys(payload).filter((k) => k.startsWith("field")).sort()).toEqual(["field0", "field1", "field2", "field3", "field4"]);
  });
});

describe("п.4: «внеси расходы» после записанной карточки", () => {
  it("карточка — последнее действие: «уже записаны», но намерение запомнено (фото следом — расходы)", async () => {
    const w = await makeWriter(9_160_000_000, "76");
    await handleAssistantPrivate(textMsg(w, `расходы\nСоль ${tag} 12\nПерец ${tag} 18`), w);
    await click(w, button("as:ok:"));
    await prisma.telegramDialogState.deleteMany({ where: { chatId: String(w.chat) } });
    io.html.mockClear();
    await handleAssistantPrivate(textMsg(w, "внеси расходы"), w);
    expect(io.html.mock.calls.at(-1)![1]).toContain("уже записаны");
    const memory = (await dialogPayload(w)).expenseMemory as { intentUntil?: number };
    expect(memory.intentUntil).toBeGreaterThan(Date.now());
  });

  it("после карточки были другие дела — не «уже записаны», а «пришлите список» и намерение", async () => {
    const w = await makeWriter(9_170_000_000, "77");
    await handleAssistantPrivate(textMsg(w, `расходы\nЧай ${tag} 12\nСахар ${tag} 18`), w);
    await click(w, button("as:ok:"));
    await otherAction(w);
    await prisma.telegramDialogState.deleteMany({ where: { chatId: String(w.chat) } });
    io.html.mockClear();
    io.text.mockClear();
    await handleAssistantPrivate(textMsg(w, "вот фото расходов"), w);
    expect(io.html.mock.calls.some((c) => String(c[1]).includes("уже записаны"))).toBe(false);
    expect(String(io.text.mock.calls.at(-1)?.[1])).toContain("Пришлите список");
    const memory = (await dialogPayload(w)).expenseMemory as { intentUntil?: number };
    expect(memory.intentUntil).toBeGreaterThan(Date.now());
  });
});

describe("п.5: одна строка «такси 20» не глотается прошлой карточкой", () => {
  it("новое сообщение «такси 20» после записанной «такси 20 + аренда» — новая карточка", async () => {
    const w = await makeWriter(9_180_000_000, "78");
    await handleAssistantPrivate(textMsg(w, `расходы\nТакси ${tag} 20\nАренда ${tag} 5000`), w);
    await click(w, button("as:ok:"));
    expect(await recorded(w)).toBe(2);
    await setHistory(w, [{ role: "user", content: `расход такси ${tag} 20` }, { role: "assistant", content: "Хорошо." }], 5901);
    io.html.mockClear();
    await handleAssistantPrivate(textMsg(w, "внеси расходы"), w);
    expect(io.html.mock.calls.some((c) => String(c[1]).includes("уже записаны"))).toBe(false);
    const [card] = await pendingCards(w);
    expect((card!.args as { chatRef?: string }).chatRef).toBe(`tg:${w.chat}:5901`);
    await click(w, button("as:ok:"));
    expect(await recorded(w)).toBe(3);
  });

  it("тот же набор строк последней карточкой (старая история без номера) — по-прежнему «уже записаны»", async () => {
    const w = await makeWriter(9_190_000_000, "79");
    const list = `расходы\nКлей ${tag} 30\nЛента ${tag} 10`;
    await handleAssistantPrivate(textMsg(w, list), w);
    await click(w, button("as:ok:"));
    await setHistory(w, [{ role: "user", content: list }, { role: "assistant", content: "Готово." }]);
    io.html.mockClear();
    await handleAssistantPrivate(textMsg(w, "дуруст ворид кун"), w);
    expect(io.html.mock.calls.at(-1)![1]).toContain("уже записаны");
    expect(await pendingCards(w)).toHaveLength(0);
    expect(await recorded(w)).toBe(2);
  });
});

beforeAll(async () => {
  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" }, select: { aiAssistantEnabled: true } });
  oldSettings = current;
  await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantEnabled: true } });
});
beforeEach(() => {
  for (const fn of [io.extract, io.chunk, io.download, io.media, io.model, io.html, io.editHtml, io.text, io.ack, io.edit, io.del]) fn.mockReset();
  io.html.mockImplementation(async () => ({ message_id: 901 }));
  io.text.mockImplementation(async () => ({}));
  io.ack.mockImplementation(async () => ({}));
  io.editHtml.mockImplementation(async () => {});
  io.edit.mockImplementation(async () => {});
  io.del.mockImplementation(async () => true);
  io.model.mockImplementation(async () => ({ ok: true, reply: "ответ модели" }));
  io.media.mockImplementation(async () => ({ text: "не должен вызываться", error: "test" }));
});
afterAll(async () => {
  if (oldSettings) await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantEnabled: oldSettings.aiAssistantEnabled } });
  const ids = writers.map((x) => x.id);
  await prisma.expense.deleteMany({ where: { createdById: { in: ids } } });
  await prisma.assistantAction.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.telegramExpenseDraft.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.telegramDialogState.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
});
