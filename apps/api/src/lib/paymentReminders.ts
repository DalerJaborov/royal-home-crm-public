import type { ExpenseUpcomingItem } from "@royal-home/shared";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { loadAgentAccess } from "../auth/middleware.js";
import { sendPushToAgent } from "../push.js";
import { answerCallbackQuery, sendHtmlMessage, type TelegramCallbackQuery, type TelegramInlineButton } from "../telegram/api.js";
import { listNumber, renderAssistantListHtml, type AssistantListItem } from "../telegram/assistantList.js";
import { escapeHtml } from "../telegram/assistantReply.js";
import { claimNoticeKeys, sendStaffNotice } from "../telegram/staffNotice.js";
import { logAgentAudit } from "./audit.js";
import { describeError } from "./describeError.js";
import { dushanbeDateString, isWithinDushanbeWindow } from "./dushanbeTime.js";
import { changeRecurringOccurrence, ExpenseCommandError } from "./expenseCommands.js";
import { upcomingExpenses } from "./expenseWorkspace.js";
import { centsToTjs, fromCents, loadMoneyContext, toCents, type MoneyContext } from "./money.js";
import { isKindMuted } from "./notificationPrefs.js";
import { findAgentsWithPermission, partitionByPermission } from "./recipients.js";
import { loadWorkWindow } from "./stationOutage.js";
import { logSystemError } from "./systemError.js";
import { claimCallback } from "./telegramCallbackClaim.js";
import { findAgentByTelegramChatId, findAgentByTelegramUserId } from "./telegramAgentLink.js";

/**
 * НАПОМИНАНИЯ ОБ ОПЛАТАХ ПОДПИСОК — ОДНА ДВЕРЬ (владелец 10.11.2026).
 *
 * Кому: всем, у кого право `finance.view` (не по роли — права раздаются
 * галочками, lib/recipients.ts). Когда — в рабочее время Душанбе:
 *  • за 3 дня до оплаты (одно сообщение на платёж; заведён позже — за сколько
 *    осталось),
 *  • в день оплаты,
 *  • при сбое оплаты у известного сервиса (402 / billing / insufficient в
 *    журнале ошибок за сутки),
 *  • «⏰ Напомнить завтра» — повтор один раз на следующий день.
 * Источник — повторяющиеся расходы CRM (expenseWorkspace::upcomingExpenses);
 * оплаченный (PAID) или пропущенный платёж не напоминается — это и есть
 * проверка оплаты. Живые балансы сервисов CRM не видит: честно пишем
 * «проверьте в кабинете сервиса».
 *
 * Все поводы одного человека за тик — ОДНИМ сообщением (правило «редко
 * беспокоить»). Каждый повод занимает ключ в StaffNotice до отправки: повтор
 * тика не шлёт второй раз, сбой отправки ключ отдаёт.
 *
 * Прежние «Скоро оплата» / «Пора оплатить» из financeAutomation.ts сняты в
 * пользу этой двери: два сообщения об одном платеже — ровно то, что владелец
 * просил не делать.
 */

const SOON_DAYS = 3;
const CARD_RESERVE = 1.02;
const MAX_ITEMS_WITH_BUTTONS = 8;
const PAY_PREFIX = "pp:";
const SNOOZE_PREFIX = "pz:";
const CARD_METHODS = new Set(["CARD", "CARD_DIRECTOR"]);

/** Сервисы, чьи сбои оплаты мы узнаём по журналу ошибок. */
export const BILLING_SERVICES: { key: string; label: string; re: RegExp }[] = [
  { key: "gemini", label: "Google Gemini", re: /gemini|generativelanguage/i },
  { key: "openai", label: "OpenAI", re: /openai/i },
  { key: "elevenlabs", label: "ElevenLabs", re: /elevenlabs|eleven\s*labs/i },
  { key: "deepseek", label: "DeepSeek", re: /deepseek/i },
  { key: "anthropic", label: "Claude (Anthropic)", re: /anthropic|claude/i },
  { key: "meta", label: "Реклама Meta", re: /meta\s*ads|graph\.facebook|facebook\s*ads/i },
  { key: "payom", label: "СМС Payom", re: /payom/i },
];
const BILLING_RE = /\b402\b|payment[\s_]required|billing|insufficient|недостаточно\s+средств|credit\s+balance\s+is\s+too\s+low/i;

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const fmt = (n: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n);

/** Сумма платежа словами: «1 200 с.» или «$20 → ~221 с. по курсу CRM». */
export function amountLines(item: Pick<ExpenseUpcomingItem, "amount" | "currency" | "paymentMethod">, money: MoneyContext): string[] {
  const cents = toCents(item.amount);
  const tjs = fromCents(centsToTjs(cents, item.currency, money));
  const lines = [item.currency === "USD" ? `💰 $${fmt(fromCents(cents))} → ~${fmt(tjs)} с. по курсу CRM` : `💰 ${fmt(tjs)} с.`];
  if (item.paymentMethod && CARD_METHODS.has(item.paymentMethod)) {
    lines.push(`💳 На карте должно быть: ~${fmt(Math.ceil(tjs * CARD_RESERVE))} с. (с запасом 2%)`);
  }
  return lines;
}

type Stage = "soon" | "due" | "repeat";
interface Reminder { stage: Stage; item: ExpenseUpcomingItem; key: string }
interface Failure { service: (typeof BILLING_SERVICES)[number]; message: string; key: string }

/** Неоплаченные повторяющиеся платежи на сегодня и ближайшие 3 дня. */
export async function duePayments(today: string): Promise<ExpenseUpcomingItem[]> {
  const rows = await upcomingExpenses(today, addDays(today, SOON_DAYS));
  return rows.filter((r) => r.recurringId && r.status === "PLANNED");
}

/** Сбои оплаты известных сервисов за сутки — по журналу ошибок. */
export async function billingFailures(now: Date = new Date()): Promise<{ service: (typeof BILLING_SERVICES)[number]; message: string }[]> {
  const rows = await prisma.errorLog.findMany({
    where: { createdAt: { gte: new Date(now.getTime() - 86_400_000) }, resolvedAt: null },
    orderBy: { createdAt: "desc" },
    select: { message: true },
    take: 500,
  });
  const found = new Map<string, { service: (typeof BILLING_SERVICES)[number]; message: string }>();
  for (const row of rows) {
    if (!BILLING_RE.test(row.message)) continue;
    const service = BILLING_SERVICES.find((s) => s.re.test(row.message));
    if (service && !found.has(service.key)) found.set(service.key, { service, message: row.message.slice(0, 200) });
  }
  return [...found.values()];
}

function itemFor(r: Reminder, today: string, money: MoneyContext): AssistantListItem {
  const left = daysBetween(today, r.item.dueDate);
  const date = `${r.item.dueDate.slice(8, 10)}.${r.item.dueDate.slice(5, 7)}`;
  const when = left <= 0 ? `📅 Сегодня — день оплаты (${date})` : `📅 Через ${left} дн. · ${date}`;
  return { title: r.item.title, main: amountLines(r.item, money), when: r.stage === "repeat" ? `${when} · повтор, как просили` : when };
}

function render(reminders: Reminder[], failures: Failure[], today: string, money: MoneyContext): string[] {
  const items = [
    ...failures.map((f): AssistantListItem => ({
      title: `⚠️ ${f.service.label}: оплата не прошла`,
      main: ["Проверьте баланс и карту в кабинете сервиса — живой баланс CRM пока не видит."],
      details: f.message,
    })),
    ...reminders.map((r) => itemFor(r, today, money)),
  ];
  return renderAssistantListHtml({
    icon: "💳",
    title: "Оплаты подписок",
    items,
    tip: reminders.length ? "после оплаты нажмите «✅ Оплатил» — CRM отметит расход оплаченным." : undefined,
  });
}

function buttonsFor(reminders: Reminder[], canPay: boolean, offset: number): TelegramInlineButton[][] {
  const single = reminders.length === 1;
  return reminders.slice(0, MAX_ITEMS_WITH_BUTTONS).map((r, i) => {
    const n = single ? "" : `${listNumber(offset + i + 1)} `;
    const ref = `${r.item.recurringId}:${r.item.dueDate}`;
    const row: TelegramInlineButton[] = [];
    if (canPay) row.push({ text: `✅ ${n}Оплатил`, callback_data: `${PAY_PREFIX}${ref}` });
    row.push({ text: single ? "⏰ Напомнить завтра" : `⏰ ${n}Завтра`, callback_data: `${SNOOZE_PREFIX}${ref}` });
    return row;
  });
}

export interface ReminderTickResult { recipients: number; sent: number; skipped: string | null }

/**
 * Тик по расписанию. Идемпотентен: каждый повод — ключ в StaffNotice, второй
 * прогон в тот же день ничего не шлёт. Вне рабочего окна — ничего.
 */
export async function runPaymentReminders(now: Date = new Date(), opts: { ignoreWorkHours?: boolean } = {}): Promise<ReminderTickResult> {
  if (!opts.ignoreWorkHours) {
    const window = await loadWorkWindow();
    if (!isWithinDushanbeWindow(window.start, window.end, now)) return { recipients: 0, sent: 0, skipped: "outside-work-hours" };
  }
  const today = dushanbeDateString(now);
  const recipients = await findAgentsWithPermission("finance.view");
  if (!recipients.length) return { recipients: 0, sent: 0, skipped: "no-recipients" };
  const [due, failures, money, payers, agents] = await Promise.all([
    duePayments(today),
    billingFailures(now),
    loadMoneyContext(),
    partitionByPermission(recipients, "finance.manage"),
    prisma.agent.findMany({ where: { id: { in: recipients } }, select: { id: true, pushMuted: true, telegramChatId: true } }),
  ]);
  const snoozes = await prisma.staffNotice.findMany({
    where: { kind: "payment", agentId: { in: recipients }, remindOn: { lte: today }, firedAt: null },
    select: { id: true, agentId: true, subject: true },
    take: 500,
  });
  const canPay = new Set(payers.granted);
  let sent = 0;
  for (const agent of agents) {
    try {
      if (isKindMuted("payment", agent.pushMuted)) continue;
      const wanted: Reminder[] = due.map((item) => {
        const stage: Stage = item.dueDate <= today ? "due" : "soon";
        return { stage, item, key: `pay:${stage}:${item.recurringId}:${item.dueDate}:${agent.id}` };
      });
      const mySnoozes = snoozes.filter((s) => s.agentId === agent.id);
      const failureKeys: Failure[] = failures.map((f) => ({ ...f, key: `pay:fail:${f.service.key}:${today}:${agent.id}` }));
      const claimed = new Set(await claimNoticeKeys(agent.id, "payment", [...wanted.map((w) => w.key), ...failureKeys.map((f) => f.key)]));
      const reminders = wanted.filter((w) => claimed.has(w.key));
      // «Напомнить завтра»: повтор, если платёж всё ещё не оплачен и сегодня о нём не напомнили.
      for (const s of mySnoozes) {
        const item = due.find((d) => `${d.recurringId}:${d.dueDate}` === s.subject);
        if (item && !reminders.some((r) => r.item.recurringId === item.recurringId && r.item.dueDate === item.dueDate)) {
          reminders.push({ stage: "repeat", item, key: `snooze:${s.id}` });
        }
      }
      const myFailures = failureKeys.filter((f) => claimed.has(f.key));
      const keys = [...claimed];
      const firedSnoozes = mySnoozes.map((s) => s.id);
      if (!reminders.length && !myFailures.length) {
        // Отложенный платёж уже оплачен или пропущен — обещание снято, повторять нечего.
        if (firedSnoozes.length) await prisma.staffNotice.updateMany({ where: { id: { in: firedSnoozes } }, data: { firedAt: now } });
        continue;
      }
      if (agent.telegramChatId) {
        const status = await sendStaffNotice({
          agentId: agent.id,
          kind: "payment",
          html: render(reminders, myFailures, today, money),
          buttons: buttonsFor(reminders, canPay.has(agent.id), myFailures.length),
          attachKeys: keys,
        });
        if (status !== "sent") continue;
      } else {
        // Без Telegram — тот же повод в колокольчик и на телефон CRM.
        const lines = [
          ...myFailures.map((f) => `${f.service.label}: оплата не прошла`),
          ...reminders.map((r) => `${r.item.title} — ${r.item.dueDate <= today ? "сегодня" : r.item.dueDate}`),
        ];
        await sendPushToAgent(agent.id, {
          kind: "payment",
          level: myFailures.length ? "CRITICAL" : undefined,
          title: `💳 Оплаты подписок · ${lines.length}`,
          body: lines.join("; ").slice(0, 300),
          url: "/finance",
          tag: `payment-reminder-${today}`,
        });
        await prisma.staffNotice.updateMany({ where: { dedupKey: { in: keys } }, data: { messageId: 0 } });
      }
      if (firedSnoozes.length) await prisma.staffNotice.updateMany({ where: { id: { in: firedSnoozes } }, data: { firedAt: now } });
      sent++;
    } catch (err) {
      void logSystemError("api", `Напоминание об оплатах не отправлено: ${describeError(err)}`, { dedupKey: "payment-reminders" });
    }
  }
  return { recipients: agents.length, sent, skipped: null };
}

// ───────────────────────── кнопки ─────────────────────────

const REF = /^([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/i;

async function clickerOf(query: TelegramCallbackQuery): Promise<{ id: string; fullName: string } | null> {
  if (!query.from?.id) return null;
  const byUser = await findAgentByTelegramUserId(String(query.from.id));
  if (byUser) return byUser;
  const chatId = query.message?.chat.id;
  return chatId !== undefined && chatId === query.from.id ? findAgentByTelegramChatId(String(chatId)) : null;
}

/** «✅ Оплатил» и «⏰ Напомнить завтра». true — нажатие наше. */
export async function handlePaymentReminderCallback(query: TelegramCallbackQuery, now: Date = new Date()): Promise<boolean> {
  const data = query.data ?? "";
  const pay = data.startsWith(PAY_PREFIX);
  if (!pay && !data.startsWith(SNOOZE_PREFIX)) return false;
  if (!(await claimCallback(query.id))) {
    await answerCallbackQuery(query.id);
    return true;
  }
  const ref = REF.exec(data.slice(PAY_PREFIX.length));
  const chatId = query.message?.chat.id !== undefined ? String(query.message.chat.id) : null;
  try {
    const clicker = await clickerOf(query);
    if (!clicker) { await answerCallbackQuery(query.id, "Привяжите аккаунт в личке с ботом"); return true; }
    if (!ref) { await answerCallbackQuery(query.id, "Кнопка устарела"); return true; }
    const [, recurringId, dueDate] = ref;
    const access = await loadAgentAccess(clicker.id);
    if (!access?.isActive || !access.permissions.has("finance.view")) {
      await answerCallbackQuery(query.id, "Нет доступа к финансам");
      return true;
    }
    if (!pay) {
      const tomorrow = addDays(dushanbeDateString(now), 1);
      try {
        await prisma.staffNotice.create({
          data: {
            agentId: clicker.id, kind: "payment", dedupKey: `pay:snooze:${recurringId}:${dueDate}:${clicker.id}:${tomorrow}`,
            subject: `${recurringId}:${dueDate}`, remindOn: tomorrow,
          },
        });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      }
      await answerCallbackQuery(query.id, "Напомню завтра");
      return true;
    }
    // Тот же путь, что кнопка «Оплатить» на экране расходов (POST
    // /expenses/recurring/:id/pay): право finance.manage, общая команда, запись в журнал.
    if (!access.permissions.has("finance.manage")) {
      await answerCallbackQuery(query.id, "Отметить оплату может тот, кто ведёт финансы");
      return true;
    }
    const { expense } = await changeRecurringOccurrence(recurringId!, "pay", { dueDate }, clicker.id);
    logAgentAudit(clicker.id, "UPDATE", "RecurringExpense", recurringId!, { paymentAction: "pay", dueDate, source: "telegram" });
    await answerCallbackQuery(query.id, "Отметила: оплачено");
    if (chatId) {
      const title = expense?.note ?? "Платёж";
      await sendHtmlMessage(chatId, escapeHtml(`✅ Оплачено: ${title} (${dueDate.slice(8, 10)}.${dueDate.slice(5, 7)}). Расход в CRM отмечен оплаченным.`));
    }
  } catch (err) {
    if (err instanceof ExpenseCommandError) {
      await answerCallbackQuery(query.id, err.body.error.slice(0, 190));
      return true;
    }
    void logSystemError("telegram", `Кнопка напоминания об оплате не сработала: ${describeError(err)}`);
    await answerCallbackQuery(query.id, "Не получилось, попробуйте ещё раз").catch(() => undefined);
  }
  return true;
}
