/**
 * Этажность, названная в тексте описания («двадцатидвухэтажная», «19-этажный»,
 * «в 22 этажном доме»). Описание пишется один раз при заведении объекта и при
 * правке этажности не пересобирается (см. routes/properties/crud.ts), поэтому
 * число в тексте и в «Параметрах» может разойтись. Функция достаёт число из
 * текста, карточка сравнивает его с `totalFloors` и предупреждает.
 */
const UNITS: Record<string, number> = {
  одно: 1, двух: 2, трех: 3, трёх: 3, четырех: 4, четырёх: 4, пяти: 5, шести: 6, семи: 7, восьми: 8, девяти: 9,
};
const TEENS: Record<string, number> = {
  десяти: 10, одиннадцати: 11, двенадцати: 12, тринадцати: 13, четырнадцати: 14, пятнадцати: 15,
  шестнадцати: 16, семнадцати: 17, восемнадцати: 18, девятнадцати: 19,
};
const TENS: Record<string, number> = { двадцати: 20, тридцати: 30, сорока: 40 };

function wordToNumber(word: string): number | null {
  const w = word.toLowerCase();
  if (w in UNITS) return UNITS[w];
  if (w in TEENS) return TEENS[w];
  if (w in TENS) return TENS[w];
  for (const [tens, value] of Object.entries(TENS)) {
    if (w.startsWith(tens)) {
      const rest = w.slice(tens.length);
      if (rest in UNITS) return value + UNITS[rest];
    }
  }
  return null;
}

export function floorsMentionedInText(text: string | null | undefined): number | null {
  if (!text) return null;
  const digits = /(\d{1,2})[\s-]*этаж(?:н|ей|а|ах|ей)/i.exec(text);
  if (digits) return Number(digits[1]);
  const word = /([а-яё]+)этажн/i.exec(text);
  if (word) return wordToNumber(word[1]);
  return null;
}

/** Число этажей из текста, если оно расходится с параметром карточки; иначе null. */
export function floorsMismatch(
  description: string | null | undefined,
  totalFloors: number | null | undefined
): number | null {
  if (!totalFloors) return null;
  const mentioned = floorsMentionedInText(description);
  return mentioned != null && mentioned !== totalFloors ? mentioned : null;
}
