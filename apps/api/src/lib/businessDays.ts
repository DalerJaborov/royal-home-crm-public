import { dushanbeWallClock } from "./dushanbeTime.js";

/** true, если момент попадает на субботу или воскресенье по Душанбе. */
export function isDushanbeWeekend(at: Date): boolean {
  const day = dushanbeWallClock(at).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Момент, когда истекут `days` РАБОЧИХ суток (выходные не считаются) от `from`,
 * по Душанбе. Считаем сутками, а не календарными датами: резерв, поставленный в
 * среду в 15:00, снимается в понедельник в 15:00 — ровно через три рабочих дня,
 * а не «после третьей рабочей даты в календаре» (это дало бы разный интервал в
 * зависимости от времени суток постановки).
 */
export function addBusinessDays(from: Date, days: number): Date {
  let cursor = from;
  let remaining = days;
  while (remaining > 0) {
    cursor = new Date(cursor.getTime() + 24 * 3600_000);
    if (!isDushanbeWeekend(cursor)) remaining--;
  }
  return cursor;
}
