/** Душанбе — UTC+5 круглый год (без перехода на летнее время). Сервер обычно
 * работает в UTC (Docker без явного TZ), поэтому "рабочие часы"/KPI/распределение
 * лидов считаем через явный сдвиг, а не через часовой пояс процесса. */
export const DUSHANBE_OFFSET_MS = 5 * 60 * 60 * 1000;

/** Текущее время как "настенные" часы Душанбе — используй только .getUTC*() у
 * результата (значения полей сдвинуты, сам Date не является реальным instant). */
export function dushanbeWallClock(at: Date = new Date()): Date {
  return new Date(at.getTime() + DUSHANBE_OFFSET_MS);
}

/**
 * «2026-08-10» + «18:00» по Душанбе → настоящий момент времени.
 *
 * Обратная операция к dushanbeWallClock. Нужна там, где местное время приходит
 * строкой без пояса: из формы агента и от модели, разбирающей разговор («встретимся
 * сегодня в шесть» → «2026-08-10T18:00»). Без явного вычитания сдвига такая строка
 * попадала бы в базу как UTC, то есть на пять часов позже, — этой ловушкой уже
 * однажды поехали все напоминания о встречах (аудит 06.08.2026).
 *
 * Время не указано — полдень: встреча «в какой-то день» посреди рабочего дня
 * заметнее, чем в полночь, когда её никто не увидит.
 */
export function dushanbeInputToDate(date: string, time = "12:00"): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return new Date(NaN);
  return new Date(Date.UTC(y, m - 1, d, hh, mm, 0) - DUSHANBE_OFFSET_MS);
}

/**
 * Дата «ГГГГ-ММ-ДД» по Душанбе — для подписей, которые читает человек
 * (ночная проверка 01.10.2026, №176: `toISOString().slice(0, 10)` даёт дату по
 * UTC, и с 00:00 до 05:00 по Душанбе в подписи стояла вчерашняя).
 */
export function dushanbeDateString(at: Date = new Date()): string {
  return dushanbeWallClock(at).toISOString().slice(0, 10);
}

/** "HH:MM" по Душанбе на переданный момент. */
export function dushanbeTimeString(at: Date = new Date()): string {
  const wall = dushanbeWallClock(at);
  const hh = String(wall.getUTCHours()).padStart(2, "0");
  const mm = String(wall.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * "YYYY-MM-DD HH:MM" по Душанбе — для текста, который читает ЧЕЛОВЕК или модель
 * (аудит №4, 27.08: ассистент называл агенту время показов сырым ISO по UTC,
 * то есть на пять часов раньше — «показ в 10:00» звучал как «в 05:00»).
 *
 * Смещение зашито в строку без суффикса Z намеренно: это стенные часы Душанбе,
 * а не момент времени, и добавлять к ним таймзону читателю не нужно.
 */
export function dushanbeDateTimeString(at: Date): string {
  const wall = dushanbeWallClock(at);
  const date = wall.toISOString().slice(0, 10);
  const hh = String(wall.getUTCHours()).padStart(2, "0");
  const mm = String(wall.getUTCMinutes()).padStart(2, "0");
  return `${date} ${hh}:${mm}`;
}

/**
 * true, если "HH:MM" момента `at` (по Душанбе) находится в [start, end) —
 * лексикографическое сравнение работает, т.к. формат фиксирован.
 *
 * ОКНО ЧЕРЕЗ ПОЛНОЧЬ (12.09.2026). Пока все окна в системе были дневными
 * (рабочие часы 09:30–18:00, часы алармов 09:50–14:45), хватало одного
 * сравнения `now >= start && now < end`. Ночные тихие часы «21:00 → 08:00»
 * такое сравнение возвращало ЛОЖЬЮ всегда: 23:00 не больше 21:00 и меньше
 * 08:00 одновременно. Теперь start > end читается как «окно перевалило за
 * полночь» и проверяется объединением двух отрезков — [start, 24:00) и
 * [00:00, end). Случай start === end — окно нулевой длины, а не круглосуточное:
 * «с 09:00 до 09:00» значит «никогда», иначе опечатка в настройке тихо
 * включила бы тишину на сутки.
 */
export function isWithinDushanbeWindow(startHHMM: string, endHHMM: string, at: Date = new Date()): boolean {
  const now = dushanbeTimeString(at);
  if (startHHMM <= endHHMM) return now >= startHHMM && now < endHHMM;
  return now >= startHHMM || now < endHHMM;
}

/**
 * Ближайший момент, когда по Душанбе наступит "HH:MM" (строго после `at`).
 *
 * Нужен, чтобы отложить уведомление «до начала рабочего дня»: считать это
 * арифметикой над UTC нельзя — контейнер живёт в UTC, и «завтра в 08:00»
 * получалось бы на пять часов мимо.
 */
export function dushanbeNextOccurrence(hhmm: string, at: Date = new Date()): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const wall = dushanbeWallClock(at);
  const today = new Date(
    Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), h, m, 0) - DUSHANBE_OFFSET_MS
  );
  return today.getTime() > at.getTime() ? today : new Date(today.getTime() + 24 * 60 * 60 * 1000);
}

/** Границы календарного дня в Душанбе (как UTC Date) — день, которому принадлежит
 * момент `at`. Используется для KPI (посчитать "за вчера") и любых дневных срезов. */
export function dushanbeDayRange(at: Date): { start: Date; end: Date } {
  const wall = dushanbeWallClock(at);
  const y = wall.getUTCFullYear();
  const m = wall.getUTCMonth();
  const d = wall.getUTCDate();
  const start = new Date(Date.UTC(y, m, d, 0, 0, 0) - DUSHANBE_OFFSET_MS);
  const end = new Date(Date.UTC(y, m, d + 1, 0, 0, 0) - DUSHANBE_OFFSET_MS);
  return { start, end };
}

/**
 * Начало текущих суток по Душанбе. Замена привычному
 * `const d = new Date(); d.setHours(0,0,0,0)` — оно берёт часовой пояс ПРОЦЕССА,
 * а прод-контейнер живёт в UTC (Dockerfile без TZ). Из-за этого «сегодня» на
 * дашборде и в сводке директору начиналось в 05:00 по Душанбе, а не в полночь.
 */
export function dushanbeStartOfToday(at: Date = new Date()): Date {
  return dushanbeDayRange(at).start;
}

/**
 * Начало месяца по Душанбе — замена `new Date(y, m, 1)` по тем же причинам.
 * Смещение на 5 часов сдвигало границу месяца: сделка, закрытая 1-го числа до
 * 05:00, попадала в отчёт за прошлый месяц.
 */
export function dushanbeStartOfMonth(at: Date = new Date()): Date {
  const wall = dushanbeWallClock(at);
  return new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), 1, 0, 0, 0) - DUSHANBE_OFFSET_MS);
}

/** Конец календарного дня по Душанбе (включительно), для фильтров «по дату N». */
export function dushanbeEndOfDay(at: Date): Date {
  return new Date(dushanbeDayRange(at).end.getTime() - 1);
}
