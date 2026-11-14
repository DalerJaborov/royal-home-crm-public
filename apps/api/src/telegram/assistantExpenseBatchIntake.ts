import { createHash } from "node:crypto";
import sharp from "sharp";
import { prisma } from "../db.js";
import { loadAgentAccess } from "../auth/middleware.js";
import { AssistantActionError, createPendingAssistantAction, type AssistantActionActor } from "../lib/assistantActions.js";
import { expenseRowsFromTable, type SkippedLine } from "../lib/expenseTableRows.js";
import { parseCsv } from "../lib/csv.js";
import { loadUsdRateInfo, NO_USD_RATE_TEXT } from "../lib/money.js";
import { MAX_EXPENSE_RECEIPT_BYTES } from "../lib/telegramExpenseReceipts.js";
import { readXlsxFirstSheet, XlsxReadError } from "../lib/xlsxRead.js";
import { readXlsFirstSheet, XlsReadError } from "../lib/xlsRead.js";
import { renderExpensePdfPage } from "../ai/assistant/mediaProbe.js";
import { defaultRootCategory } from "../ai/assistant/expenseArticles.js";
import { EXPENSE_TABLE_CHUNK_ROWS, extractExpenseTableChunk } from "../ai/assistant/expenseReceiptExtraction.js";
import type { AssistantMoneyWallet } from "../ai/assistant/moneyBudget.js";
import { ADD_EXPENSES_TOOL, MAX_BATCH_ROWS, recordedSource, type BATCH_SOURCE_KINDS } from "../ai/assistant/tools/expenseBatchTool.js";
import { sendExpenseBatchCard, type CardNotes } from "./assistantExpenseCard.js";
import { sendMessage } from "./api.js";

/**
 * ПАЧКА РАСХОДОВ ИЗ ФАЙЛА ИЛИ ФОТО (10.11.2026). Таблица Excel/CSV разбирается кодом, фото
 * таблицы — ИИ частями (EXPENSE_TABLE_CHUNK_ROWS строк) (склейка по номеру строки). Итог —
 * одно действие `add_expenses`; у каждой строки ключ повтора по хэшу её фото/файла.
 * Ничего не теряется молча: пропущенная, нечитаемая, в чужой валюте или за пределом порций
 * строка называется в карточке.
 */

export type IntakeLang = "ru" | "tg";
const TEXT = {
  ru: {
    recorded: "Эти расходы уже записаны — второй раз не записываю.",
    deleted: "Эти расходы уже записывали и потом удалили — их можно вернуть из корзины расходов.",
    pending: "Эта таблица уже ждёт подтверждения — карточка выше.",
    empty: "Не нашла в файле строк с названием и суммой. Пришлите таблицу со столбцами «Название» и «Сумма».",
    broken: "Файл не открылся. Сохраните его как .xlsx или .csv и пришлите снова.",
    encrypted: "Файл защищён паролем — снимите пароль в Excel и пришлите снова.",
    old_format: "Это файл Excel 95 — такой старый формат не читаю. Сохраните его как .xlsx и пришлите снова.",
    unreadablePhoto: "Не разобрала строки на фото. Пришлите фото ровнее и крупнее или файл Excel.",
    failed: "Не получилось подготовить карточку. Пришлите ещё раз.",
    forbidden: "Записывать расходы может только тот, у кого открыто «Вести расходы».",
    noRate: (n: number) => `${NO_USD_RATE_TEXT} В долларах ${n === 1 ? "1 строка" : `${n} строки`} — её не записываю, остальное покажу карточкой.`,
    onlyUsd: `${NO_USD_RATE_TEXT} Все суммы в долларах — ничего не записываю.`,
  },
  tg: {
    recorded: "Ин харҷҳо аллакай сабт шудаанд — дубора сабт намекунам.",
    deleted: "Ин харҷҳо пештар сабт ва баъд нест карда шуда буданд — онҳоро аз сабади харҷҳо баргардонед.",
    pending: "Ин ҷадвал аллакай интизори тасдиқ аст — корт дар боло.",
    empty: "Дар файл сатр бо ном ва маблағ наёфтам. Ҷадвалро бо сутунҳои «Ном» ва «Маблағ» фиристед.",
    broken: "Файл кушода нашуд. Онро ҳамчун .xlsx ё .csv сабт карда, боз фиристед.",
    encrypted: "Файл бо рамз ҳифз шудааст — рамзро дар Excel гиред ва боз фиристед.",
    old_format: "Ин файли Excel 95 аст — ин формати кӯҳнаро намехонам. Онро ҳамчун .xlsx сабт карда, боз фиристед.",
    unreadablePhoto: "Сатрҳои аксро хонда натавонистам. Аксро ростар ва калонтар гиред ё файли Excel фиристед.",
    failed: "Кортро омода карда натавонистам. Боз фиристед.",
    forbidden: "Харҷро танҳо касе сабт карда метавонад, ки ба ӯ «Пешбурди харҷҳо» кушода аст.",
    noRate: (n: number) => `Қурби доллар дар Танзимоти CRM нест — ${n} сатри долларӣ сабт намекунам. Қурбро дар Танзимот гузоред ё маблағро бо сомонӣ фиристед.`,
    onlyUsd: "Қурби доллар дар Танзимоти CRM нест, ҳамаи маблағҳо бо доллар — ҳеҷ чиз сабт намекунам. Қурбро дар Танзимот гузоред ё маблағро бо сомонӣ фиристед.",
  },
} as const;

export const intakeText = (lang: IntakeLang) => TEXT[lang];
export const sourceHashOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export type SpreadsheetKind = "csv" | "xlsx" | "xls";
export function spreadsheetKind(doc: { mime_type?: string; file_name?: string }): SpreadsheetKind | null {
  const name = doc.file_name?.toLowerCase() ?? "";
  const mime = doc.mime_type?.toLowerCase() ?? "";
  if (name.endsWith(".xlsx") || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (name.endsWith(".xls") || mime === "application/vnd.ms-excel") return "xls";
  if (name.endsWith(".csv") || mime === "text/csv") return "csv";
  return null;
}

export interface IntakeRow {
  title: string; amount: number; currency?: "TJS" | "USD"; currencyUnstated?: true; date?: string; month?: string;
  category: "OFFICE" | "OTHER"; categoryTitle?: string; counterparty?: string; sourceText?: string;
  sourceHash?: string; sourceIndex?: number;
}

/**
 * CSV в cp1251 (выгрузка старого 1С/Excel) — частая беда: читаем UTF-8 строго, а если байты не
 * UTF-8 — как windows-1251. BOM UTF-8 и UTF-16 узнаём по первым байтам.
 */
export function decodeCsvBytes(bytes: Buffer): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString("utf8");
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

/** Таблица файла → строки с ключом источника. null — файл не прочитался. */
export function rowsFromSpreadsheet(kind: SpreadsheetKind, bytes: Buffer) {
  try {
    const table = kind === "xlsx" ? readXlsxFirstSheet(bytes) : kind === "xls" ? readXlsFirstSheet(bytes) : parseCsv(decodeCsvBytes(bytes));
    const parsed = expenseRowsFromTable(table);
    const sourceHash = sourceHashOf(bytes);
    return { ...parsed, rows: parsed.rows.map((row, i): IntakeRow => ({ ...row, sourceHash, sourceIndex: i })) };
  } catch (error) {
    // Пароль и Excel 95 — честный отказ своими словами, остальное — «файл не открылся».
    if (error instanceof XlsReadError && (error.message === "encrypted" || error.message === "old_format")) return { refused: error.message as "encrypted" | "old_format" };
    if (error instanceof XlsxReadError || error instanceof XlsReadError) return null;
    throw error;
  }
}

export const PHOTO_TABLE_MAX_CALLS = 25;

/**
 * Фото таблицы целиком: порции по номерам строк, пока модель говорит «есть ещё». Без молчаливых
 * потерь (ревью 10.11.2026): номер, которого не вернула ни одна порция, — «не прочиталась»;
 * порция без новых строк (нумерация пошла заново) — стоп с пометкой «дочитала до N»; предел
 * порций — тоже вслух.
 */
export async function rowsFromTablePhoto(image: Buffer, sourceHash: string, wallet: AssistantMoneyWallet, maxCalls = PHOTO_TABLE_MAX_CALLS, indexOffset = 0) {
  const byNumber = new Map<number, IntakeRow | SkippedLine>();
  let fromRow = 1;
  let month: string | null = null;
  let language: "ru" | "tg" | "unknown" = "unknown";
  let hasMore = true;
  let calls = 0;
  let strayNumbers = 0;
  while (hasMore && calls < maxCalls) {
    const chunk = await extractExpenseTableChunk(image, wallet, fromRow);
    calls += 1;
    if (language === "unknown") language = chunk.language;
    month ??= chunk.month && /^\d{4}-\d{2}$/u.test(chunk.month) ? chunk.month : null;
    let progressed = false;
    for (const row of chunk.rows) {
      if (row.n < fromRow || byNumber.has(row.n)) continue;
      // Номер вне разумного (дальше конца порции вдвое) — строка «не прочиталась», а не дыра на 10 000 номеров.
      if (row.n > fromRow + 2 * EXPENSE_TABLE_CHUNK_ROWS) { strayNumbers += 1; continue; }
      progressed = true;
      const title = row.title?.replace(/\s+/gu, " ").trim();
      const date = row.date && /^\d{4}-\d{2}-\d{2}$/u.test(row.date) ? row.date : undefined;
      if (row.otherCurrency) { byNumber.set(row.n, { line: row.n, reason: "unsupported_currency", currency: row.otherCurrency }); continue; }
      byNumber.set(row.n, title && /\p{L}/u.test(title) && row.amountMinor
        ? {
          title: title.slice(0, 200), amount: row.amountMinor / 100,
          ...(row.currency ? { currency: row.currency } : { currencyUnstated: true as const }),
          ...(date ? { date } : {}), category: defaultRootCategory(title),
          sourceText: `стр. ${row.n} на фото: ${title} ${row.amountMinor / 100}${row.currency ? ` ${row.currency}` : ""}`,
          sourceHash, sourceIndex: indexOffset + row.n - 1,
        }
        : { line: row.n, reason: "unreadable" });
    }
    hasMore = chunk.hasMore;
    if (!progressed) break;
    fromRow = Math.max(...byNumber.keys()) + 1;
  }
  const last = Math.max(0, ...byNumber.keys());
  const rows: IntakeRow[] = [];
  const skipped: SkippedLine[] = [];
  for (let n = 1; n <= last; n++) {
    const row = byNumber.get(n);
    if (!row) skipped.push({ line: n, reason: "unreadable" });
    else if ("title" in row) rows.push({ ...row, ...(row.date ? {} : month ? { month } : {}) });
    else skipped.push(row);
  }
  for (let k = 0; k < strayNumbers; k++) skipped.push({ line: last + k + 1, reason: "unreadable" });
  return { rows, skipped, language, calls, ...(hasMore ? { readUpTo: last } : {}) };
}

export const PDF_MAX_PAGES = 30;
export const PDF_MAX_BYTES = 10_000_000;
/** Порций ИИ на один PDF — общий потолок на все страницы-сканы (повторное ревью 10.11.2026). */
export const PDF_MAX_PORTIONS = 60;
/** Строки сканов нумеруются после строк текстового слоя: 50 000 + сквозной номер, предел схемы 100 000. */
const PDF_SCAN_BASE = 50_000;

export type PdfPageNote = { page: number; skipped: number[]; readUpTo?: number; unreadable?: true; notRead?: true };

/** Строки страницы из текстового слоя (колонки — по двум и больше пробелам). */
function pageCells(text: string): string[][] {
  return text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => line.split(/\s{2,}|\t/u));
}

/**
 * МНОГОСТРАНИЧНЫЙ PDF (10.11.2026). Страница, на которой текстовый слой даёт хотя бы одну строку
 * расхода, разбирается кодом: такие страницы — одна таблица (заголовок с первой, номера сквозные), без
 * ИИ. Остальные (сканы, а также страница с одним водяным знаком «Scanned with …») — картинкой через
 * ИИ: каждая такая страница списывает дневной предел (`claimScanPage`), а все вместе — не больше
 * PDF_MAX_PORTIONS порций; не хватило — честное «не дочитала» по странице. Ключ повтора у всех строк —
 * хэш файла + номер строки. Невидимый текст PDF человек видит в карточке до записи.
 */
export async function rowsFromPdf(
  bytes: Buffer, sourceHash: string, wallet: AssistantMoneyWallet, texts: string[],
  claimScanPage: () => Promise<boolean>,
) {
  const lines: string[][] = [];
  const scans: number[] = [];
  texts.forEach((text, i) => {
    const cells = pageCells(text);
    if (expenseRowsFromTable(cells).rows.length) lines.push(...cells);
    else scans.push(i + 1);
  });
  const parsed = expenseRowsFromTable(lines);
  const rows: IntakeRow[] = parsed.rows.slice(0, PDF_SCAN_BASE).map((row, i) => ({ ...row, sourceHash, sourceIndex: i, sourceText: `PDF, ${row.sourceText}`.slice(0, 500) }));
  const pageNotes: PdfPageNote[] = [];
  let language: "ru" | "tg" | "unknown" = "unknown";
  let portionsLeft = PDF_MAX_PORTIONS;
  let scanOffset = PDF_SCAN_BASE;
  for (const page of scans) {
    if (portionsLeft <= 0 || !(await claimScanPage())) { pageNotes.push({ page, skipped: [], notRead: true }); continue; }
    const image = await renderExpensePdfPage(bytes, page, PDF_MAX_PAGES);
    const table = await rowsFromTablePhoto(image, sourceHash, wallet, Math.min(PHOTO_TABLE_MAX_CALLS, portionsLeft), scanOffset);
    portionsLeft -= table.calls;
    if (language === "unknown") language = table.language;
    const lastLine = Math.max(0, ...table.rows.map((row) => (row.sourceIndex ?? scanOffset) - scanOffset + 1), ...table.skipped.map((s) => s.line));
    scanOffset += lastLine;
    rows.push(...table.rows.map((row) => ({ ...row, sourceText: `PDF стр. ${page}, ${row.sourceText ?? ""}`.slice(0, 500) })));
    if (!table.rows.length) pageNotes.push({ page, skipped: [], unreadable: true });
    else if (table.skipped.length || table.readUpTo) pageNotes.push({ page, skipped: table.skipped.map((s) => s.line), ...(table.readUpTo ? { readUpTo: table.readUpTo } : {}) });
  }
  return { rows, skipped: parsed.skipped, pageNotes, pages: texts.length, language };
}

/** Строки о страницах-сканах PDF, которые прочитались не целиком (номера — по странице). */
export function pdfPageNotesText(lang: IntakeLang, notes: PdfPageNote[]): string | null {
  if (!notes.length) return null;
  const line = (n: PdfPageNote) => n.notRead
    ? lang === "tg" ? `саҳифаи ${n.page}-ро нахондам — ҳадди хондан тамом шуд, онро алоҳида фиристед` : `страницу ${n.page} не читала — исчерпан предел разбора, пришлите её отдельно`
    : lang === "tg"
    ? n.unreadable ? `саҳифаи ${n.page}-ро хонда натавонистам` : `саҳифаи ${n.page}: ${n.skipped.length ? `сатрҳои ${n.skipped.join(", ")} хонда нашуданд` : ""}${n.readUpTo ? ` то сатри ${n.readUpTo} хондам` : ""}`
    : n.unreadable ? `страницу ${n.page} не разобрала` : `стр. ${n.page}: ${n.skipped.length ? `не прочитались строки ${n.skipped.join(", ")}` : ""}${n.readUpTo ? ` дочитала до строки ${n.readUpTo}` : ""}`;
  return notes.map((n) => `⚠️ ${line(n).trim()}`).join("\n");
}

/** Что уже есть по каждому фото/файлу: записано (из пачки, альбома или как одиночный чек) или ждёт карточки. */
export async function knownSources(agentId: string, hashes: readonly string[]) {
  const out = new Map<string, "recorded" | "deleted" | "pending">();
  for (const hash of hashes) {
    const recorded = await recordedSource(hash);
    if (recorded) { out.set(hash, recorded.deletedAt ? "deleted" : "recorded"); continue; }
    const draft = await prisma.telegramExpenseDraft.findFirst({ where: { sourceHash: hash, expiresAt: { gt: new Date() } }, select: { expenseId: true } });
    if (draft) { out.set(hash, draft.expenseId ? "recorded" : "pending"); continue; }
    const pending = await prisma.assistantAction.findFirst({
      // Хэш — в ЛЮБОЙ строке пачки (альбом: фото №2 — вторая строка), а не только в первой.
      where: { agentId, tool: ADD_EXPENSES_TOOL, status: "PENDING", expiresAt: { gt: new Date() }, OR: [
        { args: { path: ["sourceHash"], equals: hash } },
        { args: { path: ["items"], array_contains: [{ sourceHash: hash }] } },
      ] },
      select: { id: true },
    });
    if (pending) out.set(hash, "pending");
  }
  return out;
}

export async function knownBatch(agentId: string, sourceHash: string) {
  return (await knownSources(agentId, [sourceHash])).get(sourceHash) ?? null;
}

/**
 * Создать действие и показать карточку. Без курса доллара долларовые строки не пишутся — об этом
 * сказано прямо (владелец 10.11.2026). Таблица длиннее MAX_BATCH_ROWS — несколько карточек.
 */
export async function stageExpenseBatch(params: {
  chatId: string; agentId: string; rows: IntakeRow[]; lang: IntakeLang; replyTo?: number;
  kind: (typeof BATCH_SOURCE_KINDS)[number]; notes?: CardNotes;
}): Promise<void> {
  const { chatId, agentId, lang, replyTo } = params;
  const t = TEXT[lang];
  const access = await loadAgentAccess(agentId);
  if (!access?.isActive || !access.permissions.has("finance.manage")) { await sendMessage(chatId, t.forbidden, replyTo); return; }
  let rows = params.rows;
  if (rows.some((row) => row.currency === "USD") && !(await loadUsdRateInfo()).rate) {
    const usd = rows.filter((row) => row.currency === "USD").length;
    rows = rows.filter((row) => row.currency !== "USD");
    await sendMessage(chatId, rows.length ? t.noRate(usd) : t.onlyUsd, replyTo);
    if (!rows.length) return;
  }
  const actor: AssistantActionActor = { agentId, channel: "telegram", telegramPrivate: true, can: (p) => access.permissions.has(p) };
  for (let part = 0; part * MAX_BATCH_ROWS < rows.length; part++) {
    const items = rows.slice(part * MAX_BATCH_ROWS, (part + 1) * MAX_BATCH_ROWS);
    try {
      const action = await createPendingAssistantAction(actor, ADD_EXPENSES_TOOL, {
        items, lang, source: { kind: params.kind, ...(replyTo ? { messageId: replyTo } : {}) },
      });
      const sent = await sendExpenseBatchCard(chatId, action, agentId, replyTo, part === 0 ? params.notes ?? {} : {});
      if (!sent) await sendMessage(chatId, t.failed, replyTo);
    } catch (error) {
      if (error instanceof AssistantActionError && error.code === "DUPLICATE") {
        await sendMessage(chatId, error.extra.deleted ? t.deleted : t.recorded, replyTo);
        continue;
      }
      if (error instanceof AssistantActionError) { await sendMessage(chatId, error.code === "FORBIDDEN" ? t.forbidden : error.message, replyTo); return; }
      throw error;
    }
  }
}

/** Фото чека или таблицы → JPEG без поворота и лишнего: один формат для разбора и хэша. */
export async function normalizeReceiptPhoto(raw: Buffer): Promise<Buffer> {
  const processor = sharp(raw, { limitInputPixels: 20_000_000, failOn: "warning" });
  const metadata = await processor.metadata();
  if (!["jpeg", "png", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1) {
    throw new Error("expense_receipt_invalid_image");
  }
  const image = await processor.rotate().jpeg({ quality: 88 }).toBuffer();
  if (image.length > MAX_EXPENSE_RECEIPT_BYTES) throw new Error("expense_receipt_image_limit");
  return image;
}

