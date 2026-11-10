import { expenseDateSchema } from "@royal-home/shared";
import { defaultRootCategory } from "../ai/assistant/expenseArticles.js";

/**
 * ТАБЛИЦА РАСХОДОВ → СТРОКИ ПАЧКИ БЕЗ ИИ (10.11.2026): CSV и .xlsx разбираются кодом.
 *
 * Заголовок ищется в первых строках по словам на русском, таджикском, узбекском и английском;
 * без заголовка — по виду ячеек (текст, число, дата). Строка «Итого» пропускается. Строка без
 * понятной суммы не теряется молча: её номер уходит в `unreadable`, карточка его называет.
 * Месяц из шапки («ОКТЯБРЬ 2026») даётся строкам без даты.
 */

export interface TableRow {
  title: string; amount: number; currency: "TJS" | "USD"; date?: string; month?: string;
  category: "OFFICE" | "OTHER"; categoryTitle?: string; counterparty?: string;
}
export interface TableParse { rows: TableRow[]; unreadable: number[]; header: boolean }

const H = {
  title: /назван|наимен|назнач|расход|стать|описан|ном(?:гӯй|и)?$|харҷ|tavsif|nomi|xarajat|item|description|^name$|purpose|что/iu,
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

/** «1 200,50», «1200.5», «$40», «400 сомонӣ» → сумма и валюта; null — не сумма. */
export function parseAmountCell(raw: string): { amount: number; currency?: "TJS" | "USD" } | null {
  const text = raw.trim();
  if (!text) return null;
  const currency = /\$|usd|доллар|dollar/iu.test(text) ? "USD" : /tjs|сомон|somon|смн/iu.test(text) ? "TJS" : undefined;
  const digits = text.replace(/[^\d.,\s -]/gu, "").trim().replace(/[\s ]/gu, "");
  if (!/^\d+(?:[.,]\d+)?$/u.test(digits) && !/^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?$/u.test(digits)) return null;
  let normalized = digits;
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/u.test(digits)) normalized = digits.replace(/,/g, "");
  else if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/u.test(digits)) normalized = digits.replace(/\./g, "").replace(",", ".");
  else normalized = digits.replace(",", ".");
  const amount = Math.round(Number(normalized) * 100) / 100;
  return Number.isFinite(amount) && amount > 0 && amount <= 99_999_999.99 ? { amount, ...(currency ? { currency } : {}) } : null;
}

/** Дата ячейки: «05.11.2026», «5.11.26», «2026-11-05», «05/11/2026» или число Excel. */
export function parseDateCell(raw: string, excelSerial = false): string | null {
  const text = raw.trim();
  let iso: string | null = null;
  const dmy = /^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/u.exec(text);
  if (dmy) iso = `${dmy[3]!.length === 2 ? `20${dmy[3]}` : dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`;
  else if (/^\d{4}-\d{2}-\d{2}/u.test(text)) iso = text.slice(0, 10);
  else if (excelSerial && /^\d{5}(?:\.\d+)?$/u.test(text)) {
    const serial = Math.floor(Number(text));
    if (serial > 30_000 && serial < 80_000) iso = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
  }
  return iso && expenseDateSchema.safeParse(iso).success ? iso : null;
}

const isNumeric = (cell: string) => parseAmountCell(cell) !== null && !/[A-Za-zА-Яа-яЁё]{3,}/u.test(cell);

export function expenseRowsFromTable(table: string[][], opts: { excel?: boolean } = {}): TableParse {
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
  let month: string | null = null;
  for (let r = 0; r < (headerAt >= 0 ? headerAt : Math.min(3, table.length)); r++) {
    for (const cell of table[r]!) month ??= monthFromHeading(cell);
  }
  const rows: TableRow[] = [];
  const unreadable: number[] = [];
  for (let r = headerAt + 1; r < table.length; r++) {
    const cells = table[r]!.map((c) => (c ?? "").trim());
    if (!cells.some(Boolean)) continue;
    const line = r + 1;
    // Строка-подзаголовок месяца посреди таблицы («НОЯБРЬ 2026»).
    const heading = cells.filter(Boolean).length === 1 ? monthFromHeading(cells.find(Boolean)!) : null;
    if (heading) { month = heading; continue; }
    let titleCell: string | undefined, amountCell: string | undefined, dateCell: string | undefined;
    if (headerAt >= 0) {
      titleCell = cols.title !== undefined ? cells[cols.title] : cells.find((c, i) => c && i !== cols.amount && i !== cols.date && !isNumeric(c));
      amountCell = cols.amount !== undefined ? cells[cols.amount] : undefined;
      dateCell = cols.date !== undefined ? cells[cols.date] : undefined;
    } else {
      titleCell = cells.find((c) => c && !isNumeric(c) && !parseDateCell(c, opts.excel));
      amountCell = [...cells].reverse().find((c) => c && isNumeric(c) && !parseDateCell(c, false));
      dateCell = cells.find((c) => c && parseDateCell(c, false));
    }
    const title = (titleCell ?? "").replace(/\s+/gu, " ").trim();
    if (TOTAL_ROW.test(title) || (!title && cells.some((c) => TOTAL_ROW.test(c)))) continue;
    const parsed = amountCell ? parseAmountCell(amountCell) : null;
    // Порядковый номер («1», «2») без названия — не расход.
    if (!parsed || !/\p{L}/u.test(title)) {
      if (cells.filter(Boolean).length >= 2) unreadable.push(line);
      continue;
    }
    const currencyCell = cols.currency !== undefined ? cells[cols.currency] ?? "" : "";
    const currency = parsed.currency ?? (/usd|\$|доллар/iu.test(currencyCell) ? "USD" : "TJS");
    const date = dateCell ? parseDateCell(dateCell, opts.excel) : null;
    const categoryTitle = cols.category !== undefined ? cells[cols.category]?.slice(0, 100) || undefined : undefined;
    const counterparty = cols.counterparty !== undefined ? cells[cols.counterparty]?.slice(0, 200) || undefined : undefined;
    rows.push({
      title: title.slice(0, 200), amount: parsed.amount, currency,
      ...(date && date <= "2100-01-01" ? { date } : month ? { month } : {}),
      category: defaultRootCategory(`${categoryTitle ?? ""} ${title}`),
      ...(categoryTitle ? { categoryTitle } : {}),
      ...(counterparty ? { counterparty } : {}),
    });
  }
  return { rows, unreadable, header: headerAt >= 0 };
}
