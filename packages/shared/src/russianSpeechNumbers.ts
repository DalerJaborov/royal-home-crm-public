import { numberToWords, ruPlural, russianGenitive, russianOrdinal } from "./spokenNumber.js";
import { roundSpokenDecimals, speakPhoneNumbers } from "./speechNumberShared.js";

/** Порядковое в нужном падеже: меняется только последнее слово («двадцать первом»). */
function ordinalCase(n: number, form: "nom" | "gen" | "prep"): string {
  const word = russianOrdinal(n);
  if (form === "nom") return word;
  return word.replace(/(ий|ый|ой)$/u, (end) => end === "ий" ? (form === "prep" ? "ьем" : "ьего") : (form === "prep" ? "ом" : "ого"));
}
const RU_WORDS = { cardinal: (n: number) => numberToWords(n, "ru"), zero: "ноль", plus: "плюс" };

/**
 * ЦИФРЫ → СЛОВА В РУССКОМ ТЕКСТЕ ДЛЯ ГОЛОСА (17.11.2026, владелец: «цифры всегда пишутся
 * буквами, потому что ИИ не справляется»). Пара к tajikSpeechNumbers: те же правила.
 * Целые числа (и с пробелами тысяч), «N м²», «N%». Даты, дроби, время, коды и номера
 * не трогаем: если после замены цифры остались — null, вызывающий решает, что делать.
 * Падеж в общем случае не согласуется («в 3 комнатах» → «в три комнатах»), но этаж и «из N»
 * говорятся по-человечески: «на четырнадцатом этаже», «четырнадцатый этаж из двадцати».
 * Телефон — по группам цифр, дробная площадь и крупная сумма — до целого (speechNumberShared).
 */
export function russianSpeechNumbers(text: string): string | null {
  const spoken = roundSpokenDecimals(speakPhoneNumbers(text, RU_WORDS))
    // Этаж: «на 14 этаже» → «на четырнадцатом этаже», «с 5-го этажа» → «с пятого этажа», «14 этаж» → «четырнадцатый этаж».
    .replace(/(^|[^\p{L}\p{N}_.,:/-])(\d{1,3})(?:-?(?:й|м|го|ом|ый|ой))?([ \u00a0\u202f]+)(этаж(?:е|а|ом)?)(?![\p{L}])/giu, (match, lead: string, digits: string, gap: string, noun: string) => {
      const n = Number(digits);
      if (!n) return match;
      const form = /е$/iu.test(noun) ? "prep" : /а$/iu.test(noun) ? "gen" : "nom";
      return `${lead}${ordinalCase(n, form)}${gap}${noun}`;
    })
    // «этаж 5» → «этаж пятый».
    .replace(/(этаж[ \u00a0\u202f]+)(\d{1,3})(?![\p{L}\p{N}_]|[.,:/−–-]\d)/giu, (match, head: string, digits: string) => Number(digits) ? `${head}${ordinalCase(Number(digits), "nom")}` : match)
    // «из 20» → «из двадцати»: после «из» число в родительном.
    .replace(/(^|[^\p{L}])(из[ \u00a0\u202f]+)(\d{1,2})(?![\p{L}\p{N}_]|[.,:/−–-]\d)/giu, (match, lead: string, head: string, digits: string) => Number(digits) ? `${lead}${head}${russianGenitive(Number(digits))}` : match)
    .replace(/(^|[^\p{L}\p{N}_:.,/+−–—-])(\d{1,7})[ \u00a0\u202f]*(?:м[²2]|кв\.?[ \u00a0\u202f]*м\.?)(?![\p{L}\p{N}_])/giu, (match, lead: string, digits: string) => {
      if (digits.length > 1 && digits.startsWith("0")) return match;
      const n = Number(digits);
      return `${lead}${numberToWords(n, "ru")} ${ruPlural(n, "квадратный метр", "квадратных метра", "квадратных метров")}`;
    })
    .replace(/(^|[^\p{L}\p{N}_:./+−–-])((?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:[ \u00a0\u202f]*%)?)(?![\p{L}\p{N}_]|[.,:/−–-]\d)/gu, (match, lead: string, number: string) => {
      const digits = number.replace(/[ \u00a0\u202f%]/g, "");
      if (digits.length > 12 || (digits.length > 1 && digits.startsWith("0"))) return match;
      const n = Number(digits);
      const words = numberToWords(n, "ru");
      return lead + (number.endsWith("%") ? `${words} ${ruPlural(n, "процент", "процента", "процентов")}` : words);
    });
  return /\p{N}/u.test(spoken) ? null : spoken;
}
