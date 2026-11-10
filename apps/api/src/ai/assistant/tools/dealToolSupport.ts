import { isReadOnlyRole } from "@royal-home/shared";
import { loadAgentAccess } from "../../../auth/middleware.js";
import { prisma } from "../../../db.js";
import { AssistantActionError, type AssistantActionActor } from "../../../lib/assistantActions.js";
import { dealActorFromAccess, type DealActor, type DealWriteFailure } from "../../../lib/dealWrites.js";
import { centsToTjs, fromCents, toCents } from "../../../lib/money.js";
import { detectClientLanguage } from "../../clientLanguage.js";
import { repliesInTajik } from "../languageRouting.js";
import type { AssistantActor } from "../actor.js";

/**
 * ОБЩЕЕ ДЛЯ ИНСТРУМЕНТОВ «СДЕЛКИ» ПОМОЩНИЦЫ ШАБНАМ (10.11.2026).
 *
 * - Только личка: общая группа не видит ни сделок, ни денег (`dealToolsAllowed`).
 * - Права — РОВНО как у REST: исполнитель получает от брокера урезанного актора,
 *   поэтому полный «запрос» (`DealActor`) собирается здесь из того же
 *   `loadAgentAccess`, что у `requireAuth`, на каждом шаге (превью, нажатие).
 * - Деньги: сумма всегда в ВАЛЮТЕ СДЕЛКИ, доллары — со строкой пересчёта по курсу
 *   из Настроек («1 500 $ × 11,15 = 16 725 с.»). Курс не задан — долларовую сумму
 *   помощница не записывает (запасной курс годится для прикидки в отчёте, но не
 *   для денег, которые человек подтверждает кнопкой).
 */

export type DealLang = "ru" | "tg";

/** Личка CRM или личка Telegram. Группа и неизвестный вход — нет. */
export function dealToolsAllowed(actor: AssistantActor): boolean {
  return actor.surface === "crm-private" || actor.surface === "telegram-private";
}

/** Запись: та же личка и не режим «только смотреть». */
export function dealWritesAllowed(actor: AssistantActor): boolean {
  return dealToolsAllowed(actor) && !isReadOnlyRole(actor.role);
}

export const NOT_PRIVATE_ERROR = "Сделки и деньги — только в личном чате с Шабнам";

/** «Запрос» из прав сотрудника-читателя (актор помощника уже несёт набор прав). */
export function dealActorOf(actor: AssistantActor): DealActor {
  return dealActorFromAccess(actor.id, {
    role: actor.role as NonNullable<DealActor["agent"]>["role"],
    permissions: (actor.permissions ?? new Set()) as NonNullable<DealActor["agent"]>["permissions"],
  });
}

/** Свежие права нажавшего — как requireAuth: учётка жива, не «только смотреть». */
export async function loadDealWriter(actionActor: AssistantActionActor): Promise<{ req: DealActor; agentName: string }> {
  const [access, agent] = await Promise.all([
    loadAgentAccess(actionActor.agentId),
    prisma.agent.findUnique({ where: { id: actionActor.agentId }, select: { fullName: true } }),
  ]);
  if (!access || !agent || !access.isActive) {
    throw new AssistantActionError(403, "FORBIDDEN", "Учётная запись недоступна");
  }
  if (isReadOnlyRole(access.role)) {
    throw new AssistantActionError(403, "FORBIDDEN", "Режим только для чтения: это действие вам недоступно");
  }
  return { req: dealActorFromAccess(actionActor.agentId, access), agentName: agent.fullName };
}

/** Отказ общей двери сделки → ошибка брокера с тем же текстом и статусом, что у REST. */
export function dealRefusal(outcome: DealWriteFailure): AssistantActionError {
  const text = outcome.body.error;
  // Условная запись не совпала (версия/стадия) — это «данные изменились», а не отказ по правилам.
  const stale = outcome.status === 409 && /изменена другим|только что изменили/u.test(text);
  return new AssistantActionError(outcome.status, stale ? "STALE" : "DEAL_REFUSED", text);
}

/** Язык ответа по словам сотрудника; модель может назвать его явно аргументом. */
export function dealLang(explicit: unknown, question?: string): DealLang {
  if (explicit === "tg" || explicit === "ru") return explicit;
  if (question && repliesInTajik(detectClientLanguage(question))) return "tg";
  return "ru";
}

const STAGES: Record<DealLang, Record<string, string>> = {
  ru: {
    NEGOTIATION: "Переговоры",
    AGREEMENT_PENDING: "Согласование",
    CONTRACT_SIGNED: "Договор подписан",
    PENDING_APPROVAL: "Ждёт одобрения",
    COMPLETED: "Закрыта",
    CANCELLED: "Отменена",
  },
  tg: {
    NEGOTIATION: "Гуфтушунид",
    AGREEMENT_PENDING: "Мувофиқа",
    CONTRACT_SIGNED: "Шартнома имзо шуд",
    PENDING_APPROVAL: "Интизори тасдиқ",
    COMPLETED: "Баста шуд",
    CANCELLED: "Бекор шуд",
  },
};

export function stageLabel(stage: string, lang: DealLang, annulled = false): string {
  if (annulled) return lang === "tg" ? "Бекор карда шуд (аннул)" : "Аннулирована";
  return STAGES[lang][stage] ?? stage;
}

/** Слова карточек и ответов — одна таблица на ru/tg. Таджикский — простыми словами, на «шумо». */
export const WORDS = {
  ru: {
    deal: "Сделка",
    client: "Клиент",
    property: "Объект",
    agent: "Агент",
    stage: "Этап",
    price: "Цена продажи",
    commission: "Комиссия",
    realtor: "Доля агента",
    company: "Доля компании",
    intake: "Доля за приём объекта",
    paid: "Выплачено",
    waiting: "Ждёт выплаты",
    noRate: "Курс доллара в Настройках не задан",
  },
  tg: {
    deal: "Муомила",
    client: "Мизоҷ",
    property: "Объект",
    agent: "Агент",
    stage: "Марҳила",
    price: "Нархи фурӯш",
    commission: "Комиссия",
    realtor: "Ҳиссаи агент",
    company: "Ҳиссаи ширкат",
    intake: "Ҳисса барои қабули объект",
    paid: "Пардохт шуд",
    waiting: "Интизори пардохт",
    noRate: "Қурби доллар дар Танзимот гузошта нашудааст",
  },
} as const;

/** Курс доллара из Настроек; не задан — null (никакого запасного курса для денег). */
export async function loadUsdRate(): Promise<number | null> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { usdToTjsRate: true } });
  const rate = settings?.usdToTjsRate ? Number(settings.usdToTjsRate) : null;
  return rate && Number.isFinite(rate) && rate > 0 ? rate : null;
}

const NBSP = / | /g;
function groupNumber(value: number, maxFraction: number): string {
  return new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: maxFraction })
    .format(value)
    .replace(NBSP, " ");
}

/** «16 725 с.» / «1 500 $» (tg: «16 725 сомонӣ»). Копейки — только если они есть. */
export function money(amount: unknown, currency: string, lang: DealLang = "ru"): string {
  const value = fromCents(toCents(amount));
  const text = groupNumber(value, 2);
  if (currency === "USD") return `${text} $`;
  return lang === "tg" ? `${text} сомонӣ` : `${text} с.`;
}

/** Сумма в сомони по курсу, ровно до копейки — та же функция, что у отчётов (lib/money.ts). */
export function usdToTjs(amount: unknown, rate: number): number {
  return fromCents(centsToTjs(toCents(amount), "USD", { usdToTjs: rate }));
}

/**
 * Сумма с валютой и, для долларов, со строкой пересчёта:
 * «1 500 $ × 11,15 = 16 725 с.». Без курса — сумма в долларах и честная пометка.
 */
export function moneyWithRate(amount: unknown, currency: string, rate: number | null, lang: DealLang = "ru"): string {
  if (amount === null || amount === undefined) return "—";
  if (currency !== "USD") return money(amount, currency, lang);
  if (rate === null) return `${money(amount, "USD", lang)} (${WORDS[lang].noRate})`;
  return `${money(amount, "USD", lang)} × ${groupNumber(rate, 4)} = ${money(usdToTjs(amount, rate), "TJS", lang)}`;
}

/** Ключ месяца «2026-10» из ответа модели; иначе текущий месяц по Душанбе. */
export function monthKeyOf(raw: unknown, nowWallIso: string): string {
  if (typeof raw === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw.trim())) return raw.trim();
  return nowWallIso.slice(0, 7);
}

export const ISO_DAY = (wall: Date) => wall.toISOString().slice(0, 10);
