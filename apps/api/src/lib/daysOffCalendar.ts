import { normalizeDaysOff, isDayOff, type DaysOffCalendar } from "@royal-home/shared";
import { prisma } from "../db.js";

/**
 * ЧТЕНИЕ ВЫХОДНЫХ ИЗ БАЗЫ (владелец 11.10.2026). Само правило «выходной ли день» —
 * packages/shared/src/daysOff.ts; здесь только откуда взять списки.
 *
 * Без кеша намеренно: Настройки — одна строка по ключу, а кеш в API не узнал бы о
 * правке, сделанной в соседнем процессе (worker), и робот ещё минуту обещал бы
 * звонок по старым выходным.
 *
 * Отказ базы — «выходных нет» (это и значение по умолчанию): лучше лишний раз
 * считать день рабочим, чем молча перестать звонить и раздавать лиды.
 */
export async function loadCompanyDaysOff(): Promise<number[]> {
  const row = await prisma.settings
    .findUnique({ where: { id: "singleton" }, select: { companyDaysOff: true } })
    .catch(() => null);
  // Отказ базы снимок не затирает: последнее прочитанное вернее, чем «выходных нет».
  if (row) lastCompanyDaysOff = normalizeDaysOff(row.companyDaysOff);
  return row ? lastCompanyDaysOff : normalizeDaysOff(null);
}

/**
 * ПОСЛЕДНИЕ ПРОЧИТАННЫЕ ОБЩИЕ ВЫХОДНЫЕ — для синхронных правил, у которых нет похода в
 * базу и десяток вызывающих (часы звонков робота: postShowingCall.ts::alignToCallHours
 * и его соседи). Обновляется каждым loadCompanyDaysOff(); тики робота зовут его первой
 * строкой, так что снимок отстаёт от Настроек не больше чем на один тик (минуту). До
 * первого чтения — пусто, то есть «выходных нет» (значение по умолчанию).
 */
let lastCompanyDaysOff: number[] = [];
export function companyDaysOffSnapshot(): number[] {
  return lastCompanyDaysOff;
}

/** Календарь компании и (если указан) агента — одним заходом. */
export async function loadDaysOffCalendar(agentId?: string | null): Promise<DaysOffCalendar> {
  const [companyDaysOff, agent] = await Promise.all([
    loadCompanyDaysOff(),
    agentId
      ? prisma.agent.findUnique({ where: { id: agentId }, select: { weeklyDaysOff: true } }).catch(() => null)
      : Promise.resolve(null),
  ]);
  return { companyDaysOff, agentDaysOff: normalizeDaysOff(agent?.weeklyDaysOff) };
}

/** Календарь по уже прочитанному агенту (без второго похода в базу). */
export function calendarFor(
  companyDaysOff: readonly number[],
  agent: { weeklyDaysOff?: readonly number[] | null } | null | undefined
): DaysOffCalendar {
  return { companyDaysOff, agentDaysOff: normalizeDaysOff(agent?.weeklyDaysOff) };
}

/** Выходной ли у агента в момент `at` (его личный или общий). */
export async function isAgentDayOff(agentId: string, at: Date = new Date()): Promise<boolean> {
  return isDayOff(at, await loadDaysOffCalendar(agentId));
}
