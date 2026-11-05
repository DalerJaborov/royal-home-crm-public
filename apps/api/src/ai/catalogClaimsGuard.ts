import { spokenNumbersToDigits } from "@royal-home/shared";
import { guardPrices } from "./priceGuard.js";
import { vacancyOfficeAddress } from "./vacancyFacts.js";
import { BW, EW } from "./wordBoundary.js";

/**
 * СТОРОЖ «ВНЕ ПОДБОРКИ» — ОБЩИЙ ДЛЯ ЧАТА И ГОЛОСА (аудит 10.10.2026, P1-6).
 *
 * Сверка улицы, площади и этажа с подборкой была написана только для голоса
 * (lib/telephony/liveVoiceGuards.ts, 08–09.10.2026): чат проверял одни цены
 * (ai/priceGuard.ts), и выдуманные «87 м², 15 этаж» в WhatsApp не ловились. Логика
 * перенесена сюда без изменений; голос зовёт её как раньше (liveVoiceGuards
 * переизлучает имена), чат — после щита цен (ai/leadQualifier.ts) и пишет находку
 * в журнал. Чистые функции, без сети и базы.
 *
 * Числа — и цифрами, и словами: обе стороны сначала приводятся к цифрам
 * (spokenNumbersToDigits из @royal-home/shared).
 */

/** Слова, после которых идёт название улицы или ориентира. */
const STREET_RE =
  /(проспект\p{L}*|пр-т|ул\.|улиц\p{L}*|переул\p{L}*|шоссе|микрорайон\p{L}*|мкр\.?|около|возле|напротив)\s+(?:имени\s+)?([\p{L}-]{3,})/giu;

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е");
}

/** Названия улиц/ориентиров из реплики (только с заглавной буквы — иначе «около дома»). */
export function extractStreetMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(STREET_RE)) {
    const word = m[2];
    const first = word[0];
    if (first === first.toLowerCase()) continue;
    if (!out.includes(word)) out.push(word);
  }
  return out;
}

// ── площадь и этаж ─────────────────────────────────────────────────────────────

/** Площадь меньше — не площадь квартиры («два метра от двери»). */
const MIN_AREA_SQM = 10;
/** Допуск совпадения площади: модель округляет «шестьдесят два с половиной» до «шестидесяти трёх». */
const AREA_TOLERANCE = 1;
const MAX_FLOOR = 60;

/**
 * «60 метров», «62.5 квадрата», «87 м²», «45 кв. м». «В 300 метрах», «500 метров от
 * метро» — расстояние, а не площадь: «метрах» и «… от/до» не берём.
 */
const AREA_RE = new RegExp(
  `(?<![\\d.,])(\\d{1,4}(?:[.,]\\d{1,2})?)\\s*(?:кв\\.?\\s*м\\p{L}*|м²|м2|квм|квадрат\\p{L}*|метр(?!ах${EW})\\p{L}*)${EW}(?!\\s+(?:от|до)${EW})`,
  "giu"
);

const ORDINAL_STEMS: [string, number][] = (
  [
    ["одиннадцат", 11],
    ["двенадцат", 12],
    ["тринадцат", 13],
    ["четырнадцат", 14],
    ["пятнадцат", 15],
    ["шестнадцат", 16],
    ["семнадцат", 17],
    ["восемнадцат", 18],
    ["девятнадцат", 19],
    ["двадцат", 20],
    ["тридцат", 30],
    ["сороков", 40],
    ["пятидесят", 50],
    ["перв", 1],
    ["втор", 2],
    ["трет", 3],
    ["четв[её]рт", 4],
    ["пят", 5],
    ["шест", 6],
    ["седьм", 7],
    ["восьм", 8],
    ["девят", 9],
    ["десят", 10],
  ] as [string, number][]
).sort((a, b) => b[0].length - a[0].length);

/** «пятый этаж», «на двадцать пятом этаже» (после цифр: «20 пятом этаже»). */
const ORDINAL_FLOOR_RE = new RegExp(
  `(?:(?<![\\d.,])([2-5]0)\\s+)?${BW}(${ORDINAL_STEMS.map(([s]) => s).join("|")})(?:ый|ой|ий|ья|ье|ом|ем|ьем|ого|его|ьего|ому|ему|ая|ую)\\s+этаж`,
  "giu"
);
/** «15 этаж», «15-й этаж», «на 15-м этаже», «этаж 15». */
const DIGIT_FLOOR_RE = new RegExp(
  `(?<![\\d.,])(\\d{1,2})(?:\\s*-?\\s*(?:й|м|ом|ем|ый|ой|ий|го))?\\s+этаж|${BW}этаж\\p{L}*\\s+(?:номер\\s+)?(\\d{1,2})(?![\\d.,])`,
  "giu"
);

function ordinalValue(stem: string): number {
  const lower = stem.toLowerCase().replace(/ё/g, "е");
  for (const [re, value] of ORDINAL_STEMS) if (new RegExp(`^${re}$`, "u").test(lower)) return value;
  return 0;
}

/** Площади из текста, уже приведённого к цифрам. */
export function extractAreaClaims(digitized: string): number[] {
  const out: number[] = [];
  for (const m of digitized.matchAll(AREA_RE)) {
    const v = Number(m[1].replace(",", "."));
    if (Number.isFinite(v) && v >= MIN_AREA_SQM && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Этажи из текста, уже приведённого к цифрам. */
export function extractFloorClaims(digitized: string): number[] {
  const out: number[] = [];
  const add = (v: number) => {
    if (Number.isInteger(v) && v >= 1 && v <= MAX_FLOOR && !out.includes(v)) out.push(v);
  };
  for (const m of digitized.matchAll(DIGIT_FLOOR_RE)) add(Number(m[1] ?? m[2]));
  for (const m of digitized.matchAll(ORDINAL_FLOOR_RE)) add(Number(m[1] ?? 0) + ordinalValue(m[2]));
  return out;
}

/** Порядковое слово само по себе («двенадцатый», «20 пятый» = 25). */
const ORDINAL_WORD_RE = new RegExp(
  `(?:(?<![\\d.,])([2-5]0)\\s+)?${BW}(${ORDINAL_STEMS.map(([s]) => s).join("|")})(?:ый|ой|ий|ья|ье|ом|ем|ьем|ого|его|ьего|ому|ему|ая|ую)${EW}`,
  "giu"
);

/** Все числа текста — для слов клиента: «метров шестьдесят», «этаж где-то пятый-шестой». */
function allNumbers(digitized: string): number[] {
  const digits = [...digitized.matchAll(/(?<![\d.,])\d{1,4}(?:[.,]\d{1,2})?(?![\d])/g)].map((m) => Number(m[0].replace(",", ".")));
  const ordinals = [...digitized.matchAll(ORDINAL_WORD_RE)].map((m) => Number(m[1] ?? 0) + ordinalValue(m[2]));
  return [...digits, ...ordinals];
}

/** Предложения-вопросы («Вам выше пятого этажа?») — не утверждение об объекте. */
function statementsOnly(text: string): string {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((s) => !/\?\s*$/.test(s))
    .join(" ");
}

/** Речь про объект: тогда «на проспекте …» — адрес варианта, а не офиса или ориентира для встречи. */
const PROPERTY_TALK_RE = new RegExp(
  `${BW}(?:квартир|двушк|тр[её]шк|однушк|комнатн|вариант|объект|новостро|вторичк|коробк|участ)\\p{L}*`,
  "iu"
);

export interface OffCatalogClaims {
  prices: number[];
  streets: string[];
  /** Площади (м²), которых нет ни в подборке звонка, ни в словах клиента. */
  areas: number[];
  /** Этажи, которых нет ни в подборке звонка, ни в словах клиента. */
  floors: number[];
}

/**
 * Что в реплике названо вне подборки звонка.
 *  - цены — тем же щитом, что у чат-бота (guardPrices), по тексту, приведённому к
 *    цифрам; источники — справочник, ответы функций, слова клиента (`allowedText`);
 *  - улицы — если основы названия нет в ответах функций и словах клиента
 *    (`catalogText`, без справочника) и реплика вообще про объект. Совпадение по основе
 *    (без двух последних букв): расшифровка склоняет («на Рудаки», «по Рудаки»);
 *  - площадь и этаж — по `catalogText` с допуском, плюс любые числа из слов клиента.
 * `catalogText` не задан — берётся `allowedText` (прежнее поведение для вызовов
 * без разделения источников).
 */
export function findOffCatalogClaims(input: {
  text: string;
  allowedText: string;
  catalogText?: string;
  clientText?: string;
  usdToTjs?: number;
}): OffCatalogClaims {
  const text = spokenNumbersToDigits(input.text);
  const allowed = spokenNumbersToDigits(input.allowedText);
  const catalog = input.catalogText === undefined ? allowed : spokenNumbersToDigits(input.catalogText);
  const client = spokenNumbersToDigits(input.clientText ?? "");

  const guarded = guardPrices({ bubbles: [text], allowedText: allowed, usdToTjs: input.usdToTjs });

  const statements = statementsOnly(text);
  const clientNumbers = allNumbers(client);
  const catalogAreas = extractAreaClaims(catalog);
  const areas = extractAreaClaims(statements).filter(
    (a) => !catalogAreas.some((c) => Math.abs(c - a) <= AREA_TOLERANCE) && !clientNumbers.some((c) => Math.abs(c - a) <= AREA_TOLERANCE)
  );
  // Этаж офиса («Бухоро 49, 2 этаж») — такой же законный источник, как улица офиса ниже:
  // без него сторож рвал приглашение на собеседование на «втором этаже» и заставлял робота
  // повторять адрес (живой звонок владельцу 24.10.2026).
  const catalogFloors = extractFloorClaims(`${catalog}
${spokenNumbersToDigits(vacancyOfficeAddress())}`);
  const floors = extractFloorClaims(statements).filter((f) => !catalogFloors.includes(f) && !clientNumbers.includes(f));

  const aboutProperty =
    PROPERTY_TALK_RE.test(input.text) || guarded.invented.length > 0 || extractAreaClaims(text).length > 0 || extractFloorClaims(text).length > 0;
  // Адрес офиса (Бухоро, Школа №1…) — законный источник: робот вправе назвать его, о чём бы ни шла речь.
  const streetSources = normalizeForMatch(`${catalog}\n${client}\n${vacancyOfficeAddress()}`);
  const streets = aboutProperty
    ? extractStreetMentions(input.text).filter((name) => {
        const norm = normalizeForMatch(name);
        const stem = norm.slice(0, Math.max(4, norm.length - 2));
        return !streetSources.includes(stem);
      })
    : [];
  return { prices: guarded.invented, streets, areas, floors };
}
