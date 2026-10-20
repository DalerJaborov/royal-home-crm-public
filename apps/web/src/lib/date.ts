function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function toLocalDateInput(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Момент времени → значение для <input type="datetime-local"> в часах агента.
 *  Через toISOString нельзя: он даёт UTC, и в Душанбе (UTC+5) поле показало бы
 *  время на пять часов раньше назначенного. */
export function toLocalDateTimeInput(value: string | Date) {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function firstDayOfCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
}

/**
 * Время в часах ДУШАНБЕ, а не в часах браузера.
 *
 * Зачем понадобилось. Весь интерфейс печатал даты через toLocaleString без
 * часового пояса, то есть в часах того устройства, с которого смотрят. Для агента
 * в Душанбе это одно и то же и проблемы не было. А владелец 01.08.2026 открыл CRM
 * из Стамбула (UTC+3) и увидел: в хронологии «показ перенесён на 03.08 в 16:00»
 * (эту строку собирает сервер по Душанбе), а на плашке объекта «Показ 03.08 в
 * 14:00». Два числа про одну встречу на одном экране — и веры не остаётся ни
 * одному.
 *
 * Компания работает в одном городе, и время у неё одно — душанбинское. Поэтому
 * пояс задаётся явно, а не берётся у устройства: агент в поездке, директор в
 * отпуске и сервер обязаны видеть один и тот же час.
 */
const DUSHANBE_TZ = "Asia/Dushanbe";

/**
 * Обратное преобразование: то, что человек НАБРАЛ в полях «дата» и «время»,
 * — это душанбинский час, а не час его устройства.
 *
 * Тот же урок, что выше, но со стороны ввода, и он был пропущен. Формы делали
 * `new Date(\`${date}T${time}\`).toISOString()`, а такая строка без указания
 * пояса трактуется как локальное время БРАУЗЕРА. Агент из Стамбула назначал
 * показ на 14:00, в базу уезжало 11:00 UTC, и клиенту уходило «показ в 16:00» —
 * молча, без единой ошибки. Достаточно было неверно выставленного часового
 * пояса на ноутбуке, чтобы встреча сдвинулась.
 *
 * Таджикистан живёт на UTC+5 круглый год (переводов часов нет с 1991-го),
 * поэтому смещение можно задать константой — без неё пришлось бы городить
 * обратный поиск через Intl ради часового пояса, который не меняется.
 */
export function dushanbeInputToIso(date: string, time?: string): string {
  return new Date(`${date}T${time || "00:00"}:00+05:00`).toISOString();
}

/**
 * «03.08 в 16:00» — время встречи, задачи, показа. Год дописывается, только
 * если он не текущий («01.01.2027 в 05:00»): 24.09.2026 пауза лидов показывала
 * «до 01.01 в 05:00», и нельзя было понять, какой это год — через три месяца
 * или через сто лет.
 */
export function dushanbeDateTime(value: string | Date, now: Date = new Date()): string {
  const date = new Date(value);
  const year = (d: Date) => d.toLocaleString("ru-RU", { timeZone: DUSHANBE_TZ, year: "numeric" });
  return date
    .toLocaleString("ru-RU", {
      timeZone: DUSHANBE_TZ,
      day: "2-digit",
      month: "2-digit",
      ...(year(date) === year(now) ? {} : { year: "numeric" as const }),
      hour: "2-digit",
      minute: "2-digit",
    })
    .replace(", ", " в ");
}

/** «16:00» — когда дата уже известна из контекста. */
export function dushanbeTime(value: string | Date): string {
  return new Date(value).toLocaleTimeString("ru-RU", {
    timeZone: DUSHANBE_TZ,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Дата без времени. Пояс важен и здесь: около полуночи день иначе уезжает на сутки. */
export function dushanbeDate(value: string | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Date(value).toLocaleDateString("ru-RU", { timeZone: DUSHANBE_TZ, ...options });
}

/**
 * Подпись дня для разделителей и групп списков: «Сегодня» и «Вчера» человек
 * узнаёт мгновенно, дата заставляет вспоминать, какое сегодня число. Дни — по
 * Душанбе. Жила локально в Messages.tsx; вынесена при мобильном редизайне
 * 17.08.2026 — те же подписи нужны мобильным чатам и журналу звонков.
 */
export function dushanbeDayLabel(at: string | Date): string {
  const day = dushanbeDate(at);
  if (day === dushanbeDate(new Date())) return "Сегодня";
  if (day === dushanbeDate(new Date(Date.now() - 86_400_000))) return "Вчера";
  return dushanbeDate(at, { day: "numeric", month: "long" });
}
/**
 * Сутки ПО ДУШАНБЕ для группировки и сравнения — «2026-08-03».
 *
 * Календарь раскладывал задачи по клеткам через setHours(0,0,0,0) и toDateString(),
 * то есть по часам устройства. Для агента в Душанбе это одно и то же, а владелец,
 * открывший CRM из Стамбула (UTC+3), видел показ, назначенный на 00:30 4 августа,
 * в клетке 3-го — и подпись рядом честно писала «4 авг», потому что она уже шла
 * через часовой пояс. Два разных числа про одну встречу на одном экране.
 *
 * Ключ строкой, а не Date: сравнение суток — это сравнение календарных дней, и
 * заводить для него момент времени значит снова тащить за собой часовой пояс.
 */
// Само правило — в общем пакете: до 22.09.2026 оно было написано и здесь, и на
// сервере, разными способами (здесь toLocaleDateString("en-CA"), там сдвиг
// времени). Ответы совпадали, но это были два независимых куска кода под одним
// именем — тот самый случай, когда правку одной стороны вторая не узнаёт.
// Разбор — в шапке packages/shared/src/dushanbeDay.ts (#752).
import { dushanbeDayKey, dushanbeHour } from "@royal-home/shared";
// dushanbeHour — текущий час по Душанбе 0–23 (пульт меняет тон по времени
// суток); тоже из общего пакета с 24.09.2026, сервер зовёт то же правило.
export { dushanbeDayKey, dushanbeHour };

/** Сегодняшний день по Душанбе, тем же ключом. */
export function dushanbeTodayKey(): string {
  return dushanbeDayKey(new Date());
}

/** Первое число текущего месяца ПО ДУШАНБЕ, форматом «ГГГГ-ММ-01» — для дефолта
 *  диапазона в Отчётах. Раньше бралось browser-local `new Date()` (см.
 *  firstDayOfCurrentMonth ниже), и у директора, открывшего CRM не из Душанбе,
 *  диапазон периода на день расходился с тем, что считает сервер (там всё через
 *  dushanbeStartOfMonth) — Отчёты и Главная показывали разные цифры за «этот месяц»
 *  по одной и той же причине, что уже ловили в Календаре (см. dushanbeDayKey выше). */
export function dushanbeFirstDayOfMonthKey(): string {
  const [year, month] = dushanbeDayKey(new Date()).split("-");
  return `${year}-${month}-01`;
}
