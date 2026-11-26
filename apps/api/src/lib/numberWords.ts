/**
 * ЧИСЛА СЛОВАМИ → ЦИФРЫ, ПО-РУССКИ И ПО-ТАДЖИКСКИ (26.11.2026, разбор звонка ПК-001086).
 *
 * Расшифровка разговора пишет числа то цифрами («165 ҳазор»), то словами («нӯҳсаду
 * шасту панҷ ҳазор», «объект двести тридцать»). Модель разбора (ai/incomingCallLead.ts)
 * таджикские числительные читает нетвёрдо, а поиск номера объекта
 * (lib/telephony/resolveCallProperty.ts) до этой правки понимал только цифры.
 *
 * ТОЛЬКО БЕЗОПАСНОЕ ПОДМНОЖЕСТВО (ревью architect 26.11.2026). Первая версия
 * складывала всё подряд и портила суммы: «миллион двести» → 1 000 200, «пятьсот
 * шестьсот тысяч» (это ДВА числа, «от пятисот до шестисот») → 1 100 000, «детский
 * сад» → «детский 100». Теперь переводится лишь то, что читается однозначно:
 *  - число = [группа «тысяч»] [группа без множителя], группа = сотни? десятки? единицы?
 *    (или сотни? + 11–19), каждый разряд не больше одного раза и по убыванию;
 *  - второе число подряд («пятьсот шестьсот», «пятьсот-шестьсот») — не число: строка
 *    остаётся словами;
 *  - «миллион» и всё с ним — не переводится: «миллион двести» в живой речи значит
 *    1 200 000, а буквально 1 000 200, и угадывать здесь нельзя;
 *  - таджикское «сад» (100) — число только рядом с другим числительным («саду шасту
 *    панҷ», «сад ҳазор»); одно слово «сад» — это сад (детский, ботанический).
 * Всё, что в правило не легло, остаётся как было: модель прочитает слова сама.
 *
 * Чего намеренно НЕ делаем: не «исправляем» услышанное (165 ≠ 965 — это решает
 * узнавание объекта с допуском, lib/propertyClueScoring.ts) и не переводим валюту.
 */
import { foldTajikLetters } from "@royal-home/shared";

/** Единицы 1–9 и 11–19. */
const UNITS: Record<string, number> = {
  один: 1, одна: 1, одно: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9,
  як: 1, ду: 2, се: 3, чор: 4, чахор: 4, панч: 5, шаш: 6, хафт: 7, хашт: 8, нух: 9,
};
const TEENS: Record<string, number> = {
  десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16,
  семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
  дах: 10, ездах: 11, яздах: 11, дувоздах: 12, сездах: 13, чордах: 14, понздах: 15, шонздах: 16, хабдах: 17, хаждах: 18, нуздах: 19,
};
const TENS: Record<string, number> = {
  двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90,
  бист: 20, си: 30, чил: 40, панчох: 50, шаст: 60, хафтод: 70, хаштод: 80, навад: 90,
};
const HUNDREDS: Record<string, number> = {
  сто: 100, двести: 200, триста: 300, четыреста: 400, пятьсот: 500, шестьсот: 600, семьсот: 700, восемьсот: 800, девятьсот: 900,
  сад: 100, яксад: 100, дусад: 200, сесад: 300, чорсад: 400, чахорсад: 400, панчсад: 500, шашсад: 600, хафтсад: 700, хаштсад: 800, нухсад: 900,
};
/** Единственный допустимый множитель. «Миллион» намеренно не здесь (см. шапку). */
const THOUSAND = new Set(["тысяча", "тысячи", "тысяч", "тыс", "хазор"]);
/** Слова, которые встречаются и как число, и как обычное слово: число — только в компании. */
/** «Миллион» — слово-число, но не переводится: цепочка с ним целиком остаётся словами. */
const MILLION = new Set(["миллион", "миллиона", "миллионов", "млн"]);
const TAJIK_HUNDREDS = new Set(["сад", "яксад", "дусад", "сесад", "чорсад", "чахорсад", "панчсад", "шашсад", "хафтсад", "хаштсад", "нухсад"]);
/**
 * После числа идёт порядковое («сто втором», «двадцать пятом году», «панҷум») или
 * цифры («нӯҳсаду 65 ҳазор») — число составное, наш разбор его не прочитает: слова остаются.
 */
const ORDINAL_OR_DIGITS =
  /^(?:\d|(?:перв|втор|трет|четв[её]рт|пят|шест|седьм|восьм|девят|десят|\p{L}*надцат|двадцат|тридцат|сороков|\p{L}*десят|сот|тысячн|миллионн)\p{L}*(?:ый|ой|ий|ая|яя|ое|ее|ого|его|ому|ему|ом|ем|ую|юю|ых|их|ым|им|ыми|ими)(?![\p{L}])|\p{L}+(?:ум|юм|уми|юми)(?![\p{L}]))/iu;
const NEEDS_COMPANY = new Set(["сад", "си", "се", "ду", "як"]);

/** Таджикское «-у» (союз «и») приклеивается к числительному: «саду шасту панҷ». */
function stripTajikConnector(word: string): string {
  if (word.length > 3 && word.endsWith("у")) {
    const bare = word.slice(0, -1);
    if (bare in UNITS || bare in TEENS || bare in TENS || bare in HUNDREDS || THOUSAND.has(bare)) return bare;
  }
  return word;
}

function normalizeWord(raw: string): string {
  return stripTajikConnector(foldTajikLetters(raw.toLowerCase().replace(/ё/g, "е")));
}

function isNumberWord(word: string): boolean {
  return word in UNITS || word in TEENS || word in TENS || word in HUNDREDS || THOUSAND.has(word) || MILLION.has(word);
}

/** Одна группа (до 999) по строгой грамматике: сотни? (десятки? единицы? | 10–19). */
function parseGroup(words: string[]): number | null {
  if (words.length === 0) return null;
  let i = 0;
  let value = 0;
  if (words[i] in HUNDREDS) value += HUNDREDS[words[i++]];
  if (i < words.length && words[i] in TEENS) {
    value += TEENS[words[i++]];
    return i === words.length ? value : null;
  }
  if (i < words.length && words[i] in TENS) value += TENS[words[i++]];
  if (i < words.length && words[i] in UNITS) value += UNITS[words[i++]];
  return i === words.length ? value : null;
}

/**
 * Значение последовательности слов-чисел; null — это не одно число по строгой
 * грамматике (два числа подряд, «миллион», лишний разряд, одинокое «сад»).
 */
export function spokenNumberValue(raw: string[]): number | null {
  const words = raw.map(normalizeWord);
  // Таджикские сотни внутри числа идут с союзом: «саду ду» (102). «сад ду» без «-у» —
  // не число («детский сад два этажа»), а «нӯҳсаду 65» не наш случай вовсе.
  for (let i = 0; i < raw.length - 1; i++) {
    const folded = foldTajikLetters(raw[i].toLowerCase());
    if (TAJIK_HUNDREDS.has(words[i]) && !folded.endsWith("у") && !THOUSAND.has(words[i + 1])) return null;
  }
  if (words.length === 0 || !words.every(isNumberWord) || words.some((w) => MILLION.has(w))) return null;
  if (words.length === 1 && NEEDS_COMPANY.has(words[0])) return null;
  const thousandAt = words.findIndex((w) => THOUSAND.has(w));
  if (thousandAt === -1) return parseGroup(words);
  if (words.slice(thousandAt + 1).some((w) => THOUSAND.has(w))) return null;
  const head = words.slice(0, thousandAt);
  const tail = words.slice(thousandAt + 1);
  // Голое «тысяч» без числа перед ним («пятьсот-шестьсот тысяч») — не 1000: слово остаётся.
  if (head.length === 0) return null;
  const thousands = parseGroup(head);
  if (thousands === null) return null;
  const rest = tail.length === 0 ? 0 : parseGroup(tail);
  if (rest === null) return null;
  return thousands * 1000 + rest;
}

export interface NumberWordsOptions {
  /**
   * Заменять только числа не меньше этого значения. В живой расшифровке «як бор»
   * (один раз) или «ду хонагӣ» (двухкомнатная) цифрами выглядят хуже, чем словами,
   * а цены — это сотни тысяч. Для короткой подсказки «объект сорок пять» порог 1.
   */
  minValue?: number;
}

/**
 * Заменяет в тексте подряд идущие слова-числа цифрами, если они читаются как ОДНО
 * число по правилам выше; иначе оставляет слова. Дефис между словами-числами
 * («пятьсот-шестьсот») — два числа, не одно: не трогаем.
 */
export function numberWordsToDigits(text: string, options: NumberWordsOptions = {}): string {
  const minValue = options.minValue ?? 100;
  const tokens = text.split(/(\s+)/);
  const out: string[] = [];
  let i = 0;
  const wordOf = (t: string) => t.match(/^(\p{L}+)([^\p{L}]*)$/u);
  while (i < tokens.length) {
    const token = tokens[i];
    const m = /^\s*$/.test(token) ? null : wordOf(token);
    if (!m || !isNumberWord(normalizeWord(m[1]))) {
      out.push(token);
      i++;
      continue;
    }
    // Копим слова-числа подряд; пунктуация после слова закрывает число.
    const run: string[] = [];
    let j = i;
    let lastWord = i;
    let trailing = "";
    while (j < tokens.length) {
      const t = tokens[j];
      if (/^\s+$/.test(t)) {
        j++;
        continue;
      }
      const mm = wordOf(t);
      if (!mm || !isNumberWord(normalizeWord(mm[1]))) break;
      run.push(mm[1]);
      trailing = mm[2];
      lastWord = j;
      j++;
      if (trailing) break;
    }
    const after = tokens.slice(lastWord + 1).find((t) => !/^\s*$/.test(t)) ?? "";
    const before = out.slice().reverse().find((t) => !/^\s*$/.test(t)) ?? "";
    const glued = !trailing && (ORDINAL_OR_DIGITS.test(after) || /\d$/.test(before));
    const value = glued ? null : spokenNumberValue(run);
    if (value === null || value < minValue) {
      // Не число (или мелкое) — слова остаются; идём дальше с последнего слова цепочки,
      // чтобы «миллион» и соседи не разбирались по кусочкам.
      for (let k = i; k <= lastWord; k++) out.push(tokens[k]);
      i = lastWord + 1;
      continue;
    }
    out.push(String(value) + trailing);
    i = lastWord + 1;
  }
  return out.join("");
}
