import { defaultRootCategory } from "../ai/assistant/expenseArticles.js";
import type { BatchRow } from "../ai/assistant/tools/expenseBatchTool.js";
import { currencyInText } from "../lib/expenseAmountParse.js";
import { todayExpenseDay } from "../lib/expenseWorkspace.js";
import { applyRowCorrection } from "./assistantExpenseCard.js";
import { stageExpenseBatch, type IntakeLang, type IntakeRow } from "./assistantExpenseBatchIntake.js";

/**
 * СПИСОК РАСХОДОВ ТЕКСТОМ → ОДНА КАРТОЧКА (17.11.2026, журнал прода 10–11.11: директор присылал
 * расходы прошлого месяца списком и пять раз получил ответ без карточки).
 *
 * «Статья сумма» по строке разбирается кодом, а не моделью — тем же разборщиком, что поправка
 * строки карточки (`applyRowCorrection`: «1 200», «5 ҳазор», «$40», «5 ноя», «вчера»). Месяц всего
 * списка — из строки-заголовка: «за октябрь», «моҳи октябр 2026», «прошлый месяц», «моҳи гузашта».
 * Месяц без года — последний наступивший (в январе «декабрь» — прошлого года). Время — по Душанбе
 * (`todayExpenseDay`, lib/expenseWorkspace.ts).
 *
 * Ничего не теряется молча: если хоть одна строка с цифрами не разобралась, список целиком уходит
 * модели (она спросит), а не в карточку без этой строки.
 */

const MONTHS: readonly RegExp[] = [
  /^(?:январ|янв)/u, /^(?:феврал|фев)/u, /^март/u, /^(?:апрел|апр)/u, /^(?:май|мая|мае)$/u, /^июн/u,
  /^июл/u, /^(?:август|авг)/u, /^(?:сентябр|сен)/u, /^(?:октябр|окт)/u, /^(?:ноябр|ноя)/u, /^(?:декабр|дек)/u,
];
const PREVIOUS_MONTH = /(?:моҳи\s+гузашт|гузашта\s+моҳ|прошл\p{L}*\s+месяц|месяц\p{L}*\s+прошл|last\s+month|o['ʻ’]?tgan\s+oy)/iu;
const THIS_MONTH = /(?:(?:этот|этого|текущ\p{L}*)\s+месяц|ҳамин\s+моҳ|моҳи\s+ҷорӣ|this\s+month)/iu;
const YEAR = /(?<!\p{N})(20\d{2})(?!\p{N})/u;
const BULLET = /^\s*(?:[-–—•*·]+|\p{N}{1,3}[.)])\s*/u;

export interface ParsedTextList { rows: IntakeRow[]; month: string | null }

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** Месяц из строки без сумм: «за октябрь», «моҳи октябр 2026», «прошлый месяц». null — месяца нет. */
export function listMonthOf(header: string, today = todayExpenseDay()): string | null {
  const current = today.slice(0, 7);
  if (PREVIOUS_MONTH.test(header)) return shiftMonth(current, -1);
  if (THIS_MONTH.test(header)) return current;
  const words = header.toLocaleLowerCase("ru").split(/[^\p{L}]+/u).filter((w) => w.length >= 3);
  const index = words.map((word) => MONTHS.findIndex((re) => re.test(word))).find((i) => i >= 0);
  if (index === undefined) return null;
  const year = YEAR.exec(header)?.[1];
  const mm = String(index + 1).padStart(2, "0");
  if (year) return `${year}-${mm}`;
  const sameYear = `${current.slice(0, 4)}-${mm}`;
  return sameYear <= current ? sameYear : `${Number(current.slice(0, 4)) - 1}-${mm}`;
}

/**
 * Месяц из подписи («моҳи гузашта», «за октябрь») — строкам фото или альбома, у которых нет ни дня, ни
 * месяца с самого фото (месяц, прочитанный на фото, сильнее подписи).
 */
export function withListMonth<T extends { date?: string; month?: string }>(rows: T[], caption: string): T[] {
  const month = caption.trim() ? listMonthOf(caption) : null;
  return month ? rows.map((row) => (row.date || row.month ? row : { ...row, month })) : rows;
}

/** Части сообщения: строки, а внутри строки — «интернет 400, бензин 122» (запятая перед буквой). */
function segmentsOf(text: string): string[] {
  return text.split(/\r?\n/u).flatMap((line) => line.split(/[,;](?=\s*\p{L})/u)).map((s) => s.trim()).filter(Boolean);
}

/**
 * Разбор списка. null — это не список расходов или в нём есть неразобранная строка с цифрами
 * (тогда решает модель). `minRows` — сколько строк нужно, чтобы считать это списком.
 */
export function parseExpenseTextList(text: string, opts: { minRows?: number; today?: string } = {}): ParsedTextList | null {
  const today = opts.today ?? todayExpenseDay();
  const segments = segmentsOf(text);
  const headers = segments.filter((s) => !/\p{N}/u.test(s.replace(YEAR, " ")));
  const month = headers.map((h) => listMonthOf(h, today)).find((m): m is string => m !== null) ?? null;
  const base: BatchRow = { title: "", amount: 0, currency: "TJS", month: month ?? today.slice(0, 7), status: "PAID", category: "OTHER" };
  const rows: IntakeRow[] = [];
  for (const segment of segments) {
    if (headers.includes(segment)) continue;
    let line = segment.replace(BULLET, "");
    // «Хароҷот: иҷора 5000» — подпись до двоеточия без цифр отбрасывается.
    const colon = line.lastIndexOf(":");
    if (colon > 0 && !/\p{N}/u.test(line.slice(0, colon))) line = line.slice(colon + 1).trim();
    const parsed = applyRowCorrection(base, line, today);
    if (!parsed || !(parsed.amount > 0) || !parsed.title || !/\p{L}/u.test(parsed.title)) return null;
    let date = parsed.date;
    // «28 декабр» в январе — прошлый декабрь, а не будущий (разборщик берёт текущий год).
    if (date && date > today && Number(date.slice(5, 7)) > Number(today.slice(5, 7))) {
      date = `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;
    }
    const stated = currencyInText(line).currency ?? (parsed.currency === "USD" ? "USD" : undefined);
    rows.push({
      title: parsed.title, amount: parsed.amount,
      ...(stated ? { currency: stated } : { currencyUnstated: true as const }),
      ...(date ? { date } : month ? { month } : {}),
      category: defaultRootCategory(parsed.title),
      sourceText: segment.slice(0, 500),
    });
  }
  return rows.length >= (opts.minRows ?? 2) ? { rows, month } : null;
}

/** Список → одна карточка `add_expenses`. Ключ — сообщение (`tg:<чат>:<сообщение>`), как у хода модели. */
export async function stageExpenseTextList(params: {
  chatId: string; agentId: string; text: string; messageId?: number; lang: IntakeLang; minRows?: number;
}): Promise<boolean> {
  const parsed = parseExpenseTextList(params.text, { minRows: params.minRows });
  if (!parsed) return false;
  await stageExpenseBatch({
    chatId: params.chatId, agentId: params.agentId, rows: parsed.rows, lang: params.lang, kind: "chat",
    ...(params.messageId ? { replyTo: params.messageId, chatRef: `tg:${params.chatId}:${params.messageId}` } : {}),
    sourceText: params.text,
  });
  return true;
}
