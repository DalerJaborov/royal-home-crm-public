/**
 * НАЗВАНИЕ РАЙОНА — ОДНО НА ВСЕ ПЛОЩАДКИ.
 *
 * Выборка «Сино, 3-комнатные» ищет район по точному совпадению с названием из справочника
 * District. Somon давно сводит район к этим названиям, а Paydo писал «как есть»
 * («И. Сомони», «шохмансур»): такие объявления тихо выпадали из медианы. Эта функция —
 * единственная дверь для названий районов; парсеры обоих источников ходят через неё.
 *
 * Справочник Душанбе: Сино, Исмоили Сомони, Шохмансур, Фирдавси. Незнакомое название
 * (другой город, посёлок) НЕ выбрасываем и не угадываем — возвращаем как написано,
 * только очищенное от «район/ноҳия».
 */

export const DISTRICTS = ["Сино", "Исмоили Сомони", "Шохмансур", "Фирдавси"] as const;
export type CanonicalDistrict = (typeof DISTRICTS)[number];

/** Регистр, ё/е, таджикские ӣ/ҳ/қ/ғ, точки и дефисы — к простому виду для сравнения. */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/ӣ/g, "и")
    .replace(/ҳ/g, "х")
    .replace(/қ/g, "к")
    .replace(/ғ/g, "г")
    .replace(/ӯ/g, "у");
}

/** Ключ (после fold + чистки) → название района. */
const CANONICAL: Record<string, CanonicalDistrict> = {
  сино: "Сино",
  "и сомони": "Исмоили Сомони",
  "исмоили сомони": "Исмоили Сомони",
  "исмоил сомони": "Исмоили Сомони",
  сомони: "Исмоили Сомони",
  шохмансур: "Шохмансур",
  шомансур: "Шохмансур",
  шахмансур: "Шохмансур",
  "шох мансур": "Шохмансур",
  фирдавси: "Фирдавси",
  фирдоуси: "Фирдавси",
};

/** «район», «р-н», «ноҳия» перед или после названия — в исходной записи (для неузнанных названий). */
const PREFIX_ORIGINAL = /^(?:район|р-н|р-он|ноҳия|нохия)\s+/i;
const SUFFIX_ORIGINAL = /\s+(?:район|р-н|р-он|ноҳия|нохия)$/i;

function clean(raw: string): string {
  let t = fold(raw)
    .replace(/[.,;:()«»"']/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Префикс снимаем после очистки знаков: «р-н Сино» → «р н сино» → «сино».
  t = t.replace(/^(?:район|р н|р он|нохия)\s+/, "").replace(/\s+(?:район|р н|р он|нохия)$/, "");
  return t.trim();
}

/** Название из справочника или null, если строка — не один из четырёх районов. */
export function canonicalDistrict(raw: string | null | undefined): CanonicalDistrict | null {
  if (!raw) return null;
  const key = clean(raw);
  return key ? (CANONICAL[key] ?? null) : null;
}

/**
 * Название района для записи в каталог: из справочника, если узнали; иначе исходная
 * строка без «район/ноҳия» и лишних пробелов. Пусто → null.
 */
export function normalizeDistrictName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const known = canonicalDistrict(raw);
  if (known) return known;
  const trimmed = raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:район|р-н|р-он|ноҳия|нохия)$/i, "")
    .replace(PREFIX_ORIGINAL, "")
    .replace(SUFFIX_ORIGINAL, "")
    .trim();
  return trimmed || null;
}

/**
 * Район в произвольном тексте (заголовок, подпись к фото): ищем подстроку. Список
 * ТОЛЬКО без голого «сомони» — «проспект Сомони» в адресе не район. Порядок важен
 * (первый найденный по списку), это поведение Somon, оно не меняется.
 */
const TEXT_ALIASES: Array<[string, CanonicalDistrict]> = [
  ["сино", "Сино"],
  ["и. сомони", "Исмоили Сомони"],
  ["исмоили сомони", "Исмоили Сомони"],
  ["и.сомони", "Исмоили Сомони"],
  ["фирдавси", "Фирдавси"],
  ["шохмансур", "Шохмансур"],
  ["шомансур", "Шохмансур"],
];

export function detectDistrictInText(text: string | null | undefined): CanonicalDistrict | null {
  if (!text) return null;
  const haystack = fold(text);
  for (const [alias, name] of TEXT_ALIASES) {
    if (haystack.includes(alias)) return name;
  }
  return null;
}
