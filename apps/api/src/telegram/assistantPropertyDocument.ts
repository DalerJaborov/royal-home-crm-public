/**
 * ТЕКСТ ИЗ ФАЙЛА ДЛЯ МАСТЕРА ОБЪЕКТА (15.11.2026, владелец: «файл → объект»).
 *
 * Сотрудник присылает Шабнам PDF, Word, Excel или фото листа с описанием объекта:
 * здесь файл становится ТЕКСТОМ, а поля из него достаёт `extractPropertyDocument`
 * (assistantPropertyFields.ts). Своих разборщиков нет — только готовые двери:
 * PDF с текстовым слоем — `pdftotext` (как у расходов), скан и фото — тот же разбор
 * файла моделью, что у «пересказа файла» (`runAssistantMediaUnderstanding`), Word —
 * `recruitmentDocxText` (отдельный поток с пределами на архив и время), таблица —
 * `readSpreadsheetTable` (как у расходов).
 *
 * Текст файла — недоверенный источник: он остаётся данными, а не просьбой помощнице.
 */
import { readExpensePdfText } from "../ai/assistant/mediaProbe.js";
import type { AssistantMoneyWallet } from "../ai/assistant/moneyBudget.js";
import { recruitmentDocxText } from "../lib/recruitmentDocumentText.js";
import { XlsxReadError } from "../lib/xlsxRead.js";
import { XlsReadError } from "../lib/xlsRead.js";
import { readSpreadsheetTable, spreadsheetKind, type SpreadsheetKind } from "./assistantExpenseBatchIntake.js";
import { runAssistantMediaUnderstanding } from "./assistantMedia.js";
import { PROPERTY_DOCUMENT_TEXT_LIMIT } from "./assistantPropertyFields.js";

export type PropertyFileKind = { kind: "pdf" } | { kind: "docx" } | { kind: "sheet"; sheet: SpreadsheetKind } | { kind: "oldWord" };
export type PropertyFileRefusal = "empty" | "unreadable" | "encrypted" | "oldWord";
export type PropertyFileText = { ok: true; text: string } | { ok: false; reason: PropertyFileRefusal };

const PDF_MAX_PAGES = 20;
/** Слишком мало текста у PDF: это скан, его читает модель (она берёт PDF до 4 МБ). */
const PDF_SCAN_TEXT_CHARS = 40;
const PDF_SCAN_MAX_BYTES = 4_000_000;
/** Текст на фото листа: короче — это просто снимок объекта со случайной вывеской. */
export const PHOTO_TEXT_MIN_CHARS = 150;

/** Какой файл с описанием объекта прислали. null — это не документ (фото, видео, архив и прочее). */
export function propertyFileKind(doc?: { mime_type?: string; file_name?: string } | null): PropertyFileKind | null {
  if (!doc) return null;
  const name = doc.file_name?.toLowerCase() ?? "";
  const mime = doc.mime_type?.toLowerCase() ?? "";
  if (mime === "application/pdf" || name.endsWith(".pdf")) return { kind: "pdf" };
  if (name.endsWith(".docx") || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return { kind: "docx" };
  if (name.endsWith(".doc") || mime === "application/msword") return { kind: "oldWord" };
  const sheet = spreadsheetKind(doc);
  return sheet ? { kind: "sheet", sheet } : null;
}

/** Предел размера: PDF читается кодом и может быть крупнее, Word и таблица — до пяти мегабайт. */
export const propertyFileLimit = (file: PropertyFileKind) => file.kind === "pdf" ? 10_000_000 : 5_000_000;

const clip = (text: string) => text.replace(/\u0000/gu, "").replace(/[ \t]+\n/gu, "\n").trim().slice(0, PROPERTY_DOCUMENT_TEXT_LIMIT);

/** Таблица → строки «ячейка | ячейка»: пустые строки и ячейки убраны, строк не больше трёхсот. */
export function tableToText(table: string[][]): string {
  const lines: string[] = [];
  for (const row of table.slice(0, 300)) {
    const cells = row.map(cell => String(cell ?? "").trim()).filter(Boolean);
    if (cells.length) lines.push(cells.join(" | "));
  }
  return clip(lines.join("\n"));
}

/** Файл → текст. Отказ называется причиной, а не ошибкой: сотруднику она объясняется словами. */
export async function readPropertyFileText(file: PropertyFileKind, buffer: Buffer, wallet: AssistantMoneyWallet): Promise<PropertyFileText> {
  try {
    if (file.kind === "oldWord") return { ok: false, reason: "oldWord" };
    if (file.kind === "sheet") {
      const text = tableToText(readSpreadsheetTable(file.sheet, buffer));
      return text ? { ok: true, text } : { ok: false, reason: "empty" };
    }
    if (file.kind === "docx") {
      const text = clip(await recruitmentDocxText(buffer));
      return text ? { ok: true, text } : { ok: false, reason: "empty" };
    }
    let layer = "";
    try { layer = clip((await readExpensePdfText(buffer, PDF_MAX_PAGES)).join("\n")); } catch { /* нет текстового слоя или pdftotext недоступен — читаем как скан */ }
    if (layer.replace(/\s+/gu, "").length >= PDF_SCAN_TEXT_CHARS) return { ok: true, text: layer };
    if (buffer.length > PDF_SCAN_MAX_BYTES) return { ok: false, reason: "unreadable" };
    const text = clip((await runAssistantMediaUnderstanding(buffer, "application/pdf", wallet)).extraction.readableText);
    return text ? { ok: true, text } : { ok: false, reason: "empty" };
  } catch (error) {
    if (error instanceof XlsReadError && error.message === "encrypted") return { ok: false, reason: "encrypted" };
    if (error instanceof XlsReadError && error.message === "old_format") return { ok: false, reason: "unreadable" };
    if (error instanceof XlsxReadError || error instanceof XlsReadError) return { ok: false, reason: "unreadable" };
    console.warn("[telegram:property-draft] file read failed", { kind: file.kind, error: error instanceof Error ? error.name : "unknown" });
    return { ok: false, reason: "unreadable" };
  }
}

/** Читаемый текст на фото: только если его много — тогда это снимок листа, а не фото квартиры. */
export async function readPhotoDocumentText(buffer: Buffer, wallet: AssistantMoneyWallet): Promise<string | null> {
  const text = clip((await runAssistantMediaUnderstanding(buffer, "image/jpeg", wallet)).extraction.readableText);
  return text.length >= PHOTO_TEXT_MIN_CHARS ? text : null;
}
