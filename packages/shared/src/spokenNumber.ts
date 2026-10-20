/**
 * ЧИСЛА СЛОВАМИ — ДЛЯ ГОЛОСА (03.10.2026, починка робота по аудиту).
 *
 * Синтезатор речи читает «62.5» и «45 000» неестественно, а то и по цифре. Промт
 * просил модель говорить числа словами, но просьба — не гарантия: ответы функций
 * приходили цифрами, и модель то переводила их, то нет. Теперь цену, площадь и
 * этаж в словах собирает сервер, на русском и на таджикском, а модель говорит
 * готовое.
 *
 * Таджикский — разговорный, как в примерах живых агентов («чил панҷ ҳазор доллар»,
 * «шаст метр»): части числа через пробел, без литературного соединительного «-у».
 */

export type SpokenLanguage = "ru" | "tg";

// ── русский ────────────────────────────────────────────────────────────────

const RU_UNITS_M = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const RU_UNITS_F = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const RU_TEENS = [
  "десять",
  "одиннадцать",
  "двенадцать",
  "тринадцать",
  "четырнадцать",
  "пятнадцать",
  "шестнадцать",
  "семнадцать",
  "восемнадцать",
  "девятнадцать",
];
const RU_TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
const RU_HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];

/** Форма слова после числа: 1 доллар, 2 доллара, 5 долларов. */
export function ruPlural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(n));
  const mod100 = abs % 100;
  const mod10 = abs % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function ruTriplet(n: number, feminine: boolean): string[] {
  const words: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) words.push(RU_HUNDREDS[h]);
  if (rest >= 10 && rest < 20) {
    words.push(RU_TEENS[rest - 10]);
  } else {
    const t = Math.floor(rest / 10);
    const u = rest % 10;
    if (t) words.push(RU_TENS[t]);
    if (u) words.push((feminine ? RU_UNITS_F : RU_UNITS_M)[u]);
  }
  return words;
}

const RU_SCALES: { value: number; feminine: boolean; forms: [string, string, string] }[] = [
  { value: 1_000_000_000, feminine: false, forms: ["миллиард", "миллиарда", "миллиардов"] },
  { value: 1_000_000, feminine: false, forms: ["миллион", "миллиона", "миллионов"] },
  { value: 1_000, feminine: true, forms: ["тысяча", "тысячи", "тысяч"] },
];

function ruInteger(n: number, feminine = false): string {
  if (n === 0) return "ноль";
  const words: string[] = [];
  let rest = n;
  for (const scale of RU_SCALES) {
    const count = Math.floor(rest / scale.value);
    if (count) {
      words.push(...ruTriplet(count, scale.feminine), ruPlural(count, ...scale.forms));
      rest %= scale.value;
    }
  }
  words.push(...ruTriplet(rest, feminine));
  return words.join(" ");
}

// ── таджикский ─────────────────────────────────────────────────────────────

const TG_UNITS = ["", "як", "ду", "се", "чор", "панҷ", "шаш", "ҳафт", "ҳашт", "нӯҳ"];
const TG_TEENS = ["даҳ", "ёздаҳ", "дувоздаҳ", "сенздаҳ", "чордаҳ", "понздаҳ", "шонздаҳ", "ҳабдаҳ", "ҳаждаҳ", "нуздаҳ"];
const TG_TENS = ["", "", "бист", "сӣ", "чил", "панҷоҳ", "шаст", "ҳафтод", "ҳаштод", "навад"];
const TG_HUNDREDS = ["", "сад", "дусад", "сесад", "чорсад", "панҷсад", "шашсад", "ҳафтсад", "ҳаштсад", "нӯҳсад"];

function tgTriplet(n: number): string[] {
  const words: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) words.push(TG_HUNDREDS[h]);
  if (rest >= 10 && rest < 20) {
    words.push(TG_TEENS[rest - 10]);
  } else {
    const t = Math.floor(rest / 10);
    const u = rest % 10;
    if (t) words.push(TG_TENS[t]);
    if (u) words.push(TG_UNITS[u]);
  }
  return words;
}

const TG_SCALES: { value: number; word: string }[] = [
  { value: 1_000_000_000, word: "миллиард" },
  { value: 1_000_000, word: "миллион" },
  { value: 1_000, word: "ҳазор" },
];

function tgInteger(n: number): string {
  if (n === 0) return "сифр";
  const words: string[] = [];
  let rest = n;
  for (const scale of TG_SCALES) {
    const count = Math.floor(rest / scale.value);
    if (count) {
      // «ҳазор», а не «як ҳазор»: так говорят по телефону.
      if (count > 1 || scale.value > 1_000) words.push(...tgTriplet(count));
      words.push(scale.word);
      rest %= scale.value;
    }
  }
  words.push(...tgTriplet(rest));
  return words.join(" ");
}

// ── общее ──────────────────────────────────────────────────────────────────

/** Целое число словами. Дробь округляется, минус — словом. */
export function numberToWords(value: number, language: SpokenLanguage, options?: { feminine?: boolean }): string {
  if (!Number.isFinite(value)) return "";
  const n = Math.round(value);
  const abs = Math.abs(n);
  const words = language === "tg" ? tgInteger(abs) : ruInteger(abs, options?.feminine ?? false);
  if (n < 0) return `минус ${words}`;
  return words;
}

/** Целая часть и «половина ли», как говорят вслух: 62.5 → 62 с половиной (и 62.4–62.6
 *  тоже), 62.3 → 62, 62.8 → 63. Десятые по телефону не называют. */
function halves(value: number): { whole: number; half: boolean } {
  const floor = Math.floor(value);
  if (Math.abs(value - floor - 0.5) < 0.15) return { whole: floor, half: true };
  return { whole: Math.round(value), half: false };
}

/** Цена словами: «сорок пять тысяч долларов», «чил панҷ ҳазор доллар». */
export function spokenPrice(value: number, currency: string, language: SpokenLanguage): string {
  const n = Math.round(Number(value));
  const usd = currency === "USD";
  if (language === "tg") return `${numberToWords(n, "tg")} ${usd ? "доллар" : "сомонӣ"}`;
  return `${numberToWords(n, "ru")} ${usd ? ruPlural(n, "доллар", "доллара", "долларов") : "сомони"}`;
}

/** Площадь словами: «шестьдесят два с половиной квадрата», «шаст ду ним метр». */
export function spokenArea(sqm: number, language: SpokenLanguage): string {
  const { whole, half } = halves(Number(sqm));
  if (language === "tg") return `${numberToWords(whole, "tg")}${half ? " ним" : ""} метр`;
  if (half) return `${numberToWords(whole, "ru")} с половиной квадрата`;
  return `${numberToWords(whole, "ru")} ${ruPlural(whole, "квадрат", "квадрата", "квадратов")}`;
}

/**
 * Расстояние словами (09.10.2026, робот: «что рядом с домом»): до километра — метры,
 * округлённые до пятидесяти («четыреста пятьдесят метров», «чорсаду панҷоҳ метр» —
 * по-разговорному, через пробел), дальше — километры с половиной («полтора километра»,
 * «два с половиной километра», «якуним километр»).
 */
export function spokenDistance(meters: number, language: SpokenLanguage): string {
  const m = Math.max(0, Number(meters));
  if (m < 950) {
    const rounded = Math.max(50, Math.round(m / 50) * 50);
    if (language === "tg") return `${numberToWords(rounded, "tg")} метр`;
    return `${numberToWords(rounded, "ru")} ${ruPlural(rounded, "метр", "метра", "метров")}`;
  }
  const { whole, half } = halves(m / 1000);
  if (language === "tg") return `${whole === 1 && half ? "якуним" : `${numberToWords(whole, "tg")}${half ? " ним" : ""}`} километр`;
  if (half) return whole === 1 ? "полтора километра" : `${numberToWords(whole, "ru")} с половиной километра`;
  return `${numberToWords(whole, "ru")} ${ruPlural(whole, "километр", "километра", "километров")}`;
}

const RU_ORD_UNITS = ["", "первый", "второй", "третий", "четвёртый", "пятый", "шестой", "седьмой", "восьмой", "девятый"];
const RU_ORD_TEENS = [
  "десятый",
  "одиннадцатый",
  "двенадцатый",
  "тринадцатый",
  "четырнадцатый",
  "пятнадцатый",
  "шестнадцатый",
  "семнадцатый",
  "восемнадцатый",
  "девятнадцатый",
];
const RU_ORD_TENS = ["", "", "двадцатый", "тридцатый", "сороковой", "пятидесятый", "шестидесятый", "семидесятый", "восьмидесятый", "девяностый"];

function ruOrdinal(n: number): string {
  if (n < 1 || n > 99) return `${ruInteger(n)}-й`;
  if (n < 10) return RU_ORD_UNITS[n];
  if (n < 20) return RU_ORD_TEENS[n - 10];
  const t = Math.floor(n / 10);
  const u = n % 10;
  return u ? `${RU_TENS[t]} ${RU_ORD_UNITS[u]}` : RU_ORD_TENS[t];
}

const RU_GEN_UNITS = ["", "одного", "двух", "трёх", "четырёх", "пяти", "шести", "семи", "восьми", "девяти"];
const RU_GEN_TEENS = [
  "десяти",
  "одиннадцати",
  "двенадцати",
  "тринадцати",
  "четырнадцати",
  "пятнадцати",
  "шестнадцати",
  "семнадцати",
  "восемнадцати",
  "девятнадцати",
];
const RU_GEN_TENS = ["", "", "двадцати", "тридцати", "сорока", "пятидесяти", "шестидесяти", "семидесяти", "восьмидесяти", "девяноста"];

/** «из девяти», «из двадцати пяти» — родительный падеж для этажности. */
function ruGenitive(n: number): string {
  if (n < 1 || n > 99) return ruInteger(n);
  if (n < 10) return RU_GEN_UNITS[n];
  if (n < 20) return RU_GEN_TEENS[n - 10];
  const t = Math.floor(n / 10);
  const u = n % 10;
  return u ? `${RU_GEN_TENS[t]} ${RU_GEN_UNITS[u]}` : RU_GEN_TENS[t];
}

/** Порядковое на таджикском: «панҷум», «дуюм», «сиюм», «бист якум». */
function tgOrdinal(n: number): string {
  const words = tgInteger(n);
  if (words.endsWith("ӣ")) return `${words.slice(0, -1)}июм`;
  if (/[аеиоуӯ]$/.test(words)) return `${words}юм`;
  return `${words}ум`;
}

// ── обратно: слова → цифры ──────────────────────────────────────────────────

/**
 * ЧИСЛА СЛОВАМИ → ЦИФРЫ (09.10.2026, аудит робота перед первым клиентом, P0-1).
 *
 * Обратная сторона spokenPrice/spokenArea: функции звонка отдают модели цену и
 * площадь СЛОВАМИ, а расшифровка речи модели приходит то словами, то цифрами.
 * Сторож «объект вне подборки» (apps/api/src/lib/telephony/liveVoiceGuards.ts)
 * сверяет числа, поэтому обе стороны сначала приводятся к цифрам здесь — теми же
 * словарями, которыми числа озвучиваются, второй копии словаря нет.
 *
 * Текст сохраняется как был, меняются только серии числительных: «сорок пять
 * тысяч долларов» → «45000 долларов», «шестьдесят два с половиной квадрата» →
 * «62.5 квадрата», «до шестисот тысяч» → «до 600000». Косвенные падежи
 * («шестидесяти», «пятисот») берутся: так человек называет бюджет («до …»).
 *
 * Серия рвётся, когда разряд не убывает («девяносто три пятьсот» — это две части
 * продиктованного номера, а не 593), поэтому номер телефона ценой не становится.
 */
const RU_GEN_HUNDREDS = ["", "ста", "двухсот", "трёхсот", "четырёхсот", "пятисот", "шестисот", "семисот", "восьмисот", "девятисот"];

function spokenWordValues(): Map<string, number> {
  const map = new Map<string, number>();
  const put = (words: readonly string[], factor: number, from = 0) =>
    words.forEach((w, i) => {
      if (!w) return;
      map.set(w, (i + from) * factor);
      map.set(w.replace(/ё/g, "е"), (i + from) * factor);
    });
  put(RU_UNITS_M, 1);
  put(RU_UNITS_F, 1);
  put(RU_GEN_UNITS, 1);
  put(RU_TEENS, 1, 10);
  put(RU_GEN_TEENS, 1, 10);
  put(RU_TENS, 10);
  put(RU_GEN_TENS, 10);
  put(RU_HUNDREDS, 100);
  put(RU_GEN_HUNDREDS, 100);
  put(TG_UNITS, 1);
  put(TG_TEENS, 1, 10);
  put(TG_TENS, 10);
  put(TG_HUNDREDS, 100);
  for (const [w, v] of [["одну", 1], ["одной", 1], ["одном", 1], ["двум", 2], ["трём", 3], ["трем", 3], ["полтора", 1.5], ["полторы", 1.5]] as const) map.set(w, v);
  return map;
}

const SPOKEN_WORD_VALUES = spokenWordValues();

const SPOKEN_SCALES: [RegExp, number][] = [
  [/^миллиард\p{L}*$/u, 1_000_000_000],
  [/^миллион\p{L}*$/u, 1_000_000],
  [/^(?:тысяч\p{L}*|тыс|тыщ\p{L}*|ҳазор|хазор)$/u, 1_000],
];

function scaleOf(word: string): number | null {
  for (const [re, value] of SPOKEN_SCALES) if (re.test(word)) return value;
  return null;
}

/** Разряд слова внутри тройки: сотни, десятки (и 10–19), единицы. */
function placeOf(value: number): number {
  return value >= 100 ? 100 : value >= 10 ? 10 : 1;
}

function formatSpokenValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/** Серии числительных в тексте — цифрами; остальной текст не трогается. */
export function spokenNumbersToDigits(text: string): string {
  const tokens = text.match(/[\p{L}\d]+(?:[.,]\d+)?|[^\p{L}\d]+/gu) ?? [];
  const out: string[] = [];
  const lower = tokens.map((t) => t.toLowerCase());
  const isSpace = (i: number) => i < tokens.length && /^[ \t -]+$/.test(tokens[i]);
  const isDigits = (i: number) => i < tokens.length && /^\d+(?:[.,]\d+)?$/.test(tokens[i]);
  const isNumberWord = (i: number) => i < tokens.length && (SPOKEN_WORD_VALUES.has(lower[i]) || scaleOf(lower[i]) !== null);
  let i = 0;
  while (i < tokens.length) {
    if (!isNumberWord(i) && !isDigits(i)) {
      out.push(tokens[i]);
      i += 1;
      continue;
    }
    // Одинокая шкала («несколько тысяч», «больше миллиона») остаётся словом: числа в
    // ней нет. «Тысяча двести» — число, его разбираем.
    if (scaleOf(lower[i]) !== null && !(isSpace(i + 1) && SPOKEN_WORD_VALUES.has(lower[i + 2] ?? ""))) {
      out.push(tokens[i]);
      i += 1;
      continue;
    }
    let total = 0;
    let current = 0;
    let lastPlace = 1000;
    let words = 0;
    let end = i; // индекс последнего токена серии
    let j = i;
    while (j < tokens.length) {
      const t = lower[j];
      const scale = scaleOf(t);
      if (isDigits(j)) {
        if (current !== 0 || (j !== i && lastPlace !== 1000)) break;
        current = Number(t.replace(",", "."));
        lastPlace = 1;
      } else if (SPOKEN_WORD_VALUES.has(t)) {
        const value = SPOKEN_WORD_VALUES.get(t)!;
        const place = placeOf(value);
        // Разряд не убывает — это уже следующее число («девяносто три пятьсот»).
        if (place >= lastPlace || (place === 10 && current % 100 >= 10)) break;
        current += value;
        lastPlace = value >= 10 && value < 20 ? 1 : place;
        words += 1;
      } else if (scale !== null) {
        total += (current || 1) * scale;
        current = 0;
        lastPlace = 1000;
      } else break;
      end = j;
      // «с половиной» после числа: 62 с половиной → 62.5, «сорок пять с половиной тысяч» → 45500.
      if (isSpace(j + 1) && lower[j + 2] === "с" && isSpace(j + 3) && /^половин\p{L}*$/u.test(lower[j + 4] ?? "") && scale === null) {
        current += 0.5;
        end = j + 4;
        j += 5;
        if (isSpace(j) && scaleOf(lower[j + 1] ?? "") !== null) {
          total += current * scaleOf(lower[j + 1])!;
          current = 0;
          end = j + 1;
        }
        break;
      }
      if (!isSpace(j + 1) || !(isNumberWord(j + 2) || isDigits(j + 2))) break;
      j += 2;
    }
    // Цифры без единого слова — как были (сохраняем «45 000» и «897 тыс.» нетронутыми
    // для разбора цен, у него свои правила для разделителей тысяч).
    if (words === 0 && !lower.slice(i, end + 1).some((t) => scaleOf(t) !== null)) {
      out.push(...tokens.slice(i, end + 1));
    } else {
      // Следом идёт ещё число («девяносто три пятьсот пятьдесят пять» — номер по
      // частям): запятая не даёт разбору цен склеить «93 555» в одну сумму.
      const next = isSpace(end + 1) && (isNumberWord(end + 2) || isDigits(end + 2));
      out.push(formatSpokenValue(total + current) + (next ? "," : ""));
    }
    i = end + 1;
  }
  return out.join("");
}

/** Этаж словами: «пятый этаж из девяти», «қабати панҷум аз нӯҳ». Цоколь — 0 и ниже. */
export function spokenFloor(floor: number, totalFloors: number | null | undefined, language: SpokenLanguage): string {
  const f = Math.round(Number(floor));
  const total = totalFloors ? Math.round(Number(totalFloors)) : null;
  if (language === "tg") {
    const base = f <= 0 ? "қабати таҳхона" : `қабати ${tgOrdinal(f)}`;
    return total && total > 0 ? `${base} аз ${tgInteger(total)}` : base;
  }
  const base = f <= 0 ? "цокольный этаж" : `${ruOrdinal(f)} этаж`;
  return total && total > 0 ? `${base} из ${ruGenitive(total)}` : base;
}
