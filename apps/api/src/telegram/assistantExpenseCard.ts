import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { loadAgentAccess } from "../auth/middleware.js";
import {
  AssistantActionError, createPendingAssistantAction, discardPendingAssistantAction,
  type AssistantActionActor, type AssistantActionView,
} from "../lib/assistantActions.js";
import { todayExpenseDay } from "../lib/expenseWorkspace.js";
import { expenseCentsToTjs, fromCents, loadMoneyContext, type MoneyContext } from "../lib/money.js";
import { articleOf, dayWords, monthWords, type CardLang } from "../ai/assistant/expenseArticles.js";
import { ADD_EXPENSES_TOOL, parseBatchArgs, type BatchArgs, type BatchRow } from "../ai/assistant/tools/expenseBatchTool.js";
import { answerCallbackQuery, editHtmlMessage, sendHtmlMessage, type TelegramCallbackQuery, type TelegramInlineButton } from "./api.js";

/**
 * КАРТОЧКА «ПРОВЕРЬТЕ РАСХОДЫ» В TELEGRAM (10.11.2026, вариант «А, по статьям» — выбор владельца).
 *
 * Одна карточка на пачку любого размера: статьи с иконкой и суммой, строки «Аренда — 5 000 · 1 ноя»,
 * длинная статья — свёрнутой цитатой; не влезает в 4096 знаков — страницы «◀️ 1/3 ▶️», а кнопки
 * «✅ Записать · ✏️ Править · ✖️ Отмена» одни на всю пачку. Записывает кнопка «Записать» — она же
 * `as:ok:<связка>` общего брокера (одно исполнение при двойном нажатии). Язык — собеседника
 * (ru или tg, `lang` в аргументах пачки).
 *
 * «Править» — выбрать строку кнопкой, потом написать или сказать поправку; «Убрать строку» —
 * до записи. Правка не меняет действие на месте: старое гасится, создаётся новое с новой карточкой,
 * чтобы подтверждали ровно то, что видно.
 */

const PAGE_CHARS = 3500;
const CALLBACK = /^ax:(pg|fx|rw|rm|nop):([0-9a-f-]{36})?(?::(\d{1,4}))?$/u;
const FIX_TTL_MS = 10 * 60_000;
const DIALOG_KIND = "assistant";

const TEXT = {
  ru: {
    count: (n: number) => `${n} ${plural(n, ["расход", "расхода", "расходов"])}`,
    expenses: "Расходы", total: "Итого", planned: "ждёт оплаты", more: "продолжение",
    rate: (r: number) => `$ по курсу CRM: 1 $ = ${r} с.`,
    write: "✅ Записать", fix: "✏️ Править", cancel: "✖️ Отмена", back: "↩️ Назад", remove: "🗑 Убрать строку",
    pickRow: "✏️ Какую строку поправить? Нажмите её номер.",
    rowPrompt: (n: number) => `✏️ Строка ${n}. Напишите или скажите поправку — например «450» или «Интернет 450 5 ноя».`,
    done: (n: number, total: string) => `✅ Записала ${n} ${plural(n, ["расход", "расхода", "расходов"])} на ${total}`,
    cancelled: "✖️ Отменила — ничего не записала",
    replaced: "✏️ Поправила — новая карточка ниже",
    stale: "Карточка устарела — пришлите расходы ещё раз",
    empty: "✖️ Строк не осталось — ничего не записала",
    unreadable: (rows: string) => `⚠️ Не прочитались строки ${rows} — допишите их сообщением, я добавлю отдельной карточкой.`,
    tjs: "с.",
  },
  tg: {
    count: (n: number) => `${n} харҷ`,
    expenses: "Харҷҳо", total: "Ҳамагӣ", planned: "ҳанӯз пардохт нашудааст", more: "давомаш",
    rate: (r: number) => `$ бо қурби CRM: 1 $ = ${r} сомонӣ`,
    write: "✅ Сабт кардан", fix: "✏️ Ислоҳ", cancel: "✖️ Бекор", back: "↩️ Бозгашт", remove: "🗑 Ин сатрро нест кардан",
    pickRow: "✏️ Кадом сатрро ислоҳ кунам? Рақамашро пахш кунед.",
    rowPrompt: (n: number) => `✏️ Сатри ${n}. Ислоҳро нависед ё бо овоз гӯед — масалан «450» ё «Интернет 450 5 ноябр».`,
    done: (n: number, total: string) => `✅ ${n} харҷро ба маблағи ${total} сабт кардам`,
    cancelled: "✖️ Бекор кардам — ҳеҷ чиз сабт нашуд",
    replaced: "✏️ Ислоҳ кардам — корти нав дар поён",
    stale: "Ин корт кӯҳна шуд — харҷҳоро боз фиристед",
    empty: "✖️ Сатр намонд — ҳеҷ чиз сабт нашуд",
    unreadable: (rows: string) => `⚠️ Сатрҳои ${rows} хонда нашуданд — онҳоро бо паём нависед, алоҳида илова мекунам.`,
    tjs: "сомонӣ",
  },
} as const;

function plural(n: number, forms: [string, string, string]): string {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? forms[0] : a >= 2 && a <= 4 && (b < 12 || b > 14) ? forms[1] : forms[2];
}

export const cardLang = (lang: BatchArgs["lang"]): CardLang => (lang === "tg" ? "tg" : "ru");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const num = (amount: number) => amount.toLocaleString("ru-RU", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 }).replace(/ /g, " ");
const rowAmount = (row: BatchRow) => (row.currency === "USD" ? `$${num(row.amount)}` : num(row.amount));
const tjsText = (lang: CardLang, cents: number) => `${num(fromCents(cents))} ${TEXT[lang].tjs}`;

/** Итог пачки в сомони по курсу CRM (lib/money.ts), без своей арифметики. */
export function batchTotalCents(args: BatchArgs, money: MoneyContext): number {
  return args.items.reduce((sum, row) => sum + expenseCentsToTjs({ amount: row.amount, currency: row.currency, exchangeRate: null }, money), 0);
}

export interface CardRender { pages: string[]; rowPage: number[] }

/** Страницы карточки. `rowPage[i]` — на какой странице строка i (для кнопок «Править»). */
export function renderExpenseCard(args: BatchArgs, money: MoneyContext, notes: { unreadable?: number[] } = {}): CardRender {
  const lang = cardLang(args.lang);
  const t = TEXT[lang];
  const months = [...new Set(args.items.map((row) => row.month))];
  const today = todayExpenseDay();
  const head = `🧾 <b>${months.length === 1 ? monthWords(lang, months[0]!, today.slice(0, 4)) : t.expenses} · ${t.count(args.items.length)}</b>`;
  const groups = new Map<string, { icon: string; name: string; cents: number; rows: { i: number; line: string }[] }>();
  args.items.forEach((row, i) => {
    const article = articleOf(lang, row);
    const group = groups.get(article.key) ?? { icon: article.icon, name: article.name, cents: 0, rows: [] };
    group.cents += expenseCentsToTjs({ amount: row.amount, currency: row.currency, exchangeRate: null }, money);
    // Без дня — только месяц; он уже в заголовке, если месяц у пачки один.
    const when = row.date ? dayWords(lang, row.date) : months.length > 1 ? monthWords(lang, row.month, today.slice(0, 4)) : null;
    group.rows.push({ i, line: `${i + 1}. ${esc(row.title)} — ${rowAmount(row)}${when ? ` · <i>${esc(when)}</i>` : ""}${row.status === "PLANNED" ? ` · ⏳ ${t.planned}` : ""}` });
    groups.set(article.key, group);
  });
  const total = batchTotalCents(args, money);
  const foot = [
    `💰 <b>${t.total}: ${tjsText(lang, total)}</b>`,
    ...(args.items.some((row) => row.currency === "USD") ? [`<i>${esc(t.rate(money.usdToTjs))}</i>`] : []),
    ...(notes.unreadable?.length ? [esc(t.unreadable(notes.unreadable.join(", ")))] : []),
  ].join("\n");
  const budget = PAGE_CHARS - head.length - foot.length - 8;
  const pages: string[][] = [[]];
  const rowPage: number[] = [];
  let used = 0;
  const block = (title: string, lines: string[]) =>
    `${title}\n${lines.length > 3 ? `<blockquote expandable>${lines.join("\n")}</blockquote>` : lines.join("\n")}`;
  for (const group of groups.values()) {
    const title = `<b>${group.icon} ${esc(group.name)} · ${tjsText(lang, group.cents)}</b>`;
    let chunk: { i: number; line: string }[] = [];
    let continued = false;
    const flush = () => {
      if (!chunk.length) return;
      const text = block(continued ? `${title} <i>(${t.more})</i>` : title, chunk.map((r) => r.line));
      if (used + text.length > budget && pages.at(-1)!.length) { pages.push([]); used = 0; }
      pages.at(-1)!.push(text);
      used += text.length + 2;
      for (const r of chunk) rowPage[r.i] = pages.length - 1;
      chunk = [];
      continued = true;
    };
    for (const row of group.rows) {
      const projected = block(title, [...chunk, row].map((r) => r.line)).length;
      if (chunk.length && (used + projected > budget)) flush();
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

interface CardNotes { unreadable?: number[] }

/** Отправить карточку пачки. false — карточка не ушла (действие погашено, если не привязалось). */
export async function sendExpenseBatchCard(
  chatId: string, action: Pick<AssistantActionView, "id">, agentId: string, replyTo?: number, notes: CardNotes = {},
): Promise<boolean> {
  const bundleId = await bindSingle(action.id, agentId);
  if (!bundleId) return false;
  const loaded = await loadBatch(bundleId, agentId);
  if (!loaded) return false;
  if (notes.unreadable?.length) await rememberNotes(loaded.row.id, notes);
  const lang = cardLang(loaded.args.lang);
  const { pages } = renderExpenseCard(loaded.args, await loadMoneyContext(), notes);
  await sendHtmlMessage(chatId, pages[0]!, replyTo, keyboard(lang, bundleId, 0, pages.length));
  return true;
}

/** Пометка «не прочитались строки» живёт с действием, чтобы листание её не теряло. */
async function rememberNotes(actionId: string, notes: CardNotes) {
  await prisma.assistantAction.update({ where: { id: actionId }, data: { statusReason: JSON.stringify({ unreadable: notes.unreadable }) } }).catch(() => undefined);
}
function notesOf(row: { statusReason: string | null }): CardNotes {
  try {
    const parsed = row.statusReason ? JSON.parse(row.statusReason) as { unreadable?: unknown } : {};
    return Array.isArray(parsed.unreadable) ? { unreadable: parsed.unreadable.filter((n): n is number => Number.isInteger(n)).slice(0, 50) } : {};
  } catch { return {}; }
}

/** Текст после «Записать» / «Отмена» для пачки расходов; null — это не пачка расходов. */
export async function expenseBatchOutcomeText(actions: readonly { tool: string; args: unknown }[], executed: boolean): Promise<string | null> {
  if (actions.length !== 1 || actions[0]!.tool !== ADD_EXPENSES_TOOL) return null;
  const args = parseBatchArgs(actions[0]!.args);
  const lang = cardLang(args.lang);
  if (!executed) return TEXT[lang].cancelled;
  return TEXT[lang].done(args.items.length, tjsText(lang, batchTotalCents(args, await loadMoneyContext())));
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
  return { kind: "replaced" as const, lang, bundleId: newBundle, args: parseBatchArgs((await prisma.assistantAction.findUniqueOrThrow({ where: { id: action.id } })).args), notes: notesOf(loaded.row), actionId: action.id };
}

/** Ждём поправку строки: метка лежит в состоянии диалога помощницы, история не теряется. */
async function rememberFix(chatId: string, agentId: string, fix: { bundleId: string; row: number; messageId: number }) {
  const state = await prisma.telegramDialogState.findUnique({ where: { chatId } });
  const live = state && state.kind === DIALOG_KIND && state.agentId === agentId && state.expiresAt > new Date();
  const messages = live ? (state.payload as { messages?: unknown }).messages ?? [] : [];
  const data = { agentId, kind: DIALOG_KIND, payload: { messages, expenseFix: { ...fix, until: Date.now() + FIX_TTL_MS } } as object, expiresAt: new Date(Date.now() + FIX_TTL_MS) };
  if (state && state.kind !== DIALOG_KIND && state.expiresAt > new Date()) return false;
  await prisma.telegramDialogState.upsert({ where: { chatId }, create: { chatId, ...data }, update: data });
  return true;
}

async function takeFix(chatId: string, agentId: string) {
  const state = await prisma.telegramDialogState.findUnique({ where: { chatId } });
  if (!state || state.kind !== DIALOG_KIND || state.agentId !== agentId) return null;
  const payload = state.payload as { messages?: unknown; expenseFix?: { bundleId?: unknown; row?: unknown; messageId?: unknown; until?: unknown } };
  const fix = payload.expenseFix;
  if (!fix || typeof fix.bundleId !== "string" || !Number.isInteger(fix.row) || !Number.isInteger(fix.messageId) || Number(fix.until) < Date.now()) return null;
  await prisma.telegramDialogState.update({ where: { chatId }, data: { payload: { messages: payload.messages ?? [] } as object } });
  return { bundleId: fix.bundleId, row: Number(fix.row), messageId: Number(fix.messageId) };
}

const TG_MONTHS = ["январ", "феврал", "март", "апрел", "май", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
const RU_MONTHS = ["янв", "фев", "мар", "апр", "ма", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/**
 * Поправка одной строки словами человека — без модели: число — сумма, «$»/«доллар» — валюта,
 * дата («5 ноя», «05.11», «вчера»/«дирӯз») — день, остальные слова — название.
 */
export function applyRowCorrection(row: BatchRow, text: string, today = todayExpenseDay()): BatchRow | null {
  let rest = ` ${text.trim()} `;
  let date: string | undefined;
  const yesterday = new Date(`${today}T00:00:00Z`); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (/\s(?:вчера|дирӯз|дируз|kecha|yesterday)\s/iu.test(rest)) { date = yesterday.toISOString().slice(0, 10); rest = rest.replace(/\s(?:вчера|дирӯз|дируз|kecha|yesterday)(?=\s)/iu, " "); }
  if (/\s(?:сегодня|имрӯз|имруз|bugun|today)\s/iu.test(rest)) { date = today; rest = rest.replace(/\s(?:сегодня|имрӯз|имруз|bugun|today)(?=\s)/iu, " "); }
  const dotted = /\s(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?(?=\s)/u.exec(rest);
  if (dotted) { date = `${dotted[3] ?? today.slice(0, 4)}-${dotted[2]!.padStart(2, "0")}-${dotted[1]!.padStart(2, "0")}`; rest = rest.replace(dotted[0], " "); }
  const worded = /\s(\d{1,2})\s+([а-яёӣӯқғҳҷ]+)(?=\s)/iu.exec(rest);
  if (!date && worded) {
    const word = worded[2]!.toLowerCase();
    const month = [TG_MONTHS, RU_MONTHS].map((list) => list.findIndex((m) => word.startsWith(m))).find((i) => i >= 0);
    if (month !== undefined) { date = `${today.slice(0, 4)}-${String(month + 1).padStart(2, "0")}-${worded[1]!.padStart(2, "0")}`; rest = rest.replace(worded[0], " "); }
  }
  let currency: BatchRow["currency"] | undefined;
  if (/\$|доллар|usd|dollar/iu.test(rest)) { currency = "USD"; rest = rest.replace(/\$|долларов|доллара|доллар|usd|dollars?/giu, " "); }
  if (/сомон|сомонӣ|tjs|somoni/iu.test(rest)) { currency = "TJS"; rest = rest.replace(/сомони|сомонӣ|сомон|tjs|somoniy|somoni|(?<=\s)с\./giu, " "); }
  let amount: number | undefined;
  const numbers = [...rest.matchAll(/\d+(?:[  ]\d{3})*(?:[.,]\d{1,2})?/gu)];
  if (numbers.length) {
    const last = numbers.at(-1)!;
    amount = Number(last[0].replace(/[  ]/gu, "").replace(",", "."));
    rest = rest.slice(0, last.index!) + " " + rest.slice(last.index! + last[0].length);
  }
  const title = rest.replace(/[—–-]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  if (amount !== undefined && !(amount > 0 && amount <= 99_999_999.99)) return null;
  if (amount === undefined && !date && !currency && !/\p{L}/u.test(title)) return null;
  const nextDate = date ?? row.date;
  const month = nextDate ? nextDate.slice(0, 7) : row.month;
  const future = nextDate ? nextDate > today : month > today.slice(0, 7);
  return {
    ...row,
    ...(title && /\p{L}/u.test(title) ? { title: title.slice(0, 200) } : {}),
    ...(amount !== undefined ? { amount: Math.round(amount * 100) / 100 } : {}),
    ...(currency ? { currency } : {}),
    ...(nextDate ? { date: nextDate } : {}),
    month,
    status: future ? "PLANNED" : row.status === "PLANNED" && date ? "PAID" : row.status,
  };
}

/**
 * Текст или расшифровка голоса, пришедшие после «Править → строка N». true — это была поправка
 * (ответ уже отправлен), false — обычное сообщение, дальше по обычному пути.
 */
export async function applyExpenseFixMessage(chatId: string, agentId: string, text: string, replyTo?: number): Promise<boolean> {
  const fix = await takeFix(chatId, agentId);
  if (!fix) return false;
  const loaded = await loadBatch(fix.bundleId, agentId);
  const lang = loaded ? cardLang(loaded.args.lang) : "ru";
  const current = loaded?.args.items[fix.row];
  const corrected = current ? applyRowCorrection(current, text) : null;
  if (!loaded || !current) {
    await sendHtmlMessage(chatId, esc(TEXT[lang].stale), replyTo);
    return true;
  }
  if (!corrected) return false;
  const result = await replaceBatch(fix.bundleId, agentId, (args) => ({ ...args, items: args.items.map((row, i) => (i === fix.row ? corrected : row)) }))
    .catch((err: unknown) => ({ kind: "error" as const, message: err instanceof AssistantActionError ? err.message : TEXT[lang].stale }));
  if (result.kind === "error") { await sendHtmlMessage(chatId, esc(result.message), replyTo); return true; }
  if (result.kind !== "replaced") { await sendHtmlMessage(chatId, esc(TEXT[lang][result.kind === "empty" ? "empty" : "stale"]), replyTo); return true; }
  await editHtmlMessage(chatId, fix.messageId, esc(TEXT[lang].replaced), null).catch(() => undefined);
  if (result.notes.unreadable?.length) await rememberNotes(result.actionId, result.notes);
  const { pages } = renderExpenseCard(result.args, await loadMoneyContext(), result.notes);
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
  const render = renderExpenseCard(loaded.args, await loadMoneyContext(), notes);
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
    const shifted = { unreadable: result.notes.unreadable };
    if (shifted.unreadable?.length) await rememberNotes(result.actionId, shifted);
    const next = renderExpenseCard(result.args, await loadMoneyContext(), shifted);
    const nextPage = Math.min(page, next.pages.length - 1);
    await editHtmlMessage(chatId, messageId, next.pages[nextPage]!, keyboard(result.lang, result.bundleId, nextPage, next.pages.length)).catch(() => undefined);
  } else {
    await editHtmlMessage(chatId, messageId, esc(t[result.kind === "empty" ? "empty" : "stale"]), null).catch(() => undefined);
  }
  await ack();
  return true;
}
