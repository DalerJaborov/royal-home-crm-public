/** Разбивает строку поиска на отдельные слова.
 *
 * Нужно потому, что адрес в карточке записан «пр. Рудаки, 45», а ищут его как
 * «Рудаки 45»: одной подстрокой такой запрос не находится никогда. Разбив запрос
 * на слова и потребовав, чтобы нашлись ВСЕ, получаем поиск, не зависящий ни от
 * порядка слов, ни от сокращений и запятых между ними.
 *
 * Разделителями считаются любые не-буквы и не-цифры, поэтому «Рудаки, 45» и
 * «Рудаки 45» дают одинаковые слова. Буквы — любого алфавита (\p{L}): кириллица,
 * латиница и таджикские буквы с диакритикой обрабатываются одинаково.
 *
 * Число слов ограничено: запрос в сотню слов иначе превратился бы в сотню
 * условий ILIKE на строку таблицы.
 */
import { transliterateLatin } from "./geoNormalize.js";

const MAX_TOKENS = 8;

export function toSearchTokens(query: string): string[] {
  return query
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0)
    .slice(0, MAX_TOKENS);
}

/**
 * Раскладка клавиатуры: что получается, если печатать русское слово, забыв
 * переключить язык. «Рудаки» вслепую на латинской раскладке даёт «Helfrb» —
 * поиск не находил ничего, хотя человек набрал ровно то, что нужно.
 */
const LATIN_TO_CYRILLIC_LAYOUT: Record<string, string> = {
  q: "й", w: "ц", e: "у", r: "к", t: "е", y: "н", u: "г", i: "ш", o: "щ", p: "з",
  a: "ф", s: "ы", d: "в", f: "а", g: "п", h: "р", j: "о", k: "л", l: "д",
  z: "я", x: "ч", c: "с", v: "м", b: "и", n: "т", m: "ь",
};

const CYRILLIC_TO_LATIN_LAYOUT: Record<string, string> = Object.fromEntries(
  Object.entries(LATIN_TO_CYRILLIC_LAYOUT).map(([latin, cyrillic]) => [cyrillic, latin])
);

/**
 * Таджикские буквы с диакритикой к их простым парам: набрали «Ҳофиз» — найдётся
 * «Хофиз», записанный с обычной русской клавиатуры (а именно так карточки и
 * заполняют: таджикские буквы требуют отдельной раскладки).
 *
 * ОБРАТНОЕ направление здесь не покрывается сознательно. Развернуть простые буквы
 * в диакритику разом («хофиз» → «ҳофӣз») нельзя: получается написание, которого
 * никто не пишет, — первая же попытка это и показала. А перебирать все комбинации
 * — десятки вариантов на слово. Правильное решение — нормализованная колонка или
 * функциональный индекс на стороне БД, это отдельная работа с миграцией.
 */
const TAJIK_FOLD: Record<string, string> = { "ӯ": "у", "ӣ": "и", "ҳ": "х", "қ": "к", "ҷ": "ч", "ғ": "г" };

function mapChars(value: string, table: Record<string, string>): string {
  return [...value].map((ch) => table[ch] ?? ch).join("");
}

/**
 * Перекладка раскладки — только если ВСЕ буквы слова нашлись в таблице. Иначе
 * получается смесь вроде «хjabp»: совпасть она ни с чем не может, а условие ILIKE
 * на строку таблицы всё равно стоит. Цифры проходят как есть.
 */
function mapWholeWord(value: string, table: Record<string, string>): string | null {
  let out = "";
  for (const ch of value) {
    if (/\d/.test(ch)) {
      out += ch;
      continue;
    }
    const mapped = table[ch];
    if (!mapped) return null;
    out += mapped;
  }
  return out;
}

const hasLatin = (value: string) => /[a-z]/.test(value);
const hasCyrillic = (value: string) => /[Ѐ-ӿ]/.test(value);

/**
 * Написания одного слова, которые считаются одним и тем же запросом.
 *
 * Требование владельца от 30.07: поиск должен переживать забытую раскладку и
 * таджикские написания. Варианты строятся ИЗ ЗАПРОСА, а не из базы.
 *
 * Вариантов намеренно мало (обычно 1–4): каждый — это ещё одно условие ILIKE на
 * строку таблицы, а слов в запросе до восьми. Однобуквенные варианты выкидываем:
 * «%я%» нашло бы пол-базы.
 */
const MAX_VARIANTS = 4;

export function toTokenVariants(token: string): string[] {
  const lower = token.toLowerCase();
  // Слово из одной буквы вариантов не получает: «я» в другой раскладке — «z», и
  // такой подстрокой находится половина базы. Цифры тоже оставляем как есть.
  if (lower.length < 2 || !/\p{L}/u.test(lower)) return [lower];

  const variants = new Set<string>([lower]);

  if (hasLatin(lower)) {
    const layout = mapWholeWord(lower, LATIN_TO_CYRILLIC_LAYOUT);
    if (layout) variants.add(layout);
    const cyrillic = transliterateLatin(lower);
    variants.add(cyrillic);
    // «Shohmansur» даёт «шоҳмансур», а в карточках пишут «Шохмансур» (29.09.2026):
    // латиница не знает, какую из двух букв имели в виду, — нужны обе.
    variants.add(mapChars(cyrillic, TAJIK_FOLD));
  }
  if (hasCyrillic(lower)) {
    const layout = mapWholeWord(lower, CYRILLIC_TO_LATIN_LAYOUT);
    if (layout) variants.add(layout);
    variants.add(mapChars(lower, TAJIK_FOLD));
  }

  return [...variants].filter((v) => v.length >= 2).slice(0, MAX_VARIANTS);
}
