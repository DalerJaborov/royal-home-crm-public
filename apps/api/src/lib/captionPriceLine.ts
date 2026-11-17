/**
 * ЦЕНА В ГОТОВОМ ТЕКСТЕ — ПО СТРОКЕ, А НЕ ПО СТАРОЙ ЦЕНЕ (15.11.2026, объект 164).
 *
 * Раньше цену в подписи и в описании сайта меняли заменой старой суммы
 * (`replaceAll(oldPrice, newPrice)`). Старая сумма считалась ЗАНОВО по
 * сегодняшнему курсу, а в тексте стояла сумма по курсу дня, когда текст
 * писали; ещё её мог переписать человек (другой пробел, «сомони» вместо «с.»).
 * Тогда замена ничего не находила, подпись уходила в публикацию со старой
 * ценой, а обложка, которую рисуют из текущей цены, — с новой.
 *
 * Здесь цена ищется по МЕСТУ: строки шаблонов подписи («✅Цена:», «Цена:»,
 * «Цена —», «💰», «… · <цена>») и суммы рядом со старой ценой в свободном
 * тексте. Число без валюты не трогается никогда.
 */

const NUM = String.raw`\d[\d\s  .,]*\d|\d`;
const TJS_WORD = String.raw`(?:с\.|сомони|сомонӣ|смн\.?|TJS)`;
const USD_AMOUNT = String.raw`(?:\$\s?(?:${NUM})|(?:${NUM})\s?(?:\$|USD|долл(?:\.|аров|ара)?))`;
const TJS_AMOUNT = String.raw`(?:${NUM})\s?${TJS_WORD}`;
/** Цена целиком: сомони с долларами в скобках, или одна из валют. */
const PRICE_VALUE = String.raw`(?:${TJS_AMOUNT}(?:\s*\(\s*${USD_AMOUNT}\s*\))?|${USD_AMOUNT})`;

/** Строки-носители цены из шаблонов подписи (reelsCaptionTemplate.ts) и блока фактов ИИ. */
const PRICE_LINE_PREFIXES = [
  String.raw`^([ \t]*✅[ \t]*Цена[ \t]*[:—–-][ \t]*)`,
  String.raw`^([ \t]*Цена[ \t]*[:—–-][ \t]*)`,
  String.raw`^([ \t]*💰[ \t]*)`,
];

function parseAmount(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/** Есть ли в строке сумма с валютой. */
export function looksLikePrice(text: string): boolean {
  return new RegExp(PRICE_VALUE, "u").test(text);
}

/**
 * Заменить цену во ВСЕХ строках-носителях цены на `newPrice`.
 * `replaced` — сколько строк переписано (0 — в тексте нет строки цены).
 */
export function replaceCaptionPriceLines(caption: string, newPrice: string): { text: string; replaced: number } {
  let replaced = 0;
  const lines = caption.split("\n").map((line) => {
    for (const prefix of PRICE_LINE_PREFIXES) {
      const m = new RegExp(prefix + "(.+)$", "u").exec(line);
      if (m && looksLikePrice(m[2])) {
        replaced++;
        return m[1] + newPrice;
      }
    }
    // Шаблон «{{condition}} · {{price}}»: цена — хвост строки после последней « · ».
    const dot = line.lastIndexOf(" · ");
    if (dot >= 0) {
      const tail = line.slice(dot + 3);
      if (new RegExp(`^${PRICE_VALUE}\\s*$`, "u").test(tail)) {
        replaced++;
        return line.slice(0, dot + 3) + newPrice;
      }
    }
    return line;
  });
  return { text: lines.join("\n"), replaced };
}

/**
 * В свободном тексте (описание на сайте) заменить суммы, которые и есть
 * старая цена: сомони в пределах ±`tolerance` от старой цены в сомони (курс
 * дня написания неизвестен) или ровно старая сумма в долларах. Прочие суммы
 * (взнос, рассрочка) отличаются от цены объекта сильнее и не трогаются.
 */
export function replacePriceMentions(
  text: string,
  old: { tjs: number; usd: number | null },
  newPrice: { tjsText: string; usdText: string | null },
  tolerance = 0.08,
): { text: string; replaced: number } {
  let replaced = 0;
  const re = new RegExp(`(${TJS_AMOUNT})(\\s*\\(\\s*${USD_AMOUNT}\\s*\\))?|(${USD_AMOUNT})`, "gu");
  const out = text.replace(re, (whole, tjsPart: string | undefined, usdParen: string | undefined, usdOnly: string | undefined) => {
    if (tjsPart) {
      const n = parseAmount(tjsPart);
      if (n !== null && old.tjs > 0 && Math.abs(n - old.tjs) / old.tjs <= tolerance) {
        replaced++;
        return usdParen && newPrice.usdText ? `${newPrice.tjsText} (${newPrice.usdText})` : newPrice.tjsText;
      }
      return whole;
    }
    if (usdOnly && old.usd !== null) {
      const n = parseAmount(usdOnly);
      if (n === old.usd) {
        replaced++;
        return newPrice.usdText ?? newPrice.tjsText;
      }
    }
    return whole;
  });
  return { text: out, replaced };
}
