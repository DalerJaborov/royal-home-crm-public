import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { prisma } from "../src/db.js";
import { resolvePermissions } from "@royal-home/shared";
import { confirmAssistantAction, createPendingAssistantAction } from "../src/lib/assistantActions.js";
import { handleAssistantCallback, handleAssistantPrivate, assistantActorFor, groupHiddenToolsForTests } from "../src/telegram/assistantBot.js";
import { pluginDeclarations } from "../src/ai/assistant.js";
import { EXPENSE_TOOL_NAMES } from "../src/ai/assistant/tools/expenseTools.js";
import { addExpensesPlugin, sourceKeyPrefix } from "../src/ai/assistant/tools/expenseBatchTool.js";
import { getExpenseHistoryTool } from "../src/ai/assistant/tools/expenseReadTools.js";
import { runAssistantToolPlugin } from "../src/ai/assistant/tools/run.js";
import { actorFromAccess } from "../src/ai/assistant/actor.js";
import { applyRowCorrection } from "../src/telegram/assistantExpenseCard.js";
import { flushExpenseAlbumsForTests, setExpenseAlbumQuietForTests } from "../src/telegram/assistantExpenseAlbum.js";
import { knownBatch, sourceHashOf } from "../src/telegram/assistantExpenseBatchIntake.js";
import { decideExpensePhotoDraft, expenseReceiptHash, getExpenseDirector, stageExpensePhotoDraft } from "../src/lib/telegramExpenseReceipts.js";
import { todayExpenseDay } from "../src/lib/expenseWorkspace.js";
import type { TelegramIncomingMessage, TelegramInlineButton } from "../src/telegram/api.js";
import { xlsxFixture } from "./helpers/xlsxFixture.js";
import { xlsFixture } from "./helpers/xlsFixture.js";
import { textPdfFixture } from "./helpers/textPdfFixture.js";
import { renderBundleCard } from "../src/telegram/assistantBot.js";

/**
 * Шабнам и расходы пачкой (10.11.2026, жалоба владельца: фото таблицы «ОКТЯБРЬ 2026» из
 * 12 строк — «вносите сами»; ревью пачки и валютная защита в тот же день).
 * ИИ-разбор подменён: живой ключ Gemini не используется.
 */

const io = vi.hoisted(() => ({
  extract: vi.fn(),
  chunk: vi.fn(),
  download: vi.fn(),
  html: vi.fn(async (_chatId: string, _html: string, _reply?: number, _buttons?: TelegramInlineButton[][]) => ({ message_id: 901 })),
  editHtml: vi.fn(async (_chatId: string, _id: number, _html: string, _buttons?: TelegramInlineButton[][] | null) => {}),
  text: vi.fn(async (_chatId: string, _text: string, _reply?: number) => ({})),
  buttons: vi.fn(async (_chatId: string, _text: string, _buttons: TelegramInlineButton[][], _reply?: number) => ({ message_id: 902 })),
  ack: vi.fn(async (_id: string, _text?: string) => ({})),
  edit: vi.fn(async (_chatId: string, _id: number, _text: string, _buttons?: TelegramInlineButton[][] | null) => {}),
  failCreateAt: { value: 0, seen: 0 },
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
vi.mock("../src/lib/expenseCommands.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/expenseCommands.js")>();
  return {
    ...original,
    // Откат пачки на середине: N-я запись падает — не должно остаться ни одной.
    createExpense: async (...args: Parameters<typeof original.createExpense>) => {
      io.failCreateAt.seen += 1;
      if (io.failCreateAt.value && io.failCreateAt.seen === io.failCreateAt.value) throw new Error("synthetic failure in row");
      return original.createExpense(...args);
    },
  };
});
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendHtmlMessage: io.html,
  editHtmlMessage: io.editHtml,
  sendMessage: io.text,
  sendMessageWithButtons: io.buttons,
  answerCallbackQuery: io.ack,
  editMessageText: io.edit,
  setMessageReaction: async () => "sent",
}));

const stamp = String(Date.now()).slice(-8);
const chatId = 8_600_000_000 + Number(stamp);
const noRightsChat = chatId + 7;
let writer: { id: string; fullName: string };
let viewer: { id: string; fullName: string };
let oldSettings: { aiAssistantEnabled: boolean; usdToTjsRate: unknown; usdToTjsRateUpdatedAt: Date | null };
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
  // Размер тоже от seed: картинок-двойников (одинаковый хэш) между тестами быть не должно.
  return sharp({ create: { width: 48 + (seed % 97), height: 40 + (Math.floor(seed / 97) % 61), channels: 3, background: { r: seed % 255, g: (seed * 7) % 255, b: (seed * 13) % 255 } } }).jpeg().toBuffer();
}
const lastCard = () => io.html.mock.calls.at(-1)!;
const cardButtons = () => lastCard()[3]!.flat();
const button = (prefix: string) => cardButtons().find((b) => "callback_data" in b && b.callback_data!.startsWith(prefix))!.callback_data!;
const mine = () => prisma.expense.count({ where: { createdById: writer.id, deletedAt: null } });
const tableRows = (rows: readonly (readonly [string, number])[], from = 1) => rows.map(([title, amountMinor], i) => ({ n: from + i, title, amountMinor, currency: null, date: null }));
const listKind = { kind: "expense_list", language: "ru", amountMinor: null, currency: null, paymentDate: null, purpose: null, vendor: null };
const writerActor = () => ({ agentId: writer.id, channel: "telegram" as const, telegramPrivate: true, can: () => true });

function bigSheet(count: number, prefix: string) {
  return [["ОКТЯБРЬ 2026"], ["№", "Название", "Сумма", "Дата"],
    ...Array.from({ length: count }, (_, i) => [i + 1, `${prefix} ${i + 1}`, 100 + i, `${String((i % 28) + 1).padStart(2, "0")}.10.2026`]),
    ["", "Итого", 999999, ""]];
}

describe("Шабнам: расходы пачкой из фото таблицы", () => {
  it("12 строк на фото — одна карточка по статьям, порции склеены без дублей, двойное «Записать» пишет 12", async () => {
    io.download.mockResolvedValue(await jpeg(1));
    io.extract.mockResolvedValue(listKind);
    // Порция 1: строки 1–8; порция 2 начинается с 7 (стык повторяет 7–8) и заканчивается 12.
    io.chunk.mockImplementation(async (_image: Buffer, _wallet: unknown, fromRow: number) => fromRow === 1
      ? { language: "ru", month: "2026-10", rows: tableRows(OCTOBER).slice(0, 8), hasMore: true }
      : { language: "ru", month: "2026-10", rows: tableRows(OCTOBER).slice(6), hasMore: false });
    const before = await mine();
    await handleAssistantPrivate(photoMsg(), writer);
    expect(io.chunk).toHaveBeenCalledTimes(2);
    expect(io.chunk.mock.calls[1]![2]).toBe(9);
    expect(io.html).toHaveBeenCalledOnce();
    const html = lastCard()[1];
    expect(html).toContain("🧾 <b>Октябрь · 12 расходов</b>");
    expect(html).toContain("🏢 Аренда");
    expect(html).toContain("3. Бензин — 122\n");
    // Реклама с названием площадки — «📣 Реклама» с каналом (10.11.2026, пачка 2).
    expect(html).toContain("📣 Реклама");
    expect(html).toContain("💱 валюта нигде не указана");
    expect(html).toContain("💰 <b>Итого: 7 787 с.</b>");
    expect(cardButtons().map((b) => b.text)).toEqual(["✅ Записать", "✏️ Править", "✖️ Отмена"]);
    expect(await mine()).toBe(before);

    const ok = button("as:ok:");
    await Promise.all([click(ok), click(ok)]);
    expect(await mine()).toBe(before + 12);
    expect(io.edit.mock.calls.map((c) => c[2])).toContain("✅ Записала 12 расходов на 7 787 с.");

    // То же фото ещё раз: без платного разбора, без второй записи.
    io.chunk.mockClear(); io.extract.mockClear();
    await handleAssistantPrivate(photoMsg(), writer);
    expect(io.extract).not.toHaveBeenCalled();
    expect(io.text.mock.calls.at(-1)?.[1]).toContain("уже записаны");
    expect(await mine()).toBe(before + 12);
  });

  it("п.8: пропущенный номер — «не прочиталась», нумерация заново — «дочитала до N», без молчаливых потерь", async () => {
    io.download.mockResolvedValue(await jpeg(2));
    io.extract.mockResolvedValue(listKind);
    io.chunk.mockImplementation(async (_image: Buffer, _wallet: unknown, fromRow: number) => fromRow === 1
      ? { language: "ru", month: null, rows: [...tableRows([["Свет", 18000], ["Вода", 4000]]), { n: 4, title: "Газ", amountMinor: 9000, currency: null, date: null }], hasMore: true }
      : { language: "ru", month: null, rows: tableRows([["Свет", 18000]]), hasMore: true });
    await handleAssistantPrivate(photoMsg(), writer);
    const html = lastCard()[1];
    expect(html).toContain("3 расхода");
    expect(html).toMatch(/строки 3 — не прочиталась/u);
    expect(html).toContain("Дочитала до строки 4");
    await click(button("as:no:"));
  });

  it("п.1: чек, записанный одиночным фото, в альбоме второй раз не пишется", async () => {
    const receipt = await jpeg(3);
    const table = await jpeg(4);
    const hash = sourceHashOf(await sharp(receipt).rotate().jpeg({ quality: 88 }).toBuffer());
    await prisma.expense.create({ data: { category: "OTHER", note: "Бумага", amount: 150, currency: "TJS", month: new Date("2026-11-01T00:00:00Z"),
      createdById: writer.id, requestKey: `tg-receipt:${hash}` } });
    io.download.mockImplementation(async (fileId: string) => (fileId.includes("r") ? receipt : table));
    io.extract.mockResolvedValue(listKind);
    io.chunk.mockResolvedValue({ language: "ru", month: null, rows: tableRows([["Такси", 3500]]), hasMore: false });
    setExpenseAlbumQuietForTests(300);
    const group = `album-${stamp}`;
    await handleAssistantPrivate(photoMsg(chatId, { media_group_id: group, caption: "расходы", photo: [{ file_id: "r-photo" }] }), writer);
    await handleAssistantPrivate(photoMsg(chatId, { media_group_id: group, photo: [{ file_id: "t-photo" }] }), writer);
    await flushExpenseAlbumsForTests();
    expect(io.extract).toHaveBeenCalledOnce();
    expect(lastCard()[1]).toContain("1 расход");
    expect(io.text.mock.calls.map((c) => c[1]).join("\n")).toContain("фото 1 уже записаны");
    await click(button("as:ok:"));
    // То же фото таблицы потом одиночным — «уже записаны».
    io.download.mockResolvedValue(table);
    io.extract.mockClear();
    await handleAssistantPrivate(photoMsg(), writer);
    expect(io.extract).not.toHaveBeenCalled();
    expect(io.text.mock.calls.at(-1)?.[1]).toContain("уже записаны");
    setExpenseAlbumQuietForTests(null);
  });
});

describe("Шабнам: фото из ждущего альбома отдельно — одна запись в любом порядке нажатий", () => {
  const evidence = { language: "ru" as const, amountMinor: 15025, currency: "TJS" as const, paymentDate: "2026-11-04", purpose: "бумага", vendor: null };
  async function albumAndDraft(seed: number) {
    // Картинки уникальны на прогон: хэш фото — ключ повтора, а база общая между прогонами.
    const photo = await jpeg(seed + Number(stamp.slice(-4)) * 3);
    const other = await jpeg(seed + 1 + Number(stamp.slice(-4)) * 3);
    const hash = expenseReceiptHash(photo);
    const action = await createPendingAssistantAction(writerActor(), "add_expenses", {
      lang: "ru", source: { kind: "album" },
      items: [
        { title: "Такси", amount: 35, currency: "TJS", sourceHash: expenseReceiptHash(other), sourceIndex: 0 },
        { title: "бумага", amount: 150.25, currency: "TJS", sourceHash: hash, sourceIndex: 0 },
      ],
    });
    // Альбом ждёт «Записать»: фото №2 (вторая строка пачки) уже известно как ждущее.
    expect(await knownBatch(writer.id, hash)).toBe("pending");
    const director = (await getExpenseDirector(String(chatId), writer.id))!;
    const draft = await stageExpensePhotoDraft(director, ++seq, photo, evidence);
    if (draft.kind !== "pending") throw new Error("draft expected");
    return { action, draft, director, hash };
  }
  const fromPhoto = (hash: string) => prisma.expense.count({ where: { OR: [{ requestKey: `tg-receipt:${hash}` }, { requestKey: { startsWith: sourceKeyPrefix(hash) } }] } });

  it("«Записать» альбом, потом «Да» чеку — чек отказан, запись одна", async () => {
    const { action, draft, director, hash } = await albumAndDraft(40);
    await confirmAssistantAction(action.id, writerActor());
    expect(await decideExpensePhotoDraft(director, draft.id, true)).toEqual({ kind: "alreadyRecorded" });
    expect(await fromPhoto(hash)).toBe(1);
  });

  it("«Да» чеку, потом «Записать» альбом — альбом отказан, запись одна", async () => {
    const { action, draft, director, hash } = await albumAndDraft(50);
    expect(await decideExpensePhotoDraft(director, draft.id, true)).toMatchObject({ kind: "recorded" });
    await expect(confirmAssistantAction(action.id, writerActor())).rejects.toMatchObject({ code: "STALE" });
    expect(await fromPhoto(hash)).toBe(1);
  });

  it("одновременные нажатия — одна запись (общая блокировка по источнику)", async () => {
    const { action, draft, director, hash } = await albumAndDraft(60);
    await Promise.allSettled([confirmAssistantAction(action.id, writerActor()), decideExpensePhotoDraft(director, draft.id, true)]);
    expect(await fromPhoto(hash)).toBe(1);
  });
});

describe("Шабнам: расходы из Excel и CSV без ИИ", () => {
  it("Excel на 120 строк — страницы, одни кнопки, итог ровно по строкам, «Итого» не строка; повтор файла — «уже записаны»", async () => {
    const file = xlsxFixture(bigSheet(120, "Закупка"));
    io.download.mockResolvedValue(file);
    const before = await mine();
    await handleAssistantPrivate(docMsg("октябрь.xlsx", "расходы за октябрь"), writer);
    expect(io.extract).not.toHaveBeenCalled();
    const card = lastCard();
    expect(card[1].length).toBeLessThanOrEqual(4096);
    expect(card[1]).toContain("120 расходов");
    expect(card[1]).toContain("<blockquote expandable>");
    expect(cardButtons().find((b) => /^1\/\d+$/u.test(b.text))).toBeTruthy();
    await click(button("ax:pg:").replace(/:0$/u, ":1"));
    expect(io.editHtml.mock.calls.at(-1)?.[2]).toContain("120 расходов");
    // «Править» на любой странице — кнопок не больше 48 строк + «Назад».
    await click(button("ax:fx:"));
    expect(io.editHtml.mock.calls.at(-1)![3]!.flat().length).toBeLessThanOrEqual(49);
    await click(button("as:ok:"));
    expect(await mine()).toBe(before + 120);
    const sum = await prisma.expense.aggregate({ where: { createdById: writer.id, note: { startsWith: "Закупка " } }, _sum: { amount: true } });
    expect(Number(sum._sum.amount)).toBe(Array.from({ length: 120 }, (_, i) => 100 + i).reduce((a, b) => a + b, 0));
    await handleAssistantPrivate(docMsg("октябрь (копия).xlsx", "расходы"), writer);
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

  it("п.7: файл без подписи — вопрос «Это расходы?»; «Да» — карточка; подпись про другое — прежний путь", async () => {
    io.download.mockResolvedValue(Buffer.from("Название,Сумма\nВода,40\n", "utf8"));
    await handleAssistantPrivate(docMsg("вода.csv"), writer);
    expect(io.html).not.toHaveBeenCalled();
    const question = io.buttons.mock.calls.at(-1)!;
    expect(question[1]).toContain("Это расходы?");
    await click(question[2][0]![0]!.callback_data!, 902);
    expect(lastCard()[1]).toContain("Вода — 40");
    await click(button("as:no:"));
    const { handleTelegramExpenseReceipt } = await import("../src/telegram/assistantExpenseReceipt.js");
    const { createAssistantMoneyWallet } = await import("../src/ai/assistant/moneyBudget.js");
    io.download.mockClear();
    expect(await handleTelegramExpenseReceipt(docMsg("отчёт.xlsx", "отчёт по продажам"), writer.id, createAssistantMoneyWallet())).toBe(false);
    expect(io.download).not.toHaveBeenCalled();
  });

  it("откат на середине: 7-я из 12 строк падает — не записано ничего", async () => {
    io.download.mockResolvedValue(Buffer.from(["Название,Сумма", ...OCTOBER.map(([t, a]) => `${t},${a / 100}`)].join("\n"), "utf8"));
    await handleAssistantPrivate(docMsg("откат.csv", "расходы"), writer);
    const before = await mine();
    io.failCreateAt.seen = 0; io.failCreateAt.value = 7;
    await click(button("as:ok:"));
    io.failCreateAt.value = 0;
    expect(io.failCreateAt.seen).toBe(7);
    expect(await mine()).toBe(before);
  });
});

describe("Шабнам: деньги и валюта видны целиком", () => {
  it("долларовая строка — «22 $ × 11,15 = 245,30 с.», под итогом курс и дата; пометки валюты", async () => {
    io.download.mockResolvedValue(Buffer.from("Название;Сумма\nХостинг;$22\nДомен;$10\nСвет;180 сомони\nВода;40\n", "utf8"));
    await handleAssistantPrivate(docMsg("валюта.csv", "расходы"), writer);
    const html = lastCard()[1];
    expect(html).toContain("Хостинг — 22 $ × 11,15 = 245,30 с.");
    expect(html).toContain("курс: 11,15 (Настройки CRM, обновлён 10 ноя)");
    expect(html).toMatch(/Свет — 180[^\n]*\n\s+💱 валюта не как у остальных/u);
    expect(html).toMatch(/Вода — 40[^\n]*\n\s+💱 валюта не указана — проверьте/u);
    const before = await mine();
    await click(button("as:ok:"));
    expect(await mine()).toBe(before + 4);
    const hosting = await prisma.expense.findFirstOrThrow({ where: { createdById: writer.id, note: "Хостинг" }, orderBy: { createdAt: "desc" } });
    // Курс в записи — тот же, что в карточке.
    expect(Number(hosting.exchangeRate)).toBe(11.15);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Expense", entityId: hosting.id, action: "EXPENSE_CREATE" } });
    expect(log.meta).toMatchObject({ currency: "USD", exchangeRate: 11.15, sourceKind: "csv", sourceText: expect.stringContaining("Хостинг | $22") });
    const history = await getExpenseHistoryTool.run({ expenseId: hosting.id }, { actor: { ...actorFromAccess(writer.id, { role: "ADMIN", permissions: resolvePermissions("ADMIN", { granted: [], revoked: [] }) }, "telegram-private") } }) as { expenses: { history: { action: string; sourceText?: string; exchangeRate?: number }[] }[] };
    expect(history.expenses[0]!.history[0]).toMatchObject({ action: "EXPENSE_CREATE", exchangeRate: 11.15 });
  });

  it("сумма на порядок выше обычной для статьи — «⚠️ проверьте сумму»", async () => {
    for (let i = 0; i < 3; i++) {
      await prisma.expense.create({ data: { category: "OFFICE", note: "Интернет", amount: 400, currency: "TJS", status: "PAID", month: new Date("2026-11-01T00:00:00Z"), createdById: writer.id } });
    }
    io.download.mockResolvedValue(Buffer.from("Название;Сумма\nИнтернет;$5000\n", "utf8"));
    await handleAssistantPrivate(docMsg("подозрительно.csv", "расходы"), writer);
    expect(lastCard()[1]).toContain("⚠️ проверьте сумму");
    await click(button("as:no:"));
  });

  it("нет курса в Настройках — долларовые строки не пишутся, сказано прямо", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { usdToTjsRate: null } });
    try {
      io.download.mockResolvedValue(Buffer.from("Название;Сумма\nХостинг;$22\nСвет;180 сомони\n", "utf8"));
      await handleAssistantPrivate(docMsg("безкурса.csv", "расходы"), writer);
      expect(io.text.mock.calls.map((c) => c[1]).join("\n")).toContain("Курс доллара в Настройках CRM не задан — 1 строку в долларах не записываю");
      expect(lastCard()[1]).toContain("1 расход");
      expect(lastCard()[1]).not.toContain("Хостинг");
      await click(button("as:no:"));
      await expect(createPendingAssistantAction(writerActor(), "add_expenses", { items: [{ title: "Хостинг", amount: 22, currency: "USD" }] }))
        .rejects.toMatchObject({ code: "NO_RATE" });
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { usdToTjsRate: 11.15 } });
    }
  });

  it("п.5: модель назвала евро — строка не пишется", async () => {
    await expect(createPendingAssistantAction(writerActor(), "add_expenses", { items: [{ title: "Билет", amount: 300, otherCurrency: "€" }] }))
      .rejects.toMatchObject({ code: "ROWS_INVALID", message: expect.stringContaining("валюта € пока не поддерживается") });
  });
});

describe("Шабнам: «Править» и «Убрать строку» до записи", () => {
  it("строка 2 поправлена словами, строка 1 убрана — записывается только видимое", async () => {
    io.download.mockResolvedValue(Buffer.from("Название,Сумма\nБензин,122\nИнтернет,400\nТакси,35\n", "utf8"));
    await handleAssistantPrivate(docMsg("правка.csv", "расходы"), writer);
    await click(button("ax:fx:"));
    const rowTwo = io.editHtml.mock.calls.at(-1)![3]!.flat().find((b) => b.text === "2")!.callback_data!;
    await click(rowTwo);
    // Непонятная поправка (чужая валюта) не уходит модели и не снимает метку.
    await handleAssistantPrivate({ message_id: ++seq, chat: { id: chatId, type: "private" }, from: { id: chatId }, text: "€40" }, writer);
    expect(io.html.mock.calls.at(-1)?.[1]).toContain("Не поняла поправку");
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

  it("п.13: поправка — сумма тем же разборщиком; «5.5» и «12.10» — суммы, дата только однозначная", () => {
    const row = { title: "Интернет", amount: 400, currency: "TJS" as const, month: "2026-11", status: "PAID" as const, category: "OFFICE" as const };
    expect(applyRowCorrection(row, "450", "2026-11-10")).toMatchObject({ title: "Интернет", amount: 450 });
    expect(applyRowCorrection(row, "5.5", "2026-11-10")).toMatchObject({ amount: 5.5 });
    expect(applyRowCorrection(row, "12.10", "2026-11-10")).toMatchObject({ amount: 12.1 });
    expect(applyRowCorrection(row, "1.200", "2026-11-10")).toMatchObject({ amount: 1200 });
    expect(applyRowCorrection(row, "1 200", "2026-11-10")).toMatchObject({ amount: 1200 });
    expect(applyRowCorrection(row, "$40 5 ноя", "2026-11-10")).toMatchObject({ amount: 40, currency: "USD", date: "2026-11-05" });
    expect(applyRowCorrection(row, "05.11.2026", "2026-11-10")).toMatchObject({ amount: 400, date: "2026-11-05" });
    expect(applyRowCorrection(row, "дирӯз", "2026-11-10")).toMatchObject({ date: "2026-11-09" });
    expect(applyRowCorrection(row, "05.11", "2026-11-10")).toMatchObject({ amount: 400, date: "2026-11-05" });
    expect(applyRowCorrection(row, "5 т", "2026-11-10")).toMatchObject({ amount: 5000 });
    expect(applyRowCorrection(row, "5т", "2026-11-10")).toMatchObject({ amount: 5000 });
    expect(applyRowCorrection(row, "€40", "2026-11-10")).toBeNull();
    expect(applyRowCorrection(row, "(500)", "2026-11-10")).toBeNull();
  });
});

describe("Шабнам: ключ повтора текста и голоса", () => {
  const pluginActor = () => actorFromAccess(writer.id, { role: "ADMIN", permissions: resolvePermissions("ADMIN", { granted: [], revoked: [] }) }, "telegram-private");
  const args = { lang: "ru", items: [{ title: `Такси ${stamp}`, amount: 30, currency: "TJS" }] };

  it("п.2: повтор того же хода (та же модель, тот же апдейт) — одна карточка, не две", async () => {
    const hooks = { channel: "telegram" as const, turnKey: `tg:${chatId}:${stamp}01`, question: "такси 30" };
    const first = await runAssistantToolPlugin(addExpensesPlugin, args, pluginActor(), hooks) as { actionId: string };
    const second = await runAssistantToolPlugin(addExpensesPlugin, args, pluginActor(), hooks) as { actionId: string };
    expect(second.actionId).toBe(first.actionId);
    await confirmAssistantAction(first.actionId, writerActor());
    const third = await runAssistantToolPlugin(addExpensesPlugin, args, pluginActor(), hooks) as { code?: string };
    expect(third.code).toBe("DUPLICATE");
  });

  it("п.9: второе «такси 30» другим сообщением — новая запись с пометкой «похоже», а не отказ", async () => {
    const before = await mine();
    const hooks = { channel: "telegram" as const, turnKey: `tg:${chatId}:${stamp}02`, question: "такси 30" };
    const result = await runAssistantToolPlugin(addExpensesPlugin, args, pluginActor(), hooks) as { actionId: string; confirmRequired: boolean };
    expect(result.confirmRequired).toBe(true);
    const { loadCardContext } = await import("../src/telegram/assistantExpenseCard.js");
    const { parseBatchArgs } = await import("../src/ai/assistant/tools/expenseBatchTool.js");
    const row = await prisma.assistantAction.findUniqueOrThrow({ where: { id: result.actionId } });
    const ctx = await loadCardContext(parseBatchArgs(row.args));
    expect(ctx.flags[0]!.join(" ")).toContain("похоже на уже записанное");
    await confirmAssistantAction(result.actionId, writerActor());
    expect(await mine()).toBe(before + 1);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "EXPENSE_CREATE", agentId: writer.id }, orderBy: { createdAt: "desc" } });
    expect(log.meta).toMatchObject({ sourceKind: "chat", sourceText: "такси 30" });
  });

  it("модель не может подставить свой ключ сообщения или хэш фото", () => {
    const bound = addExpensesPlugin.bindContext!({ items: [{ title: "x", amount: 1, sourceHash: "a".repeat(64) }], chatRef: "чужое", sourceHash: "b".repeat(64) }, { turnKey: "tg:1:2" });
    expect(bound).toMatchObject({ chatRef: "tg:1:2", source: { kind: "chat" } });
    expect(bound.sourceHash).toBeUndefined();
    expect((bound.items as Record<string, unknown>[])[0]!.sourceHash).toBeUndefined();
  });
});

describe("Шабнам, пачка 2: PDF, .xls, реклама и зарплата, языки", () => {
  it("многостраничный PDF: текст — кодом, скан — ИИ, ключ общий; повтор файла — «уже записаны»", async () => {
    const pdf = textPdfFixture([
      [["Name", "Amount"], ["Office rent", "5000"], ["Internet", "400"]],
      [["Fuel", "122"], ["Taxi", "35"]],
      null,
    ]);
    io.download.mockResolvedValue(pdf);
    io.chunk.mockResolvedValue({ language: "ru", month: null, rows: tableRows([["Вода", 4000]]), hasMore: false });
    const msg = () => ({ ...docMsg("octobre.pdf", "расходы"), document: { file_id: `pdf-${++seq}`, file_name: "octobre.pdf", mime_type: "application/pdf" } });
    await handleAssistantPrivate(msg(), writer);
    // Две страницы с текстом — без ИИ, одна страница-скан — одна порция ИИ.
    expect(io.extract).not.toHaveBeenCalled();
    expect(io.chunk).toHaveBeenCalledOnce();
    const html = lastCard()[1];
    expect(html).toContain("5 расходов");
    expect(html).toContain("Office rent — 5 000");
    expect(html).toContain("Taxi — 35");
    expect(html).toContain("Вода — 40");
    const before = await mine();
    await click(button("as:ok:"));
    expect(await mine()).toBe(before + 5);
    const keys = await prisma.expense.findMany({ where: { createdById: writer.id, requestKey: { startsWith: sourceKeyPrefix(sourceHashOf(pdf)) } }, select: { requestKey: true } });
    expect(new Set(keys.map((k) => k.requestKey)).size).toBe(5);
    io.chunk.mockClear();
    await handleAssistantPrivate(msg(), writer);
    expect(io.chunk).not.toHaveBeenCalled();
    expect(io.text.mock.calls.at(-1)?.[1]).toContain("уже записаны");
  });

  it("старый .xls с подписью — карточка, как у .xlsx", async () => {
    io.download.mockResolvedValue(xlsFixture([["Название", "Сумма"], ["Свет", 180], ["Уборка", { rk: 250 }]]));
    await handleAssistantPrivate(docMsg("старый.xls", "расходы"), writer);
    expect(lastCard()[1]).toContain("2 расхода");
    expect(lastCard()[1]).toContain("Свет — 180");
    await click(button("as:no:"));
  });

  it("реклама: канал по словам строки; не узнан — кнопки каналов у строки, выбор пишется в «Реклама»", async () => {
    io.download.mockResolvedValue(Buffer.from("Название,Сумма\nРеклама Instagram,1000\nРеклама таргет,500\n", "utf8"));
    await handleAssistantPrivate(docMsg("реклама.csv", "расходы"), writer);
    const html = lastCard()[1];
    expect(html).toContain("📣 канал рекламы не узнала — выберите: ✏️ Править → строка 2");
    await click(button("ax:fx:"));
    await click(io.editHtml.mock.calls.at(-1)![3]!.flat().find((b) => b.text === "2")!.callback_data!);
    const channels = io.editHtml.mock.calls.at(-1)![3]!.flat();
    expect(channels.map((b) => b.text)).toContain("Facebook");
    await click(channels.find((b) => b.text === "Facebook")!.callback_data!);
    const card = io.editHtml.mock.calls.at(-1)!;
    expect(card[2]).not.toContain("канал рекламы не узнала");
    await click(card[3]!.flat().find((b) => b.text === "✅ Записать")!.callback_data!);
    const rows = await prisma.expense.findMany({ where: { createdById: writer.id, note: { startsWith: "Реклама " } }, select: { note: true, category: true, source: true } });
    expect(rows).toEqual(expect.arrayContaining([
      { note: "Реклама Instagram", category: "ADVERTISING", source: "INSTAGRAM" },
      { note: "Реклама таргет", category: "ADVERTISING", source: "FACEBOOK" },
    ]));
  });

  it("зарплата: сотрудник по имени; однофамильцы — кнопки, а не выбор за человека", async () => {
    const a = await prisma.agent.create({ data: { fullName: `Ахмадбек Рахимов ${stamp}`, phone: `+992932${stamp}`, passwordHash: "x", role: "AGENT" } });
    const b = await prisma.agent.create({ data: { fullName: `Ахмадбек Сафаров ${stamp}`, phone: `+992933${stamp}`, passwordHash: "x", role: "AGENT" } });
    try {
      io.download.mockResolvedValue(Buffer.from(`Название,Сумма\nЗарплата Ахмадбек,3000\nЗарплата Рахимов ${stamp},4000\n`, "utf8"));
      await handleAssistantPrivate(docMsg("зарплата.csv", "расходы"), writer);
      const html = lastCard()[1];
      expect(html).toContain("👥 похожих сотрудников несколько");
      await click(button("ax:fx:"));
      await click(io.editHtml.mock.calls.at(-1)![3]!.flat().find((x) => x.text === "1")!.callback_data!);
      const people = io.editHtml.mock.calls.at(-1)![3]!.flat();
      await click(people.find((x) => x.text.startsWith("Ахмадбек Сафаров"))!.callback_data!);
      await click(io.editHtml.mock.calls.at(-1)![3]!.flat().find((x) => x.text === "✅ Записать")!.callback_data!);
      const rows = await prisma.expense.findMany({ where: { createdById: writer.id, category: "SALARY" }, select: { agentId: true, amount: true } });
      expect(rows.map((r) => [r.agentId, Number(r.amount)])).toEqual(expect.arrayContaining([[b.id, 3000], [a.id, 4000]]));
    } finally {
      await prisma.expense.deleteMany({ where: { agentId: { in: [a.id, b.id] } } });
      await prisma.agent.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    }
  });

  it("вопрос «Это расходы?» — на таджикском, если разговор по-таджикски", async () => {
    await prisma.telegramDialogState.upsert({ where: { chatId: String(chatId) }, update: { agentId: writer.id, kind: "assistant", expiresAt: new Date(Date.now() + 600_000),
      payload: { messages: [{ role: "user", content: "Салом, ман харҷҳоро мефиристам, лутфан санҷед" }] } },
    create: { chatId: String(chatId), agentId: writer.id, kind: "assistant", expiresAt: new Date(Date.now() + 600_000),
      payload: { messages: [{ role: "user", content: "Салом, ман харҷҳоро мефиристам, лутфан санҷед" }] } } });
    io.download.mockResolvedValue(Buffer.from("Ном,Маблағ\nОб,40\n", "utf8"));
    await handleAssistantPrivate(docMsg("об.csv"), writer);
    const question = io.buttons.mock.calls.at(-1)!;
    expect(question[1]).toContain("Ин харҷҳоянд?");
    expect(question[2][0]!.map((b) => b.text)).toEqual(["✅ Ҳа, харҷ", "Не"]);
    await click(question[2][0]![0]!.callback_data!, 902);
    expect(cardButtons().map((b) => b.text)).toContain("✅ Сабт кардан");
    await click(button("as:no:"));
    await prisma.telegramDialogState.deleteMany({ where: { chatId: String(chatId) } });
  });

  it("рамка карточки подтверждения других инструментов — на языке собеседника, русская не изменилась", () => {
    const action = { id: "a", tool: "complete_task", status: "PENDING" as const, expiresAt: "", executedAt: null, undoneAt: null, undoUntil: null, result: null,
      preview: { title: "Завершить задачу", was: { Задача: "позвонить" }, becomes: { Статус: "Выполнено" } } };
    const ru = renderBundleCard([action], "Шабнам");
    expect(ru).toContain("Подтвердите действие:");
    expect(ru).toContain("   Было: Задача: позвонить");
    expect(ru).toContain("Подтвердить может только Шабнам.");
    const tg = renderBundleCard([action], "Шабнам", false, undefined, false, "tg");
    expect(tg).toContain("Ин амалро тасдиқ кунед:");
    expect(tg).toContain("   Пеш: Задача: позвонить");
    expect(tg).toContain("   Мешавад: Статус: Выполнено");
    expect(tg).toContain("Танҳо Шабнам тасдиқ карда метавонад.");
  });
});

describe("Шабнам: права, общая группа и рубильник", () => {
  it("без «Вести расходы» файл не становится карточкой, инструменты записи не объявляются", async () => {
    io.download.mockResolvedValue(Buffer.from("Название,Сумма\nБензин,122\n", "utf8"));
    await handleAssistantPrivate(docMsg("чужой.csv", "расходы", noRightsChat), viewer);
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
    const actor = { agentId: writer.id, channel: "telegram" as const, telegramPrivate: false, can: () => true };
    await expect(createPendingAssistantAction(actor, "add_expenses", { items: [{ title: "Бензин", amount: 122 }] }))
      .rejects.toMatchObject({ code: "PRIVATE_CHAT_REQUIRED" });
  });

  it("п.6: помощник выключен — файл не скачивается и не разбирается", async () => {
    vi.resetModules();
    vi.doMock("../src/ai/assistant/runtime.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/ai/assistant/runtime.js")>()),
      loadAssistantSettings: async () => ({ enabled: false, groundedSearchEnabled: false, semanticSearchEnabled: false }),
    }));
    const { handleTelegramExpenseReceipt } = await import("../src/telegram/assistantExpenseReceipt.js");
    const { createAssistantMoneyWallet } = await import("../src/ai/assistant/moneyBudget.js");
    io.download.mockResolvedValue(Buffer.from("Название,Сумма\nБензин,122\n", "utf8"));
    expect(await handleTelegramExpenseReceipt(docMsg("выкл.csv", "расходы"), writer.id, createAssistantMoneyWallet())).toBe(false);
    expect(await handleTelegramExpenseReceipt(photoMsg(chatId, { media_group_id: `off-${stamp}`, caption: "расходы" }), writer.id, createAssistantMoneyWallet())).toBe(false);
    expect(io.download).not.toHaveBeenCalled();
    vi.doUnmock("../src/ai/assistant/runtime.js");
  });
});

beforeAll(async () => {
  writer = await prisma.agent.create({ data: { fullName: "Batch Writer Fixture", phone: `+992930${stamp}`, passwordHash: "x",
    role: "ADMIN", telegramChatId: String(chatId), telegramUserId: String(chatId) } });
  viewer = await prisma.agent.create({ data: { fullName: "Batch Viewer Fixture", phone: `+992931${stamp}`, passwordHash: "x",
    role: "ADMIN", telegramChatId: String(noRightsChat), telegramUserId: String(noRightsChat), permissions: { granted: [], revoked: ["finance.manage"] } } });
  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" },
    select: { aiAssistantEnabled: true, usdToTjsRate: true, usdToTjsRateUpdatedAt: true } });
  oldSettings = current;
  await prisma.settings.update({ where: { id: "singleton" }, data: {
    aiAssistantEnabled: true, usdToTjsRate: 11.15, usdToTjsRateUpdatedAt: new Date("2026-11-10T06:00:00Z") } });
});
beforeEach(() => {
  for (const fn of [io.extract, io.chunk, io.download, io.html, io.editHtml, io.text, io.buttons, io.ack, io.edit]) fn.mockClear();
  io.extract.mockReset(); io.chunk.mockReset(); io.download.mockReset();
  io.html.mockImplementation(async () => ({ message_id: 901 }));
  io.buttons.mockImplementation(async () => ({ message_id: 902 }));
});
afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: {
    aiAssistantEnabled: oldSettings.aiAssistantEnabled, usdToTjsRate: oldSettings.usdToTjsRate as number | null, usdToTjsRateUpdatedAt: oldSettings.usdToTjsRateUpdatedAt } });
  const ids = [writer.id, viewer.id];
  await prisma.expense.deleteMany({ where: { createdById: { in: ids } } });
  await prisma.assistantAction.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.telegramExpenseDraft.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.telegramDialogState.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
});
