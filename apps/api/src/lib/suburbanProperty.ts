import { geoMatchKey } from "./geoNormalize.js";
import { BOT_DISTRICT_NAMES } from "@royal-home/shared";
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
/**
 * СИЛЬНЫЕ ПРИЗНАКИ — названное место за городом (Вахдат, Варзоб, Гиссар, дача, «9 км» как место). Агенты часто записывают такой дом
 * в ближайший городской район («дом в Вахдате» с районом Шохмансур, аудит P0-4), поэтому они решают и при городском
 * районе в справочнике.
 */
const STRONG_SUBURB_PATTERNS: RegExp[] = [
  // «Кохи Вахдат», «проспект Вахдат», «Варзоб ГЭС», «улица Варзобская», «Гиссарская» — в городе.
  /(?<!(?:кохи|дворец|улица|ул|проспект|просп|кучаи|хиебони|кинотеатр) )(?<![\p{L}\d])вахдат/u,
  /(?<![\p{L}\d])варзоб(?!ская|ской улиц| ?гэс)/u,
  /(?<![\p{L}\d])(гиссар(?!ская)|хисор)/u,
  /(^| )чорбог/u,
  /(^| )дачн/u,
  /(^| )(дача|дачу|дачи|дачке|дачка)( |$)/u,
  /(^| )(город|г|шахри) турсунзода/u,
  /(^| )(шахринав|файзобод|кофарнихон)/u,
  // «9 км», «9-й км», «12 километр» — но не «1 2 км от», не «12 км до аэропорта» и не «до центра 5 км»: это расстояние
  // до чего-то, а не место (после нормализации запятая — пробел).
  /(^| )(?<!до \p{L}+ )\d{1,2} ?(й|ой|ом)? ?(км|километр\p{L}*)(?! от)(?! до)( |$)/u,
];
/**
 * СЛАБЫЕ ПРИЗНАКИ — общие слова («за городом», «пригород»). Решают, только когда района в
 * справочнике нет: у квартиры в Сино «за городом шумно, а тут тихо» — не загород (финальное ревью #204, Ф-3).
 */
const WEAK_SUBURB_PATTERNS: RegExp[] = [
  /(^| )пригород/u,
  /(^| )за город(ом)?( |$)/u,
  /(^| )берун аз шахр/u,
];
const SUBURB_PATTERNS: RegExp[] = [...STRONG_SUBURB_PATTERNS, ...WEAK_SUBURB_PATTERNS];

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
  // Район из справочника сильнее СЛАБЫХ слов карточки (финальное ревью #204, Ф-3): «до центра 5 км», «12 км до
  // аэропорта», «за городом шумно, а тут тихо» у квартиры в Сино — не загород. Названное место за городом (Вахдат,
  // Варзоб, дача) решает и при городском районе: агенты записывают такие дома в ближайший район города (аудит P0-4).
  if (p.district?.name === RUDAKI_DISTRICT_NAME) return true;
  const texts = [p.title, p.address, p.landmark, p.description];
  if (p.district?.name && CITY_DISTRICT_NAMES.has(p.district.name)) {
    // Городской район: загород только по названному месту (сильный признак) или по словам района Рудаки.
    return texts.some((t) => !!t && (mentionsRudakiDistrict(t) || STRONG_SUBURB_PATTERNS.some((re) => re.test(geoMatchKey(t)))));
  }
  return texts.some((t) => textMentionsSuburb(t));
}

/** Четыре района города из справочника — всё, кроме района Рудаки. */
const CITY_DISTRICT_NAMES: ReadonlySet<string> = new Set(BOT_DISTRICT_NAMES.filter((name) => name !== RUDAKI_DISTRICT_NAME));

/** Объект именно в районе Рудаки: район в справочнике или слова района в карточке. */
export function isRudakiProperty(p: SuburbCheckFields): boolean {
  // Слова района Рудаки решают и при городском районе: агенты записывают такие дома в ближайший район города.
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
