import { DUSHANBE_OFFSET_MS, dushanbeWallClock } from "./dushanbeTime.js";

/**
 * ПЕРИОД ДИДЖЕСТА ИНСАЙТОВ — ОДНО МЕСТО ДЛЯ КРОНА И КНОПКИ «СОБРАТЬ СЕЙЧАС».
 *
 * Собрание директоров — 15-го и 30-го (в коротком месяце — в последний день)
 * в 09:00 по Душанбе, и сводка собирается в это же утро. Прежде период шёл
 * «1–15, 23:59» и «16–конец месяца»: сводку собирали в 09:00, а период
 * заканчивался в полночь — события с 09:00 до конца дня собрания (а 31-го
 * числа — и весь следующий день) не попадали ни в одну сводку (E10 глубокой
 * проверки 02.10.2026). Теперь период — ровно от прошлого собрания до этого:
 * соседние периоды стыкуются без зазора, дни собраний те же.
 *
 * Правило было скопировано в cron.ts и routes/insights.ts — теперь оба зовут
 * эту функцию.
 */

const MEETING_HOUR = 9;

/** День собрания второй половины месяца: 30-е или последний день короткого месяца. */
function secondMeetingDay(y: number, m: number): number {
  return Math.min(30, new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
}

function meetingInstant(y: number, m: number, day: number): Date {
  return new Date(Date.UTC(y, m, day, MEETING_HOUR, 0, 0) - DUSHANBE_OFFSET_MS);
}

export interface InsightDigestPeriod {
  periodStart: Date;
  /** Включительно — сборщики берут `lte`; за миллисекунду до собрания. */
  periodEnd: Date;
  meetingAt: Date;
}

/** Ближайшее собрание (сегодняшнее или следующее) и период, который к нему ведёт. */
export function insightDigestPeriod(now: Date = new Date()): InsightDigestPeriod {
  const wall = dushanbeWallClock(now);
  const y = wall.getUTCFullYear();
  const m = wall.getUTCMonth();
  const day = wall.getUTCDate();

  let meetingAt: Date;
  let periodStart: Date;
  if (day <= 15) {
    meetingAt = meetingInstant(y, m, 15);
    periodStart = meetingInstant(y, m - 1, secondMeetingDay(y, m - 1));
  } else if (day <= secondMeetingDay(y, m)) {
    meetingAt = meetingInstant(y, m, secondMeetingDay(y, m));
    periodStart = meetingInstant(y, m, 15);
  } else {
    // 31-е: собрание этого месяца уже прошло 30-го, ближайшее — 15-го следующего.
    meetingAt = meetingInstant(y, m + 1, 15);
    periodStart = meetingInstant(y, m, secondMeetingDay(y, m));
  }
  return { periodStart, periodEnd: new Date(meetingAt.getTime() - 1), meetingAt };
}

/** Сегодня по Душанбе — день собрания (15-е или 30-е / последний день короткого месяца). */
export function isInsightMeetingDay(now: Date = new Date()): boolean {
  const wall = dushanbeWallClock(now);
  const day = wall.getUTCDate();
  return day === 15 || day === secondMeetingDay(wall.getUTCFullYear(), wall.getUTCMonth());
}
