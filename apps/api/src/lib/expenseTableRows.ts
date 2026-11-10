import { expenseDateSchema } from "@royal-home/shared";
import { defaultRootCategory } from "../ai/assistant/expenseArticles.js";
import { currencyInText, parseExpenseAmount } from "./expenseAmountParse.js";

/**
 * ТАБЛИЦА РАСХОДОВ → СТРОКИ ПАЧКИ БЕЗ ИИ (10.11.2026): CSV и .xlsx разбираются кодом.
 *
 * Заголовок ищется в первых строках по словам на русском, таджикском, узбекском и английском;
 * без заголовка — по виду ячеек, и если сумма неоднозначна (два числа, похожих на сумму), строка
 * не угадывается, а уходит в «не прочитались». Строка «Итого» пропускается. Валюта — из ячейки,
 * из заголовка столбца («Сумма, $») или из столбца «Валюта»; не названа — пометка в карточке.
 * Сумма — один разборщик `parseExpenseAmount`: минус и скобки — отказ, € и ₽ — не сомони.
 */

export type SkipReason = "unreadable" | "negative" | "unsupported_currency" | "ambiguous";
export interface SkippedLine { line: number; reason: SkipReason; currency?: string }
export interface TableRow {
  title: string; amount: number; currency?: "TJS" | "USD"; currencyUnstated?: true; date?: string; month?: string;
  category: "OFFICE" | "OTHER"; categoryTitle?: string; counterparty?: string; sourceText: string;
}
export interface TableParse { rows: TableRow[]; skipped: SkippedLine[]; header: boolean }

const H = {
  title: /назван|наимен|назнач|расход|стать|описан|^ном(?:гӯй|и)?$|харҷ|tavsif|nomi|xarajat|item|description|^name$|purpose|что/iu,
  amount: /сумм|маблағ|summa|amount|стоимост|нарх|narx|price|^итог|^total|^сум$/iu,
  date: /дата|сана|sana|date|день|рӯз|kun/iu,
  currency: /валют|асъор|valyuta|currency/iu,
  category: /категор|раздел|гурӯҳ|toifa|category|статья/iu,
  counterparty: /кому|получател|контрагент|поставщик|ба\s*кӣ|kimga|vendor|payee|supplier/iu,
};
const TOTAL_ROW = /^\s*(?:итого|всего|ҳамагӣ|хамаги|jami|total)(?=$|[\s:.,])/iu;

const MONTH_WORDS: [RegExp, number][] = [
  [/^(?:январ|january|yanvar)/iu, 1], [/^(?:феврал|february|fevral)/iu, 2], [/^(?:март|march|mart)/iu, 3],
  [/^(?:апрел|april|aprel)/iu, 4], [/^(?:ма[йя]|may)/iu, 5], [/^(?:июн|june|iyun)/iu, 6], [/^(?:июл|july|iyul)/iu, 7],
  [/^(?:август|august|avgust)/iu, 8], [/^(?:сентябр|september|sentabr)/iu, 9], [/^(?:октябр|october|oktabr)/iu, 10],
  [/^(?:ноябр|november|noyabr)/iu, 11], [/^(?:декабр|december|dekabr)/iu, 12],
];

/** «ОКТЯБРЬ 2026» → «2026-10». */
export function monthFromHeading(text: string): string | null {
  const m = /([A-Za-zА-Яа-яЁёӢӣӮӯ]+)\s*(20\d{2})/u.exec(text.trim());
  if (!m) return null;
  const month = MONTH_WORDS.find(([re]) => re.test(m[1]!))?.[1];
  return month ? `${m[2]}-${String(month).padStart(2, "0")}` : null;
}

/** Дата ячейки: «05.11.2026», «5.11.26», «2026-11-05», «05/11/2026» (дату Excel ридер уже перевёл). */
export function parseDateCell(raw: string): string | null {
  const text = raw.trim();
  let iso: string | null = null;
  const dmy = /^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/u.exec(text);
  if (dmy) iso = `${dmy[3]!.length === 2 ? `20${dmy[3]}` : dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`;
  else if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) iso = text;
  return iso && expenseDateSchema.safeParse(iso).success ? iso : null;
}

/** Похоже на серийную дату Excel без формата (45962): не сумма, а неоднозначность. */
const looksLikeExcelSerial = (cell: string) => /^\d{5}(?:\.\d+)?$/u.test(cell.trim()) && Number(cell) > 30_000 && Number(cell) < 80_000;
const isAmountLike = (cell: string) => parseExpenseAmount(cell).ok && !parseDateCell(cell) && !/[A-Za-zА-Яа-яЁё]{4,}/u.test(cell);

export function expenseRowsFromTable(table: string[][]): TableParse {
  let headerAt = -1;
  let cols: Partial<Record<keyof typeof H, number>> = {};
  for (let r = 0; r < Math.min(table.length, 15); r++) {
    const found: Partial<Record<keyof typeof H, number>> = {};
    table[r]!.forEach((cell, c) => {
      const text = cell.trim();
      if (!text || text.length > 40) return;
      for (const key of Object.keys(H) as (keyof typeof H)[]) if (found[key] === undefined && H[key].test(text)) { found[key] = c; break; }
    });
    if (found.amount !== undefined && (found.title !== undefined || found.date !== undefined)) { headerAt = r; cols = found; break; }
  }
  // «Сумма, $» / «Маблағ (сомонӣ)» — валюта всего столбца.
  const headerCurrency = headerAt >= 0 && cols.amount !== undefined ? currencyInText(table[headerAt]![cols.amount] ?? "") : {};
  let month: string | null = null;
  for (let r = 0; r < (headerAt >= 0 ? headerAt : Math.min(3, table.length)); r++) {
    for (const cell of table[r]!) month ??= monthFromHeading(cell);
  }
  const rows: TableRow[] = [];
  const skipped: SkippedLine[] = [];
  for (let r = headerAt + 1; r < table.length; r++) {
    const cells = table[r]!.map((c) => (c ?? "").trim());
    if (!cells.some(Boolean)) continue;
    const line = r + 1;
    const filled = cells.filter(Boolean);
    const heading = filled.length === 1 ? monthFromHeading(filled[0]!) : null;
    if (heading) { month = heading; continue; }
    if (filled.some((c) => TOTAL_ROW.test(c))) continue;
    let titleCell: string | undefined, amountCell: string | undefined, dateCell: string | undefined;
    if (headerAt >= 0) {
      titleCell = cols.title !== undefined ? cells[cols.title] : cells.find((c, i) => c && i !== cols.amount && i !== cols.date && !isAmountLike(c));
      amountCell = cols.amount !== undefined ? cells[cols.amount] : undefined;
      dateCell = cols.date !== undefined ? cells[cols.date] : undefined;
    } else {
      titleCell = cells.find((c) => c && /\p{L}{2,}/u.test(c) && !parseExpenseAmount(c).ok && !parseDateCell(c));
      dateCell = cells.find((c) => c && parseDateCell(c));
      // Первый столбец с порядковым номером («1», «2») — не сумма.
      const candidates = cells.filter((c, i) => c && !(i === 0 && /^\d{1,4}$/u.test(c)) && (isAmountLike(c) || looksLikeExcelSerial(c)));
      if (candidates.length > 1 || candidates.some(looksLikeExcelSerial)) { skipped.push({ line, reason: "ambiguous" }); continue; }
      amountCell = candidates[0];
    }
    const title = (titleCell ?? "").replace(/\s+/gu, " ").trim();
    const currencyCell = cols.currency !== undefined ? cells[cols.currency] ?? "" : "";
    const parsed = amountCell ? parseExpenseAmount(amountCell) : null;
    const columnCurrency = currencyInText(currencyCell);
    const other = columnCurrency.other ?? headerCurrency.other;
    if (parsed && !parsed.ok && parsed.reason === "unsupported_currency") { skipped.push({ line, reason: "unsupported_currency", currency: parsed.currency }); continue; }
    if (parsed?.ok && other && !parsed.currency) { skipped.push({ line, reason: "unsupported_currency", currency: other }); continue; }
    if (parsed && !parsed.ok && parsed.reason === "negative") { skipped.push({ line, reason: "negative" }); continue; }
    if (!parsed?.ok || !/\p{L}/u.test(title)) {
      if (filled.length >= 2) skipped.push({ line, reason: "unreadable" });
      continue;
    }
    const currency = parsed.currency ?? columnCurrency.currency ?? headerCurrency.currency;
    const date = dateCell ? parseDateCell(dateCell) : null;
    const categoryTitle = cols.category !== undefined ? cells[cols.category]?.slice(0, 100) || undefined : undefined;
    const counterparty = cols.counterparty !== undefined ? cells[cols.counterparty]?.slice(0, 200) || undefined : undefined;
    rows.push({
      title: title.slice(0, 200), amount: parsed.amount,
      ...(currency ? { currency } : { currencyUnstated: true as const }),
      ...(date ? { date } : month ? { month } : {}),
      category: defaultRootCategory(`${categoryTitle ?? ""} ${title}`),
      ...(categoryTitle ? { categoryTitle } : {}),
      ...(counterparty ? { counterparty } : {}),
      sourceText: `стр. ${line}: ${filled.join(" | ")}`.slice(0, 500),
    });
  }
  return { rows, skipped, header: headerAt >= 0 };
}
