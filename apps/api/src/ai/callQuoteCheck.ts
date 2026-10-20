/**
 * ПРОВЕРКА «ДОСЛОВНОЙ» ЦИТАТЫ ПО РАСШИФРОВКЕ (02.10.2026, аудит звонков робота, А3).
 *
 * Разбор разговора поручен модели, а модель вправе выдумать фразу, которой никто
 * не произносил. В красном сигнале руководителю («жалоба на сотрудника», «продал
 * мимо агентства») цитата — единственное, что владелец читает как слова
 * человека; выдуманная цитата — ложное обвинение. Поэтому до того, как исход
 * уйдёт руководителю, цитата сверяется с расшифровкой: она обязана найтись в
 * репликах ЧЕЛОВЕКА (строки «Клиент: …», см. liveVoiceBridge.ts), а не бота — иначе
 * вопрос бота «а агент на вас не давил?» превращался бы в «слова клиента».
 *
 * СВЕРКА ПО СЛОВАМ, А НЕ ПО СТРОКЕ (третий аудит 02.10.2026, В1). Прежняя
 * «всё или ничего» подстрочная проверка давала ложные «нет» на настоящих жалобах:
 * модель выбрасывала слова-паразиты («ну это…»), писала «50 тысяч» вместо «пятьдесят
 * тысяч», упрощала таджикские буквы (ӯ→у, қ→к, ҳ→х, ғ→г, ҷ→ч, ӣ→и), добавляла «уже».
 * Каждое такое «нет» тихо гасило красный сигнал. Теперь обе стороны приводятся к
 * одному виду (NFC, свёртка таджикских букв, числа словами → цифры, слова-паразиты
 * убраны), а цитата ищется как последовательность слов:
 *  - точное вхождение целыми словами всегда годится («да» не найдётся в «когда»);
 *  - слегка перефразированная цитата (>= 2 слов) годится, если не менее 80% её слов
 *    идут по порядку в КОМПАКТНОМ окне расшифровки и в окне нет отрицания, которого
 *    нет в цитате («он грубил» не проходит по «он не грубил» — это обратный смысл);
 *  - однословная цитата — только точная.
 * Многоточие внутри цитаты («опоздал … а потом») делит её на куски, каждый из
 * которых должен найтись по порядку.
 */

/** Слова-паразиты и вставки: убираются из обеих сторон до сверки. */
const FILLER_WORDS = new Set([
  "ну",
  "это",
  "типа",
  "значит",
  "короче",
  "вот",
  "как",
  "бы",
  "э",
  "ээ",
  "эээ",
  "м",
  "мм",
  "ммм",
  "эм",
  "хм",
  "ага",
  "яъне",
  "мана",
  "хуллас",
]);

/** Отрицания: лишнее отрицание в окне расшифровки — обратный смысл цитаты. */
const NEGATION_WORDS = new Set(["не", "нет", "ни", "нельзя", "никогда", "нест", "ничего", "никто"]);

/** Доля слов цитаты, которая должна найтись по порядку, чтобы перефраз считался цитатой. */
const FUZZY_MIN_SHARE = 0.8;

/** Свёртка таджикских букв к русским (после NFD снимаются и точки/черты: ӣ→и, ӯ→у, ё→е, й→и). */
const TAJIK_FOLD: Record<string, string> = { ҳ: "х", қ: "к", ғ: "г", ҷ: "ч" };

const NUMBER_WORDS: Record<string, number> = {
  // русский
  один: 1, одна: 1, одну: 1, одно: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8,
  девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15,
  шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40,
  пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90, сто: 100, двести: 200, триста: 300,
  четыреста: 400, пятьсот: 500, шестьсот: 600, семьсот: 700, восемьсот: 800, девятьсот: 900,
  // таджикский (после свёртки букв)
  як: 1, ду: 2, се: 3, чор: 4, панч: 5, шаш: 6, хафт: 7, хашт: 8, нух: 9, дах: 10, бист: 20, си: 30, чил: 40,
  панчох: 50, шаст: 60, хафтод: 70, хаштод: 80, навад: 90, сад: 100,
};
const NUMBER_MULTIPLIERS: Record<string, number> = {
  тысяча: 1_000, тысячи: 1_000, тысяч: 1_000, тысячу: 1_000, хазор: 1_000,
  миллион: 1_000_000, миллиона: 1_000_000, миллионов: 1_000_000, миллиони: 1_000_000,
};

/** Слова текста в сравнимом виде: без регистра и знаков, таджикские буквы свёрнуты, числа цифрами, паразиты убраны. */
function quoteTokens(text: string): string[] {
  const prepared = text
    .normalize("NFC")
    // «50 000», «50,000», «1.5»: цифры, разделённые пробелом тысяч или знаком, — одно число.
    .replace(/(\d)[\s ](?=\d{3}(?!\d))/g, "$1")
    .replace(/(\d)[.,](?=\d)/g, "$1");
  const lowered = prepared
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[ҳқғҷ]/gu, (c) => TAJIK_FOLD[c] ?? c);
  const raw = lowered.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return foldNumbers(raw).filter((t) => !FILLER_WORDS.has(t));
}

/** «пятьдесят тысяч» и «50 тысяч» → «50000»; одиночные числительные → цифры. */
function foldNumbers(tokens: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    const isWord = token in NUMBER_WORDS;
    const isDigits = /^\d+$/.test(token);
    const isMultiplier = token in NUMBER_MULTIPLIERS;
    if (!isWord && !isDigits && !isMultiplier) {
      out.push(token);
      i++;
      continue;
    }
    // Серия числительных подряд: единицы складываются, «тысяч/миллион» умножают набранное.
    let total = 0;
    let current = 0;
    let used = 0;
    let j = i;
    while (j < tokens.length) {
      const t = tokens[j]!;
      if (t in NUMBER_WORDS) {
        current += NUMBER_WORDS[t]!;
      } else if (/^\d+$/.test(t) && (current === 0 || j === i)) {
        current += Number(t);
      } else if (t in NUMBER_MULTIPLIERS) {
        total += (current || 1) * NUMBER_MULTIPLIERS[t]!;
        current = 0;
      } else {
        break;
      }
      used++;
      j++;
    }
    if (used === 0) {
      out.push(token);
      i++;
      continue;
    }
    out.push(String(total + current));
    i = j;
  }
  return out;
}

/** Приведение к виду, в котором сравниваем: слова одним пробелом, без знаков. */
export function normalizeForQuoteMatch(text: string): string {
  return quoteTokens(text).join(" ");
}

/** Реплики человека из расшифровки моста, без служебных пометок и без реплик бота. */
export function clientSpeechOf(transcript: readonly string[]): string {
  return transcript
    .filter((line) => line.startsWith("Клиент:"))
    .map((line) => line.slice("Клиент:".length))
    .join(" ");
}

/** Одно и то же слово: точно либо с другим окончанием («продана»/«продан», «опоздал»/«опоздали»). */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5) return false;
  if (Math.abs(a.length - b.length) > 3) return false;
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return common >= 5 && common >= Math.min(a.length, b.length) - 2;
}

function countNegations(tokens: readonly string[]): number {
  return tokens.reduce((n, t) => n + (NEGATION_WORDS.has(t) ? 1 : 0), 0);
}

/**
 * Где в словах человека (`hay`, начиная с `from`) стоит кусок цитаты. Возвращает
 * индекс за последним совпавшим словом или -1.
 */
function findPiece(piece: readonly string[], hay: readonly string[], from: number): number {
  // 1. Точное вхождение целыми словами подряд.
  for (let i = from; i + piece.length <= hay.length; i++) {
    let ok = true;
    for (let k = 0; k < piece.length; k++) {
      if (hay[i + k] !== piece[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return i + piece.length;
  }
  // Однословная цитата — только точная: «да» не должно находиться в чужом слове и в «ну да ладно».
  if (piece.length < 2) return -1;

  // 2. Перефраз: слова по порядку в компактном окне, без лишнего отрицания.
  const need = piece.length <= 4 ? piece.length : Math.ceil(piece.length * FUZZY_MIN_SHARE);
  const windowLen = piece.length + Math.max(2, Math.ceil(piece.length * 0.5));
  for (let i = from; i < hay.length; i++) {
    // Опорное слово окна — первое или второе слово цитаты (одно слово цитаты может быть потеряно).
    const startsFirst = sameWord(hay[i]!, piece[0]!);
    if (!startsFirst && !sameWord(hay[i]!, piece[1]!)) continue;
    let p = startsFirst ? 0 : 1;
    let matched = 0;
    let last = i;
    for (let h = i; h < Math.min(hay.length, i + windowLen) && p < piece.length; h++) {
      if (sameWord(hay[h]!, piece[p]!)) {
        matched++;
        p++;
        last = h;
      } else if (p + 1 < piece.length && sameWord(hay[h]!, piece[p + 1]!)) {
        // Слово цитаты, которого в расшифровке нет, — пропущено, идём дальше.
        matched++;
        p += 2;
        last = h;
      }
    }
    if (matched < need) continue;
    // Отрицание, которого цитата не несёт, переворачивает смысл.
    if (countNegations(hay.slice(i, last + 1)) > countNegations(piece)) continue;
    return last + 1;
  }
  return -1;
}

/**
 * Есть ли цитата в словах человека. Пустая цитата — «не найдена» (нечего
 * подтверждать), и вызывающий решает, нужна ли она вообще.
 */
export function quoteIsInTranscript(quote: string | null | undefined, transcript: readonly string[]): boolean {
  if (!quote || !quote.trim()) return false;
  const hay = quoteTokens(clientSpeechOf(transcript));
  if (hay.length === 0) return false;

  const pieces = quote
    .split(/\.{2,}|…/)
    .map(quoteTokens)
    .filter((p) => p.length > 0);
  if (pieces.length === 0) return false;

  let from = 0;
  for (const piece of pieces) {
    const next = findPiece(piece, hay, from);
    if (next === -1) return false;
    from = next;
  }
  return true;
}

/** Пометка в сводке: исход понижен, потому что цитаты в расшифровке нет. */
export const QUOTE_NOT_CONFIRMED_NOTE = "цитата не подтверждена расшифровкой";

/** Дописывает пометку к сводке (сводка может быть пустой). */
export function withQuoteNotConfirmedNote(summary: string | null): string {
  return summary ? `${summary} [${QUOTE_NOT_CONFIRMED_NOTE}]` : `[${QUOTE_NOT_CONFIRMED_NOTE}]`;
}
