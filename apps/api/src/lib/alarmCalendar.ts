import {
  addWorkingDays,
  isDayOff,
  NO_DAYS_OFF,
  startOfWorkingDayAtOrAfter as sharedStartOfWorkingDay,
  workingDaysBetween as sharedWorkingDaysBetween,
  type DaysOffCalendar,
} from "@royal-home/shared";

/**
 * КАЛЕНДАРЬ ТРЕВОГ — по НАСТРОЙКАМ, а не по зашитому воскресенью (владелец 11.10.2026:
 * «у нас нет никаких выходных … из настроек можно выбрать, у кого выходной»).
 *
 * До 11.10 здесь жила рабочая неделя понедельник–суббота с выходным воскресеньем
 * (решение 08.09.2026). Теперь выходные — данные: `Settings.companyDaysOff` (общие) и
 * `Agent.weeklyDaysOff` (личные). Само правило — packages/shared/src/daysOff.ts, этот
 * файл только держит прежние имена, чтобы вызывающие не расходились по смыслу.
 * Календарь передаёт вызывающий (lib/daysOffCalendar.ts читает его из базы); не
 * передан — выходных нет, каждый день рабочий (это и есть значение по умолчанию).
 *
 * ПОЧЕМУ ОТДЕЛЬНО ОТ lib/businessDays.ts. Тот календарь считает выходными субботу и
 * воскресенье, и по нему живёт срок резерва объекта под сделку — у него своя история и
 * свой смысл, его эта правка не трогает.
 *
 * ЧТО ИЗ ЭТОГО СЛЕДУЕТ ДЛЯ СИСТЕМЫ КОНТРОЛЯ:
 *  - выходной (общий или личный ЭТОГО агента) не идёт в счётчики тишины;
 *  - штрафы за выходной не начисляются: наказание за нерабочий день — первое, что
 *    ломает доверие сотрудников к системе;
 *  - пустые списки — выходных нет, и тревоги считают каждый день.
 */

export type { DaysOffCalendar };

/** true, если момент попадает на выходной по календарю (по Душанбе). */
export function isAlarmDayOff(at: Date, cal: DaysOffCalendar = NO_DAYS_OFF): boolean {
  return isDayOff(at, cal);
}

/**
 * Сколько РАБОЧИХ суток календаря тревог прошло между двумя моментами.
 * Считаем сутками, а не датами: «три рабочих дня» от среды 15:00 — это суббота 15:00
 * (при пустом календаре). Сутки, кончающиеся в выходной, в счёт не идут.
 */
export function workingDaysBetween(from: Date, to: Date, cal: DaysOffCalendar = NO_DAYS_OFF): number {
  return sharedWorkingDaysBetween(from, to, cal);
}

/** Момент, когда истекут `days` рабочих суток от `from`. Зеркало workingDaysBetween. */
export function addAlarmWorkingDays(from: Date, days: number, cal: DaysOffCalendar = NO_DAYS_OFF): Date {
  return addWorkingDays(from, days, cal);
}

/**
 * НАЧАЛО БЛИЖАЙШЕГО РАБОЧЕГО ДНЯ (владелец 09.09.2026). Отсчёт сроков по клиенту идёт
 * не с минуты его сообщения, а с начала рабочего дня: написал в 23:00 — срок считается
 * с утра. Выходной по календарю пропускается целиком.
 */
export function startOfWorkingDayAtOrAfter(at: Date, dayStartHHMM = "09:30", cal: DaysOffCalendar = NO_DAYS_OFF): Date {
  return sharedStartOfWorkingDay(at, cal, dayStartHHMM);
}
