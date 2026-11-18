/**
 * СУММА, КАК ЕЁ ГОВОРЯТ (18.11.2026): «85 тысяч», «85к», «1,5 млн», «85 000», «85000$».
 * Голосовое «цена восемьдесят пять тысяч» модель обычно сама превращает в 85000, но иногда присылает
 * строку «85 тысяч» — раньше это был отказ схемы или, хуже, число 85. Теперь строка разбирается кодом:
 * множитель (тысяча/миллион) умножает, пробелы и знаки валюты отбрасываются. Не разобралось — NaN
 * (схема откажет и модель переспросит), а не угаданная сумма.
 */
const THOUSAND = String.raw`тысяч[аи]?|тыс\.?|т\.|к|k|минг`;
const MILLION = String.raw`миллион(?:а|ов)?|млн\.?|м|m|миллиун`;
const CURRENCY = String.raw`\$|usd|tjs|сомони|сомонӣ|сомон|с\.|сом|долл\p{L}*|у\.е\.?`;
const AMOUNT = new RegExp(String.raw`^(\d[\d ]*(?:[.,]\d+)?)\s*(?:(${THOUSAND})|(${MILLION}))?\s*(?:${CURRENCY})?$`, "iu");

export function parseSpokenAmount(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  const match = AMOUNT.exec(value.replace(/[  ]/gu, " ").trim());
  if (!match) return Number.NaN;
  const base = Number(match[1]!.replace(/ +/gu, "").replace(",", "."));
  if (match[2]) return Math.round(base * 1_000);
  if (match[3]) return Math.round(base * 1_000_000);
  return base;
}
