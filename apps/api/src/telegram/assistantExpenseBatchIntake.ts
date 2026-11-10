import { createHash } from "node:crypto";
import sharp from "sharp";
import { MAX_EXPENSE_RECEIPT_BYTES } from "../lib/telegramExpenseReceipts.js";
import { prisma } from "../db.js";
import { loadAgentAccess } from "../auth/middleware.js";
import { AssistantActionError, createPendingAssistantAction, type AssistantActionActor } from "../lib/assistantActions.js";
import { expenseRowsFromTable } from "../lib/expenseTableRows.js";
import { parseCsv } from "../lib/csv.js";
import { readXlsxFirstSheet, XlsxReadError } from "../lib/xlsxRead.js";
import { defaultRootCategory } from "../ai/assistant/expenseArticles.js";
import { EXPENSE_TABLE_CHUNK_ROWS, extractExpenseTableChunk } from "../ai/assistant/expenseReceiptExtraction.js";
import type { AssistantMoneyWallet } from "../ai/assistant/moneyBudget.js";
import { ADD_EXPENSES_TOOL, MAX_BATCH_ROWS, recordedPhotoBatch } from "../ai/assistant/tools/expenseBatchTool.js";
import { sendExpenseBatchCard } from "./assistantExpenseCard.js";
import { sendMessage } from "./api.js";

/**
 * ПАЧКА РАСХОДОВ ИЗ ФАЙЛА ИЛИ ФОТО (10.11.2026). Таблица Excel/CSV разбирается кодом, фото
 * таблицы — ИИ частями по EXPENSE_TABLE_CHUNK_ROWS строк (склейка по номеру строки). Итог —
 * одно действие `add_expenses` с хэшем файла: тот же файл второй раз не запишется.
 */

export type IntakeLang = "ru" | "tg";
const TEXT = {
  ru: {
    recorded: "Эти расходы уже записаны — второй раз не записываю.",
    deleted: "Эти расходы уже записывали и потом удалили — их можно вернуть из корзины расходов.",
    pending: "Эта таблица уже ждёт подтверждения — карточка выше.",
    empty: "Не нашла в файле строк с названием и суммой. Пришлите таблицу со столбцами «Название» и «Сумма».",
    xls: "Старый формат .xls не читаю. Сохраните файл как .xlsx или .csv и пришлите снова.",
    broken: "Файл не открылся. Сохраните его как .xlsx или .csv и пришлите снова.",
    unreadablePhoto: "Не разобрала строки на фото. Пришлите фото ровнее и крупнее или файл Excel.",
    failed: "Не получилось подготовить карточку. Пришлите ещё раз.",
    forbidden: "Записывать расходы может только тот, у кого открыто «Вести расходы».",
  },
  tg: {
    recorded: "Ин харҷҳо аллакай сабт шудаанд — дубора сабт намекунам.",
    deleted: "Ин харҷҳо пештар сабт ва баъд нест карда шуда буданд — онҳоро аз сабади харҷҳо баргардонед.",
    pending: "Ин ҷадвал аллакай интизори тасдиқ аст — корт дар боло.",
    empty: "Дар файл сатр бо ном ва маблағ наёфтам. Ҷадвалро бо сутунҳои «Ном» ва «Маблағ» фиристед.",
    xls: "Формати кӯҳнаи .xls-ро намехонам. Файлро ҳамчун .xlsx ё .csv сабт карда, боз фиристед.",
    broken: "Файл кушода нашуд. Онро ҳамчун .xlsx ё .csv сабт карда, боз фиристед.",
    unreadablePhoto: "Сатрҳои аксро хонда натавонистам. Аксро ростар ва калонтар гиред ё файли Excel фиристед.",
    failed: "Кортро омода карда натавонистам. Боз фиристед.",
    forbidden: "Харҷро танҳо касе сабт карда метавонад, ки ба ӯ «Пешбурди харҷҳо» кушода аст.",
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
  title: string; amount: number; currency: "TJS" | "USD"; date?: string; month?: string;
  category: "OFFICE" | "OTHER"; categoryTitle?: string; counterparty?: string;
}

/** Таблица файла → строки. null — файл не прочитался. */
export function rowsFromSpreadsheet(kind: Exclude<SpreadsheetKind, "xls">, bytes: Buffer) {
  try {
    const table = kind === "xlsx" ? readXlsxFirstSheet(bytes) : parseCsv(bytes.toString("utf8"));
    return expenseRowsFromTable(table, { excel: kind === "xlsx" });
  } catch (error) {
    if (error instanceof XlsxReadError) return null;
    throw error;
  }
}

/**
 * Фото таблицы целиком: порции по номерам строк, пока модель говорит «есть ещё». Строка с
 * непрочитанной суммой или названием не выбрасывается молча — её номер уходит в `unreadable`.
 */
export async function rowsFromTablePhoto(image: Buffer, wallet: AssistantMoneyWallet, maxCalls = 12) {
  const byNumber = new Map<number, IntakeRow | null>();
  let fromRow = 1;
  let month: string | null = null;
  let language: "ru" | "tg" | "unknown" = "unknown";
  for (let call = 0; call < maxCalls; call++) {
    const chunk = await extractExpenseTableChunk(image, wallet, fromRow);
    if (language === "unknown") language = chunk.language;
    month ??= chunk.month && /^\d{4}-\d{2}$/u.test(chunk.month) ? chunk.month : null;
    let progressed = false;
    for (const row of chunk.rows) {
      if (row.n < fromRow || byNumber.has(row.n)) continue;
      progressed = true;
      const title = row.title?.replace(/\s+/gu, " ").trim();
      const date = row.date && /^\d{4}-\d{2}-\d{2}$/u.test(row.date) ? row.date : undefined;
      byNumber.set(row.n, title && /\p{L}/u.test(title) && row.amountMinor
        ? { title: title.slice(0, 200), amount: row.amountMinor / 100, currency: row.currency ?? "TJS", ...(date ? { date } : {}), category: defaultRootCategory(title) }
        : null);
    }
    const last = Math.max(0, ...byNumber.keys());
    if (!chunk.hasMore || !progressed || chunk.rows.length < 1) break;
    fromRow = last + 1;
    if (chunk.rows.length < EXPENSE_TABLE_CHUNK_ROWS / 4 && !chunk.hasMore) break;
  }
  const numbers = [...byNumber.keys()].sort((a, b) => a - b);
  const rows: IntakeRow[] = [];
  const unreadable: number[] = [];
  for (const n of numbers) {
    const row = byNumber.get(n);
    if (row) rows.push({ ...row, ...(row.date ? {} : month ? { month } : {}) });
    else unreadable.push(n);
  }
  return { rows, unreadable, language };
}

/** Записана уже или ждёт карточки пачка с этим файлом. */
export async function knownBatch(agentId: string, sourceHash: string): Promise<"recorded" | "deleted" | "pending" | null> {
  const recorded = await recordedPhotoBatch(sourceHash);
  if (recorded) return recorded.deletedAt ? "deleted" : "recorded";
  const pending = await prisma.assistantAction.findFirst({
    where: { agentId, tool: ADD_EXPENSES_TOOL, status: "PENDING", expiresAt: { gt: new Date() }, args: { path: ["sourceHash"], equals: sourceHash } },
    select: { id: true },
  });
  return pending ? "pending" : null;
}

/**
 * Создать действие и показать карточку. Таблица длиннее MAX_BATCH_ROWS режется на несколько
 * карточек — каждая со своим ключом повтора (хэш файла + номер части).
 */
export async function stageExpenseBatch(params: {
  chatId: string; agentId: string; rows: IntakeRow[]; lang: IntakeLang; sourceHash: string; replyTo?: number; unreadable?: number[];
}): Promise<void> {
  const { chatId, agentId, rows, lang, replyTo } = params;
  const t = TEXT[lang];
  const access = await loadAgentAccess(agentId);
  if (!access?.isActive || !access.permissions.has("finance.manage")) { await sendMessage(chatId, t.forbidden, replyTo); return; }
  const actor: AssistantActionActor = { agentId, channel: "telegram", telegramPrivate: true, can: (p) => access.permissions.has(p) };
  for (let part = 0; part * MAX_BATCH_ROWS < rows.length; part++) {
    const items = rows.slice(part * MAX_BATCH_ROWS, (part + 1) * MAX_BATCH_ROWS);
    const sourceHash = part === 0 ? params.sourceHash : sourceHashOf(Buffer.from(`${params.sourceHash}:${part}`));
    try {
      const action = await createPendingAssistantAction(actor, ADD_EXPENSES_TOOL, { items, lang, sourceHash });
      const sent = await sendExpenseBatchCard(chatId, action, agentId, replyTo, part === 0 ? { unreadable: params.unreadable } : {});
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
