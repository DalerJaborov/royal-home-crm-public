/**
 * ОБЩИЕ ШАГИ «ЦИФРЫ → РЕЧЬ» ДЛЯ ОБОИХ ЯЗЫКОВ (17.11.2026, правки диспетчера к #252).
 * Модуль не знает слов ни одного языка: слова передаёт вызывающий (russianSpeechNumbers,
 * tajikSpeechNumbers), поэтому круга импортов нет.
 *
 * 1. Номер телефона (7–12 цифр подряд или с пробелами/дефисами/скобками, «+992…») читается
 *    по группам, как его диктуют: «девяносто, сто двадцать три, сорок пять, шестьдесят семь».
 *    Иначе «900123456» прозвучал бы как «девятьсот миллионов…». Не номер: тысячи через пробел
 *    («1 200 000»), сумма с валютой («120000000 сомони», «$120000000»), даты.
 * 2. Дробная площадь округляется до целого («117,85 м²» → «118 м²»), дробная сумма от ста и
 *    больше — до целого вниз (дирамы и центы вслух не называют). Мелкая дробная сумма («99,5 сомонӣ») и
 *    прочие дроби остаются цифрами: вызывающий отдаст их текстом, а не голосом.
 */

const SEP_CLASS = "[ \\u00a0\\u202f()\\-‐‑–]";
const PHONE = new RegExp(`(^|[^\\p{L}\\p{N}_.,:/])(\\+?\\(?\\d(?:${SEP_CLASS}*\\d){6,14})(?![\\p{L}\\p{N}_]|[.,:/]\\d)`, "gu");
const SEPARATORS = /[ \u00a0\u202f()\-‐‑–]+/u;
const THOUSANDS = /^\d{1,3}(?:[ \u00a0\u202f]\d{3})+$/u;
const DATE_LIKE = /^\d{1,2}-\d{1,2}-\d{2,4}$|^\d{4}-\d{1,2}-\d{1,2}/u;
const MONEY_AFTER = /^[ \u00a0\u202f]*(?:сомон|доллар|долл|\$|usd|tjs|дирам|цент|евро|рубл)/iu;
const AREA_UNIT = "м[²2]|кв\\.?[ \\u00a0\\u202f]*м|квадрат|метр";
const MONEY_UNIT = "сомон|доллар|долл|usd|tjs";

/** Группы, как диктуют таджикский номер: 2-3-2-2 у девяти цифр, «992» отдельно. */
function phoneGroups(digits: string): string[] {
  if (digits.length === 12 && digits.startsWith("992")) return ["992", ...phoneGroups(digits.slice(3))];
  const pattern = digits.length === 9 ? [2, 3, 2, 2] : digits.length === 10 ? [3, 3, 2, 2] : digits.length === 7 ? [3, 2, 2] : null;
  const out: string[] = [];
  if (pattern) {
    let i = 0;
    for (const size of pattern) { out.push(digits.slice(i, i + size)); i += size; }
    return out;
  }
  let i = digits.length % 2;
  if (i) out.push(digits.slice(0, i));
  for (; i < digits.length; i += 2) out.push(digits.slice(i, i + 2));
  return out;
}

export type SpeechWords = { cardinal: (n: number) => string; zero: string; plus: string };

function sayGroup(group: string, words: SpeechWords): string {
  const lead = /^0+/u.exec(group)?.[0].length ?? 0;
  const rest = group.slice(lead);
  return [...Array<string>(lead).fill(words.zero), ...(rest ? [words.cardinal(Number(rest))] : [])].join(" ");
}

/** Номера телефонов — по группам цифр; всё остальное не трогает. */
export function speakPhoneNumbers(text: string, words: SpeechWords): string {
  return text.replace(PHONE, (match: string, lead: string, raw: string, offset: number, whole: string) => {
    const digits = raw.replace(/\D/gu, "");
    if (digits.length < 7 || digits.length > 12) return match;
    if (THOUSANDS.test(raw) || DATE_LIKE.test(raw)) return match;
    if (lead === "$" || MONEY_AFTER.test(whole.slice(offset + match.length))) return match;
    const body = raw.replace(/^\+/u, "");
    // Разделители автора сохраняют его группы; слитный номер режется по образцу.
    const parts = SEPARATORS.test(body) ? body.split(SEPARATORS).filter(Boolean) : phoneGroups(digits);
    return `${lead}${raw.startsWith("+") ? `${words.plus} ` : ""}${parts.map((g) => sayGroup(g, words)).join(", ")}`;
  });
}

/** Дробная площадь — до целого всегда, дробная сумма — от ста и больше. */
export function roundSpokenDecimals(text: string): string {
  return text
    .replace(new RegExp(`(\\d+)[.,](\\d+)(?=[ \\u00a0\\u202f]*(?:${AREA_UNIT}))`, "giu"), (_m: string, int: string, frac: string) => String(Math.round(Number(`${int}.${frac}`))))
    .replace(new RegExp(`(\\d+)[.,](\\d{1,2})(?=[ \\u00a0\\u202f]*(?:${MONEY_UNIT}))`, "giu"), (match: string, int: string, frac: string) => {
      const value = Number(`${int}.${frac}`);
      return value >= 100 ? String(Math.floor(value)) : match;
    });
}
