import { pluralizeRu } from "@royal-home/shared";
import { dushanbeDate, dushanbeTime } from "../../../lib/date";

/**
 * ГЛАВНЫЕ РУКОВОДИТЕЛЕЙ (директор, админ, РОП, акционер; 20.11.2026) — правила без
 * разметки, чтобы их можно было проверить тестом: тренд комиссии, подпись периода
 * сравнения и состояние сотрудника в «Команде». Данные — только из снимка пульта и
 * живой сводки команды; ничего не досчитывается «на глаз».
 */

const OFFSET_MS = 5 * 60 * 60 * 1000;
const ONLINE_MS = 15 * 60 * 1000;

export interface Trend {
  dir: "up" | "down" | "flat";
  /** Модуль изменения в процентах; null — сравнивать не с чем (в прошлом месяце было 0). */
  pct: number | null;
}

/**
 * Тренд комиссии к прошлому месяцу на ту же точку. Нет числа прошлого месяца — нет
 * тренда; в прошлом месяце 0, а сейчас больше — рост без процента (деление на ноль
 * не выдаём за «+∞ %»); оба нуля — сравнивать нечего.
 */
export function commissionTrend(fact: number, previous: number | null | undefined): Trend | null {
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return null;
  if (previous <= 0) return fact > 0 ? { dir: "up", pct: null } : null;
  const pct = Math.round(((fact - previous) / previous) * 100);
  return { dir: pct > 0 ? "up" : pct < 0 ? "down" : "flat", pct: Math.abs(pct) };
}

/**
 * Подпись периода сравнения по Душанбе — ровно то, что считает сервер
 * (lib/dashboardInsights.ts::computePreviousMonthCommission: прошлый месяц с 1-го числа
 * до той же точки месяца, с точностью до минуты): 20 ноября 14:00 → «1–20 октября до
 * 14:00»; 31 марта → «1–28 февраля» (прошлый месяц короче — он целиком, без часа);
 * 1-е число → «1 октября до 09:00».
 */
export function previousMonthPeriod(now: Date = new Date()): { range: string; month: string } {
  const wall = new Date(now.getTime() + OFFSET_MS);
  const y = wall.getUTCFullYear();
  const m = wall.getUTCMonth();
  const prevDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const whole = wall.getUTCDate() > prevDays;
  const day = Math.min(wall.getUTCDate(), prevDays);
  // Полдень по Душанбе — день не уезжает ни в каком поясе устройства.
  const at = new Date(Date.UTC(y, m - 1, day, 7));
  const dayMonth = dushanbeDate(at, { day: "numeric", month: "long" });
  const range = day === 1 ? dayMonth : `1–${dayMonth}`;
  return { range: whole ? range : `${range} до ${dushanbeTime(now)}`, month: dushanbeDate(at, { month: "long" }) };
}

/** «40 мин», «1 ч 20 мин», «2 дн.» — сколько ждёт. */
export function waitLabel(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} мин`;
  if (m < 24 * 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} ч ${rest} мин` : `${h} ч`;
  }
  return `${Math.floor(m / (24 * 60))} дн.`;
}

export interface LeaderAgentInput {
  lastSeenAt?: string | null;
  activeLoad: number;
  pendingAccept: number;
  takesLeads?: boolean;
  overdueTasks?: number;
  /** Дел за сегодня (звонки, показы, задачи, сообщения) — сервер считает по каждому агенту. */
  actionsToday?: number;
  /** Сегодня у него выходной (общий, личный, праздник компании). */
  dayOffToday?: boolean;
}

export interface LeaderAgentStatus {
  /** «сейчас в CRM», «заходил в 09:40», «заходил 18 ноября», «ещё не заходил в CRM». */
  seen: string;
  /** Одна главная пометка справа; null — всё в порядке. */
  flag: { tone: "crit" | "warn" | "muted"; text: string } | null;
  /** Порядок в списке: сначала тревоги, потом внимание, потом остальные. */
  rank: number;
}

function sameDushanbeDay(a: Date, b: Date): boolean {
  return new Date(a.getTime() + OFFSET_MS).toISOString().slice(0, 10) === new Date(b.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Состояние сотрудника для «Команды» руководителя.
 *
 * «Сегодня не заходил» — только по фактам: рабочий день уже начался (час из Настроек,
 * `workdayStartAt`), в CRM сегодня не заходил и ни одного дела за сегодня не записано;
 * у кого приём заявок на паузе — не тревога, а пометка «на паузе». Без часа начала дня
 * (старый ответ сервера) отсутствие не помечается вовсе: лучше промолчать, чем
 * назвать прогульщиком того, у кого смена ещё не началась.
 */
export function agentStatus(agent: LeaderAgentInput, opts: {
  /** Заявок, которые он не принял вовремя (живая сводка команды). */
  lateLeads: number;
  workdayStartAt?: string;
  now: Date;
}): LeaderAgentStatus {
  const { now } = opts;
  const last = agent.lastSeenAt ? new Date(agent.lastSeenAt) : null;
  const seenToday = !!last && sameDushanbeDay(last, now);
  const seen = !last ? "ещё не заходил в CRM"
    : now.getTime() - last.getTime() < ONLINE_MS ? "сейчас в CRM"
    : seenToday ? `заходил в ${dushanbeTime(last)}`
    : `заходил ${dushanbeDate(last, { day: "numeric", month: "long" })}`;

  // Начало дня — сегодняшнее по Душанбе (снимок мог прийти вчера и лежать в кэше вкладки),
  // и уже наступило; в выходной агента «не заходил» не тревога.
  const start = opts.workdayStartAt ? new Date(opts.workdayStartAt) : null;
  const workdayStarted = !!start && !Number.isNaN(start.getTime()) && sameDushanbeDay(start, now) && now.getTime() >= start.getTime()
    && agent.dayOffToday !== true;
  const paused = agent.takesLeads === false;
  if (opts.lateLeads > 0) {
    return { seen, rank: 0, flag: { tone: "crit", text: `не принял вовремя: ${opts.lateLeads} ${pluralizeRu(opts.lateLeads, ["заявка", "заявки", "заявок"])}` } };
  }
  if (!paused && workdayStarted && !seenToday && agent.actionsToday === 0) {
    return { seen, rank: 0, flag: { tone: "crit", text: "сегодня не заходил" } };
  }
  if ((agent.overdueTasks ?? 0) > 0) {
    const n = agent.overdueTasks ?? 0;
    return { seen, rank: 1, flag: { tone: "warn", text: `просрочено: ${n} ${pluralizeRu(n, ["задача", "задачи", "задач"])}` } };
  }
  if (agent.pendingAccept > 0) {
    return { seen, rank: 1, flag: { tone: "warn", text: `ждут принятия: ${agent.pendingAccept}` } };
  }
  if (paused) return { seen, rank: 2, flag: { tone: "muted", text: "приём заявок на паузе" } };
  return { seen, rank: 3, flag: null };
}
