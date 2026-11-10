import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { crc32, deflateRawSync } from "node:zlib";
import { prisma } from "../src/db.js";
import { resolvePermissions } from "@royal-home/shared";
import { createPendingAssistantAction } from "../src/lib/assistantActions.js";
import { ADD_EXPENSES_TOOL as BOT_BATCH_TOOL, handleAssistantCallback, handleAssistantPrivate, assistantActorFor, groupHiddenToolsForTests } from "../src/telegram/assistantBot.js";
import { ADD_EXPENSES_TOOL } from "../src/ai/assistant/tools/expenseBatchTool.js";
import { EXPENSE_TOOL_NAMES } from "../src/ai/assistant/tools/expenseTools.js";
import { pluginDeclarations } from "../src/ai/assistant.js";
import { applyRowCorrection } from "../src/telegram/assistantExpenseCard.js";
import { expenseRowsFromTable } from "../src/lib/expenseTableRows.js";
import { readXlsxFirstSheet } from "../src/lib/xlsxRead.js";
import { todayExpenseDay } from "../src/lib/expenseWorkspace.js";
import type { TelegramIncomingMessage, TelegramInlineButton } from "../src/telegram/api.js";

/**
 * Шабнам и расходы пачкой (10.11.2026, жалоба владельца: фото таблицы «ОКТЯБРЬ 2026» из
 * 12 строк — «вносите сами»). ИИ-разбор подменён: живой ключ Gemini не используется.
 */

const io = vi.hoisted(() => ({
  extract: vi.fn(),
  chunk: vi.fn(),
  download: vi.fn(),
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
}));
vi.mock("../src/ai/assistant/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/assistant/runtime.js")>()),
  loadAssistantSettings: async () => ({ enabled: true, groundedSearchEnabled: false, semanticSearchEnabled: false }),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendHtmlMessage: io.html,
  editHtmlMessage: io.editHtml,
  sendMessage: io.text,
  answerCallbackQuery: io.ack,
  editMessageText: io.edit,
  setMessageReaction: async () => "sent",
}));

const stamp = String(Date.now()).slice(-8);
const chatId = 8_600_000_000 + Number(stamp);
const noRightsChat = chatId + 7;
let writer: { id: string; fullName: string };
let viewer: { id: string; fullName: string };
let oldEnabled = false;
let seq = 0;

const OCTOBER = [
  ["Аренда офиса", 500000], ["Интернет Babilon", 40000], ["Бензин", 12200], ["Такси", 3500], ["Свет", 18000], ["Уборка", 25000],
  ["Канцтовары", 9000], ["Вода", 4000], ["Обед команде", 15000], ["Ремонт двери", 30000], ["Реклама Instagram", 100000], ["Картридж", 22000],
] as const;

function photoMsg(chat = chatId, extra: Partial<TelegramIncomingMessage> = {}): TelegramIncomingMessage {
  return { message_id: ++seq, chat: { id: chat, type: "private" }, from: { id: chat }, photo: [{ file_id: `table-photo-${seq}` }], ...extra };
}
function docMsg(fileName: string, caption?: string, chat = chatId): TelegramIncomingMessage {
  return { message_id: ++seq, chat: { id: chat, type: "private" }, from: { id: chat }, document: { file_id: `doc-${seq}`, file_name: fileName }, ...(caption ? { caption } : {}) };
}
const click = (data: string, messageId = 901) => handleAssistantCallback({
  id: `exp-batch-${stamp}-${++seq}`, from: { id: chatId }, message: { chat: { id: chatId, type: "private" }, message_id: messageId }, data,
});
async function jpeg(seed: number) {
  return sharp({ create: { width: 48, height: 40, channels: 3, background: { r: seed % 255, g: (seed * 7) % 255, b: (seed * 13) % 255 } } }).jpeg().toBuffer();
}
const lastCard = () => io.html.mock.calls.at(-1)!;
const cardButtons = () => lastCard()[3]!.flat();
const button = (prefix: string) => cardButtons().find((b) => "callback_data" in b && b.callback_data!.startsWith(prefix))!.callback_data!;
const mine = () => prisma.expense.count({ where: { createdById: writer.id, deletedAt: null } });

/** Минимальный .xlsx: книга, связи, общие строки и один лист (как сохраняет Excel). */
function xlsx(rows: (string | number)[][]): Buffer {
  const strings: string[] = [];
  const sid = (s: string) => { const i = strings.indexOf(s); return i >= 0 ? i : strings.push(s) - 1; };
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheetRows = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => typeof v === "number"
    ? `<c r="${col(c)}${r + 1}"><v>${v}</v></c>` : `<c r="${col(c)}${r + 1}" t="s"><v>${sid(v)}</v></c>`).join("")}</row>`).join("");
  const files: [string, string][] = [
    ["xl/workbook.xml", `<workbook xmlns:r="r"><sheets><sheet name="Октябрь" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/sharedStrings.xml", `<sst>${strings.map((s) => `<si><t>${s.replace(/&/g, "&amp;")}</t></si>`).join("")}</sst>`],
    ["xl/worksheets/sheet1.xml", `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`],
  ];
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, "utf8");
    const packed = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(8, 10);
    head.writeUInt32LE(crc32(data), 16); head.writeUInt32LE(packed.length, 20); head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBuf.length, 28); head.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    central.push(head, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

function bigSheet(count: number, prefix: string) {
  return [["ОКТЯБРЬ 2026"], ["№", "Название", "Сумма", "Дата"],
    ...Array.from({ length: count }, (_, i) => [i + 1, `${prefix} ${i + 1}`, 100 + i, `${String((i % 28) + 1).padStart(2, "0")}.10.2026`]),
    ["", "Итого", 999999, ""]];
}

describe("Шабнам: расходы пачкой из фото таблицы", () => {
  it("12 строк на фото — одна карточка по статьям, порции склеены без дублей, двойное «Записать» пишет 12", async () => {
    io.download.mockResolvedValue(await jpeg(1));
    io.extract.mockResolvedValue({ kind: "expense_list", language: "ru", amountMinor: null, currency: null, paymentDate: null, purpose: null, vendor: null });
    // Порция 1: строки 1–8; порция 2 начинается с 7 (стык повторяет 7–8) и заканчивается 12.
    io.chunk.mockImplementation(async (_image: Buffer, _wallet: unknown, fromRow: number) => {
      const rows = OCTOBER.map(([title, amountMinor], i) => ({ n: i + 1, title, amountMinor, currency: null, date: null }));
      return fromRow === 1
        ? { language: "ru", month: "2026-10", rows: rows.slice(0, 8), hasMore: true }
        : { language: "ru", month: "2026-10", rows: rows.slice(6), hasMore: false };
    });
    const before = await mine();
    await handleAssistantPrivate(photoMsg(), writer);
    expect(io.chunk).toHaveBeenCalledTimes(2);
    expect(io.chunk.mock.calls[1]![2]).toBe(9);
    expect(io.html).toHaveBeenCalledOnce();
    const html = lastCard()[1];
    expect(html).toContain("🧾 <b>Октябрь · 12 расходов</b>");
    expect(html).toContain("🏢 Аренда");
    expect(html).toContain("⛽ Бензин");
    expect(html).toContain("3. Бензин — 122\n");
    expect(html).toContain("💰 <b>Итого: 7 787 с.</b>");
    expect(cardButtons().map((b) => b.text)).toEqual(["✅ Записать", "✏️ Править", "✖️ Отмена"]);
    expect(await mine()).toBe(before);

    const ok = button("as:ok:");
    await Promise.all([click(ok), click(ok)]);
    expect(await mine()).toBe(before + 12);
    expect(io.edit.mock.calls.map((c) => c[2])).toContain("✅ Записала 12 расходов на 7 787 с.");
    const audit = await prisma.auditLog.count({ where: { agentId: writer.id, action: "EXPENSE_CREATE" } });
    expect(audit).toBeGreaterThanOrEqual(12);

    // То же фото ещё раз: без платного разбора, без второй записи.
    io.chunk.mockClear(); io.extract.mockClear();
    await handleAssistantPrivate(photoMsg(), writer);
    expect(io.extract).not.toHaveBeenCalled();
    expect(io.text.mock.calls.at(-1)?.[1]).toContain("уже записаны");
    expect(await mine()).toBe(before + 12);
  });
});

describe("Шабнам: расходы из Excel и CSV без ИИ", () => {
  it("Excel на 120 строк — страницы, одни кнопки, итог ровно по строкам, «Итого» не строка", async () => {
    const file = xlsx(bigSheet(120, "Закупка"));
    expect(readXlsxFirstSheet(file)).toHaveLength(123);
    io.download.mockResolvedValue(file);
    const before = await mine();
    await handleAssistantPrivate(docMsg("октябрь.xlsx"), writer);
    expect(io.extract).not.toHaveBeenCalled();
    const card = lastCard();
    expect(card[1].length).toBeLessThanOrEqual(4096);
    expect(card[1]).toContain("120 расходов");
    expect(card[1]).toContain("<blockquote expandable>");
    const pager = cardButtons().find((b) => /^1\/\d+$/u.test(b.text));
    expect(pager).toBeTruthy();
    // Листаем: та же связка, другая страница.
    await click(button("ax:pg:").replace(/:0$/u, ":1"));
    expect(io.editHtml.mock.calls.at(-1)?.[2]).toContain("120 расходов");
    await click(button("as:ok:"));
    expect(await mine()).toBe(before + 120);
    const sum = await prisma.expense.aggregate({ where: { createdById: writer.id, note: { startsWith: "Закупка " } }, _sum: { amount: true } });
    expect(Number(sum._sum.amount)).toBe(Array.from({ length: 120 }, (_, i) => 100 + i).reduce((a, b) => a + b, 0));
    // Тот же файл повторно — «уже записаны».
    await handleAssistantPrivate(docMsg("октябрь (копия).xlsx"), writer);
    expect(io.text.mock.calls.at(-1)?.[1]).toContain("уже записаны");
    expect(await mine()).toBe(before + 120);
  });

  it("та же пачка по-таджикски — вся карточка и итог на таджикском", async () => {
    io.download.mockResolvedValue(Buffer.from("Ном;Маблағ;Сана\nИҷораи офис;5000;01.11.2026\nИнтернет;400;02.11.2026\n", "utf8"));
    await handleAssistantPrivate(docMsg("ноябр.csv", "харҷҳо"), writer);
    const html = lastCard()[1];
    expect(html).toContain("2 харҷ");
    expect(html).toContain("🏢 Иҷора");
    expect(html).toContain("<i>1 ноябр</i>");
    expect(html).toContain("Ҳамагӣ: 5 400 сомонӣ");
    expect(cardButtons().map((b) => b.text)).toEqual(["✅ Сабт кардан", "✏️ Ислоҳ", "✖️ Бекор"]);
    await click(button("as:no:"));
    expect(io.edit.mock.calls.at(-1)?.[2]).toBe("✖️ Бекор кардам — ҳеҷ чиз сабт нашуд");
  });

  it("таблица без понятной суммы называет строку, а не молчит", () => {
    const parsed = expenseRowsFromTable([["Название", "Сумма"], ["Аренда", "5 000"], ["Свет", "—"], ["Итого", "5000"]]);
    expect(parsed.rows.map((r) => [r.title, r.amount, r.category])).toEqual([["Аренда", 5000, "OFFICE"]]);
    expect(parsed.unreadable).toEqual([3]);
  });
});

describe("Шабнам: «Править» и «Убрать строку» до записи", () => {
  it("строка 2 поправлена словами, строка 1 убрана — записывается только видимое", async () => {
    io.download.mockResolvedValue(Buffer.from("Название,Сумма\nБензин,122\nИнтернет,400\nТакси,35\n", "utf8"));
    await handleAssistantPrivate(docMsg("правка.csv"), writer);
    await click(button("ax:fx:"));
    const rowTwo = io.editHtml.mock.calls.at(-1)![3]!.flat().find((b) => b.text === "2")!.callback_data!;
    await click(rowTwo);
    // Поправка текстом: «Интернет Babilon 450».
    await handleAssistantPrivate({ message_id: ++seq, chat: { id: chatId, type: "private" }, from: { id: chatId }, text: "Интернет Babilon 450" }, writer);
    expect(lastCard()[1]).toContain("Интернет Babilon — 450");
    await click(button("ax:fx:"));
    const rowOne = io.editHtml.mock.calls.at(-1)![3]!.flat().find((b) => b.text === "1")!.callback_data!;
    await click(rowOne);
    const remove = io.editHtml.mock.calls.at(-1)![3]!.flat().find((b) => b.text.startsWith("🗑"))!.callback_data!;
    await click(remove);
    const afterRemove = io.editHtml.mock.calls.at(-1)!;
    expect(afterRemove[2]).toContain("2 расхода");
    expect(afterRemove[2]).not.toContain("Бензин");
    const before = await mine();
    await click(afterRemove[3]!.flat().find((b) => b.text === "✅ Записать")!.callback_data!);
    expect(await mine()).toBe(before + 2);
    expect(await prisma.expense.findFirst({ where: { createdById: writer.id, note: "Интернет Babilon" } })).toMatchObject({ amount: expect.anything() });
  });

  it("поправка понимает сумму, доллары и дату словами", () => {
    const row = { title: "Интернет", amount: 400, currency: "TJS" as const, month: "2026-11", status: "PAID" as const, category: "OFFICE" as const };
    expect(applyRowCorrection(row, "450", "2026-11-10")).toMatchObject({ title: "Интернет", amount: 450 });
    expect(applyRowCorrection(row, "$40 5 ноя", "2026-11-10")).toMatchObject({ amount: 40, currency: "USD", date: "2026-11-05" });
    expect(applyRowCorrection(row, "дирӯз", "2026-11-10")).toMatchObject({ date: "2026-11-09" });
  });
});

describe("Шабнам: права и общая группа", () => {
  it("без «Вести расходы» файл не становится карточкой, инструменты не объявляются", async () => {
    io.download.mockResolvedValue(Buffer.from("Название,Сумма\nБензин,122\n", "utf8"));
    await handleAssistantPrivate(docMsg("чужой.csv", undefined, noRightsChat), viewer);
    expect(io.html).not.toHaveBeenCalled();
    const access = { role: "ADMIN", permissions: resolvePermissions("ADMIN", { granted: [], revoked: ["finance.manage"] }) };
    const names = pluginDeclarations(assistantActorFor(viewer.id, access, "private"), true, "telegram").map((d) => d.name);
    expect(names).toContain("list_expenses");
    expect(names).not.toContain("add_expenses");
  });

  it("в общей группе нет ни чтения, ни записи денег, а брокер не примет пачку из группы", async () => {
    const access = { role: "DIRECTOR", permissions: resolvePermissions("DIRECTOR", { granted: [], revoked: [] }) };
    const group = pluginDeclarations(assistantActorFor(writer.id, access, "group"), true, "telegram").map((d) => d.name);
    expect(group.filter((n) => /expense/u.test(n))).toEqual([]);
    // Сторож: каждый инструмент расходов из реестра закрыт в группе и списком (третья дверь).
    expect(EXPENSE_TOOL_NAMES.filter((n) => !groupHiddenToolsForTests().has(n))).toEqual([]);
    expect(BOT_BATCH_TOOL).toBe(ADD_EXPENSES_TOOL);
    const actor = { agentId: writer.id, channel: "telegram" as const, telegramPrivate: false, can: () => true };
    await expect(createPendingAssistantAction(actor, "add_expenses", { items: [{ title: "Бензин", amount: 122 }] }))
      .rejects.toMatchObject({ code: "PRIVATE_CHAT_REQUIRED" });
  });

  it("текст «интернет 400, бензин 122 вчера» дважды — второй раз отказ «уже записаны»", async () => {
    const actor = { agentId: writer.id, channel: "telegram" as const, telegramPrivate: true, can: () => true };
    const yesterday = new Date(`${todayExpenseDay()}T00:00:00Z`); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const args = { lang: "ru", items: [{ title: "Интернет", amount: 400, category: "OFFICE" }, { title: "Бензин", amount: 122, date: yesterday.toISOString().slice(0, 10) }] };
    const first = await createPendingAssistantAction(actor, "add_expenses", args);
    expect(first.preview.title).toContain("2 расхода");
    const { confirmAssistantAction } = await import("../src/lib/assistantActions.js");
    await confirmAssistantAction(first.id, actor);
    await expect(createPendingAssistantAction(actor, "add_expenses", args)).rejects.toMatchObject({ code: "DUPLICATE" });
  });
});

beforeAll(async () => {
  writer = await prisma.agent.create({ data: { fullName: "Batch Writer Fixture", phone: `+992930${stamp}`, passwordHash: "x",
    role: "ADMIN", telegramChatId: String(chatId), telegramUserId: String(chatId) } });
  viewer = await prisma.agent.create({ data: { fullName: "Batch Viewer Fixture", phone: `+992931${stamp}`, passwordHash: "x",
    role: "ADMIN", telegramChatId: String(noRightsChat), telegramUserId: String(noRightsChat), permissions: { granted: [], revoked: ["finance.manage"] } } });
  const current = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { aiAssistantEnabled: true } });
  oldEnabled = current.aiAssistantEnabled;
  await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantEnabled: true } });
});
beforeEach(() => {
  for (const fn of Object.values(io)) fn.mockClear();
  io.extract.mockReset(); io.chunk.mockReset(); io.download.mockReset();
  io.html.mockImplementation(async () => ({ message_id: 901 }));
});
afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantEnabled: oldEnabled } });
  const ids = [writer.id, viewer.id];
  await prisma.expense.deleteMany({ where: { createdById: { in: ids } } });
  await prisma.assistantAction.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.telegramDialogState.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
});
