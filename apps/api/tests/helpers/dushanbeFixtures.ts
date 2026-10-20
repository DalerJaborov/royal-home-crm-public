import { dushanbeDayRange, dushanbeStartOfMonth } from "../../src/lib/dushanbeTime.js";

/**
 * ВРЕМЕННЫЕ ТОЧКИ ДЛЯ ФИКСТУР, НЕ ЗАВИСЯЩИЕ ОТ ЧАСА ПРОГОНА.
 *
 * Зачем это вообще. Душанбе живёт в UTC+5, а контейнер и раннер CI — в UTC.
 * Полночь по Душанбе наступает в 19:00 UTC, то есть посреди рабочего дня
 * сборщика. Привычная фикстура `new Date(Date.now() - 2 * 60 * 60 * 1000)`
 * («два часа назад») в 19:00–21:00 UTC оказывается ВЧЕРАШНИМ днём по Душанбе, и
 * тест, который проверяет «сегодня» (`newToday`, дневной срез дашборда, дневной
 * ключ бюджета ИИ), падает на совершенно исправном коде. То же самое с месяцем:
 * «три дня назад» первого числа — это прошлый месяц.
 *
 * Такие падения нельзя воспроизвести днём и невозможно отличить от настоящей
 * поломки. Проверено 11.09.2026: сплошная сверка набора в 00:30 по Душанбе
 * (то есть в самое опасное окно) нашла ровно один такой тест — clients-summary
 * с его `newToday`. Остальные файлы уже брали границы из lib/dushanbeTime.ts;
 * помощник заведён, чтобы следующая фикстура не начиналась с `Date.now() - N`.
 *
 * Правило: если ожидание теста опирается на границу суток или месяца по
 * Душанбе, момент фикстуры берётся отсюда, а не вычитанием из `Date.now()`.
 * Внутри — те же `dushanbeDayRange`/`dushanbeStartOfMonth`, что и в коде
 * (lib/dushanbeTime.ts), никаких `setHours`.
 *
 * Поведение днём не меняется: пока с начала суток прошло больше запрошенного
 * отступа, возвращается ровно `now - msAgo`. Ужимается отступ только у самой
 * границы, где более раннего момента «сегодня» просто не существует.
 */

const SECOND = 1000;

/** Момент `msAgo` назад, но гарантированно внутри ТЕКУЩИХ суток Душанбе. */
export function agoWithinDushanbeDay(msAgo: number, now: Date = new Date()): Date {
  const { start } = dushanbeDayRange(now);
  const elapsed = now.getTime() - start.getTime();
  // Секунда запаса, чтобы момент не совпал с самой границей: срезы берут
  // сутки как [start, end), и точное равенство границе читается неоднозначно.
  const back = Math.min(msAgo, Math.max(elapsed - SECOND, 0));
  return new Date(now.getTime() - back);
}

/** Часы назад, но внутри текущих суток Душанбе. */
export function hoursAgoWithinDushanbeDay(hours: number, now: Date = new Date()): Date {
  return agoWithinDushanbeDay(hours * 60 * 60 * 1000, now);
}

/** Минуты назад, но внутри текущих суток Душанбе. */
export function minutesAgoWithinDushanbeDay(minutes: number, now: Date = new Date()): Date {
  return agoWithinDushanbeDay(minutes * 60 * 1000, now);
}

/** Момент `msAgo` назад, но гарантированно внутри ТЕКУЩЕГО месяца Душанбе. */
export function agoWithinDushanbeMonth(msAgo: number, now: Date = new Date()): Date {
  const start = dushanbeStartOfMonth(now);
  const elapsed = now.getTime() - start.getTime();
  const back = Math.min(msAgo, Math.max(elapsed - SECOND, 0));
  return new Date(now.getTime() - back);
}

/** Дни назад, но внутри текущего месяца Душанбе. */
export function daysAgoWithinDushanbeMonth(days: number, now: Date = new Date()): Date {
  return agoWithinDushanbeMonth(days * 24 * 60 * 60 * 1000, now);
}

/**
 * Сколько полных минут прошло от момента фикстуры до «сейчас» — чтобы ожидание
 * теста считалось по тому же правилу, что и фикстура, а не по круглому числу,
 * которое верно лишь днём.
 */
export function minutesSince(at: Date, now: Date = new Date()): number {
  return Math.floor((now.getTime() - at.getTime()) / 60_000);
}
