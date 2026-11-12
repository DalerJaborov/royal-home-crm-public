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

/**
 * ПРЕДОХРАНИТЕЛЬ НАБОРОВ НА ОДИН НОМЕР (П5, 11.11.2026). Частота выше считает только
 * состоявшиеся разговоры: автоответчик, «взял не тот» и наш сбой её не тратят — так
 * задумано, чтобы повтор после сбоя не убивал приглашение. Но каждый такой поднятый
 * звонок тратит минуты ElevenLabs, и сценарий, зациклившийся на автоответчике, звонил бы
 * одному номеру без конца. Поэтому отдельно: не больше стольких ПОДНЯТЫХ звонков робота
 * (любых сессий, с любым итогом) на номер за сутки по Душанбе. Это предохранитель от
 * нашей ошибки, а не политика компании: в Настройки не вынесен (ОЦЕНКА — подтвердить у
 * владельца). Проверочный звонок из Настроек не считается.
 */
export const ROBOT_CALL_DAILY_SESSIONS_FUSE = 4;

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
  // П5 (11.11.2026): потолок минут робота (lib/liveVoiceSpend.ts) и предохранитель наборов на номер.
  "minutes_cap_day",
  "minutes_cap_month",
  "daily_sessions_fuse",
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
  weekly_limit: "Робот уже разговаривал с этим номером несколько раз за неделю — пауза",
  policy_unavailable: "Не удалось проверить, можно ли звонить, — попробуйте позже",
  minutes_cap_day: "Робот наговорил дневной потолок минут — звонки перенесены на завтра. Потолок — в Настройках, раздел «Живой голос»",
  minutes_cap_month: "Робот наговорил месячный потолок минут — звонки перенесены на следующий месяц. Потолок — в Настройках, раздел «Живой голос»",
  daily_sessions_fuse: "Робот уже несколько раз поднимал звонок на этот номер сегодня — следующий звонок завтра",
};

function timesRu(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} раз`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} раза`;
  return `${n} раз`;
}

/** Текст отказа с числами из Настроек (частота на номер). */
export function robotCallRefusalText(code: RobotCallRefusalCode, limits: { weeklyMax?: number } = {}): string {
  if (code === "weekly_limit" && limits.weeklyMax && limits.weeklyMax > 0) {
    return `Робот уже разговаривал с этим номером ${timesRu(limits.weeklyMax)} за неделю — пауза`;
  }
  return ROBOT_CALL_REFUSAL_TEXT[code];
}

/**
 * Предел частоты из Настроек: целое ≥ 1. Ноль и отрицательное НЕ значат «без предела»
 * (это сняло бы защиту одной опечаткой) — берётся значение по умолчанию.
 */
export function robotCallLimitOrDefault(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fallback;
}

/** Отказ «перенести, а не тратить попытку»: время или частота, а не запрет человека. */
export const ROBOT_CALL_DEFER_CODES: ReadonlySet<RobotCallRefusalCode> = new Set([
  "outside_hours",
  "day_off",
  "holiday",
  "daily_limit",
  "weekly_limit",
  "policy_unavailable",
  "minutes_cap_day",
  "minutes_cap_month",
  "daily_sessions_fuse",
]);

/**
 * PUT /clients/:id/robot-call-stop — поставить или снять «Не звонить роботом».
 * `stopped: false` снимает только отметку сотрудника. Просьбу САМОГО клиента (в переписке,
 * в разговоре с роботом, станция) снимает лишь явное действие руководителя:
 * `{ stopped: false, overrideClientRequest: true }` — это не побочный эффект снятия своей отметки.
 */
export const robotCallStopUpdateSchema = z
  .object({
    stopped: z.boolean(),
    overrideClientRequest: z.literal(true).optional(),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .strict()
  .refine((v) => !(v.stopped && v.overrideClientRequest), "Разрешение вопреки просьбе клиента — только при снятии запрета");
export type RobotCallStopUpdate = z.infer<typeof robotCallStopUpdateSchema>;

/** Просьба самого клиента: откуда она. */
export const ROBOT_CALL_CLIENT_REASONS = ["CONVERSATION", "VOICE", "STATION"] as const;
export type RobotCallClientReason = (typeof ROBOT_CALL_CLIENT_REASONS)[number];

/** Ответ ручки: что сейчас запрещает роботу звонить этому клиенту — все причины сразу. */
export const robotCallStopStateSchema = z.object({
  /** Робот этому клиенту не звонит (по любой из причин ниже). */
  stopped: z.boolean(),
  /** Отметка сотрудника «Не звонить роботом». */
  staffStop: z.boolean(),
  /** Действующие просьбы самого клиента; пусто — их нет (или руководство разрешило). */
  clientReasons: z.array(z.enum(ROBOT_CALL_CLIENT_REASONS)),
  since: z.string().nullable(),
  /** Клиент просил в переписке не беспокоить (сама отметка переписки, для рассылок не трогается). */
  optedOutInChat: z.boolean(),
  /** Руководство разрешило роботу звонить вопреки просьбе клиента (кто — в журнале действий). */
  allowedBySupervisor: z.boolean(),
  /** Может ли этот сотрудник снять отметку сотрудника. */
  canClear: z.boolean(),
  /** Может ли этот сотрудник разрешить робота вопреки просьбе клиента (руководство). */
  canOverride: z.boolean(),
});
export type RobotCallStopState = z.infer<typeof robotCallStopStateSchema>;

/** Подпись причин просьбы клиента: «в переписке и в разговоре с роботом». */
export function robotCallClientReasonsRu(reasons: readonly RobotCallClientReason[]): string {
  const words: Record<RobotCallClientReason, string> = {
    CONVERSATION: "в переписке",
    VOICE: "в разговоре с роботом",
    STATION: "номер в чёрном списке станции",
  };
  return reasons.map((r) => words[r]).join(", ");
}
