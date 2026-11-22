import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { handleAssistantCallback, handleAssistantPrivate } from "../src/telegram/assistantBot.js";
import { rememberExpensePhoto } from "../src/telegram/assistantExpenseFollowup.js";
import { noteSentMessage, resetSentMessageLogForTests } from "../src/telegram/sentMessageLog.js";
import type { TelegramIncomingMessage, TelegramInlineButton } from "../src/telegram/api.js";

/**
 * Ревью волны 2 «Шабнам» (22.11.2026): дубль расходов после «Записано», стирание чата без вопроса,
 * перехват чужих просьб расходами, потеря запомненных фото при сохранении истории.
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
let seq = 100;
let oldSettings: { aiAssistantEnabled: boolean } | null = null;

async function makeWriter(base: number, label: string): Promise<Writer> {
  const chat = base + Number(stamp);
  const agent = await prisma.agent.create({ data: { fullName: `Review Fixes ${label} Fixture`, phone: `+99294${label}${stamp}`, passwordHash: "x",
    role: "ADMIN", telegramChatId: String(chat), telegramUserId: String(chat) } });
  const writer = { id: agent.id, chat };
  writers.push(writer);
  return writer;
}
const textMsg = (w: Writer, text: string): TelegramIncomingMessage =>
  ({ message_id: ++seq, chat: { id: w.chat, type: "private" }, from: { id: w.chat }, text });
const photoMsg = (w: Writer): TelegramIncomingMessage =>
  ({ message_id: ++seq, chat: { id: w.chat, type: "private" }, from: { id: w.chat }, photo: [{ file_id: `rf-photo-${stamp}-${seq}` }] });
const click = (w: Writer, data: string) => handleAssistantCallback({
  id: `rf-${stamp}-${++seq}`, from: { id: w.chat }, message: { chat: { id: w.chat, type: "private" }, message_id: 901 }, data,
});
const lastCard = () => io.html.mock.calls.at(-1)!;
const button = (prefix: string) =>
  lastCard()[3]!.flat().find((b) => "callback_data" in b && b.callback_data!.startsWith(prefix))!.callback_data!;
const pendingCards = (w: Writer) => prisma.assistantAction.findMany({ where: { agentId: w.id, tool: "add_expenses", status: "PENDING" }, orderBy: { createdAt: "desc" } });
const recorded = (w: Writer) => prisma.expense.count({ where: { createdById: w.id, deletedAt: null } });
/** История разговора, как после хода модели: именно из неё берётся «список в прошлом сообщении». */
async function setHistory(w: Writer, messages: { role: "user" | "assistant"; content: string }[]) {
  const data = { agentId: w.id, kind: "assistant", payload: { messages }, expiresAt: new Date(Date.now() + 10 * 60_000) };
  await prisma.telegramDialogState.upsert({ where: { chatId: String(w.chat) }, create: { chatId: String(w.chat), ...data }, update: data });
}
const dialogPayload = async (w: Writer) =>
  (await prisma.telegramDialogState.findUniqueOrThrow({ where: { chatId: String(w.chat) } })).payload as Record<string, unknown>;
/** Сообщений с кнопками (карточек) — ответ модели идёт без кнопок. */
const withCard = () => io.html.mock.calls.filter((c) => Array.isArray(c[3]) && c[3].length > 0).length;
const otherKind = { kind: "other", language: "ru", amountMinor: null, currency: null, paymentDate: null, purpose: null, vendor: null };

describe("блокер: после «Записано» «дуруст ворид кун» не собирает карточку второй раз", () => {
  let w: Writer;
  beforeAll(async () => { w = await makeWriter(9_100_000_000, "81"); });

  it("исполненный список: повторная просьба — «уже записаны», новой карточки и новых записей нет", async () => {
    const list = `Внеси расходы за прошлый месяц:\nАренда ${tag} 5000\nИнтернет ${tag} 400\nТакси ${tag} 35`;
    await handleAssistantPrivate(textMsg(w, list), w);
    await click(w, button("as:ok:"));
    const before = await recorded(w);
    expect(before).toBe(3);
    // Ход модели положил список в историю (код-путь историю не пишет) — как в журнале прода.
    await setHistory(w, [{ role: "user", content: list }, { role: "assistant", content: "Готово, карточка выше." }]);
    io.html.mockClear();
    await handleAssistantPrivate(textMsg(w, "дуруст ворид кун"), w);
    expect(await pendingCards(w)).toHaveLength(0);
    expect(await recorded(w)).toBe(before);
    expect(io.html.mock.calls.at(-1)![1]).toContain("уже записаны");
    // И без истории: «внеси эти расходы» сразу после записи — тоже «уже записаны», а не «пришлите список».
    await prisma.telegramDialogState.deleteMany({ where: { chatId: String(w.chat) } });
    io.html.mockClear();
    await handleAssistantPrivate(textMsg(w, "внеси эти расходы"), w);
    expect(await pendingCards(w)).toHaveLength(0);
    expect(io.html.mock.calls.at(-1)![1]).toContain("уже записаны");
  });

  it("список из прошлого сообщения (старая история без номера): ключ — отпечаток и день, второе «запиши» упирается в уже записанное", async () => {
    const w2 = await makeWriter(9_200_000_000, "82");
    const list = `расходы\nСвет ${tag} 180\nВода ${tag} 40`;
    await setHistory(w2, [{ role: "user", content: list }, { role: "assistant", content: "Уточните месяц." }]);
    await handleAssistantPrivate(textMsg(w2, "дуруст ворид кун"), w2);
    const [card] = await pendingCards(w2);
    expect(card).toBeTruthy();
    // Ключ не зависит от номера нынешнего сообщения; номера исходного в истории нет — отпечаток + день по Душанбе.
    expect((card!.args as { chatRef?: string }).chatRef).toMatch(/^list:[0-9a-f]{32}:\d{4}-\d{2}-\d{2}$/u);
    await click(w2, button("as:ok:"));
    expect(await recorded(w2)).toBe(2);
    await handleAssistantPrivate(textMsg(w2, "запиши"), w2);
    expect(await pendingCards(w2)).toHaveLength(0);
    expect(await recorded(w2)).toBe(2);
  });
});

describe("перехват чужих просьб расходами", () => {
  it("«вот фото» без слова расхода и без глагола записи уходит модели, запомненные фото не трогаются", async () => {
    const w = await makeWriter(9_300_000_000, "83");
    io.download.mockResolvedValue(Buffer.from("x"));
    io.extract.mockResolvedValue(otherKind);
    await handleAssistantPrivate(photoMsg(w), w);
    const extractCalls = io.extract.mock.calls.length;
    await handleAssistantPrivate(textMsg(w, "вот фото"), w);
    expect(io.model).toHaveBeenCalledOnce();
    expect(io.extract.mock.calls.length).toBe(extractCalls);
    expect(withCard()).toBe(0);
  });

  it("«запиши» после «объект 123 цена 5000» — это не список расходов: модель, карточки нет", async () => {
    const w = await makeWriter(9_400_000_000, "84");
    await setHistory(w, [{ role: "user", content: "объект 123 цена 5000" }, { role: "assistant", content: "Нашла." }]);
    await handleAssistantPrivate(textMsg(w, "запиши"), w);
    expect(io.model).toHaveBeenCalledOnce();
    expect(await pendingCards(w)).toHaveLength(0);
    expect(withCard()).toBe(0);
  });

  it("«да, запиши» возвращает карточку, только если она последнее действие и свежая; иначе — модели", async () => {
    const w = await makeWriter(9_500_000_000, "85");
    await handleAssistantPrivate(textMsg(w, `расходы\nМыло ${tag} 15\nГубка ${tag} 25`), w);
    expect(await pendingCards(w)).toHaveLength(1);
    io.html.mockClear();
    // Карточка последняя — показываем её снова, модель не зовём.
    await handleAssistantPrivate(textMsg(w, "запиши"), w);
    expect(io.model).not.toHaveBeenCalled();
    expect(io.html).toHaveBeenCalledOnce();
    // После неё было другое дело помощницы — «запиши» уже не про карточку.
    await prisma.assistantAction.create({ data: {
      agentId: w.id, channel: "telegram", tool: "create_task", args: {}, argsHash: `rf-${stamp}`, preview: {}, snapshotBefore: {},
      status: "CANCELLED", expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(Date.now() + 2_000),
    } });
    io.html.mockClear();
    await handleAssistantPrivate(textMsg(w, "запиши"), w);
    expect(io.model).toHaveBeenCalledOnce();
    expect(withCard()).toBe(0);
  });
});

describe("чат не стирается без вопроса", () => {
  let w: Writer;
  beforeAll(async () => { w = await makeWriter(9_600_000_000, "86"); resetSentMessageLogForTests(); });

  it("«убери голосовые ответы» и «удали сообщение для Нозы» — вопрос словами, ничего не удалено", async () => {
    noteSentMessage(w.chat, 5001); noteSentMessage(w.chat, 5002);
    for (const phrase of ["убери голосовые ответы", "удали сообщение для Нозы"]) {
      io.text.mockClear();
      await handleAssistantPrivate(textMsg(w, phrase), w);
      expect(io.del).not.toHaveBeenCalled();
      expect(io.model).not.toHaveBeenCalled();
      expect(String(io.text.mock.calls.at(-1)?.[1])).toContain("Что убрать?");
    }
  });

  it("«удали последнее» стирает только последнее, явное «удали всё, что прислала» — остальное", async () => {
    await handleAssistantPrivate(textMsg(w, "удали последнее сообщение"), w);
    expect(io.del.mock.calls.map((c) => c[1])).toEqual([5002]);
    io.del.mockClear();
    await handleAssistantPrivate(textMsg(w, "удали всё, что прислала"), w);
    expect(io.del.mock.calls.map((c) => c[1])).toEqual([5001]);
  });
});

describe("сохранение истории не стирает запомненные фото", () => {
  it("ход модели после фото без слов: expenseMemory в состоянии цел, история записана", async () => {
    const w = await makeWriter(9_700_000_000, "87");
    io.download.mockResolvedValue(Buffer.from("x"));
    io.extract.mockResolvedValue(otherKind);
    await handleAssistantPrivate(photoMsg(w), w);
    expect(((await dialogPayload(w)).expenseMemory as { photos: unknown[] }).photos).toHaveLength(1);
    await handleAssistantPrivate(textMsg(w, "привет, как дела"), w);
    expect(io.model).toHaveBeenCalledOnce();
    const payload = await dialogPayload(w);
    expect((payload.expenseMemory as { photos: unknown[] }).photos).toHaveLength(1);
    expect(JSON.stringify(payload.messages)).toContain("привет, как дела");
  });

  it("фото, пришедшие во время хода модели, не затираются сохранением истории", async () => {
    const w = await makeWriter(9_800_000_000, "88");
    await setHistory(w, [{ role: "user", content: "привет" }, { role: "assistant", content: "Здравствуйте." }]);
    const photos = Array.from({ length: 6 }, (_, i) =>
      ({ message_id: 7000 + i, chat: { id: w.chat, type: "private" }, photo: [{ file_id: `rf-par-${stamp}-${i}` }] }) as TelegramIncomingMessage);
    io.model.mockImplementation(async () => {
      await Promise.all(photos.map((p) => rememberExpensePhoto(p, w.id)));
      return { ok: true, reply: "ответ после фото" };
    });
    await handleAssistantPrivate(textMsg(w, "посмотри один вопрос"), w);
    const payload = await dialogPayload(w);
    expect((payload.expenseMemory as { photos: unknown[] }).photos).toHaveLength(6);
    expect(JSON.stringify(payload.messages)).toContain("ответ после фото");
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
