/**
 * ПОДПИСИ МЕСЯЦА ПО КЛЮЧУ «ГГГГ-ММ» — одно место для сервера и сайта (20.11.2026).
 *
 * До этого одно и то же правило жило трижды: отчёт PDF на сервере
 * (apps/api/src/lib/reportPdf/theme.ts), «Графики по команде» и графики главной
 * «Нового вида» на сайте. Сторож `npm run audit:rules` поймал второе экспортное
 * имя `monthTitle`; обе стороны теперь зовут отсюда.
 */
const MONTHS_NOM = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/** «2026-11» → «Ноябрь 2026». */
export function monthTitle(key: string): string {
  const [y, m] = key.split("-").map(Number);
  const name = MONTHS_NOM[(m ?? 1) - 1] ?? key;
  return `${name[0]!.toUpperCase()}${name.slice(1)} ${y}`;
}

/** «2026-11» → «ноя». */
export function monthShort(key: string): string {
  const m = Number(key.split("-")[1]);
  return MONTHS_SHORT[m - 1] ?? key;
}
