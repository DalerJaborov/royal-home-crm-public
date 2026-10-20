import { z } from "zod";
import { DUSHANBE_OFFSET_MS } from "./dushanbeDay.js";

/**
 * ВЫХОДНЫЕ ДНИ: КОМПАНИИ И АГЕНТА — ОДНО ПРАВИЛО, ОДНО МЕСТО (решение владельца 11.10.2026).
 *
 * «У нас нет никаких выходных — робот и телефон всегда в сети; агенты тоже работают
 * каждый день; из настроек можно выбрать, у кого выходной». До этой правки воскресенье
 * было зашито общим выходным (решение 08.09.2026) в десятке мест: календарь тревог,
 * обещание звонка, справка о часах, запись на показ, перезвон, «соединить с агентом».
 *
 * Теперь выходные — ДАННЫЕ:
 *  - `Settings.companyDaysOff` — общие выходные компании (по умолчанию пусто);
 *  - `Agent.weeklyDaysOff` — личные выходные агента (по умолчанию пусто).
 * День недели — по Душанбе: 0 — воскресенье, 1 — понедельник … 6 — суббота (как
 * `Date.getUTCDay()` у настенных часов Душанбе и `EXTRACT(DOW)` в Postgres).
 * Пустые списки = выходных нет, каждый день рабочий.
 *
 * Функции здесь чистые: списки передаёт вызывающий (сервер читает Настройки и
 * агента сам), поэтому их одинаково зовут сервер, сайт и тесты.
 */

/** Порядок дней в интерфейсе: с понедельника. */
export const WEEKDAYS_MON_FIRST = [1, 2, 3, 4, 5, 6, 0] as const;

/** Именительный падеж, индекс — день недели (0 — воскресенье). */
export const WEEKDAY_NAMES_RU = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"] as const;

/** Короткие подписи переключателей, индекс — день недели. */
export const WEEKDAY_SHORT_RU = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"] as const;

/**
 * Список выходных: числа 0..6 без повторов, хотя бы один день рабочий.
 * Семь выходных — это не выходные, а отсутствие: для него есть пауза приёма и отпуск.
 */
export const daysOffSchema = z
  .array(z.number().int().min(0).max(6))
  .max(6, "Хотя бы один день в неделю должен быть рабочим")
  .refine((days) => new Set(days).size === days.length, "Дни недели не должны повторяться");

export type DaysOff = z.infer<typeof daysOffSchema>;

/** Выходные компании и (если известен) конкретного агента. Пусто/нет — выходных нет. */
export interface DaysOffCalendar {
  companyDaysOff?: readonly number[] | null;
  agentDaysOff?: readonly number[] | null;
}

/** Календарь без выходных — каждый день рабочий. */
export const NO_DAYS_OFF: DaysOffCalendar = Object.freeze({ companyDaysOff: [], agentDaysOff: [] });

/** Привести значение из базы/формы к чистому списку: 0..6, без повторов, по порядку. */
export function normalizeDaysOff(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<number>();
  for (const v of value) {
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 6) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/** День недели по Душанбе (0 — воскресенье). */
export function dushanbeWeekday(at: Date): number {
  return new Date(at.getTime() + DUSHANBE_OFFSET_MS).getUTCDay();
}

/** Выходной ли день недели `weekday` по календарю (общий выходной ИЛИ личный агента). */
export function isWeekdayOff(weekday: number, cal: DaysOffCalendar = NO_DAYS_OFF): boolean {
  return Boolean(cal.companyDaysOff?.includes(weekday) || cal.agentDaysOff?.includes(weekday));
}

/** Попадает ли момент на выходной по Душанбе. Пустые списки — никогда. */
export function isDayOff(at: Date, cal: DaysOffCalendar = NO_DAYS_OFF): boolean {
  return isWeekdayOff(dushanbeWeekday(at), cal);
}

/** Работает ли агент (или компания, если агент не указан) в день момента `at`. */
export function isWorkingDay(at: Date, cal: DaysOffCalendar = NO_DAYS_OFF): boolean {
  return !isDayOff(at, cal);
}

const DAY_MS = 24 * 3600_000;

function dayStartMoment(at: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map((n) => Number(n) || 0);
  const wall = new Date(at.getTime() + DUSHANBE_OFFSET_MS);
  return new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), h, m, 0, 0) - DUSHANBE_OFFSET_MS);
}

/**
 * НАЧАЛО БЛИЖАЙШЕГО РАБОЧЕГО ДНЯ, не раньше `at`: рабочий день и момент после его
 * начала — сам `at`; рабочий день до начала — его начало; выходной — начало
 * следующего рабочего дня. Если рабочих дней нет вовсе (все семь — выходные у
 * компании и агента вместе), отдаёт момент через две недели — вызывающему этого
 * хватает, чтобы не крутиться бесконечно.
 */
export function startOfWorkingDayAtOrAfter(at: Date, cal: DaysOffCalendar = NO_DAYS_OFF, dayStartHHMM = "09:30"): Date {
  let cursor = at;
  for (let guard = 0; guard < 14; guard++) {
    const start = dayStartMoment(cursor, dayStartHHMM);
    if (!isDayOff(cursor, cal)) return cursor >= start ? cursor : start;
    cursor = new Date(start.getTime() + DAY_MS);
  }
  return cursor;
}

/**
 * НАЧАЛО СЛЕДУЮЩЕГО РАБОЧЕГО ДНЯ строго ПОСЛЕ дня момента `at` (по Душанбе):
 * «перезвонит в следующий рабочий день» — завтра, если завтра не выходной.
 */
export function nextWorkingDayStart(at: Date, cal: DaysOffCalendar = NO_DAYS_OFF, dayStartHHMM = "09:30"): Date {
  const tomorrowStart = new Date(dayStartMoment(at, dayStartHHMM).getTime() + DAY_MS);
  return startOfWorkingDayAtOrAfter(tomorrowStart, cal, dayStartHHMM);
}

/**
 * Сколько РАБОЧИХ суток прошло между моментами. Сутки засчитываются по их концу:
 * отрезок, кончающийся в выходной, рабочим днём не становится. Пустой календарь —
 * просто число полных суток.
 */
export function workingDaysBetween(from: Date, to: Date, cal: DaysOffCalendar = NO_DAYS_OFF): number {
  if (to <= from) return 0;
  let days = 0;
  let cursor = from;
  while (true) {
    const next = new Date(cursor.getTime() + DAY_MS);
    if (next > to) break;
    if (!isDayOff(next, cal)) days++;
    cursor = next;
  }
  return days;
}

/** Момент, когда истекут `days` рабочих суток от `from` (зеркало workingDaysBetween). */
export function addWorkingDays(from: Date, days: number, cal: DaysOffCalendar = NO_DAYS_OFF): Date {
  let cursor = from;
  let remaining = days;
  // Предохранитель: календарь, где выходных семь, не должен вешать процесс.
  for (let guard = 0; remaining > 0 && guard < days * 8 + 14; guard++) {
    cursor = new Date(cursor.getTime() + DAY_MS);
    if (!isDayOff(cursor, cal)) remaining--;
  }
  return cursor;
}

function joinRu(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} и ${words[words.length - 1]}`;
}

/**
 * Выходные словами для клиента и для подписей: «выходных нет — работаем каждый день»,
 * «выходной — воскресенье», «выходные — суббота и воскресенье».
 */
export function daysOffSentenceRu(days: readonly number[] | null | undefined): string {
  const list = normalizeDaysOff(days);
  if (list.length === 0) return "выходных нет — работаем каждый день";
  const ordered = WEEKDAYS_MON_FIRST.filter((d) => list.includes(d)).map((d) => WEEKDAY_NAMES_RU[d]);
  return list.length === 1 ? `выходной — ${ordered[0]}` : `выходные — ${joinRu(ordered)}`;
}
