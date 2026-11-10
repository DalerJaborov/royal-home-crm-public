import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { loadAgentAccess } from "../auth/middleware.js";
import {
  AssistantActionError, createPendingAssistantAction, discardPendingAssistantAction,
  type AssistantActionActor, type AssistantActionView,
} from "../lib/assistantActions.js";
import { parseExpenseAmount, currencyInText } from "../lib/expenseAmountParse.js";
import type { SkippedLine } from "../lib/expenseTableRows.js";
import { todayExpenseDay } from "../lib/expenseWorkspace.js";
import { expenseCentsToTjs, fromCents, loadMoneyContext, loadUsdRateInfo, type MoneyContext } from "../lib/money.js";
import { articleOf, dayWords, monthWords, type CardLang } from "../ai/assistant/expenseArticles.js";
import {
  ADD_EXPENSES_TOOL, batchCurrency, parseBatchArgs, resolveRows, type BatchArgs, type BatchRow,
} from "../ai/assistant/tools/expenseBatchTool.js";
import { answerCallbackQuery, editHtmlMessage, sendHtmlMessage, type TelegramCallbackQuery, type TelegramInlineButton } from "./api.js";

/**
 * КАРТОЧКА «ПРОВЕРЬТЕ РАСХОДЫ» В TELEGRAM (10.11.2026, вариант «А, по статьям» — выбор владельца).
 *
 * Одна карточка на пачку любого размера: статьи с иконкой и суммой, строки «Аренда — 5 000 · 1 ноя»,
 * длинная статья — свёрнутой цитатой; не влезает в 4096 знаков — страницы «◀️ 1/3 ▶️», а кнопки
 * «✅ Записать · ✏️ Править · ✖️ Отмена» одни на всю пачку. Записывает кнопка «Записать» — она же
 * `as:ok:<связка>` общего брокера (одно исполнение при двойном нажатии). Язык — собеседника.
 *
 * ДЕНЬГИ ВИДНЫ ЦЕЛИКОМ (владелец 10.11.2026: «никогда чтобы расходы не ошибались, особенно в
 * валюте»): у долларовой строки — пересчёт «22 $ × 11,15 = 245,30 с.» по тому курсу, что запишется
 * в exchangeRate, под итогом — курс и дата его обновления; валюта, которой не было в источнике,
 * чужая для пачки валюта, сумма на порядок выше обычной для статьи и похожая на уже записанную
 * строка — помечены; строки, которые не пишем, названы с причиной.
 *
 * «Править» — выбрать строку кнопкой, потом написать или сказать поправку; «Убрать строку» — до
 * записи. Правка не меняет действие на месте: старое гасится, создаётся новое с новой карточкой.
 */

const PAGE_CHARS = 3400;
/** Кнопок «Править» на страницу — не больше 48 (у Telegram предел 100 кнопок на сообщение). */
const PAGE_ROWS = 48;
const CALLBACK = /^ax:(pg|fx|rw|rm|nop):([0-9a-f-]{36})?(?::(\d{1,4}))?$/u;
const FIX_TTL_MS = 10 * 60_000;
const DIALOG_KIND = "assistant";
const SUSPICIOUS_RATIO = 10;

export interface CardNotes { skipped?: SkippedLine[]; readUpTo?: number }

const TEXT = {
  ru: {
    count: (n: number) => `${n} ${plural(n, ["расход", "расхода", "расходов"])}`,
    expenses: "Расходы", total: "Итого", planned: "ждёт оплаты", more: "продолжение",
    rate: (r: string, when: string | null) => `курс: ${r} (Настройки CRM${when ? `, обновлён ${when}` : ""})`,
    rateLater: "курс при оплате",
    write: "✅ Записать", fix: "✏️ Править", cancel: "✖️ Отмена", back: "↩️ Назад", remove: "🗑 Убрать строку",
    pickRow: "✏️ Какую строку поправить? Нажмите её номер.",
    rowPrompt: (n: number) => `✏️ Строка ${n}. Напишите или скажите поправку — например «450», «$40» или «Интернет 450 5 ноя».`,
    notUnderstood: "Не поняла поправку. Напишите сумму («450», «1 200», «$40») или «название сумма дата».",
    done: (n: number, total: string) => `✅ Записала ${n} ${plural(n, ["расход", "расхода", "расходов"])} на ${total}`,
    cancelled: "✖️ Отменила — ничего не записала",
    replaced: "✏️ Поправила — новая карточка ниже",
    stale: "Карточка устарела — пришлите расходы ещё раз",
    empty: "✖️ Строк не осталось — ничего не записала",
    flagUnstated: "💱 валюта не указана — проверьте",
    noCurrency: "💱 валюта нигде не указана — считаю в сомони, проверьте",
    flagMismatch: "💱 валюта не как у остальных — проверьте",
    flagSuspicious: "⚠️ проверьте сумму: намного больше обычного для этой статьи",
    flagDuplicate: (day: string) => `⚠️ похоже на уже записанное ${day}`,
    flagSalary: "запишу в «Прочее» — сотрудника для зарплаты укажите в CRM",
    flagAds: "запишу в «Прочее» — канал рекламы укажите в CRM",
    skippedHead: "⚠️ Не записываю:",
    skip: {
      unreadable: "не прочиталась", ambiguous: "непонятно, какое число сумма", negative: "сумма со знаком минус",
      unsupported_currency: (c?: string) => `валюта ${c ?? ""} пока не поддерживается — укажите в сомони или $`,
    },
    lines: (list: string) => `строки ${list}`,
    readUpTo: (n: number) => `⚠️ Дочитала до строки ${n} — остальное пришлите отдельным фото, добавлю новой карточкой.`,
    tjs: "с.",
  },
  tg: {
    count: (n: number) => `${n} харҷ`,
    expenses: "Харҷҳо", total: "Ҳамагӣ", planned: "ҳанӯз пардохт нашудааст", more: "давомаш",
    rate: (r: string, when: string | null) => `қурб: ${r} (Танзимоти CRM${when ? `, ${when} нав шуд` : ""})`,
    rateLater: "қурб ҳангоми пардохт",
    write: "✅ Сабт кардан", fix: "✏️ Ислоҳ", cancel: "✖️ Бекор", back: "↩️ Бозгашт", remove: "🗑 Ин сатрро нест кардан",
    pickRow: "✏️ Кадом сатрро ислоҳ кунам? Рақамашро пахш кунед.",
    rowPrompt: (n: number) => `✏️ Сатри ${n}. Ислоҳро нависед ё бо овоз гӯед — масалан «450», «$40» ё «Интернет 450 5 ноябр».`,
    notUnderstood: "Ислоҳро нафаҳмидам. Маблағро нависед («450», «1 200», «$40») ё «ном маблағ сана».",
    done: (n: number, total: string) => `✅ ${n} харҷро ба маблағи ${total} сабт кардам`,
    cancelled: "✖️ Бекор кардам — ҳеҷ чиз сабт нашуд",
    replaced: "✏️ Ислоҳ кардам — корти нав дар поён",
    stale: "Ин корт кӯҳна шуд — харҷҳоро боз фиристед",
    empty: "✖️ Сатр намонд — ҳеҷ чиз сабт нашуд",
    flagUnstated: "💱 асъор нишон дода нашудааст — санҷед",
    noCurrency: "💱 асъор дар ҳеҷ ҷо нишон дода нашудааст — бо сомонӣ ҳисоб мекунам, санҷед",
    flagMismatch: "💱 асъор аз дигар сатрҳо фарқ дорад — санҷед",
    flagSuspicious: "⚠️ маблағро санҷед: барои ин модда аз муқаррарӣ хеле зиёд аст",
    flagDuplicate: (day: string) => `⚠️ ба харҷи ${day} сабтшуда монанд аст`,
    flagSalary: "ба «Дигар харҷҳо» сабт мекунам — кормандро дар CRM нишон диҳед",
    flagAds: "ба «Дигар харҷҳо» сабт мекунам — канали рекламаро дар CRM нишон диҳед",
    skippedHead: "⚠️ Сабт намекунам:",
    skip: {
      unreadable: "хонда нашуд", ambiguous: "маълум нест, кадом рақам маблағ аст", negative: "маблағ бо аломати минус",
      unsupported_currency: (c?: string) => `асъори ${c ?? ""} ҳоло дастгирӣ намешавад — бо сомонӣ ё $ нависед`,
    },
    lines: (list: string) => `сатрҳои ${list}`,
    readUpTo: (n: number) => `⚠️ То сатри ${n} хондам — боқимондаро бо акси алоҳида фиристед, бо корти нав илова мекунам.`,
    tjs: "сомонӣ",
  },
} as const;

function plural(n: number, forms: [string, string, string]): string {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? forms[0] : a >= 2 && a <= 4 && (b < 12 || b > 14) ? forms[1] : forms[2];
}

export const cardLang = (lang: BatchArgs["lang"]): CardLang => (lang === "tg" ? "tg" : "ru");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const num = (amount: number) => amount.toLocaleString("ru-RU", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 }).replace(/[  ]/g, " ");
const tjsText = (lang: CardLang, cents: number) => `${num(fromCents(cents))} ${TEXT[lang].tjs}`;
const rowCents = (row: BatchRow, money: MoneyContext) => expenseCentsToTjs({ amount: row.amount, currency: row.currency, exchangeRate: null }, money);

/** Итог пачки в сомони по курсу CRM (lib/money.ts), без своей арифметики. */
export function batchTotalCents(args: BatchArgs, money: MoneyContext): number {
  return args.items.reduce((sum, row) => sum + rowCents(row, money), 0);
}

/** Всё, что карточке нужно знать из базы: курс, разделы после разбора, пометки строк. */
export interface CardContext {
  money: MoneyContext;
  rateUpdatedAt: Date | null;
  categories: BatchRow["category"][];
  categoryTitles: (string | undefined)[];
  flags: string[][];
  /** Валюты не было ни в одной строке: одна строка под итогом вместо пометки у каждой. */
  noCurrencyAnywhere: boolean;
}

/**
 * Пометки строк (ревью и решение владельца 10.11.2026). Сумма «на порядок выше обычной» —
 * сравнение с медианой той же статьи за 3 месяца (не меньше трёх записей); «похоже на уже
 * записанное» — то же название, сумма и валюта за 60 дней.
 */
export async function loadCardContext(args: BatchArgs): Promise<CardContext> {
  const lang = cardLang(args.lang);
  const t = TEXT[lang];
  const usd = args.items.some((row) => row.currency === "USD");
  const rateInfo = usd ? await loadUsdRateInfo() : null;
  const money = usd && rateInfo?.rate ? { usdToTjs: rateInfo.rate } : await loadMoneyContext();
  const resolved = await resolveRows(args);
  const majority = batchCurrency(args.items);
  const mixed = new Set(args.items.filter((row) => !row.currencyUnstated).map((row) => row.currency)).size > 1;
  const noCurrencyAnywhere = args.items.every((row) => row.currencyUnstated);
  const since = new Date(Date.now() - 92 * 86_400_000);
  const history = await prisma.expense.findMany({
    where: { deletedAt: null, status: "PAID", createdAt: { gte: since } },
    select: { note: true, category: true, amount: true, currency: true, exchangeRate: true, createdAt: true },
    take: 20_001,
  });
  const byArticle = new Map<string, number[]>();
  for (const row of history) {
    const key = articleOf("ru", { title: row.note ?? "", category: row.category }).key;
    byArticle.set(key, [...(byArticle.get(key) ?? []), expenseCentsToTjs(row, money)]);
  }
  const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
  const recent = history.filter((row) => row.createdAt.getTime() > Date.now() - 60 * 86_400_000);
  const flags = args.items.map((row, i) => {
    const out: string[] = [];
    if (row.currencyUnstated && !noCurrencyAnywhere) out.push(t.flagUnstated);
    else if (mixed && row.currency !== majority) out.push(t.flagMismatch);
    const sample = byArticle.get(articleOf("ru", { title: row.title, category: resolved[i]!.body.category as BatchRow["category"] }).key);
    if (sample && sample.length >= 3 && rowCents(row, money) >= SUSPICIOUS_RATIO * Math.max(1, median(sample))) out.push(t.flagSuspicious);
    const twin = recent.find((past) => (past.note ?? "").trim().toLowerCase() === row.title.trim().toLowerCase()
      && Number(past.amount) === row.amount && past.currency === row.currency);
    if (twin) out.push(t.flagDuplicate(dayWords(lang, twin.createdAt.toISOString().slice(0, 10))));
    if (resolved[i]!.downgraded) out.push(resolved[i]!.downgraded === "salary" ? t.flagSalary : t.flagAds);
    return out;
  });
  return {
    money, rateUpdatedAt: rateInfo?.updatedAt ?? null,
    categories: resolved.map((row) => row.body.category as BatchRow["category"]),
    categoryTitles: resolved.map((row) => row.categoryTitle),
    flags, noCurrencyAnywhere,
  };
}

/** Строка суммы: сомони как есть, доллар — с пересчётом по курсу, который запишется. */
function amountLine(lang: CardLang, row: BatchRow, money: MoneyContext): string {
  if (row.currency !== "USD") return num(row.amount);
  if (row.status === "PLANNED") return `${num(row.amount)} $ · ${TEXT[lang].rateLater}`;
  return `${num(row.amount)} $ × ${num(money.usdToTjs)} = ${tjsText(lang, rowCents(row, money))}`;
}

function skippedText(lang: CardLang, notes: CardNotes): string[] {
  const t = TEXT[lang];
  const out: string[] = [];
  if (notes.skipped?.length) {
    const groups = new Map<string, number[]>();
    for (const s of notes.skipped) {
      const label = s.reason === "unsupported_currency" ? t.skip.unsupported_currency(s.currency) : t.skip[s.reason];
      groups.set(label, [...(groups.get(label) ?? []), s.line]);
    }
    out.push([t.skippedHead, ...[...groups].map(([label, lines]) => `• ${t.lines(lines.slice(0, 30).join(", "))}${lines.length > 30 ? "…" : ""} — ${label}`)].join("\n"));
  }
  if (notes.readUpTo) out.push(t.readUpTo(notes.readUpTo));
  return out;
}

export interface CardRender { pages: string[]; rowPage: number[] }

/** Страницы карточки. `rowPage[i]` — на какой странице строка i (для кнопок «Править»). */
export function renderExpenseCard(args: BatchArgs, ctx: CardContext, notes: CardNotes = {}): CardRender {
  const lang = cardLang(args.lang);
  const t = TEXT[lang];
  const months = [...new Set(args.items.map((row) => row.month))];
  const today = todayExpenseDay();
  const head = `🧾 <b>${months.length === 1 ? monthWords(lang, months[0]!, today.slice(0, 4)) : t.expenses} · ${t.count(args.items.length)}</b>`;
  const groups = new Map<string, { icon: string; name: string; cents: number; rows: { i: number; line: string }[] }>();
  args.items.forEach((row, i) => {
    const article = articleOf(lang, { title: row.title, category: ctx.categories[i] ?? row.category, categoryTitle: ctx.categoryTitles[i] ?? row.categoryTitle });
    const group = groups.get(article.key) ?? { icon: article.icon, name: article.name, cents: 0, rows: [] };
    group.cents += rowCents(row, ctx.money);
    // Без дня — только месяц; он уже в заголовке, если месяц у пачки один.
    const when = row.date ? dayWords(lang, row.date) : months.length > 1 ? monthWords(lang, row.month, today.slice(0, 4)) : null;
    const flags = (ctx.flags[i] ?? []).map((f) => `\n   ${esc(f)}`).join("");
    group.rows.push({ i, line: `${i + 1}. ${esc(row.title)} — ${esc(amountLine(lang, row, ctx.money))}${when ? ` · <i>${esc(when)}</i>` : ""}${row.status === "PLANNED" ? ` · ⏳ ${t.planned}` : ""}${flags}` });
    groups.set(article.key, group);
  });
  const usd = args.items.some((row) => row.currency === "USD");
  const foot = [
    `💰 <b>${t.total}: ${tjsText(lang, batchTotalCents(args, ctx.money))}</b>`,
    ...(ctx.noCurrencyAnywhere ? [esc(args.items[0]?.currency === "USD" ? t.flagUnstated : t.noCurrency)] : []),
    ...(usd ? [`<i>${esc(t.rate(num(ctx.money.usdToTjs), ctx.rateUpdatedAt ? dayWords(lang, ctx.rateUpdatedAt.toISOString().slice(0, 10)) : null))}</i>`] : []),
    ...skippedText(lang, notes).map(esc),
  ].join("\n");
  const budget = PAGE_CHARS - head.length - foot.length - 8;
  const pages: string[][] = [[]];
  const rowPage: number[] = [];
  let used = 0;
  let pageRows = 0;
  const block = (title: string, lines: string[]) =>
    `${title}\n${lines.length > 3 ? `<blockquote expandable>${lines.join("\n")}</blockquote>` : lines.join("\n")}`;
  for (const group of groups.values()) {
    const title = `<b>${group.icon} ${esc(group.name)} · ${tjsText(lang, group.cents)}</b>`;
    let chunk: { i: number; line: string }[] = [];
    let continued = false;
    const flush = () => {
      if (!chunk.length) return;
      const text = block(continued ? `${title} <i>(${t.more})</i>` : title, chunk.map((r) => r.line));
      if ((used + text.length > budget || pageRows + chunk.length > PAGE_ROWS) && pages.at(-1)!.length) { pages.push([]); used = 0; pageRows = 0; }
      pages.at(-1)!.push(text);
      used += text.length + 2;
      pageRows += chunk.length;
      for (const r of chunk) rowPage[r.i] = pages.length - 1;
      chunk = [];
      continued = true;
    };
    for (const row of group.rows) {
      const projected = block(title, [...chunk, row].map((r) => r.line)).length;
      if (chunk.length && (used + projected > budget || pageRows + chunk.length + 1 > PAGE_ROWS)) flush();
      chunk.push(row);
    }
    flush();
  }
  return { pages: pages.map((blocks) => [head, ...blocks, foot].join("\n\n")), rowPage };
}

function keyboard(lang: CardLang, bundleId: string, page: number, pages: number): TelegramInlineButton[][] {
  const t = TEXT[lang];
  return [
    ...(pages > 1 ? [[
      { text: "◀️", callback_data: `ax:pg:${bundleId}:${Math.max(0, page - 1)}` },
      { text: `${page + 1}/${pages}`, callback_data: "ax:nop:" },
      { text: "▶️", callback_data: `ax:pg:${bundleId}:${Math.min(pages - 1, page + 1)}` },
    ]] : []),
    [
      { text: t.write, callback_data: `as:ok:${bundleId}` },
      { text: t.fix, callback_data: `ax:fx:${bundleId}:${page}` },
      { text: t.cancel, callback_data: `as:no:${bundleId}` },
    ],
  ];
}

/** Связка из одного действия — тот же `bundleId`, что у общих кнопок `as:ok|no`. */
async function bindSingle(actionId: string, agentId: string): Promise<string | null> {
  const bundleId = randomUUID();
  const bound = await prisma.assistantAction.updateMany({
    where: { id: actionId, agentId, status: "PENDING", bundleId: null, expiresAt: { gt: new Date() } },
    data: { bundleId },
  });
  if (bound.count === 1) return bundleId;
  const row = await prisma.assistantAction.findUnique({ where: { id: actionId }, select: { bundleId: true, status: true, agentId: true } });
  return row?.status === "PENDING" && row.agentId === agentId && row.bundleId
    && (await prisma.assistantAction.count({ where: { bundleId: row.bundleId } })) === 1 ? row.bundleId : null;
}

async function loadBatch(bundleId: string, agentId: string) {
  const rows = await prisma.assistantAction.findMany({ where: { bundleId }, take: 2 });
  const row = rows.length === 1 ? rows[0]! : null;
  if (!row || row.tool !== ADD_EXPENSES_TOOL || row.agentId !== agentId) return null;
  return { row, args: parseBatchArgs(row.args) };
}

/** Отправить карточку пачки. false — карточка не ушла (действие погашено, если не привязалось). */
export async function sendExpenseBatchCard(
  chatId: string, action: Pick<AssistantActionView, "id">, agentId: string, replyTo?: number, notes: CardNotes = {},
): Promise<boolean> {
  const bundleId = await bindSingle(action.id, agentId);
  if (!bundleId) return false;
  const loaded = await loadBatch(bundleId, agentId);
  if (!loaded) return false;
  if (notes.skipped?.length || notes.readUpTo) await rememberNotes(loaded.row.id, notes);
  const lang = cardLang(loaded.args.lang);
  const { pages } = renderExpenseCard(loaded.args, await loadCardContext(loaded.args), notes);
  await sendHtmlMessage(chatId, pages[0]!, replyTo, keyboard(lang, bundleId, 0, pages.length));
  return true;
}

/** Пометки «не записываю строки…» живут с действием, чтобы листание их не теряло. */
async function rememberNotes(actionId: string, notes: CardNotes) {
  await prisma.assistantAction.update({ where: { id: actionId }, data: { statusReason: JSON.stringify(notes).slice(0, 4000) } }).catch(() => undefined);
}
function notesOf(row: { statusReason: string | null }): CardNotes {
  try {
    const parsed = row.statusReason ? JSON.parse(row.statusReason) as CardNotes : {};
    const skipped = Array.isArray(parsed.skipped)
      ? parsed.skipped.filter((s) => s && Number.isInteger(s.line) && ["unreadable", "negative", "unsupported_currency", "ambiguous"].includes(s.reason)).slice(0, 200)
      : undefined;
    return { ...(skipped?.length ? { skipped } : {}), ...(Number.isInteger(parsed.readUpTo) ? { readUpTo: parsed.readUpTo } : {}) };
  } catch { return {}; }
}

/** Текст после «Записать» / «Отмена» для пачки расходов; null — это не пачка расходов. */
export async function expenseBatchOutcomeText(actions: readonly { tool: string; args: unknown }[], executed: boolean): Promise<string | null> {
  if (actions.length !== 1 || actions[0]!.tool !== ADD_EXPENSES_TOOL) return null;
  const args = parseBatchArgs(actions[0]!.args);
  const lang = cardLang(args.lang);
  if (!executed) return TEXT[lang].cancelled;
  const usd = args.items.some((row) => row.currency === "USD");
  const rate = usd ? (await loadUsdRateInfo()).rate : null;
  const money = rate ? { usdToTjs: rate } : await loadMoneyContext();
  return TEXT[lang].done(args.items.length, tjsText(lang, batchTotalCents(args, money)));
}

async function freshActor(agentId: string): Promise<AssistantActionActor | null> {
  const access = await loadAgentAccess(agentId);
  if (!access?.isActive) return null;
  return { agentId, channel: "telegram", telegramPrivate: true, can: (p) => access.permissions.has(p) };
}

/** Старое действие гасится, новое (с изменёнными строками) получает свою карточку. */
async function replaceBatch(bundleId: string, agentId: string, change: (args: BatchArgs) => BatchArgs) {
  const loaded = await loadBatch(bundleId, agentId);
  const actor = await freshActor(agentId);
  if (!loaded || !actor || loaded.row.status !== "PENDING" || loaded.row.expiresAt <= new Date()) return { kind: "stale" as const };
  const lang = cardLang(loaded.args.lang);
  const next = change(loaded.args);
  await discardPendingAssistantAction(loaded.row.id, actor);
  if (!next.items.length) return { kind: "empty" as const, lang };
  const action = await createPendingAssistantAction(actor, ADD_EXPENSES_TOOL, next);
  const newBundle = await bindSingle(action.id, agentId);
  if (!newBundle) return { kind: "stale" as const };
  const args = parseBatchArgs((await prisma.assistantAction.findUniqueOrThrow({ where: { id: action.id } })).args);
  return { kind: "replaced" as const, lang, bundleId: newBundle, args, notes: notesOf(loaded.row), actionId: action.id };
}

/** Ждём поправку строки: метка лежит в состоянии диалога помощницы, история не теряется. */
async function rememberFix(chatId: string, agentId: string, fix: { bundleId: string; row: number; messageId: number }) {
  const state = await prisma.telegramDialogState.findUnique({ where: { chatId } });
  if (state && state.kind !== DIALOG_KIND && state.expiresAt > new Date()) return false;
  const live = state && state.kind === DIALOG_KIND && state.agentId === agentId && state.expiresAt > new Date();
  const messages = live ? (state.payload as { messages?: unknown }).messages ?? [] : [];
  const data = { agentId, kind: DIALOG_KIND, payload: { messages, expenseFix: { ...fix, until: Date.now() + FIX_TTL_MS } } as object, expiresAt: new Date(Date.now() + FIX_TTL_MS) };
  await prisma.telegramDialogState.upsert({ where: { chatId }, create: { chatId, ...data }, update: data });
  return true;
}

async function peekFix(chatId: string, agentId: string) {
  const state = await prisma.telegramDialogState.findUnique({ where: { chatId } });
  if (!state || state.kind !== DIALOG_KIND || state.agentId !== agentId) return null;
  const payload = state.payload as { messages?: unknown; expenseFix?: { bundleId?: unknown; row?: unknown; messageId?: unknown; until?: unknown } };
  const fix = payload.expenseFix;
  if (!fix || typeof fix.bundleId !== "string" || !Number.isInteger(fix.row) || !Number.isInteger(fix.messageId) || Number(fix.until) < Date.now()) return null;
  return { bundleId: fix.bundleId, row: Number(fix.row), messageId: Number(fix.messageId), messages: payload.messages ?? [] };
}

async function clearFix(chatId: string, messages: unknown) {
  await prisma.telegramDialogState.updateMany({ where: { chatId, kind: DIALOG_KIND }, data: { payload: { messages } as object } });
}

const AMOUNT_WORDS = /^(?:(?:сомони|сомонӣ|с\.?|tjs|usd|доллар\p{L}*|dollars?|тыс\.?|т\.?|тысяч\p{L}*|млн|миллион\p{L}*|ming|ҳазор|хазор|k|руб\p{L}*|евро|eur)(?:\s+|$))*$/iu;
const TG_MONTHS = ["январ", "феврал", "март", "апрел", "май", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
const RU_MONTHS = ["янв", "фев", "мар", "апр", "ма", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/**
 * Поправка одной строки словами человека — без модели (ревью 10.11.2026, п. 13). Сумма — тем же
 * разборщиком, что таблица (`parseExpenseAmount`: «1 200», «1.200», «12.10», «$40»). Дата — только
 * однозначная: «5 ноя», «05.11.2026», «вчера»/«дирӯз»; «5.5» и «12.10» — суммы, а не даты.
 * Остальные слова — название. Ничего не понятно — null.
 */
export function applyRowCorrection(row: BatchRow, text: string, today = todayExpenseDay()): BatchRow | null {
  let rest = ` ${text.trim()} `;
  let date: string | undefined;
  const yesterday = new Date(`${today}T00:00:00Z`); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayWord = /\s(?:вчера|дирӯз|дируз|kecha|yesterday)(?=\s)/iu;
  const todayWord = /\s(?:сегодня|имрӯз|имруз|bugun|today)(?=\s)/iu;
  if (yesterdayWord.test(rest)) { date = yesterday.toISOString().slice(0, 10); rest = rest.replace(yesterdayWord, " "); }
  if (todayWord.test(rest)) { date = today; rest = rest.replace(todayWord, " "); }
  const dotted = /\s(\d{1,2})[./](\d{1,2})[./](\d{4})(?=\s)/u.exec(rest);
  if (dotted) { date = `${dotted[3]}-${dotted[2]!.padStart(2, "0")}-${dotted[1]!.padStart(2, "0")}`; rest = rest.replace(dotted[0], " "); }
  // «05.11» — день с ведущим нулём: дата без года, а не сумма 5,11 («12.10» и «5.5» остаются суммами).
  const zeroDay = !date ? /\s(0[1-9])[./](0[1-9]|1[0-2])(?=\s)/u.exec(rest) : null;
  if (zeroDay) { date = `${today.slice(0, 4)}-${zeroDay[2]}-${zeroDay[1]}`; rest = rest.replace(zeroDay[0], " "); }
  const worded = /\s(\d{1,2})\s+([а-яёӣӯқғҳҷ]+)(?=\s)/iu.exec(rest);
  if (!date && worded) {
    const word = worded[2]!.toLowerCase();
    const month = [TG_MONTHS, RU_MONTHS].map((list) => list.findIndex((m) => word.startsWith(m))).find((i) => i >= 0);
    if (month !== undefined) { date = `${today.slice(0, 4)}-${String(month + 1).padStart(2, "0")}-${worded[1]!.padStart(2, "0")}`; rest = rest.replace(worded[0], " "); }
  }
  if (date && !/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  const words = rest.trim().split(/\s+/u).filter(Boolean);
  // Сумма — хвост слов, который разборщик принимает целиком («1 200», «$40», «400 сомони», «2 тыс»).
  let amount: number | undefined;
  let currency: BatchRow["currency"] | undefined;
  for (let take = Math.min(words.length, 4); take >= 1 && amount === undefined; take--) {
    const tail = words.slice(-take).join(" ");
    // В хвосте суммы — только число и слова валюты/«тыс»: «Интернет Babilon 450» — название и сумма.
    if (!/\d/u.test(tail) || !AMOUNT_WORDS.test(tail.replace(/[\d\s.,$()€₽−–-]+/gu, " ").trim())) continue;
    const parsed = parseExpenseAmount(tail);
    if (parsed.ok) {
      amount = parsed.amount;
      currency = parsed.currency;
      words.splice(words.length - take, take);
    } else if (parsed.reason === "unsupported_currency" || parsed.reason === "negative") return null;
  }
  const leftover = words.join(" ");
  if (!currency) currency = currencyInText(leftover).currency;
  const title = leftover.replace(/\$|долларов|доллара|доллар|usd|сомони|сомонӣ|tjs/giu, " ").replace(/[—–-]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (/\d/u.test(title)) return null;
  if (amount === undefined && !date && !currency && !/\p{L}/u.test(title)) return null;
  const nextDate = date ?? row.date;
  const month = nextDate ? nextDate.slice(0, 7) : row.month;
  const future = nextDate ? nextDate > today : month > today.slice(0, 7);
  return {
    ...row,
    ...(title && /\p{L}/u.test(title) ? { title: title.slice(0, 200) } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(currency ? { currency, currencyUnstated: undefined } : {}),
    ...(nextDate ? { date: nextDate } : {}),
    month,
    status: future ? "PLANNED" : row.status === "PLANNED" && date ? "PAID" : row.status,
  };
}

/**
 * Текст или расшифровка голоса, пришедшие после «Править → строка N». true — это была поправка
 * (ответ уже отправлен), false — обычное сообщение, дальше по обычному пути. Метка «жду поправку»
 * снимается только после успешного разбора: непонятая поправка не уходит модели новой просьбой.
 */
export async function applyExpenseFixMessage(chatId: string, agentId: string, text: string, replyTo?: number): Promise<boolean> {
  const fix = await peekFix(chatId, agentId);
  if (!fix) return false;
  const loaded = await loadBatch(fix.bundleId, agentId);
  const lang = loaded ? cardLang(loaded.args.lang) : "ru";
  const current = loaded?.args.items[fix.row];
  if (!loaded || !current || loaded.row.status !== "PENDING") {
    await clearFix(chatId, fix.messages);
    await sendHtmlMessage(chatId, esc(TEXT[lang].stale), replyTo);
    return true;
  }
  const corrected = applyRowCorrection(current, text);
  if (!corrected) {
    await sendHtmlMessage(chatId, esc(TEXT[lang].notUnderstood), replyTo);
    return true;
  }
  await clearFix(chatId, fix.messages);
  const result = await replaceBatch(fix.bundleId, agentId, (args) => ({ ...args, items: args.items.map((row, i) => (i === fix.row ? corrected : row)) }))
    .catch((err: unknown) => ({ kind: "error" as const, message: err instanceof AssistantActionError ? err.message : TEXT[lang].stale }));
  if (result.kind === "error") { await sendHtmlMessage(chatId, esc(result.message), replyTo); return true; }
  if (result.kind !== "replaced") { await sendHtmlMessage(chatId, esc(TEXT[lang][result.kind === "empty" ? "empty" : "stale"]), replyTo); return true; }
  await editHtmlMessage(chatId, fix.messageId, esc(TEXT[lang].replaced), null).catch(() => undefined);
  if (result.notes.skipped?.length || result.notes.readUpTo) await rememberNotes(result.actionId, result.notes);
  const { pages } = renderExpenseCard(result.args, await loadCardContext(result.args), result.notes);
  await sendHtmlMessage(chatId, pages[0]!, replyTo, keyboard(result.lang, result.bundleId, 0, pages.length));
  return true;
}

/** Кнопки `ax:*`: листать, «Править», выбрать строку, убрать строку. true — наша кнопка. */
export async function handleExpenseCardCallback(query: TelegramCallbackQuery, agentId: string | null): Promise<boolean> {
  if (!query.data?.startsWith("ax:")) return false;
  const match = CALLBACK.exec(query.data);
  const ack = (text?: string) => answerCallbackQuery(query.id, text).catch(() => undefined);
  const chat = query.message?.chat;
  const messageId = query.message?.message_id;
  if (!match || match[1] === "nop" || !match[2] || !chat || chat.type !== "private" || !messageId || !agentId) { await ack(); return true; }
  const [, verb, bundleId, rawIndex] = match;
  const index = Number(rawIndex ?? 0);
  const chatId = String(chat.id);
  const loaded = await loadBatch(bundleId!, agentId);
  if (!loaded || loaded.row.status !== "PENDING" || loaded.row.expiresAt <= new Date()) {
    await ack(TEXT[loaded ? cardLang(loaded.args.lang) : "ru"].stale);
    return true;
  }
  const lang = cardLang(loaded.args.lang);
  const t = TEXT[lang];
  const notes = notesOf(loaded.row);
  const render = renderExpenseCard(loaded.args, await loadCardContext(loaded.args), notes);
  const page = Math.min(Math.max(0, verb === "pg" || verb === "fx" ? index : render.rowPage[index] ?? 0), render.pages.length - 1);
  if (verb === "pg") {
    await editHtmlMessage(chatId, messageId, render.pages[page]!, keyboard(lang, bundleId!, page, render.pages.length)).catch(() => undefined);
    await ack();
    return true;
  }
  if (verb === "fx") {
    const rows = loaded.args.items.map((_, i) => i).filter((i) => render.rowPage[i] === page);
    const buttons: TelegramInlineButton[][] = [];
    for (let i = 0; i < rows.length; i += 6) buttons.push(rows.slice(i, i + 6).map((r) => ({ text: String(r + 1), callback_data: `ax:rw:${bundleId}:${r}` })));
    buttons.push([{ text: t.back, callback_data: `ax:pg:${bundleId}:${page}` }]);
    await editHtmlMessage(chatId, messageId, `${render.pages[page]}\n\n${esc(t.pickRow)}`, buttons).catch(() => undefined);
    await ack();
    return true;
  }
  if (!Number.isInteger(index) || index < 0 || index >= loaded.args.items.length) { await ack(t.stale); return true; }
  if (verb === "rw") {
    await rememberFix(chatId, agentId, { bundleId: bundleId!, row: index, messageId });
    await editHtmlMessage(chatId, messageId, `${render.pages[page]}\n\n${esc(t.rowPrompt(index + 1))}`, [[
      { text: t.remove, callback_data: `ax:rm:${bundleId}:${index}` },
      { text: t.back, callback_data: `ax:pg:${bundleId}:${page}` },
    ]]).catch(() => undefined);
    await ack();
    return true;
  }
  // rm: убрать строку до записи — новая пачка без неё, карточка на том же месте.
  const result = await replaceBatch(bundleId!, agentId, (args) => ({ ...args, items: args.items.filter((_, i) => i !== index) }))
    .catch(() => ({ kind: "stale" as const }));
  if (result.kind === "replaced") {
    if (result.notes.skipped?.length || result.notes.readUpTo) await rememberNotes(result.actionId, result.notes);
    const next = renderExpenseCard(result.args, await loadCardContext(result.args), result.notes);
    const nextPage = Math.min(page, next.pages.length - 1);
    await editHtmlMessage(chatId, messageId, next.pages[nextPage]!, keyboard(result.lang, result.bundleId, nextPage, next.pages.length)).catch(() => undefined);
  } else {
    await editHtmlMessage(chatId, messageId, esc(t[result.kind === "empty" ? "empty" : "stale"]), null).catch(() => undefined);
  }
  await ack();
  return true;
}
