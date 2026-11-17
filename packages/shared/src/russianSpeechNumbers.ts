import { numberToWords, ruPlural } from "./spokenNumber.js";

/**
 * ЦИФРЫ → СЛОВА В РУССКОМ ТЕКСТЕ ДЛЯ ГОЛОСА (17.11.2026, владелец: «цифры всегда пишутся
 * буквами, потому что ИИ не справляется»). Пара к tajikSpeechNumbers: те же правила.
 * Целые числа (и с пробелами тысяч), «N м²», «N%». Даты, дроби, время, коды и номера
 * не трогаем: если после замены цифры остались — null, вызывающий решает, что делать.
 * Падеж не согласуется («в 3 комнатах» → «в три комнатах»): именительный — самый частый случай.
 */
export function russianSpeechNumbers(text: string): string | null {
  const spoken = text
    .replace(/(^|[^\p{L}\p{N}_:.,/+−–—-])(\d{1,7})[   ]*(?:м[²2]|кв\.?[   ]*м\.?)(?![\p{L}\p{N}_])/giu, (match, lead: string, digits: string) => {
      if (digits.length > 1 && digits.startsWith("0")) return match;
      const n = Number(digits);
      return `${lead}${numberToWords(n, "ru")} ${ruPlural(n, "квадратный метр", "квадратных метра", "квадратных метров")}`;
    })
    .replace(/(^|[^\p{L}\p{N}_:./+−–-])((?:\d{1,3}(?:[   ]\d{3})+|\d+)(?:[   ]*%)?)(?![\p{L}\p{N}_]|[.,:/−–-]\d)/gu, (match, lead: string, number: string) => {
      const digits = number.replace(/[   %]/g, "");
      if (digits.length > 12 || (digits.length > 1 && digits.startsWith("0"))) return match;
      const n = Number(digits);
      const words = numberToWords(n, "ru");
      return lead + (number.endsWith("%") ? `${words} ${ruPlural(n, "процент", "процента", "процентов")}` : words);
    });
  return /\p{N}/u.test(spoken) ? null : spoken;
}
