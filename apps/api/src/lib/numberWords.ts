/**
 * ЧИСЛА СЛОВАМИ → ЦИФРЫ, ПО-РУССКИ И ПО-ТАДЖИКСКИ (26.11.2026, разбор звонка ПК-001086).
 *
 * Расшифровка разговора пишет числа то цифрами («165 ҳазор»), то словами («нӯҳсаду
 * шасту панҷ ҳазор», «объект двести тридцать»). Модель разбора (ai/incomingCallLead.ts)
 * таджикские числительные читает нетвёрдо, а поиск номера объекта
 * (lib/telephony/resolveCallProperty.ts) до этой правки понимал только цифры. Здесь —
 * одно правило на оба места: найти в тексте подряд идущие слова-числа и заменить их
 * цифрами; всё остальное в тексте не трогается.
 *
 * Чего намеренно НЕ делаем: не «исправляем» услышанное (165 ≠ 965 — это решает
 * узнавание объекта с допуском, lib/propertyClueScoring.ts) и не переводим валюту.
 *
 * Таджикские буквы сворачиваются к русским близнецам тем же правилом, что у мест
 * (foldTajikLetters): «нӯҳсад», «нухсад» и «нуҳсад» — одно слово.
 */
import { foldTajikLetters } from "@royal-home/shared";

/** Единицы и десятки до 19 — значение прибавляется к текущему разряду. */
const SMALL: Record<string, number> = {
  // русский
  ноль: 0, один: 1, одна: 1, одно: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9,
  десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16,
  семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
  двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90,
  // таджикский (свёрнутые буквы: ҳ→х, ӯ→у, ҷ→ч, қ→к)
  як: 1, ду: 2, се: 3, чор: 4, чахор: 4, панч: 5, шаш: 6, хафт: 7, хашт: 8, нух: 9,
  дах: 10, ездах: 11, яздах: 11, дувоздах: 12, сездах: 13, чордах: 14, понздах: 15, шонздах: 16, хабдах: 17, хаждах: 18, нуздах: 19,
  бист: 20, си: 30, чил: 40, панчох: 50, шаст: 60, хафтод: 70, хаштод: 80, навад: 90,
};

/** Сотни — отдельным разрядом: «нӯҳсад» = 900, «девятьсот». */
const HUNDREDS: Record<string, number> = {
  сто: 100, двести: 200, триста: 300, четыреста: 400, пятьсот: 500, шестьсот: 600, семьсот: 700, восемьсот: 800, девятьсот: 900,
  сад: 100, яксад: 100, дусад: 200, сесад: 300, чорсад: 400, чахорсад: 400, панчсад: 500, шашсад: 600, хафтсад: 700, хаштсад: 800, нухсад: 900,
};

/** Множители: всё накопленное до них умножается. */
const MULTIPLIERS: Record<string, number> = {
  тысяча: 1000, тысячи: 1000, тысяч: 1000, тыс: 1000, хазор: 1000,
  миллион: 1_000_000, миллиона: 1_000_000, миллионов: 1_000_000, млн: 1_000_000,
};

/**
 * Таджикское «-у» (союз «и») приклеивается к числительному: «саду шасту панҷ».
 * Снимаем его только у слов, которые без него — число; «ду» (2) не трогаем.
 */
function stripTajikConnector(word: string): string {
  if (word.length > 3 && word.endsWith("у")) {
    const bare = word.slice(0, -1);
    if (bare in SMALL || bare in HUNDREDS || bare in MULTIPLIERS) return bare;
  }
  return word;
}

function normalizeWord(raw: string): string {
  return stripTajikConnector(foldTajikLetters(raw.toLowerCase().replace(/ё/g, "е")));
}

function isNumberWord(word: string): boolean {
  return word in SMALL || word in HUNDREDS || word in MULTIPLIERS;
}

/** Значение последовательности слов-чисел. null — последовательность не число. */
export function spokenNumberValue(words: string[]): number | null {
  if (words.length === 0) return null;
  let total = 0;
  let current = 0;
  let sawDigit = false;
  for (const raw of words) {
    const w = normalizeWord(raw);
    if (w in MULTIPLIERS) {
      total += (current || 1) * MULTIPLIERS[w];
      current = 0;
      sawDigit = true;
    } else if (w in HUNDREDS) {
      current += HUNDREDS[w];
      sawDigit = true;
    } else if (w in SMALL) {
      current += SMALL[w];
      sawDigit = true;
    } else return null;
  }
  return sawDigit ? total + current : null;
}

export interface NumberWordsOptions {
  /**
   * Заменять только числа не меньше этого значения. В живой расшифровке «як бор»
   * (один раз) или «ду хонагӣ» (двухкомнатная) цифрами выглядят хуже, чем словами,
   * а цены и номера объектов — это сотни и больше. Для короткой подсказки «объект
   * сорок пять» порог ставят в 1.
   */
  minValue?: number;
}

/**
 * Заменяет в тексте подряд идущие слова-числа цифрами. Между словами допускаются
 * пробелы и дефисы. Знаки препинания и остальные слова остаются на месте.
 */
export function numberWordsToDigits(text: string, options: NumberWordsOptions = {}): string {
  const minValue = options.minValue ?? 100;
  const tokens = text.split(/(\s+)/);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (/^\s+$/.test(token) || token === "") {
      out.push(token);
      i++;
      continue;
    }
    // Слово с хвостовой пунктуацией: число берём, знак возвращаем после цифр.
    const m = token.match(/^([\p{L}-]+)([^\p{L}]*)$/u);
    if (!m || !isNumberWord(normalizeWord(m[1]))) {
      out.push(token);
      i++;
      continue;
    }
    // Копим последовательность: слово, пробел, слово… пока идут числа без пунктуации между ними.
    const run: string[] = [];
    let j = i;
    /** Индекс последнего слова-числа: пробелы после него остаются тексту. */
    let lastWord = i;
    let trailing = "";
    while (j < tokens.length) {
      const t = tokens[j];
      if (/^\s+$/.test(t)) {
        j++;
        continue;
      }
      const mm = t.match(/^([\p{L}-]+)([^\p{L}]*)$/u);
      if (!mm) break;
      const parts = mm[1].split("-").filter(Boolean);
      if (!parts.every((p) => isNumberWord(normalizeWord(p)))) break;
      run.push(...parts);
      trailing = mm[2];
      lastWord = j;
      j++;
      if (trailing) break; // пунктуация закрывает число
    }
    const value = spokenNumberValue(run);
    if (value === null || value < minValue) {
      out.push(token);
      i++;
      continue;
    }
    out.push(String(value) + trailing);
    i = lastWord + 1;
  }
  return out.join("");
}
