/**
 * РАЙОН ОБЪЕКТА ОПРЕДЕЛЯЕТ КАРТА, А НЕ ПОДСКАЗКА «БЛИЖАЙШИЙ ИЗ ЧЕТЫРЁХ»
 * (20.09.2026).
 *
 * ЖИВОЙ СЛУЧАЙ. Карточка ОБ-000109: «Шохмансур, улица Дехоти, 8». Улица Дехоти
 * лежит в Фирдавси — это видно и по справочнику улиц (`Street.districtId`), и по
 * границе района (`District.boundary`), обе таблицы в базе с 12.09.2026. Район
 * тем не менее записан чужой, и цена ошибки не косметическая:
 *   — бот читает адреса наших объектов как «район здесь известен ТОЧНО»
 *     (`ai/dushanbeGeography.ts::propertyGeographyBlock`) и повторяет ошибку
 *     клиенту: «ин хона дар кӯчаи Деҳотӣ, 8 (районы Шоҳмансур)»;
 *   — подборка фильтруется по району (`ai/leadQualifier.ts`), и объект не
 *     находится тому, кто ищет в правильном;
 *   — неверный район уходит на публичную страницу сайта в заголовок объявления.
 *
 * ОТКУДА ОШИБКА. Мастер объекта подсказывал район, сравнивая точку с ЧЕТЫРЬМЯ
 * вбитыми в код «центрами» районов (`apps/web/src/lib/districtCoords.ts`) и беря
 * ближайший. Для Дехоти, 8 (38.5334, 68.7558) ближайшим по этому счёту выходит
 * «центр» Шохмансура — сами эти четыре точки выставлены на глаз и к настоящим
 * границам отношения не имеют. Агент соглашался с подсказкой, и больше район
 * никто не проверял: сервер определял его по полигону только когда поле пустое.
 *
 * ЧТО ТЕПЕРЬ. Этот модуль — единственное место, где район выводится из карты, и
 * его ответ сильнее присланного формой:
 *   1. есть координаты и точка ВНУТРИ границы района — берём его. Это факт, а не
 *      догадка, поэтому и перебивает выбор человека (план блока H прямо просил
 *      «район всегда по полигону, агент его не выбирает»);
 *   2. координат нет — ищем в адресе название улицы из справочника. Отвечаем,
 *      только если найденная улица одна и район у неё в источнике однозначен
 *      (`Street.districtId` заполнен: у 19 улиц города он null, они лежат сразу
 *      в нескольких районах — там молчим);
 *   3. ничего из этого не сошлось — null, и остаётся то, что выбрал человек.
 *      Пустая база справочника (стенд, тесты) попадает сюда же и ничего не ломает.
 */
import { prisma } from "../db.js";
import { isPointInPolygon, parseWktPolygonRing } from "./geo.js";
import { geoMatchKey, plainStreetQuery } from "./geoNormalize.js";

/** Вид улицы в адресе на русском, таджикском и латиницей — после geoMatchKey. */
const STREET_KIND_WORDS = "улица|ул|проспект|пр|проезд|переулок|пер|кучаи|куча|хиебони|гузаргохи";

export interface MapDistrict {
  id: string;
  name: string;
  /** Чем именно определён район — уходит в журнал и в объяснение агенту. */
  source: "point" | "street";
  /** Улица справочника, по которой определён район (source: "street"). */
  street?: string;
}


/**
 * СПРАВОЧНИК ЧИТАЕТСЯ НЕ НА КАЖДОЕ СОХРАНЕНИЕ. Улиц 920, районов 4, меняются они
 * разовым импортом (prisma/scripts/import-geo.ts), а спрашивают их и каждое
 * сохранение карточки, и сверка всей базы одним проходом (prisma/scripts/
 * check-property-districts.ts) — без этого кэша сверка превратилась бы в N+1 по
 * числу объектов. Минута — потолок, за который правка справочника доедет сама.
 */
const REFERENCE_TTL_MS = 60_000;

type DistrictRow = { id: string; name: string; boundary: string | null };
type StreetRow = { name: string; nameTj: string | null; district: { id: string; name: string } | null };

let districtsCache: { at: number; rows: DistrictRow[] } | null = null;
let streetsCache: { at: number; rows: StreetRow[] } | null = null;

async function loadDistricts(): Promise<DistrictRow[]> {
  if (districtsCache && Date.now() - districtsCache.at < REFERENCE_TTL_MS) return districtsCache.rows;
  const rows = await prisma.district.findMany({ select: { id: true, name: true, boundary: true } });
  districtsCache = { at: Date.now(), rows };
  return rows;
}

async function loadStreets(): Promise<StreetRow[]> {
  if (streetsCache && Date.now() - streetsCache.at < REFERENCE_TTL_MS) return streetsCache.rows;
  const rows = await prisma.street.findMany({
    where: { districtId: { not: null } },
    select: { name: true, nameTj: true, district: { select: { id: true, name: true } } },
  });
  streetsCache = { at: Date.now(), rows };
  return rows;
}

/** Сбросить кэш справочника — для тестов и для скрипта сверки после правки данных. */
export function resetDistrictReferenceCache(): void {
  districtsCache = null;
  streetsCache = null;
}

/**
 * Район по точке — ТОЛЬКО попаданием в границу.
 *
 * Здесь нет запасного «ближайший центр района», который есть у lookupGeoPoint
 * (lib/geoLookup.ts): там он уместен, потому что отвечает на вопрос «что это за
 * место» и пустой ответ хуже приблизительного. Здесь ответ ПЕРЕБИВАЕТ выбор
 * живого человека, и приблизительного основания для этого мало — именно
 * приблизительная подсказка и завела ошибку, которую этот модуль чинит.
 */
export async function districtByPoint(lat: number, lng: number): Promise<MapDistrict | null> {
  const districts = await loadDistricts();
  for (const d of districts) {
    if (!d.boundary) continue;
    const ring = parseWktPolygonRing(d.boundary);
    if (ring && isPointInPolygon(lng, lat, ring)) return { id: d.id, name: d.name, source: "point" };
  }
  return null;
}

/**
 * Район по названию улицы в адресе.
 *
 * Сравниваем вхождением нормализованного названия улицы в нормализованный адрес,
 * а не разбором адреса на части: агенты пишут адрес живым языком и в любом
 * порядке («Шохмансур, улица Дехоти, 8», «кучаи Дехоти 8», «Дехоти 8/2»), и
 * разбор по запятым ломается на первом же непривычном написании. Улиц в городе
 * 920 — прочитать их все дешевле, чем угадывать формат строки.
 *
 * Берём САМОЕ ДЛИННОЕ совпадение: «улица Айни» и «проезд Айни» обе попадут в
 * адрес «проезд Айни, 4», и правильная из них — длинная. Если самых длинных
 * несколько и районы у них разные — молчим, угадывать тут нечего.
 */
export async function districtByAddress(address: string): Promise<MapDistrict | null> {
  // Обе стороны — со свёрнутыми таджикскими буквами (28.09.2026): «кучаи Дехоти 8»
  // против «кӯчаи деҳотӣ» из справочника иначе не совпадало ни с одним написанием.
  const haystack = geoMatchKey(address);
  if (!haystack) return null;
  const streets = await loadStreets();

  let best: { length: number; matches: MapDistrict[] } | null = null;
  for (const s of streets) {
    if (!s.district) continue;
    for (const raw of [s.name, s.nameTj]) {
      if (!raw) continue;
      const needle = geoMatchKey(raw);
      // Короткие названия («Абай») в длинном адресе дают ложные совпадения по
      // куску слова, поэтому ищем по границам слов, а не подстрокой.
      const full = new RegExp(`(^| )${escapeRegExp(needle)}( |$)`);
      // Имя улицы без вида («дехоти» из «улица дехоти») — так пишут чаще всего
      // («кучаи Дехоти 8», «Дехоти 8/2»). Голое имя берём, только когда за ним
      // номер дома или перед ним вид улицы на любом языке: иначе «Сино» в
      // адресе приняли бы за улицу Сино.
      const bare = plainStreetQuery(needle);
      const byBareName =
        bare !== needle &&
        bare.length >= 4 &&
        new RegExp(`(^| )(?:(?:${STREET_KIND_WORDS}) ${escapeRegExp(bare)}( |$)|${escapeRegExp(bare)} \\d)`).test(haystack);
      if (needle.length < 4) continue;
      // Длина — того, что совпало: голое «айни» у «улицы Айни» и «проезда Айни»
      // равны, и при разных районах ниже честно получится «не знаю».
      const length = full.test(haystack) ? needle.length : byBareName ? bare.length : 0;
      if (!length) continue;
      const found: MapDistrict = { id: s.district.id, name: s.district.name, source: "street", street: s.name };
      if (!best || length > best.length) best = { length, matches: [found] };
      else if (length === best.length) best.matches.push(found);
    }
  }
  if (!best) return null;
  const ids = new Set(best.matches.map((m) => m.id));
  return ids.size === 1 ? best.matches[0] : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Что о районе объекта говорит карта. null — карта молчит, решает человек.
 *
 * Адрес спрашиваем только когда координат нет вовсе: точка точнее текста, а два
 * ответа подряд по одному объекту — лишний запрос к справочнику улиц на каждое
 * сохранение карточки.
 */
export async function districtFromMap(input: {
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
}): Promise<MapDistrict | null> {
  if (input.lat != null && input.lng != null) {
    const byPoint = await districtByPoint(Number(input.lat), Number(input.lng));
    if (byPoint) return byPoint;
  }
  const address = input.address?.trim();
  return address ? districtByAddress(address) : null;
}
