import { isReadOnlyRole, EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "@royal-home/shared";
import { prisma, type TxClient } from "../../../db.js";
import { loadAgentAccess } from "../../../auth/middleware.js";
import { AssistantActionError, type AssistantActionActor } from "../../../lib/assistantActions.js";
import { ExpenseCommandError } from "../../../lib/expenseCommands.js";
import { ExpenseLifecycleError } from "../../../lib/expenseWorkspace.js";
import type { AssistantActor } from "../actor.js";
import { findActiveAgentByName } from "../../../lib/agentNameLookup.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * ОБЩЕЕ У ИНСТРУМЕНТОВ РАСХОДОВ ШАБНАМ (10.11.2026).
 *
 * Права — ровно REST `routes/expenses.ts`: раздел открыт правом `finance.view`,
 * любая запись — ещё и `finance.manage`; акционер (роль только для чтения) не пишет.
 * Канал — CRM и ЛИЧКА Telegram: в общей группе деньги не показываются и не меняются
 * (GROUP_HIDDEN_PERMISSIONS / GROUP_HIDDEN_TOOLS в telegram/assistantBot.ts и
 * `privateTelegram` у исполнителей — две двери закрыты независимо).
 */

export const EXPENSE_LANGS = ["ru", "tg", "uz", "en"] as const;
export type ExpenseLang = (typeof EXPENSE_LANGS)[number];

export function financeReadAllowed(actor: AssistantActor): boolean {
  return actor.canViewFinance && actor.surface !== "telegram-group";
}

export function financeWriteAllowed(actor: AssistantActor): boolean {
  return financeReadAllowed(actor) && (actor.permissions?.has("finance.manage") ?? false) && !isReadOnlyRole(actor.role);
}

/** Свежие права нажавшего — на каждом снимке и исполнении, как requireAuth на каждом запросе. */
export async function assertFinanceWriter(actionActor: AssistantActionActor, db?: TxClient): Promise<void> {
  if (actionActor.channel === "telegram" && actionActor.telegramPrivate !== true) {
    throw new AssistantActionError(403, "PRIVATE_CHAT_REQUIRED", "Про деньги — только в личке с Шабнам");
  }
  const access = await loadAgentAccess(actionActor.agentId, db);
  if (!access?.isActive) throw new AssistantActionError(403, "FORBIDDEN", "Учётная запись недоступна");
  if (isReadOnlyRole(access.role)) {
    throw new AssistantActionError(403, "FORBIDDEN", "Режим только для чтения: это действие вам недоступно");
  }
  if (!access.permissions.has("finance.view") || !access.permissions.has("finance.manage")) {
    throw new AssistantActionError(403, "FORBIDDEN", "Нет права вести расходы");
  }
}

/** Ошибка правила расходов → отказ брокера тем же текстом, что видит экран. */
export function asActionError(err: unknown): never {
  if (err instanceof ExpenseCommandError) {
    throw new AssistantActionError(err.status, typeof err.body.code === "string" ? err.body.code : "EXPENSE_RULE", err.body.error);
  }
  if (err instanceof ExpenseLifecycleError) throw new AssistantActionError(err.status, "EXPENSE_RULE", err.message);
  throw err;
}

export function asPluginExecutor<A>(executor: unknown): AssistantWriteToolPlugin["executor"] {
  return executor as AssistantWriteToolPlugin["executor"] & { __args?: A };
}

/** Подписи карточек на языке собеседника. Названия расходов — как их написал человек. */
const LABELS = {
  ru: {
    check: (n: number) => `Проверьте ${n} ${plural(n, ["расход", "расхода", "расходов"])}`,
    total: "итого", paid: "оплачено", planned: "ждёт оплаты", rate: "доллары по курсу CRM",
    write: "Записать", fix: "Исправить", cancel: "Отмена", confirm: "Подтвердить",
    categories: EXPENSE_CATEGORY_LABELS,
  },
  tg: {
    check: (n: number) => `${n} харҷро санҷед`,
    total: "ҳамагӣ", paid: "пардохт шуд", planned: "интизори пардохт", rate: "доллар бо қурби CRM",
    write: "Сабт кун", fix: "Ислоҳ", cancel: "Бекор", confirm: "Тасдиқ",
    categories: { ADVERTISING: "Реклама", SALARY: "Музди меҳнат", OFFICE: "Офис", OTHER: "Дигар" },
  },
  uz: {
    check: (n: number) => `${n} ta xarajatni tekshiring`,
    total: "jami", paid: "to'langan", planned: "to'lov kutilmoqda", rate: "dollar CRM kursida",
    write: "Yozish", fix: "Tuzatish", cancel: "Bekor", confirm: "Tasdiqlash",
    categories: { ADVERTISING: "Reklama", SALARY: "Ish haqi", OFFICE: "Ofis", OTHER: "Boshqa" },
  },
  en: {
    check: (n: number) => `Check ${n} ${n === 1 ? "expense" : "expenses"}`,
    total: "total", paid: "paid", planned: "awaiting payment", rate: "dollars at the CRM rate",
    write: "Record", fix: "Fix", cancel: "Cancel", confirm: "Confirm",
    categories: { ADVERTISING: "Advertising", SALARY: "Salary", OFFICE: "Office", OTHER: "Other" },
  },
} as const satisfies Record<ExpenseLang, unknown>;

function plural(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

export function expenseLabels(lang: ExpenseLang) {
  return LABELS[lang];
}

export function categoryLabel(lang: ExpenseLang, category: ExpenseCategory, title?: string | null): string {
  return title?.trim() || LABELS[lang].categories[category];
}

/** Число как в CRM («15 400», «122,50»): копейки только если они есть. */
function amountText(amount: number): string {
  return amount.toLocaleString("ru-RU", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 });
}

/** Сумма с валютой («5 000 с.», «$40»), подпись валюты — на языке собеседника. */
export function moneyText(amount: number, currency: "TJS" | "USD", lang: ExpenseLang): string {
  const number = amountText(amount);
  if (currency === "USD") return `$${number}`;
  return `${number} ${lang === "tg" ? "сомонӣ" : lang === "uz" ? "somoniy" : lang === "en" ? "TJS" : "с."}`;
}

/** Язык по словам человека: модель передаёт `lang`, без него — по самому тексту. */
export function guessExpenseLang(text: string): ExpenseLang {
  if (/[ӣӯқғҳҷ]/iu.test(text) || /(?:^|\s)(?:харҷ|барои|ман|шумо|сомонӣ|кун)(?=$|[\s.,!?])/iu.test(text)) return "tg";
  if (/[а-яё]/iu.test(text)) return "ru";
  if (/(?:^|\s)(?:xarajat|harajat|so'm|ming|uchun|oy|kecha|bugun|ijara|benzin)(?=$|[\s.,!?])/iu.test(text) || /[oʻgʻ]ʻ/u.test(text)) return "uz";
  return /[a-z]/iu.test(text) ? "en" : "ru";
}

/** Категория-подраздел по названию из справочника; null — подходящей нет. */
export async function findCategoryByTitle(title: string | undefined, db: Pick<TxClient, "expenseCategoryDefinition"> = prisma) {
  const wanted = title?.trim().toLowerCase();
  if (!wanted) return null;
  const rows = await db.expenseCategoryDefinition.findMany({ where: { active: true }, select: { id: true, title: true, rootCategory: true }, take: 500 });
  return rows.find(r => r.title.trim().toLowerCase() === wanted)
    ?? (rows.filter(r => r.title.trim().toLowerCase().startsWith(wanted)).length === 1
      ? rows.find(r => r.title.trim().toLowerCase().startsWith(wanted))! : null);
}

/**
 * Сотрудник для зарплаты по имени — общая дверь `lib/agentNameLookup.ts` (одно правило с передачей
 * клиентов): ровно один активный — он, иначе null; кандидатов отдаёт `findActiveAgentByName`.
 */
export async function findAgentByName(name: string | undefined, _db?: unknown) {
  if (!name?.trim()) return null;
  const match = await findActiveAgentByName(name);
  return match.kind === "one" ? match.agent : null;
}
