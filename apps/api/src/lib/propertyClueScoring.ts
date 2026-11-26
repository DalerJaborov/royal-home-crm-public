/**
 * ПРИМЕТЫ ОБЪЕКТА ИЗ РАЗГОВОРА — МЯГКИЕ СРАВНЕНИЯ БЕЗ БАЗЫ (26.11.2026).
 *
 * Чистые функции для узнавания объекта (lib/propertyMatch.ts::identifyProperty).
 * Вынесены отдельно, чтобы проверять их таблицей случаев без базы и без ИИ.
 *
 * ЖИВОЙ СЛУЧАЙ, РАДИ КОТОРОГО НАПИСАНО (ПК-001086, 26.11.2026). Клиент позвонил
 * оператору по ролику Instagram про объект №230: «ду хонага… масҷиди Мехкалон,
 * Қазоқон… 165 ҳазор». В карточке — 2 комнаты, «возле мечети в Қазоқон», 965 000
 * сомони. Расшифровка потеряла первую цифру цены (нӯҳсаду → саду), и прежнее
 * правило «цена дальше 20 % — точно другой объект» вычеркнуло ровно тот объект, о
 * котором шла речь; заявка ушла по очереди чужому агенту, а хозяин объекта о ней
 * не узнал. Отсюда три правила ниже:
 *
 *  1. ЦЕНА — ПРИМЕТА, А НЕ ПРИГОВОР. Точная и близкая цена дают баллы, как раньше.
 *     Расхождение снимает баллы, но объект не вычёркивает: если совпали место,
 *     комнаты и этаж, один неверно расслышанный разряд не должен отдать клиента
 *     чужому агенту. Отдельно узнаются типичные ошибки: другая валюта (модель
 *     назвала доллары сомони или наоборот), потерянные тысячи и ОДНА неверная
 *     цифра в числе (165 ↔ 965, 9 ↔ 1 на телефонной линии) — им достаётся
 *     маленький плюс, а не минус.
 *  2. ОРИЕНТИРЫ СРАВНИВАЮТСЯ С ДОПУСКОМ НА НАПИСАНИЕ. «Казакон» и «Қазоқон»,
 *     «Исмаили Самани» и «Исмоили Сомони» — одно место: после свёртки таджикских
 *     букв разрешается одна замена буквы на слово от шести букв.
 *  3. ВИД МЕСТА ПО-ТАДЖИКСКИ И ПО-РУССКИ — ОДНО СЛОВО: «масҷид» = «мечеть»,
 *     «бозор» = «рынок». Совпадение вида места — слабая примета (+1): мечетей в
 *     городе много, но «мечеть» в карточке и «масҷид» в разговоре — всё же не
 *     совпадение случайное.
 */
import { foldTajikLetters, normalizeGeoText } from "@royal-home/shared";
import { levenshteinDistance } from "./levenshtein.js";

/** Как сравнилась названная цена с ценой карточки. */
export type PriceVerdictKind =
  /** В пределах 3 % — «та самая». */
  | "exact"
  /** В пределах 10 % — человек округлил. */
  | "close"
  /** Совпадает, если считать названную сумму в другой валюте. */
  | "other_currency"
  /** Совпадает с точностью до «тысяч»: «965» вместо «965 000». */
  | "thousands"
  /** Одна цифра не та при тех же разрядах: 165 000 ↔ 965 000 — похоже на ошибку распознавания. */
  | "asr_slip"
  /** Другая цена. */
  | "far";

export interface PriceVerdict {
  kind: PriceVerdictKind;
  /** Баллы к узнаванию (могут быть отрицательными). */
  score: number;
  /** Подпись приметы для хронологии; null — писать нечего. */
  signal: string | null;
  /** Цена сошлась настолько, что считается точной приметой (для правила «четыре точные приметы»). */
  exact: boolean;
}

const PRICE_EXACT = 0.03;
const PRICE_CLOSE = 0.1;

function relDiff(a: number, b: number): number {
  return a > 0 && b > 0 ? Math.abs(a - b) / a : 1;
}

/**
 * Одна цифра не та при одинаковом числе разрядов. Сравниваем числа, округлённые до
 * тысяч, если обе суммы не меньше десяти тысяч (цены жилья называют «тысячами»), —
 * иначе хвостовые разряды сравнивать бессмысленно.
 */
export function looksLikeDigitSlip(said: number, card: number): boolean {
  if (said <= 0 || card <= 0) return false;
  const scale = said >= 10_000 && card >= 10_000 ? 1000 : 1;
  const a = String(Math.round(said / scale));
  const b = String(Math.round(card / scale));
  if (a.length !== b.length || a === b) return false;
  let differ = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differ++;
  return differ === 1;
}

/**
 * Названная цена (уже в сомони, как её перевёл код по курсу) против цены карточки в
 * сомони. `usdToTjs` — для проверки «а если модель перепутала валюту».
 */
export function comparePrice(saidTjs: number, cardTjs: number, usdToTjs: number): PriceVerdict {
  if (saidTjs <= 0 || cardTjs <= 0) return { kind: "far", score: 0, signal: null, exact: false };
  const diff = relDiff(saidTjs, cardTjs);
  if (diff <= PRICE_EXACT) return { kind: "exact", score: 4, signal: "цена", exact: true };
  if (diff <= PRICE_CLOSE) return { kind: "close", score: 3, signal: "цена", exact: false };
  if (usdToTjs > 1) {
    // Сумма названа в сомони, а на деле это были доллары (или наоборот).
    if (relDiff(saidTjs * usdToTjs, cardTjs) <= PRICE_CLOSE || relDiff(saidTjs / usdToTjs, cardTjs) <= PRICE_CLOSE) {
      return { kind: "other_currency", score: 2, signal: "цена (в другой валюте)", exact: false };
    }
  }
  if (relDiff(saidTjs * 1000, cardTjs) <= PRICE_CLOSE || relDiff(saidTjs / 1000, cardTjs) <= PRICE_CLOSE) {
    return { kind: "thousands", score: 2, signal: "цена (без тысяч)", exact: false };
  }
  if (looksLikeDigitSlip(saidTjs, cardTjs) || (usdToTjs > 1 && looksLikeDigitSlip(saidTjs * usdToTjs, cardTjs))) {
    return { kind: "asr_slip", score: 1, signal: "цена похожа (одна цифра расслышана иначе?)", exact: false };
  }
  return { kind: "far", score: -3, signal: null, exact: false };
}

/**
 * Два слова — одно место с точностью до написания: общее начало (как у sameWord в
 * ai/geoMentions.ts) ИЛИ одна замена/перестановка буквы в слове от шести букв, две —
 * от девяти. Обе стороны уже нормализованы geoMatchKey (таджикские буквы свёрнуты).
 */
export function fuzzyPlaceWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // Правило sameWord: общее начало с точностью до окончания.
  if (short.length < 5) {
    if (short.length >= 3 && long.length - short.length <= 1 && long.startsWith(short)) return true;
  } else {
    let common = 0;
    while (common < a.length && common < b.length && a[common] === b[common]) common++;
    if (common >= 4 && common >= short.length - 2) return true;
  }
  // Допуск на написание: «казакон» ↔ «казокон», «самани» ↔ «сомони». Таджикское
  // «о» по-русски пишут «а» системно (Сомонӣ/Самани, Шоҳмансур/Шахмансур) — эти две
  // буквы сравниваются как одна, остальное — одна замена на слово от шести букв, две от девяти.
  if (short.length < 6) return false;
  const fa = a.replace(/о/g, "а");
  const fb = b.replace(/о/g, "а");
  if (fa === fb) return true;
  const max = short.length >= 9 ? 2 : 1;
  return levenshteinDistance(fa, fb, max) <= max;
}

/**
 * Вид места по-таджикски и по-русски → одно каноническое слово. Ключи —
 * нормализованные основы (после свёртки таджикских букв, без окончаний: сравнение
 * идёт по началу слова).
 */
const PLACE_TYPE_STEMS: Array<[stem: string, canonical: string]> = [
  ["масчид", "мечеть"], ["мечет", "мечеть"], ["мачит", "мечеть"],
  ["бозор", "рынок"], ["базар", "рынок"], ["рынок", "рынок"], ["рынк", "рынок"],
  ["мактаб", "школа"], ["школ", "школа"],
  ["беморхон", "больница"], ["больниц", "больница"], ["касалхон", "больница"],
  ["таваллудхон", "роддом"], ["роддом", "роддом"],
  ["бог", "парк"], ["парк", "парк"],
  ["купрук", "мост"], ["мост", "мост"],
  ["истгох", "остановка"], ["остановк", "остановка"],
  ["донишгох", "университет"], ["университет", "университет"],
  ["дорухон", "аптека"], ["аптек", "аптека"],
  ["фурушгох", "магазин"], ["магазин", "магазин"],
  ["маркази савдо", "тц"], ["торговый центр", "тц"], ["торговый ценр", "тц"],
  ["варзишгох", "стадион"], ["стадион", "стадион"],
  ["бонк", "банк"], ["банк", "банк"],
  ["гардиш", "кольцо"], ["кольц", "кольцо"], ["круг", "кольцо"],
];

/** Канонические виды мест, встреченные в тексте (мечеть, рынок, роддом…). */
export function placeTypeWords(text: string | null | undefined): Set<string> {
  const found = new Set<string>();
  if (!text) return found;
  const normalized = foldTajikLetters(normalizeGeoText(text));
  for (const [stem, canonical] of PLACE_TYPE_STEMS) {
    if (stem.includes(" ")) {
      if (normalized.includes(stem)) found.add(canonical);
      continue;
    }
    // Начало слова: «масҷиди», «мечети», «бозори» — всё одна основа.
    if (new RegExp(`(?<![\\p{L}])${stem}`, "u").test(normalized)) found.add(canonical);
  }
  return found;
}

/** Сколько видов мест совпало между сказанным и карточкой. */
export function placeTypeHits(said: Set<string>, card: Set<string>): number {
  let n = 0;
  for (const s of said) if (card.has(s)) n++;
  return n;
}

/** Сколько дней объект считается «свежим»: только что снятый ролик чаще всего и
 *  есть тот, по которому звонят. */
export const FRESH_PROPERTY_DAYS = 14;

export function isFreshProperty(createdAt: Date | null | undefined, now: number = Date.now()): boolean {
  return !!createdAt && now - createdAt.getTime() <= FRESH_PROPERTY_DAYS * 86_400_000;
}
