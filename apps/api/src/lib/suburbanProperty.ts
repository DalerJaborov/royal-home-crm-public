import { geoMatchKey } from "./geoNormalize.js";
import { mentionsRudakiDistrict, RUDAKI_DISTRICT_NAME } from "./serviceArea.js";

/**
 * ЗА ГОРОДОМ — ОТДЕЛЬНЫЙ ПРИЗНАК, А НЕ ЧЕТВЕРТЬ ДУШАНБЕ (10.10.2026, аудит поиска
 * ботами P0-4, docs/audit-bots-2026-10-10-search.md).
 *
 * Районов в справочнике четыре, и дом в Вахдате, дача в Варзобе или «9 км, шиферный
 * завод» агенты записывают в ближайший городской район. На «дом в Шохмансуре до 6 млн»
 * бот называл два загородных дома из трёх, а единственный городской стоял четвёртым.
 * Записи объектов здесь не правятся (это работа агентов, список — в журнале правки):
 * признак читается из того, что агент уже написал в заголовке, адресе, ориентире и
 * описании.
 *
 * Слова — те, что встречаются в каталоге и в речи клиентов. Нарочно НЕТ голых «Рудаки»
 * и «Турсунзода»: это и районы области, и улица/проспект в самом Душанбе. Расстояние
 * «9 км» — признак, а «1,2 км от …» (автоподпись ориентира, lib/landmarkPick.ts) — нет.
 *
 * Одно место на оба конца: запрос клиента («дом в Вахдате») и карточка объекта
 * сверяются одной функцией — иначе загородный запрос не нашёл бы загородный объект.
 */
const SUBURB_PATTERNS: RegExp[] = [
  // «Кохи Вахдат», «проспект Вахдат», «Варзоб ГЭС», «улица Варзобская», «Гиссарская» — в городе.
  /(?<!(?:кохи|дворец|улица|ул|проспект|просп|кучаи|хиебони|кинотеатр) )(?<![\p{L}\d])вахдат/u,
  /(?<![\p{L}\d])варзоб(?!ская|ской улиц| ?гэс)/u,
  /(?<![\p{L}\d])(гиссар(?!ская)|хисор)/u,
  /(^| )чорбог/u,
  /(^| )дачн/u,
  /(^| )(дача|дачу|дачи|дачке|дачка)( |$)/u,
  /(^| )пригород/u,
  /(^| )за город(ом)?( |$)/u,
  /(^| )берун аз шахр/u,
  /(^| )(город|г|шахри) турсунзода/u,
  /(^| )(шахринав|файзобод|кофарнихон)/u,
  // «9 км», «9-й км», «12 километр» — но не «1 2 км от» (после нормализации запятая — пробел).
  /(^| )\d{1,2} ?(й|ой|ом)? ?(км|километр\p{L}*)(?! от)( |$)/u,
];

/** Текст говорит о месте за городом: «дом в Вахдате», «дача в Варзобе», «9 км». */
export function textMentionsSuburb(text: string | null | undefined): boolean {
  if (!text) return false;
  const key = geoMatchKey(text);
  // Район Рудаки (и Сомониён) — за городом, хоть и наша зона с 15.11.2026: зона — не карта (lib/serviceArea.ts).
  return mentionsRudakiDistrict(text) || SUBURB_PATTERNS.some((re) => re.test(key));
}

export interface SuburbCheckFields {
  title?: string | null;
  address?: string | null;
  landmark?: string | null;
  description?: string | null;
  /** Район из справочника: «Рудаки» — за городом, даже если в тексте карточки слов района нет. */
  district?: { name: string } | null;
}

/** Объект за городом — по словам самой карточки. */
export function isSuburbanProperty(p: SuburbCheckFields): boolean {
  return p.district?.name === RUDAKI_DISTRICT_NAME || [p.title, p.address, p.landmark, p.description].some((t) => textMentionsSuburb(t));
}

/** Объект именно в районе Рудаки: район в справочнике или слова района в карточке. */
export function isRudakiProperty(p: SuburbCheckFields): boolean {
  return p.district?.name === RUDAKI_DISTRICT_NAME || [p.title, p.address, p.landmark, p.description].some((t) => mentionsRudakiDistrict(t));
}

/**
 * ВНЕ ЗОНЫ — ЗАГОРОД НЕ В РАЙОНЕ РУДАКИ (владелец 16.11.2026: «Загород не берём, только Душанбе»; Рудаки — зона с 15.11).
 * Одна дверь для всех ботов и робота: такой объект не предлагается (lib/propertyMatch.ts), такой запрос не ищется.
 */
export function propertyOutsideServiceArea(p: SuburbCheckFields): boolean {
  return isSuburbanProperty(p) && !isRudakiProperty(p);
}

/** Запрос «за городом» не в районе Рудаки — вне зоны. */
export function queryOutsideServiceArea(q: { suburban?: boolean | null; districtName?: string | null }): boolean {
  return q.suburban === true && q.districtName !== RUDAKI_DISTRICT_NAME;
}
