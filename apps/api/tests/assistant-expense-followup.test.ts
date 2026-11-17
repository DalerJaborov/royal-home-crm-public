import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { prisma } from "../src/db.js";
import { handleAssistantCallback, handleAssistantPrivate } from "../src/telegram/assistantBot.js";
import { expenseFollowupKind, mentionsExpenses } from "../src/ai/assistant/expenseIntent.js";
import { listMonthOf, parseExpenseTextList } from "../src/telegram/assistantExpenseTextList.js";
import { flushExpenseAlbumsForTests, setExpenseAlbumQuietForTests } from "../src/telegram/assistantExpenseAlbum.js";
import { ADD_EXPENSES_TTL_MS } from "../src/ai/assistant/tools/expenseBatchTool.js";
import { todayExpenseDay } from "../src/lib/expenseWorkspace.js";
import type { TelegramIncomingMessage, TelegramInlineButton } from "../src/telegram/api.js";

/**
 * Шабнам: расходы списком и фото — одна карточка, а не «поговорила и не сделала» (17.11.2026, журнал
 * прода 10–11.11: пять просьб внести расходы прошлого месяца — ноль вызовов, две карточки истекли).
 * Фразы в тесте — нейтральные команды, без имён. ИИ-разбор фото и модель подменены: живой Gemini не зовётся.
 */

const io = vi.hoisted(() => ({
  extract: vi.fn(),
  chunk: vi.fn(),
  download: vi.fn(),
  media: vi.fn(),
  model: vi.fn(),
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
  answerCallbackQuery: io.ack,
  editMessageText: io.edit,
  setMessageReaction: async () => "sent",
  sendChatAction: async () => {},
}));

const stamp = String(Date.now()).slice(-8);
/** Метка прогона буквами: цифра в названии строки сделала бы его «суммой», а список — неразобранным. */
const tag = stamp.replace(/\d/gu, (d) => "абвгдежзик"[Number(d)]!);
type Writer = { id: string; fullName: string; chat: number };
const writers: Writer[] = [];
let oldSettings: { aiAssistantEnabled: boolean } | null = null;
let seq = 0;

async function makeWriter(base: number, label: string): Promise<Writer> {
  const chat = base + Number(stamp);
  const agent = await prisma.agent.create({ data: { fullName: `Expense Followup ${label} Fixture`, phone: `+99293${label}${stamp}`, passwordHash: "x",
    role: "ADMIN", telegramChatId: String(chat), telegramUserId: String(chat) } });
  const writer = { id: agent.id, fullName: agent.fullName, chat };
  writers.push(writer);
  return writer;
}

const textMsg = (w: Writer, text: string): TelegramIncomingMessage =>
  ({ message_id: ++seq, chat: { id: w.chat, type: "private" }, from: { id: w.chat }, text });
const photoMsg = (w: Writer, extra: Partial<TelegramIncomingMessage> = {}): TelegramIncomingMessage =>
  ({ message_id: ++seq, chat: { id: w.chat, type: "private" }, from: { id: w.chat }, photo: [{ file_id: `fu-photo-${stamp}-${seq}` }], ...extra });
const click = (w: Writer, data: string, messageId = 901) => handleAssistantCallback({
  id: `exp-fu-${stamp}-${++seq}`, from: { id: w.chat }, message: { chat: { id: w.chat, type: "private" }, message_id: messageId }, data,
});
async function jpeg(seed: number) {
  return sharp({ create: { width: 52 + (seed % 89), height: 44 + (Math.floor(seed / 89) % 53), channels: 3, background: { r: (seed * 3) % 255, g: (seed * 11) % 255, b: (seed * 17) % 255 } } }).jpeg().toBuffer();
}
const lastCard = () => io.html.mock.calls.at(-1)!;
const button = (prefix: string, buttons = lastCard()[3]!) =>
  buttons.flat().find((b) => "callback_data" in b && b.callback_data!.startsWith(prefix))!.callback_data!;
const pending = (w: Writer) => prisma.assistantAction.findFirstOrThrow({ where: { agentId: w.id, tool: "add_expenses", status: "PENDING" }, orderBy: { createdAt: "desc" } });
const itemsOf = (row: { args: unknown }) => (row.args as { items: { title: string; amount: number; month: string; date?: string; currency: string; currencyUnstated?: boolean }[]; lang: string; chatRef?: string });
const recorded = (w: Writer) => prisma.expense.count({ where: { createdById: w.id, deletedAt: null } });
const listKind = { kind: "expense_list", language: "tg", amountMinor: null, currency: null, paymentDate: null, purpose: null, vendor: null };
const otherKind = { ...listKind, kind: "other" };
const tableRows = (rows: readonly (readonly [string, number])[]) => rows.map(([title, amountMinor], i) => ({ n: i + 1, title, amountMinor, currency: null, date: null }));

function previousMonth(today = todayExpenseDay()): string {
  const [y, m] = today.slice(0, 7).split("-").map(Number) as [number, number];
  const index = y * 12 + (m - 1) - 1;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

describe("слова просьбы о расходах (одно место на все входы)", () => {
  it("таджикские и русские формы, в любом месте подписи", () => {
    expect(mentionsExpenses("Салом! Ҳамин хароҷотҳоро дар CRM ворид кун")).toBe(true);
    expect(mentionsExpenses("харҷҳои октябр")).toBe(true);
    expect(mentionsExpenses("вот расходы за прошлый месяц")).toBe(true);
    expect(mentionsExpenses("аксар вақт")).toBe(false);
    expect(mentionsExpenses("покажи объект 193")).toBe(false);
  });

  it("просьба без данных — какая; с цифрами или про другое — не сюда", () => {
    expect(expenseFollowupKind("ҳамин хароҷотҳоро дар CRM ворид кун")).toBe("record");
    expect(expenseFollowupKind("внеси эти расходы")).toBe("record");
    expect(expenseFollowupKind("мана акс")).toBe("photo");
    expect(expenseFollowupKind("вот фото, внеси")).toBe("photo");
    expect(expenseFollowupKind("дуруст ворид кун")).toBe("write");
    expect(expenseFollowupKind("запиши")).toBe("write");
    expect(expenseFollowupKind("повтори карточку")).toBe("card");
    expect(expenseFollowupKind("кортро боз нишон деҳ")).toBe("card");
    expect(expenseFollowupKind("запиши задачу позвонить клиенту")).toBeNull();
    expect(expenseFollowupKind("запиши интернет")).toBeNull();
    expect(expenseFollowupKind("сколько расходов за октябрь")).toBeNull();
    expect(expenseFollowupKind("внеси расход такси 30")).toBeNull();
  });
});

describe("список текстом — разбор кодом, месяц по Душанбе", () => {
  it("«прошлый месяц» / «моҳи гузашта» — месяц перед сегодняшним; месяц без года — последний наступивший", () => {
    expect(listMonthOf("Внеси расходы за прошлый месяц", "2026-11-17")).toBe("2026-10");
    expect(listMonthOf("Хароҷоти моҳи гузашта", "2026-01-05")).toBe("2025-12");
    expect(listMonthOf("за октябрь", "2026-11-17")).toBe("2026-10");
    expect(listMonthOf("моҳи декабр", "2027-01-10")).toBe("2026-12");
    expect(listMonthOf("моҳи октябр 2025", "2026-11-17")).toBe("2025-10");
    expect(listMonthOf("ворид кун", "2026-11-17")).toBeNull();
  });

  it("строки с нумерацией, тире, «сомонӣ», «1 200» и «5 ҳазор»; дата строки сильнее месяца списка", () => {
    const parsed = parseExpenseTextList([
      "Хароҷоти моҳи гузашта, ворид кун:",
      "1. Иҷора — 5 ҳазор",
      "2) Интернет 400 сомонӣ",
      "- Бензин 1 200",
      "Об 40, нон 25",
      "Такси 35 5 октябр",
    ].join("\n"), { today: "2026-11-17" })!;
    expect(parsed.month).toBe("2026-10");
    expect(parsed.rows.map((r) => [r.title, r.amount])).toEqual([
      ["Иҷора", 5000], ["Интернет", 400], ["Бензин", 1200], ["Об", 40], ["нон", 25], ["Такси", 35],
    ]);
    expect(parsed.rows[1]).toMatchObject({ currency: "TJS" });
    expect(parsed.rows[0]).toMatchObject({ currencyUnstated: true, month: "2026-10" });
    expect(parsed.rows[5]).toMatchObject({ date: "2026-10-05" });
  });

  it("строка с цифрами, которая не разобралась, — список целиком модели, а не карточка без неё", () => {
    expect(parseExpenseTextList("расходы\nАренда 5000\n5000", { today: "2026-11-17" })).toBeNull();
    expect(parseExpenseTextList("расходы: аренда 5000", { today: "2026-11-17" })).toBeNull(); // одна строка — модели
    expect(parseExpenseTextList("расходы: аренда 5000", { today: "2026-11-17", minRows: 1 })!.rows).toHaveLength(1);
  });
});

describe("Telegram: список, фото, «вот фото», истёкшая карточка", () => {
  let w1: Writer; let w2: Writer; let w3: Writer;
  beforeAll(async () => {
    w1 = await makeWriter(8_700_000_000, "71");
    w2 = await makeWriter(8_800_000_000, "72");
    w3 = await makeWriter(8_900_000_000, "73");
  });

  it("таджикский список за прошлый месяц — одна карточка со всеми строками, верным месяцем и сроком в час; модель не зовётся", async () => {
    const msg = textMsg(w1, "Хароҷоти моҳи гузашта, ворид кун:\nИҷора 5000\nИнтернет 400 сомонӣ\nБензин 1 200");
    await handleAssistantPrivate(msg, w1);
    expect(io.model).not.toHaveBeenCalled();
    expect(io.html).toHaveBeenCalledOnce();
    expect(lastCard()[1]).toContain("3 харҷ");
    const row = await pending(w1);
    const args = itemsOf(row);
    expect(args.lang).toBe("tg");
    expect(args.items.map((i) => [i.title, i.amount, i.month])).toEqual([
      ["Иҷора", 5000, previousMonth()], ["Интернет", 400, previousMonth()], ["Бензин", 1200, previousMonth()],
    ]);
    expect(args.chatRef).toBe(`tg:${w1.chat}:${msg.message_id}`);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThanOrEqual(ADD_EXPENSES_TTL_MS - 5_000);
    await click(w1, button("as:no:"));
  });

  it("русский список за прошлый месяц — одна карточка, «Записать» пишет все строки один раз", async () => {
    const before = await recorded(w1);
    await handleAssistantPrivate(textMsg(w1, `Внеси расходы за прошлый месяц:\n1. Аренда офиса ${tag} — 5000\n2. Интернет ${tag} 400\n3. Такси ${tag} 35`), w1);
    expect(io.model).not.toHaveBeenCalled();
    expect(lastCard()[1]).toContain("3 расхода");
    const ok = button("as:ok:");
    await Promise.all([click(w1, ok), click(w1, ok)]);
    expect(await recorded(w1)).toBe(before + 3);
    expect(await prisma.expense.count({ where: { createdById: w1.id, note: { contains: tag }, status: "PAID" } })).toBe(3);
  });

  it("истёкшая карточка: «Записать» честно говорит «ничего не записала», «Показать снова» — новая карточка, запись одна", async () => {
    await handleAssistantPrivate(textMsg(w1, `расходы\nСвет ${tag} 180\nВода ${tag} 40`), w1);
    const okOld = button("as:ok:");
    const row = await pending(w1);
    await prisma.assistantAction.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    const before = await recorded(w1);
    await click(w1, okOld);
    expect(await recorded(w1)).toBe(before);
    const expired = io.editHtml.mock.calls.at(-1)!;
    expect(expired[2]).toContain("ничего не записала");
    const again = button("ax:re:", expired[3]!);
    expect(io.ack.mock.calls.at(-1)?.[1]).toContain("ничего не записала");

    io.html.mockClear();
    await click(w1, again);
    expect(io.html).toHaveBeenCalledOnce();
    expect(lastCard()[1]).toContain("2 расхода");
    await click(w1, button("as:ok:"));
    expect(await recorded(w1)).toBe(before + 2);
    // Ещё раз «Показать снова» на старой карточке — «уже записаны», второй записи нет.
    await click(w1, again);
    expect(io.html.mock.calls.at(-1)![1]).toContain("уже записаны");
    expect(await recorded(w1)).toBe(before + 2);
  });

  it("«повтори карточку» после истечения — та же пачка новой карточкой (сутки)", async () => {
    await handleAssistantPrivate(textMsg(w1, `расходы\nКартридж ${tag} 220\nБумага ${tag} 90`), w1);
    const row = await pending(w1);
    await prisma.assistantAction.update({ where: { id: row.id }, data: { status: "EXPIRED", expiresAt: new Date(Date.now() - 1_000) } });
    io.html.mockClear();
    await handleAssistantPrivate(textMsg(w1, "повтори карточку"), w1);
    expect(io.model).not.toHaveBeenCalled();
    expect(io.html).toHaveBeenCalledOnce();
    const fresh = await pending(w1);
    expect(fresh.id).not.toBe(row.id);
    expect(itemsOf(fresh).items.map((i) => i.amount)).toEqual([220, 90]);
    await click(w1, button("as:no:"));
  });

  it("фото + таджикская подпись — разбор как расходы (не пересказ), месяц подписи у строк без месяца", async () => {
    io.download.mockResolvedValue(await jpeg(Number(stamp.slice(-4)) + 11));
    io.extract.mockResolvedValue(listKind);
    io.chunk.mockResolvedValue({ language: "tg", month: null, rows: tableRows([["Иҷора", 500000], ["Интернет", 40000]]), hasMore: false });
    await handleAssistantPrivate(photoMsg(w2, { caption: "Салом, ҳамин хароҷотҳоро дар CRM ворид кун, моҳи гузашта" }), w2);
    expect(io.media).not.toHaveBeenCalled();
    expect(io.model).not.toHaveBeenCalled();
    expect(io.extract).toHaveBeenCalledOnce();
    const args = itemsOf(await pending(w2));
    expect(args.items.map((i) => [i.title, i.amount, i.month])).toEqual([["Иҷора", 5000, previousMonth()], ["Интернет", 400, previousMonth()]]);
    await click(w2, button("as:no:"));
  });

  it("фото без слов, потом «мана акс, ворид кун» — одна карточка из запомненного фото", async () => {
    io.download.mockResolvedValue(await jpeg(Number(stamp.slice(-4)) + 23));
    // Одиночное фото без подписи: разбор не узнал расходы — 👀, фото запомнено.
    io.extract.mockResolvedValueOnce(otherKind).mockResolvedValue(listKind);
    io.chunk.mockResolvedValue({ language: "tg", month: null, rows: tableRows([["Об", 4000], ["Нон", 2500], ["Такси", 3500]]), hasMore: false });
    setExpenseAlbumQuietForTests(300);
    await handleAssistantPrivate(photoMsg(w2), w2);
    expect(io.html).not.toHaveBeenCalled();
    await handleAssistantPrivate(textMsg(w2, "мана акс, ворид кун"), w2);
    await flushExpenseAlbumsForTests();
    expect(io.model).not.toHaveBeenCalled();
    expect(io.html).toHaveBeenCalledOnce();
    expect(itemsOf(await pending(w2)).items.map((i) => i.amount)).toEqual([40, 25, 35]);
    await click(w2, button("as:no:"));
    setExpenseAlbumQuietForTests(null);
  });

  it("«внеси расходы» без данных — одна фраза, чего не хватает; следующий альбом без подписи — расходы одной карточкой", async () => {
    await handleAssistantPrivate(textMsg(w3, "ҳамин хароҷотҳоро дар CRM ворид кун"), w3);
    expect(io.model).not.toHaveBeenCalled();
    expect(io.html).not.toHaveBeenCalled();
    expect(String(io.text.mock.calls.at(-1)?.[1])).toContain("«харҷ — маблағ»");

    const a = await jpeg(Number(stamp.slice(-4)) + 37);
    const b = await jpeg(Number(stamp.slice(-4)) + 41);
    io.download.mockImplementation(async (fileId: string) => (fileId.endsWith("-a") ? a : b));
    io.extract.mockResolvedValue(listKind);
    io.chunk.mockResolvedValue({ language: "tg", month: null, rows: tableRows([["Свет", 18000]]), hasMore: false });
    setExpenseAlbumQuietForTests(300);
    const group = `fu-album-${stamp}`;
    await handleAssistantPrivate(photoMsg(w3, { media_group_id: group, photo: [{ file_id: `fu-${stamp}-a` }] }), w3);
    await handleAssistantPrivate(photoMsg(w3, { media_group_id: group, photo: [{ file_id: `fu-${stamp}-b` }] }), w3);
    await flushExpenseAlbumsForTests();
    expect(io.html).toHaveBeenCalledOnce();
    expect(itemsOf(await pending(w3)).items).toHaveLength(2);
    await click(w3, button("as:no:"));
    setExpenseAlbumQuietForTests(null);
  });

  it("фото с подписью вне шаблона — ядро получает подпись и текст фото цитатой-данными (не пересказ без истории)", async () => {
    io.media.mockResolvedValueOnce({ text: "Извлечено из файла; данные требуют проверки:\n\nИҷора 5000\nИнтернет 400",
      extraction: { transcript: "", readableText: "Иҷора 5000\nИнтернет 400", visualDescription: "", incomplete: false } });
    await handleAssistantPrivate(photoMsg(w2, { caption: "инро дуруст кун" }), w2);
    expect(io.media).toHaveBeenCalledOnce();
    expect(io.model).toHaveBeenCalledOnce();
    const history = io.model.mock.calls[0]![0] as { role: string; content: string }[];
    expect(history.at(-1)!.content).toMatch(/^инро дуруст кун\n<client_content kind="document">[\s\S]*Иҷора 5000[\s\S]*<\/client_content>/u);
    // Ход с цитатой лёг в историю: следующее «ворид кун» модель видит вместе со строками.
    const state = await prisma.telegramDialogState.findUniqueOrThrow({ where: { chatId: String(w2.chat) } });
    expect(JSON.stringify(state.payload)).toContain("Иҷора 5000");
  });

  it("«повтори карточку», когда карточек нет, — одна фраза, а не разговор ни о чём", async () => {
    await prisma.assistantAction.deleteMany({ where: { agentId: w3.id } });
    await prisma.telegramDialogState.deleteMany({ where: { chatId: String(w3.chat) } });
    await handleAssistantPrivate(textMsg(w3, "повтори карточку"), w3);
    expect(io.model).not.toHaveBeenCalled();
    expect(String(io.text.mock.calls.at(-1)?.[1])).toContain("Карточки расходов за последние сутки нет");
  });
});

beforeAll(async () => {
  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" }, select: { aiAssistantEnabled: true } });
  oldSettings = current;
  await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantEnabled: true } });
});
beforeEach(() => {
  for (const fn of [io.extract, io.chunk, io.download, io.media, io.model, io.html, io.editHtml, io.text, io.ack, io.edit]) fn.mockReset();
  io.html.mockImplementation(async () => ({ message_id: 901 }));
  io.text.mockImplementation(async () => ({}));
  io.ack.mockImplementation(async () => ({}));
  io.editHtml.mockImplementation(async () => {});
  io.edit.mockImplementation(async () => {});
  io.model.mockImplementation(async () => ({ ok: true, reply: "модель не должна была понадобиться" }));
  io.media.mockImplementation(async () => ({ text: "не должен вызываться", error: "test" }));
});
afterAll(async () => {
  if (oldSettings) await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantEnabled: oldSettings.aiAssistantEnabled } });
  const ids = writers.map((w) => w.id);
  await prisma.expense.deleteMany({ where: { createdById: { in: ids } } });
  await prisma.assistantAction.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.telegramExpenseDraft.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.telegramDialogState.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
});
