import { z } from "zod";
import { dushanbeDayKey, DUSHANBE_OFFSET_MS } from "./dushanbeDay.js";
import { isWeekdayOff, normalizeDaysOff } from "./daysOff.js";

/**
 * МОЖНО ЛИ ЗВОНИТЬ РОБОТОМ: ЧИСТАЯ ЧАСТЬ ОДНОЙ ДВЕРИ (П3, 11.11.2026).
 *
 * Сама дверь — `apps/api/src/lib/robotCallPolicy.ts` (`robotCallAllowed`): её зовёт
 * каждый набор робота в мосте живого голоса. Здесь лежит то, что не ходит в базу и
 * одинаково нужно серверу, сайту и тестам: часы звонков робота, праздники, подписи
 * причин отказа и схемы ручки «не звонить роботом» в карточке клиента.
 */

/** Окно звонков робота по Душанбе: с 09:00 до 19:00 (те же часы, что у опроса после показа). */
export const ROBOT_CALL_DAY_START_HOUR = 9;
export const ROBOT_CALL_DAY_END_HOUR = 19;

/**
 * Частота на номер по умолчанию (решение владельца по умолчанию, план 11.11.2026, раздел 4):
 * не больше одного разговора робота в сутки по Душанбе и трёх за семь суток — по всем видам
 * звонков вместе. Сами значения — поля Настроек с этими умолчаниями.
 */
export const ROBOT_CALL_DAILY_MAX_DEFAULT = 1;
export const ROBOT_CALL_WEEKLY_MAX_DEFAULT = 3;

/** Дата праздника «ГГГГ-ММ-ДД» по Душанбе. */
export const companyHolidayDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Дата в виде ГГГГ-ММ-ДД")
  .refine((value) => {
    const [y, m, d] = value.split("-").map(Number);
    const at = new Date(Date.UTC(y, m - 1, d));
    return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
  }, "Такой даты нет");

/** Список праздников компании: без повторов, не больше сотни дат. */
export const companyHolidaysSchema = z
  .array(companyHolidayDateSchema)
  .max(100, "Слишком много праздников")
  .refine((days) => new Set(days).size === days.length, "Даты не должны повторяться");

/** Привести значение из базы к чистому списку дат: только верные «ГГГГ-ММ-ДД», без повторов, по порядку. */
export function normalizeCompanyHolidays(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const v of value) {
    if (typeof v === "string" && companyHolidayDateSchema.safeParse(v).success) out.add(v);
  }
  return [...out].sort();
}

/** Календарь звонков робота: общие выходные дни недели и праздничные даты. */
export interface RobotCallCalendar {
  companyDaysOff?: readonly number[] | null;
  companyHolidays?: readonly string[] | null;
}

export type RobotCallWindowRefusal = "outside_hours" | "day_off" | "holiday";

/** Праздник ли у компании в сутки момента `at` (по Душанбе). */
export function isCompanyHoliday(at: Date, holidays: readonly string[] | null | undefined): boolean {
  if (!holidays || holidays.length === 0) return false;
  return normalizeCompanyHolidays(holidays).includes(dushanbeDayKey(at));
}

/** Почему сейчас не время звонить роботом, или `null`, если время подходит. */
export function robotCallWindowRefusal(at: Date, cal: RobotCallCalendar = {}): RobotCallWindowRefusal | null {
  if (isCompanyHoliday(at, cal.companyHolidays)) return "holiday";
  const wall = new Date(at.getTime() + DUSHANBE_OFFSET_MS);
  if (isWeekdayOff(wall.getUTCDay(), { companyDaysOff: normalizeDaysOff(cal.companyDaysOff) })) return "day_off";
  const hour = wall.getUTCHours();
  if (hour < ROBOT_CALL_DAY_START_HOUR || hour >= ROBOT_CALL_DAY_END_HOUR) return "outside_hours";
  return null;
}

const DAY_MS = 24 * 3600_000;

/** Начало ближайшего окна звонков робота не раньше `at` (сам `at`, если он уже в окне). */
export function nextRobotCallWindowStart(at: Date, cal: RobotCallCalendar = {}): Date {
  if (robotCallWindowRefusal(at, cal) === null) return at;
  const wall = new Date(at.getTime() + DUSHANBE_OFFSET_MS);
  const startOf = (offset: number) =>
    new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + offset, ROBOT_CALL_DAY_START_HOUR) - DUSHANBE_OFFSET_MS);
  let offset = wall.getUTCHours() < ROBOT_CALL_DAY_START_HOUR ? 0 : 1;
  // Предохранитель: год праздников и выходных подряд схема не пропускает, но цикл от этого не зависит.
  for (let guard = 0; guard < 400; guard++, offset++) {
    const candidate = startOf(offset);
    if (robotCallWindowRefusal(candidate, cal) === null) return candidate;
  }
  return new Date(at.getTime() + DAY_MS);
}

/** Откуда пришёл запрет «не звонить роботом». Значения — как в базе (enum RobotCallStopSource). */
export const ROBOT_CALL_STOP_SOURCES = ["CONVERSATION", "VOICE", "STAFF", "STATION"] as const;
export type RobotCallStopSource = (typeof ROBOT_CALL_STOP_SOURCES)[number];

export const ROBOT_CALL_STOP_SOURCE_LABELS: Record<RobotCallStopSource, string> = {
  CONVERSATION: "клиент попросил в переписке",
  VOICE: "клиент попросил в разговоре с роботом",
  STAFF: "поставил сотрудник",
  STATION: "номер в чёрном списке станции",
};

/** Причины, по которым робот не набирает номер. */
export const ROBOT_CALL_REFUSAL_CODES = [
  "invalid_number",
  "outside_hours",
  "day_off",
  "holiday",
  "stopped",
  "opted_out",
  "blacklisted",
  "daily_limit",
  "weekly_limit",
  "policy_unavailable",
] as const;
export type RobotCallRefusalCode = (typeof ROBOT_CALL_REFUSAL_CODES)[number];

/** Простыми словами — для кнопки «Звонок роботом» и журнала. */
export const ROBOT_CALL_REFUSAL_TEXT: Record<RobotCallRefusalCode, string> = {
  invalid_number: "Номер не похож на таджикский — станция не сможет его набрать",
  outside_hours: `Робот звонит только с ${String(ROBOT_CALL_DAY_START_HOUR).padStart(2, "0")}:00 до ${ROBOT_CALL_DAY_END_HOUR}:00 по Душанбе`,
  day_off: "Сегодня выходной — робот не звонит",
  holiday: "Сегодня праздник — робот не звонит",
  stopped: "Этому номеру нельзя звонить роботом: стоит отметка «Не звонить роботом»",
  opted_out: "Клиент просил его не беспокоить — робот не звонит",
  blacklisted: "Номер в чёрном списке станции — робот не звонит",
  daily_limit: "Робот уже разговаривал с этим номером сегодня — следующий звонок завтра",
  weekly_limit: "Робот уже звонил на этот номер три раза за неделю — пауза",
  policy_unavailable: "Не удалось проверить, можно ли звонить, — попробуйте позже",
};

/** Отказ «перенести, а не тратить попытку»: время или частота, а не запрет человека. */
export const ROBOT_CALL_DEFER_CODES: ReadonlySet<RobotCallRefusalCode> = new Set([
  "outside_hours",
  "day_off",
  "holiday",
  "daily_limit",
  "weekly_limit",
  "policy_unavailable",
]);

/** PUT /clients/:id/robot-call-stop — поставить или снять «Не звонить роботом». */
export const robotCallStopUpdateSchema = z
  .object({
    stopped: z.boolean(),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .strict();
export type RobotCallStopUpdate = z.infer<typeof robotCallStopUpdateSchema>;

/** Ответ ручки: что сейчас запрещает роботу звонить этому клиенту. */
export const robotCallStopStateSchema = z.object({
  /** Стоит ли отметка «Не звонить роботом» (по номеру клиента или по карточке). */
  stopped: z.boolean(),
  source: z.enum(ROBOT_CALL_STOP_SOURCES).nullable(),
  since: z.string().nullable(),
  /** Клиент сам просил не беспокоить в переписке — робот не звонит и без отметки. */
  optedOutInChat: z.boolean(),
  /** Может ли этот сотрудник снять отметку (просьбу клиента снимает только руководство). */
  canClear: z.boolean(),
});
export type RobotCallStopState = z.infer<typeof robotCallStopStateSchema>;
