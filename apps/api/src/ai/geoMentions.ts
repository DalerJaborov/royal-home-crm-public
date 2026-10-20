/**
 * МЕСТА, НАЗВАННЫЕ КЛИЕНТОМ, — ПО НАСТОЯЩЕЙ КАРТЕ ГОРОДА (20.09.2026).
 *
 * ЖИВОЙ СЛУЧАЙ, ради которого написано. Клиентка спросила в директе: «кадом
 * тарафда боша кучаи дехоти?» Бот ответил «Кӯчаи Деҳотӣ дар тарафи Фирдавсӣ
 * ҷойгир аст» — наугад, и в том же разговоре двумя сообщениями выше называл ту
 * же улицу Шохмансуром. Ответить ему было нечем: вся география бота — это
 * рукописный список примерно из шестидесяти народных названий, каждое привязано
 * к одному из четырёх районов (`MANDATORY_BOT_RULES` в dushanbeGeography.ts).
 * Улиц в нём нет НИ ОДНОЙ, домов тоже.
 *
 * При этом лицензированный слой города лежит в базе с 12.09.2026: 920 улиц,
 * 24 325 домов, 857 ориентиров, 27 микрорайонов, 117 жилых массивов, границы
 * районов. Им пользуются карта объектов и мастер объекта — и не пользовался бот,
 * то есть ровно то место, куда клиент задаёт вопрос «это где?».
 *
 * ЧТО ДЕЛАЕТ ЭТОТ МОДУЛЬ. Находит в сообщении клиента названия мест из
 * справочника и отдаёт про каждое одну строку, собранную ТОЙ ЖЕ функцией, что
 * подписывает объекты на карте (`describePlace` в lib/landmarkPick.ts): область
 * плюс один узнаваемый ориентир — «46-й микрорайон, рядом Бозорчаи 46 мкрн».
 * Район приписан рядом, потому что в карточку лида он всё равно нужен, а вслух
 * бот обязан говорить ориентиром (правило «ГОВОРИ ОРИЕНТИРАМИ, А НЕ РАЙОНАМИ»).
 *
 * ПОЧЕМУ ВХОЖДЕНИЕМ, А НЕ `resolveGeoText`. Та функция (lib/geoResolve.ts) ищет
 * место по строке-запросу целиком и ранжирует типы так, что район весомее улицы.
 * На живой фразе клиента она не годится дважды: фраза — не запрос, а в адресе
 * вроде «Шохмансур, улица Дехоти» она вернула бы район, то есть ровно ту ошибку,
 * которую этот модуль чинит. Здесь нужен обратный порядок: сначала самое точное
 * (улица, ориентир), и только потом широкое.
 *
 * ЧЕГО МОДУЛЬ НЕ ДЕЛАЕТ. Не угадывает: не нашёл названия — отдаёт пустую строку,
 * и бот остаётся с прежней картой народных названий. Пустой справочник (стенд,
 * тесты) попадает сюда же.
 *
 * НАРОДНЫЕ ТОЧКИ (20.09.2026). К справочнику из базы добавляются семь названий,
 * которых в купленном слое нет, а проверенная координата нашлась (`FOLK_PINS` в
 * ai/folkPlaces.ts): «Медгородок», «Караболо», «ОВИР», «Садбарг», «Ховарон»,
 * «Сархадчиён», «Колхоз Россия». Район у них берётся не из рукописного списка, а
 * у своей же границы по точке, и ранг у них самый низкий — запись, заведённая
 * агентом в справочнике ориентиров, побеждает строчку в коде.
 */
import { prisma } from "../db.js";
import { foldTajikLetters, geoMatchKey } from "../lib/geoNormalize.js";
import { describePlace } from "../lib/landmarkPick.js";
import { readableLandmarkName } from "../lib/landmarkCategory.js";
import { districtByPoint } from "../lib/propertyDistrict.js";
import { FOLK_PINS, FOLK_PLACES } from "./folkPlaces.js";

/** Сколько мест описываем в одном ходе: клиент называет одно, редко два. */
const MAX_PLACES = 2;
/** Короткие названия в длинной фразе дают ложные совпадения — «Абай», «ДОК». */
const MIN_NAME_LENGTH = 4;
/** Справочник меняется разовым импортом — читать его на каждое сообщение незачем. */
const INDEX_TTL_MS = 5 * 60_000;

export interface IndexedPlace {
  /** Название как в справочнике — его же показываем модели. */
  name: string;
  /** Варианты написания (русский и таджикский), нормализованные. */
  needles: string[];
  lat: number;
  lng: number;
  districtName: string | null;
  /** Улица точнее микрорайона, микрорайон точнее жилого массива — при равной
   *  длине совпадения выигрывает более точный тип. */
  rank: number;
  /** Описание места словами источника — только у народных точек (FOLK_PINS).
   *  Идёт в ход, когда своя карта не нашла рядом ориентира и точка не попала ни
   *  в один район: сказать «медцентр у троллейбусного парка» честнее, чем
   *  промолчать про место, координату которого мы знаем. */
  fallbackWhere?: string;
}

let indexCache: { at: number; places: IndexedPlace[] } | null = null;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function needlesOf(...names: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    if (!n) continue;
    const normalized = geoMatchKey(n);
    if (normalized.length >= MIN_NAME_LENGTH && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

async function loadIndex(): Promise<IndexedPlace[]> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.places;
  const [streets, landmarks, microdistricts, livingAreas, aliases] = await Promise.all([
    prisma.street.findMany({ select: { id: true, name: true, nameTj: true, lat: true, lng: true, district: { select: { name: true } } } }),
    prisma.landmark.findMany({ where: { enabled: true }, select: { id: true, name: true, aliases: true, lat: true, lng: true, district: { select: { name: true } } } }),
    prisma.microdistrict.findMany({ select: { id: true, name: true, nameTj: true, lat: true, lng: true } }),
    prisma.livingArea.findMany({ select: { id: true, name: true, nameTj: true, lat: true, lng: true } }),
    // Словарь синонимов — ЕДИНСТВЕННОЕ место, где живут народные написания:
    // «82 мкр» вместо «82-й микрорайон», «Чортут» вместо латинского «Chortut»,
    // «Корвон» вместо «Рынок "Корвон"». Их пишет туда импорт слоя
    // (prisma/scripts/import-geo.ts) и ручная правка справочника, а поиск и
    // подбор (lib/geoResolve.ts) давно ищут по нему. Бот — не искал: он читал
    // только официальные названия, то есть ровно не ту форму, какой человек
    // пишет в переписке. Дома сюда не берём: их синонимы импорт не заводит.
    prisma.geoAlias.findMany({
      where: { targetType: { in: ["street", "landmark", "microdistrict", "livingArea"] } },
      select: { normalized: true, targetType: true, targetId: true },
    }),
  ]);
  const byKey = new Map<string, IndexedPlace>();
  const put = (type: string, id: string, place: IndexedPlace) => byKey.set(`${type}:${id}`, place);
  for (const s of streets) {
    put("street", s.id, {
      name: s.name,
      needles: needlesOf(s.name, s.nameTj),
      lat: Number(s.lat),
      lng: Number(s.lng),
      districtName: s.district?.name ?? null,
      rank: 3,
    });
  }
  for (const l of landmarks) {
    put("landmark", l.id, {
      // Бот называет место вслух — по-русски, если справочник знает такое имя.
      name: readableLandmarkName(l.name, l.aliases) ?? l.name,
      needles: needlesOf(l.name, ...l.aliases),
      lat: Number(l.lat),
      lng: Number(l.lng),
      districtName: l.district?.name ?? null,
      rank: 3,
    });
  }
  // Район микрорайону и жилому массиву — по точке, своей же границей (10.10.2026, аудит
  // поиска P1-4): в справочнике он у них не записан, и бот видел «82 мкр» без района.
  const areaDistrict = async (lat: number, lng: number) => (await districtByPoint(lat, lng))?.name ?? null;
  for (const m of microdistricts) {
    const lat = Number(m.lat);
    const lng = Number(m.lng);
    put("microdistrict", m.id, { name: m.name, needles: needlesOf(m.name, m.nameTj), lat, lng, districtName: await areaDistrict(lat, lng), rank: 2 });
  }
  for (const a of livingAreas) {
    const lat = Number(a.lat);
    const lng = Number(a.lng);
    put("livingArea", a.id, { name: a.name, needles: needlesOf(a.name, a.nameTj), lat, lng, districtName: await areaDistrict(lat, lng), rank: 1 });
  }
  for (const a of aliases) {
    const place = byKey.get(`${a.targetType}:${a.targetId}`);
    // Синоним выключенного ориентира ведёт в пустоту — такой записи в byKey нет.
    if (!place) continue;
    // `GeoAlias.normalized` уже пропущен через normalizeGeoText тем же импортом,
    // второй раз нормализовать нечего — но короткие всё равно отсеиваем.
    const needle = foldTajikLetters(a.normalized);
    if (needle.length >= MIN_NAME_LENGTH && !place.needles.includes(needle)) place.needles.push(needle);
  }
  // Народные названия, у которых есть проверенная точка, но нет записи в
  // купленном слое (ai/folkPlaces.ts, FOLK_PINS). Район спрашиваем у своей же
  // границы: приписывать его рядом с точкой на глаз — ровно та ошибка, с
  // которой начался весь разбор географии. Ранг 0 — ниже любого типа с карты:
  // заведи агент это место в справочнике ориентиров, и победит запись, а не
  // строчка в коде.
  for (const pin of FOLK_PINS) {
    if ([...byKey.values()].some((p) => p.name === pin.name)) continue;
    const district = await districtByPoint(pin.lat, pin.lng);
    put("folkPin", pin.name, {
      name: pin.name,
      needles: needlesOf(pin.name),
      lat: pin.lat,
      lng: pin.lng,
      districtName: district?.name ?? null,
      rank: 0,
      fallbackWhere: pin.where,
    });
  }
  const places = [...byKey.values()].filter((p) => p.needles.length > 0);
  indexCache = { at: Date.now(), places };
  return places;
}

/** Сбросить кэш справочника — для тестов и после повторного импорта слоя. */
export function resetGeoMentionIndex(): void {
  indexCache = null;
}

/** Одно слово с точностью до падежного окончания: «фабрики» — «фабрика»,
 *  «Гулдаста» — «Гулдаст». Общее начало обязано покрыть всё короткое слово,
 *  кроме двух последних букв. Короткое слово («парк», «бог») — только плюс одна
 *  буква окончания («парка»); числа (номера мкр, домов) — только целиком. */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 5) return short.length >= 3 && long.length - short.length <= 1 && long.startsWith(short);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return common >= 4 && common >= Math.min(a.length, b.length) - 2;
}

/** Все слова названия встречаются во фразе подряд, с точностью до окончания:
 *  человек говорит «у фабрики Гулдаст», в справочнике — «Фабрика Гулдаст». */
function looseMatch(needle: string, words: string[]): boolean {
  const parts = needle.split(" ");
  for (let i = 0; i + parts.length <= words.length; i++) {
    if (parts.every((p, j) => sameWord(p, words[i + j]))) return true;
  }
  return false;
}

/** Названия мест из справочника, встреченные в тексте. Длинное совпадение
 *  сильнее короткого («проезд Рудаки» важнее «Рудаки»), при равной длине —
 *  более точный тип места. `loose` — сравнивать слова с точностью до падежного
 *  окончания (узнавание объекта по звонку, identifyProperty в lib/propertyMatch.ts); реплики
 *  чат-бота идут без него, как и прежде. */
export async function placesMentioned(text: string, opts: { loose?: boolean } = {}): Promise<IndexedPlace[]> {
  const haystack = geoMatchKey(text);
  if (haystack.length < MIN_NAME_LENGTH) return [];
  const words = haystack.split(" ");
  const found: { place: IndexedPlace; length: number }[] = [];
  for (const place of await loadIndex()) {
    let matched = 0;
    for (const needle of place.needles) {
      // По границам слов: иначе «Айни» находится внутри «Айнишо», а «46» — везде.
      const hit = opts.loose
        ? looseMatch(needle, words)
        : new RegExp(`(^| )${escapeRegExp(needle)}( |$)`).test(haystack);
      if (hit) matched = Math.max(matched, needle.length);
    }
    if (matched > 0) found.push({ place, length: matched });
  }
  found.sort((a, b) => b.length - a.length || b.place.rank - a.place.rank);
  const out: IndexedPlace[] = [];
  for (const f of found) {
    // Одно и то же место под двумя именами описывать дважды незачем.
    if (out.some((p) => p.name === f.place.name)) continue;
    out.push(f.place);
    if (out.length >= MAX_PLACES) break;
  }
  return out;
}

/** Ссылка на точку на карте — ровно того вида, каким показ объекта уже шлёт
 *  геометку в WhatsApp (messengers/propertyShowcase.ts), и тот же адрес уже
 *  разрешён проверкой ссылок (ai/replyGuards.ts). Второго вида быть не должно:
 *  одна и та же вещь в переписке обязана выглядеть одинаково. */
function mapLink(lat: number, lng: number): string {
  return `https://maps.google.com/?q=${lat},${lng}`;
}

/**
 * Блок промта про места, названные клиентом. Пусто — ничего не нашли, и это
 * нормальный случай: молчание честнее выдуманного ориентира.
 *
 * `allowLinks` — тот же рубильник владельца, что гасит ссылку на карточку
 * объекта (`abilities.links`, messengers/botCapabilities.ts). Выключен — ссылки
 * на карту в блоке нет вовсе: дать модели адрес и рядом запретить его печатать
 * означает ровно ту ошибку, ради которой LINKS_DISABLED_RULE и написан.
 */
/**
 * МИКРОРАЙОН, КОТОРОГО НЕТ В ДУШАНБЕ — СПРОСИТЬ ГОРОД (Dan 03.10.2026).
 *
 * Живой случай: продавец написал «3 мик, 5 этаж», бот принял заявку «дар Сино»
 * и назвал агента, а квартира была в Худжанде — там микрорайоны с 1-го по 34-й,
 * у Душанбе свои номера. Мы принимаем только Душанбе. Dan: «надо спросить город,
 * когда что-то непонятно, чтобы не ошибаться».
 *
 * Номер микрорайона, которого не знает ни карта города, ни список народных
 * названий, — повод один раз спросить город, а не угадывать район.
 */
const MKR_NUMBER =
  /(?<![\p{L}\p{N}])(\d{1,3})\s*-?\s*(?:й|ой|ум|юм|ом)?\s*(?:мкр|мик)[\p{L}.]*|(?<![\p{L}])(?:мкр|мик)[\p{L}.]*\s*№?\s*(\d{1,3})(?![\p{N}])/giu;
const DUSHANBE_NAMED = /душанбе|dushanbe|душанбеи/iu;

export function microdistrictNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(MKR_NUMBER)) {
    const n = Number(m[1] ?? m[2]);
    if (Number.isFinite(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Номера микрорайонов Душанбе из народного списка («82 мкр» и т.п.). */
const FOLK_MKR = new Set(
  FOLK_PLACES.map((p) => p.name.match(/^(\d{1,3})\s*мкр/u)?.[1]).filter((n): n is string => !!n).map(Number)
);

export async function unknownMicrodistrictRule(text: string): Promise<string> {
  if (DUSHANBE_NAMED.test(text)) return "";
  const numbers = microdistrictNumbers(text);
  if (numbers.length === 0) return "";
  const index = await loadIndex();
  const known = (n: number) =>
    FOLK_MKR.has(n) || index.some((p) => p.rank === 2 && p.needles.some((needle) => new RegExp(`(^| )${n}( |$)`).test(needle)));
  const unknown = numbers.filter((n) => !known(n));
  if (unknown.length === 0) return "";
  const list = unknown.map((n) => `«${n} мкр»`).join(", ");
  return (
    `\n\nГОРОД НЕ ЯСЕН: ${list} — такого микрорайона в Душанбе мы не знаем (такие номера есть в Худжанде ` +
    "и других городах). Прежде чем принимать заявку или называть район, спроси ОДНИМ коротким вопросом, " +
    "в каком городе квартира (по-таджикски: «Хона дар кадом шаҳр аст?»). Район и «Сино» не придумывай. " +
    "Если окажется не Душанбе — поступай по правилу про другой город."
  );
}

export async function geoMentionBlock(text: string, allowLinks = true): Promise<string> {
  const cityRule = await unknownMicrodistrictRule(text).catch(() => "");
  // С точностью до падежа (10.10.2026, аудит поиска P1-4): «в Зарафшоне», «возле
  // Корвона», «на Испечаке» точным вхождением не узнавались вовсе.
  const places = await placesMentioned(text, { loose: true });
  if (places.length === 0) return cityRule;
  const lines: string[] = [];
  for (const place of places) {
    const described = await describePlace(place.lat, place.lng);
    const where = described.text || place.districtName || place.fallbackWhere || "";
    if (!where) continue;
    const link = allowLinks ? `, карта: ${mapLink(place.lat, place.lng)}` : "";
    lines.push(`- ${place.name} — ${where}${place.districtName ? ` (район ${place.districtName})` : ""}${link}`);
  }
  if (lines.length === 0) return cityRule;
  return (
    cityRule +
    "\n\nМЕСТА, НАЗВАННЫЕ КЛИЕНТОМ, ПО КАРТЕ ГОРОДА (это точные данные, не догадка — " +
    "отвечай про них ОТСЮДА и ничего не придумывай; если раньше в этом разговоре ты " +
    "сказал про это место иначе, верным считается написанное здесь):\n" +
    lines.join("\n") +
    "\nВслух называй ОРИЕНТИР («наздики Бозорчаи 46 мкр»), район — только если клиент спросил именно про район." +
    (allowLinks
      ? "\nСпросил «это где?», «дар кучо?» — после ориентира дай ссылку на карту ОТСЮДА последней строкой, " +
        "как есть и без подписи. Своих ссылок на карты не сочиняй: если её тут нет, обойдись ориентиром."
      : "")
  );
}
