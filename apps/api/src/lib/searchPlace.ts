import { placesMentioned, sameWord } from "../ai/geoMentions.js";
import { FOLK_PLACES, type OfficialDistrict } from "../ai/folkPlaces.js";
import { geoMatchKey } from "./geoNormalize.js";
import { resolveBuildingByText } from "./geoResolve.js";
import { districtByPoint } from "./propertyDistrict.js";
import { isGenericPlaceName, radiusFor, type MatchPlace, type PropertyMatchQuery } from "./propertyMatch.js";
import { textMentionsSuburb } from "./suburbanProperty.js";

/**
 * МЕСТО В ЗАПРОСЕ ПОКУПАТЕЛЯ — КОДОМ, ОДНИМ ПРАВИЛОМ ДЛЯ ГОЛОСА И ЧАТ-БОТА
 * (10.10.2026, аудит поиска ботами P0-2, P0-3, P1-4, docs/audit-bots-2026-10-10-search.md).
 *
 * Раньше район для подбора выбирала модель: чат-бот — из «карты народных названий» в
 * промте, робот — «из головы» (блока карты у него не было вовсе). Теперь слова клиента
 * («в Зарафшоне», «возле Корвона», «82 мкр», «у ОВИРа») разбирает код:
 *  1. официальный район словом — он и есть район;
 *  2. место с карты города (ai/geoMentions.ts, с точностью до падежа) — точка для
 *     близости и район по точке (`districtByPoint`), если район не назван;
 *  3. народное название без точки (ai/folkPlaces.ts) — его район;
 *  4. «за городом» (Вахдат, Варзоб, дача) — отдельный признак (lib/suburbanProperty.ts).
 * Не нашлось — пусто, модель остаётся запасным путём, как раньше.
 */

const OFFICIAL_DISTRICTS: { district: OfficialDistrict; re: RegExp }[] = [
  { district: "Сино", re: /(^| )сино( |$)/u },
  { district: "Фирдавси", re: /(^| )фирдавс[\p{L}]*/u },
  { district: "Шохмансур", re: /(^| )шохмансур[\p{L}]*/u },
  // «Сомони» без «Исмоили» — это ещё и валюта: «500 000 сомони».
  { district: "Исмоили Сомони", re: /(^| )(исмоил[\p{L}]* сомон[\p{L}]*|и сомони)/u },
];

export interface ResolvedSearchPlace {
  /** Район, названный словом. */
  districtName: OfficialDistrict | null;
  /** Район места (по точке карты или по народному списку) — когда района словом нет. */
  placeDistrictName: string | null;
  place: MatchPlace | null;
  suburban: boolean;
}

/** Все слова названия встречаются подряд, с точностью до падежного окончания. */
function looseHas(words: string[], name: string): boolean {
  const parts = geoMatchKey(name).split(" ").filter(Boolean);
  if (parts.length === 0 || parts.join("").length < 3) return false;
  for (let i = 0; i + parts.length <= words.length; i++) {
    if (parts.every((p, j) => sameWord(p, words[i + j]))) return true;
  }
  return false;
}

/** Официальный район, названный в тексте словами человека («в Сино», «Шоҳмансур»), или null. */
export function officialDistrictIn(text: string | null | undefined): OfficialDistrict | null {
  if (!text?.trim()) return null;
  const key = geoMatchKey(text);
  return OFFICIAL_DISTRICTS.find((d) => d.re.test(key))?.district ?? null;
}

/** Радиус вокруг точного дома: «рядом с Рудаки 177» — соседние дома и кварталы. */
export const HOUSE_SEARCH_RADIUS_M = 500;

/** Слова «у», «около», «рядом с»… перед адресом геокодеру домов не нужны. */
const ADDRESS_LEAD = /^(?:(?:у|около|возле|рядом с|рядом|напротив|дар назди|наздики|назди|по адресу|адрес)\s+)+/iu;
/** Хвост реплики «одно-два слова + номер дома»: «Рудаки 177», «проспект Сомони, 32а». */
const ADDRESS_TAIL = /(?:^|\s)((?:[\p{L}.-]+\s+)?[\p{L}.-]{3,}),?\s*(\d{1,4})\s*([a-zа-яё])?\s*$/iu;
/** Слово перед числом, после которого число — не номер дома: «мкр 91», «Сино 2», «до 600», «3 этаж». */
const NOT_A_STREET_WORD = /^(?:мкр|мкрн|микрорайон\p{L}*|сино|фирдавс\p{L}*|шохмансур\p{L}*|шоҳмансур\p{L}*|сомон\p{L}*|исмоил\p{L}*|до|от|за|по|около|возле|дом|дома|этаж\p{L}*|комнат\p{L}*|кв|квартир\p{L}*|тыс\p{L}*|млн|миллион\p{L}*|доллар\p{L}*|школ\p{L}*|мактаб\p{L}*|район\p{L}*|ноҳия\p{L}*|хона\p{L}*|ҳуҷра\p{L}*)$/iu;
/** Улица названа видом («проспект Сомони 32») — тогда и «Сомони» годится как имя улицы. */
const STREET_KIND = /^(?:ул|ул\.|улица|пр|пр\.|проспект|пр-т|проезд|переулок|кучаи|кӯчаи|хиёбони|шоҳроҳи)$/iu;
/** Цена, комнаты, этаж в реплике — это запрос подбора, а не адрес. */
const SEARCH_CUES = /(?:^|\s)(?:до|от)\s+\d|тыс|млн|сомони\s*$|\$|комнат|двушк|трешк|однушк|этаж/iu;

/**
 * «Улица + номер дома» — только когда это похоже на адрес; всё прочее отсекается ДО запроса в базу
 * (ревью 08.11): «мкр 91», «Сино 2», «двушка в Сино до 600» дом не порождают и не стоят запросов.
 */
export function houseAddressCandidate(text: string): string | null {
  const address = text.trim().replace(ADDRESS_LEAD, "").trim();
  if (SEARCH_CUES.test(address)) return null;
  const m = ADDRESS_TAIL.exec(address);
  if (!m) return null;
  // «квартира у Рудаки 177»: предлог перед улицей геокодеру не нужен.
  const words = m[1].split(/\s+/).filter((w, i, all) => !(all.length > 1 && i === 0 && /^(?:у|в|на|по|к|с|около|возле|назди)$/iu.test(w)));
  const last = words[words.length - 1];
  const kindNamed = words.length > 1 && STREET_KIND.test(words[0]);
  if (!kindNamed && NOT_A_STREET_WORD.test(last)) return null;
  return `${words.join(" ")} ${m[2]}${m[3] ?? ""}`;
}

async function houseByAddress(text: string): Promise<MatchPlace | null> {
  const candidate = houseAddressCandidate(text);
  if (!candidate) return null;
  const house = await resolveBuildingByText(candidate);
  return house ? { name: house.name, lat: house.lat, lng: house.lng, radiusM: HOUSE_SEARCH_RADIUS_M } : null;
}

export async function resolveSearchPlace(text: string | null | undefined): Promise<ResolvedSearchPlace> {
  const empty: ResolvedSearchPlace = { districtName: null, placeDistrictName: null, place: null, suburban: false };
  if (!text?.trim()) return empty;
  let key = geoMatchKey(text);
  const official = officialDistrictIn(text);
  // Название района — не место: «Исмоили Сомони» не должен найтись проспектом Сомони.
  for (const d of OFFICIAL_DISTRICTS) key = key.replace(new RegExp(d.re.source, "gu"), " ");
  const suburban = textMentionsSuburb(text);

  // Адрес «улица + номер дома» («Рудаки 177») — точка самого дома из справочника домов
  // (lib/geoResolve.ts::resolveBuildingByText, тот же геокодер, что у адреса объекта), а не
  // середина проспекта длиной в десять километров (07.11.2026, проверка владельца).
  const house = await houseByAddress(text);
  if (house) {
    const district = (await districtByPoint(house.lat, house.lng))?.name ?? null;
    return { districtName: official, placeDistrictName: district, place: house, suburban };
  }

  // «Школа», «Рынок» без имени — не место: таких по городу сотни (P2-4).
  const [found] = (key.trim() ? await placesMentioned(key, { loose: true }) : []).filter((p) => !isGenericPlaceName(p.name));
  let place: MatchPlace | null = null;
  let placeDistrictName: string | null = null;
  if (found) {
    place = { name: found.name, lat: found.lat, lng: found.lng, radiusM: radiusFor(found) };
    placeDistrictName = found.districtName ?? (await districtByPoint(found.lat, found.lng))?.name ?? null;
  }
  if (!placeDistrictName) {
    const words = key.split(" ").filter(Boolean);
    const folk = FOLK_PLACES.find((f) => looseHas(words, f.name));
    if (folk) placeDistrictName = folk.district;
  }
  return { districtName: official, placeDistrictName, place, suburban };
}

/** Комнаты словами клиента: «двушка», «2-комн», «дуҳуҷра», «3 хонага». */
const ROOM_WORDS: [number, RegExp][] = [
  [1, /(^| )(однушк|однокомнат|якхона|якхучра|як хона|як хучра)/u],
  [2, /(^| )(двушк|двухкомнат|духона|духучра|ду хона|ду хучра)/u],
  [3, /(^| )(трешк|трехкомнат|сехона|сехучра|се хона|се хучра)/u],
  [4, /(^| )(четырехкомнат|чорхона|чорхучра|чор хона|чор хучра)/u],
];
const ROOMS_NUMBER = /(^| )([1-9]) ?(х )?(комн|к( |$)|хонаг|хонах|хучра|комнат|room)/u;

export function roomsFromText(text: string): number | null {
  const key = geoMatchKey(text);
  for (const [n, re] of ROOM_WORDS) if (re.test(key)) return n;
  const m = key.match(ROOMS_NUMBER);
  return m ? Number(m[2]) : null;
}

/** Тип жилья словами клиента. «Дом печати» — место, а не дом. */
export function typeFromText(text: string): "APARTMENT" | "HOUSE" | "LAND" | "COMMERCIAL" | null {
  const key = geoMatchKey(text);
  if (/(^| )(квартир|кв( |$)|хонаи истикомати|двушк|трешк|однушк|новостройк|элитк)/u.test(key)) return "APARTMENT";
  if (/(^| )(участ|замин|сотик|сотк)/u.test(key)) return "LAND";
  if (/(^| )(коммерч|помещени|магазин|склад)/u.test(key)) return "COMMERCIAL";
  if (/(^| )(дом|дома|домик|частный дом|хавли|коттедж)( |$)(?!печати)/u.test(key)) return "HOUSE";
  return null;
}

/** «Подешевле», «самое дешёвое», «арзонтар». */
export function wantsCheapest(text: string): boolean {
  return /(^| )(дешевл|подешевл|самое дешев|самый дешев|самую дешев|арзон)/u.test(geoMatchKey(text));
}

/**
 * ЗАПРОС ЧАТ-БОТА — ПО ЭТОМУ ХОДУ, А НЕ ПО ПРОШЛОМУ (10.10.2026, аудит P0-2).
 *
 * Черновик лида (LeadDraft) заполняет модель В ОТВЕТЕ — то есть на ходе, где клиент
 * впервые написал «ищу двушку в Сино», в черновике ещё пусто, и подборка в промт не
 * попадала: бот не мог назвать ни одного варианта, а правило «нет блока — нет
 * подходящего» толкало его к «вариантҳо надорем». Здесь последняя реплика клиента
 * разбирается кодом ДО вызова модели: что названо в ней, перекрывает черновик (это
 * самое свежее), остальное берётся из черновика. Бюджет не разбирается — валюту и
 * «тысячи» надёжно понимает только модель (ai/moneyThresholds.ts), он остаётся из черновика.
 */
export async function buyerQueryForTurn(
  draft: PropertyMatchQuery & { intent?: string | null },
  lastClientText: string
): Promise<PropertyMatchQuery> {
  const resolved = await resolveSearchPlace(lastClientText);
  const rooms = roomsFromText(lastClientText);
  const type = typeFromText(lastClientText);
  return {
    ...draft,
    // Район словом — свежее черновика; район места — только если черновик района не знает.
    districtName: resolved.districtName ?? draft.districtName ?? resolved.placeDistrictName ?? null,
    type: type ?? draft.type ?? null,
    rooms: rooms ?? draft.rooms ?? null,
    place: resolved.place ?? draft.place ?? null,
    placeText: lastClientText,
    suburban: resolved.suburban || !!draft.suburban,
    sort: wantsCheapest(lastClientText) ? "cheap" : (draft.sort ?? null),
  };
}
