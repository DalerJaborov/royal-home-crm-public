/**
 * ПРИМЕТЫ ОБЪЕКТА ИЗ РАЗГОВОРА — МЯГКИЕ СРАВНЕНИЯ БЕЗ БАЗЫ (26.11.2026).
 *
 * Чистые функции для узнавания объекта (lib/propertyMatch.ts::identifyProperty).
 * Вынесены отдельно, чтобы проверять их таблицей случаев без базы и без ИИ.
 *
 * ЖИВОЙ СЛУЧАЙ, РАДИ КОТОРОГО НАПИСАНО (ПК-001086, 26.11.2026). Клиент позвонил
 * оператору по ролику Instagram про объект №230: «ду хонага… масҷиди Мехкалон,
 * Қазоқон… 165 ҳазор». В карточке — 2 комнаты, «возле мечети в Қазоқон», 965 000
 * сомони. Расшифровка потеряла первую цифру цены (нӯҳсаду → саду), и правило «цена
 * дальше 20 % — точно другой объект» вычеркнуло ровно тот объект, о котором шла
 * речь; заявка ушла по очереди чужому агенту, а хозяин объекта о ней не узнал.
 *
 * ДОПУСК НА ОШИБКУ РАСШИФРОВКИ — ТОЛЬКО ПО ФЛАГУ `tolerateAsr` (ревью architect
 * 26.11.2026). identifyProperty зовут и чат (botPropertyMention.ts, sharedMedia.ts),
 * и голосовой консультант (liveVoicePropertyTools.ts) — там человек пишет или
 * говорит сам, а не через расшифровку с оператором, и правило владельца 24.09 «цена
 * дальше 20 % — другой объект» остаётся в силе. Флаг ставит только разбор звонка
 * оператора (qualifyIncoming.ts), и только пока включён рубильник
 * callObjectToOwnerEnabled.
 *
 * Что считается ошибкой расшифровки, а что — другой ценой:
 *  - потерян или не так расслышан СТАРШИЙ разряд: «165» ↔ «965», «65» ↔ «965»
 *    (хвост числа совпал, значащий); потеряны «тысячи»: «965» ↔ «965 000»;
 *    модель перепутала валюту (сумма сходится в другой валюте);
 *  - соседние круглые сотни (300 ↔ 400, 500 ↔ 600), другой второй разряд
 *    (1,2 млн ↔ 1,9 млн) — ДРУГАЯ цена: без флага вычёркивание, с флагом минус три
 *    балла (объект остаётся, решают место и остальные приметы).
 */
import { foldTajikLetters, normalizeGeoText } from "@royal-home/shared";
import { levenshteinDistance } from "./levenshtein.js";

/** Как сравнилась названная цена с ценой карточки. */
export type PriceVerdictKind =
  /** В пределах 3 % — «та самая». */
  | "exact"
  /** В пределах 10 % — человек округлил. */
  | "close"
  /** Совпадает, если считать названную сумму в другой валюте (только tolerateAsr). */
  | "other_currency"
  /** Совпадает с точностью до «тысяч»: «965» вместо «965 000» (только tolerateAsr). */
  | "thousands"
  /** Старший разряд потерян/расслышан иначе: 165 000 ↔ 965 000 (только tolerateAsr). */
  | "asr_slip"
  /** Другая цена: без флага — вычёркивание (`veto`), с флагом — минус. */
  | "far";

export interface PriceVerdict {
  kind: PriceVerdictKind;
  /** Баллы к узнаванию (могут быть отрицательными). */
  score: number;
  /** Подпись приметы для хронологии; null — писать нечего. */
  signal: string | null;
  /** Цена сошлась настолько, что считается точной приметой (для правила «четыре точные приметы»). */
  exact: boolean;
  /** Объект вычёркивается (прежнее правило 24.09: цена объявления дальше 20 %). */
  veto: boolean;
}

const PRICE_EXACT = 0.03;
const PRICE_CLOSE = 0.1;
/** Дальше этого без допуска на расшифровку — точно другой объект (правило 24.09.2026). */
const PRICE_VETO = 0.2;

function relDiff(a: number, b: number): number {
  return a > 0 && b > 0 ? Math.abs(a - b) / a : 1;
}

/** Цифры суммы без «тысяч», когда обе суммы — цены жилья (от десяти тысяч). */
function digitsOf(said: number, card: number): [string, string] {
  const scale = said >= 10_000 && card >= 10_000 ? 1000 : 1;
  return [String(Math.round(said / scale)), String(Math.round(card / scale))];
}

/**
 * Потерян или не так расслышан СТАРШИЙ разряд: названное число — хвост числа
 * карточки («65» ↔ «965») либо отличается только первой цифрой при значащем хвосте
 * («165» ↔ «965»: хвост «65»). Круглые сотни (300 ↔ 400: хвост «00») и расхождение
 * не в первой цифре (1200 ↔ 1900) — не ошибка расшифровки, а другая цена.
 */
export function looksLikeLeadingDigitSlip(said: number, card: number): boolean {
  if (said <= 0 || card <= 0) return false;
  const [a, b] = digitsOf(said, card);
  if (a === b) return false;
  if (b.length > a.length && b.endsWith(a) && /[1-9]/.test(a)) return true;
  if (a.length !== b.length || a.length < 2) return false;
  const tailA = a.slice(1);
  const tailB = b.slice(1);
  return a[0] !== b[0] && tailA === tailB && /[1-9]/.test(tailA);
}

export interface PriceCompareOptions {
  /** Допуск на ошибку расшифровки: разбор звонка оператора при включённом рубильнике. */
  tolerateAsr?: boolean;
}

/**
 * Названная цена (уже в сомони, как её перевёл код по курсу) против цены карточки в
 * сомони. `usdToTjs` — для проверки «а если модель перепутала валюту» (только с флагом).
 */
export function comparePrice(saidTjs: number, cardTjs: number, usdToTjs: number, options: PriceCompareOptions = {}): PriceVerdict {
  if (saidTjs <= 0 || cardTjs <= 0) return { kind: "far", score: 0, signal: null, exact: false, veto: false };
  const diff = relDiff(saidTjs, cardTjs);
  if (diff <= PRICE_EXACT) return { kind: "exact", score: 4, signal: "цена", exact: true, veto: false };
  if (diff <= PRICE_CLOSE) return { kind: "close", score: 3, signal: "цена", exact: false, veto: false };
  if (!options.tolerateAsr) {
    // Правило 24.09.2026 для всех каналов: дальше 20 % — точно другой объект.
    return { kind: "far", score: 0, signal: null, exact: false, veto: diff > PRICE_VETO };
  }
  if (usdToTjs > 1) {
    // Сумма названа в сомони, а на деле это были доллары (или наоборот).
    if (relDiff(saidTjs * usdToTjs, cardTjs) <= PRICE_CLOSE || relDiff(saidTjs / usdToTjs, cardTjs) <= PRICE_CLOSE) {
      return { kind: "other_currency", score: 2, signal: "цена (в другой валюте)", exact: false, veto: false };
    }
  }
  if (relDiff(saidTjs * 1000, cardTjs) <= PRICE_CLOSE || relDiff(saidTjs / 1000, cardTjs) <= PRICE_CLOSE) {
    return { kind: "thousands", score: 2, signal: "цена (без тысяч)", exact: false, veto: false };
  }
  if (looksLikeLeadingDigitSlip(saidTjs, cardTjs) || (usdToTjs > 1 && looksLikeLeadingDigitSlip(saidTjs * usdToTjs, cardTjs))) {
    return { kind: "asr_slip", score: 1, signal: "цена похожа (старший разряд расслышан иначе?)", exact: false, veto: false };
  }
  return { kind: "far", score: -3, signal: null, exact: false, veto: false };
}

/**
 * Два слова — одно место с точностью до написания. База — правило sameWord из
 * ai/geoMentions.ts (общее начало с точностью до окончания), поверх него:
 *  - для ВСЕХ каналов: таджикское «о» по-русски пишут «а» системно (Сомонӣ/Самани,
 *    Шоҳмансур/Шахмансур, Қазоқон/Казакон) — эти две буквы сравниваются как одна.
 *    Это строго расширяет совпадение: всё, что совпадало раньше, совпадает и теперь;
 *  - только с `loose` (разбор звонка с допуском на расшифровку): одна замена или
 *    перестановка буквы в слове от шести букв, две — от девяти.
 */
export function fuzzyPlaceWord(a: string, b: string, options: { loose?: boolean } = {}): boolean {
  if (a === b) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  if (prefixSame(a, b)) return true;
  // «о»=«а» — только у слов от шести букв: «сино» и «сина» — разные места.
  const short = Math.min(a.length, b.length);
  if (short < 6) return false;
  const fa = a.replace(/о/g, "а");
  const fb = b.replace(/о/g, "а");
  if (prefixSame(fa, fb)) return true;
  if (!options.loose) return false;
  const max = short >= 9 ? 2 : 1;
  return levenshteinDistance(fa, fb, max) <= max;
}

/** Правило sameWord (ai/geoMentions.ts): общее начало с точностью до окончания. */
function prefixSame(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 5) return short.length >= 3 && long.length - short.length <= 1 && long.startsWith(short);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return common >= 4 && common >= short.length - 2;
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

/** Регулярные выражения собираются один раз, а не на каждый объект пула (ревью 26.11). */
const PLACE_TYPE_MATCHERS: Array<{ test: (normalized: string) => boolean; canonical: string }> = PLACE_TYPE_STEMS.map(
  ([stem, canonical]) => {
    if (stem.includes(" ")) return { canonical, test: (s: string) => s.includes(stem) };
    const re = new RegExp(`(?<![\\p{L}])${stem}`, "u");
    return { canonical, test: (s: string) => re.test(s) };
  }
);

/** Канонические виды мест, встреченные в тексте (мечеть, рынок, роддом…). */
export function placeTypeWords(text: string | null | undefined): Set<string> {
  const found = new Set<string>();
  if (!text) return found;
  const normalized = foldTajikLetters(normalizeGeoText(text));
  for (const m of PLACE_TYPE_MATCHERS) if (m.test(normalized)) found.add(m.canonical);
  return found;
}

/** Сколько видов мест совпало между сказанным и карточкой. */
export function placeTypeHits(said: Set<string>, card: Set<string>): number {
  let n = 0;
  for (const s of said) if (card.has(s)) n++;
  return n;
}

/** Сколько дней объект считается «свежим»: только что снятый ролик чаще всего и
 *  есть тот, по которому звонят. Свежесть — ТОЛЬКО тай-брейк между объектами с
 *  равными баллами (ревью 26.11), не баллы и не порог. */
export const FRESH_PROPERTY_DAYS = 14;

export function isFreshProperty(createdAt: Date | null | undefined, now: number = Date.now()): boolean {
  return !!createdAt && now - createdAt.getTime() <= FRESH_PROPERTY_DAYS * 86_400_000;
}
