/**
 * ЕДИНАЯ ТОЧКА ВХОДА «ТЕКСТ → МЕСТО НА КАРТЕ» (12.09.2026, дополнение владельца
 * к блоку B, docs/geo-match-plan-12-09.md): бот и подбор обязаны спрашивать
 * ОДНУ функцию, а не заводить каждый свой разбор текста — иначе они будут
 * знать разные написания одного и того же места, ровно как уже разъехались
 * площадь/этаж в двух копиях фильтра подбора (план, раздел D4).
 *
 * Три слоя, по возрастанию цены и убыванию уверенности:
 *   1. точное совпадение по GeoAlias.normalized;
 *   2. префиксное (человек мог не дописать слово — «82 микрорай» вместо
 *      «82 микрорайон»);
 *   3. нечёткое через pg_trgm (тот же порог similarity, что у обычного
 *      поиска, `FUZZY_SIMILARITY_THRESHOLD` из lib/fuzzySearch.ts — техника
 *      SET LOCAL threshold та же, что там, код не переиспользован напрямую,
 *      потому что helper там приватный, а константа — переиспользована).
 *
 * РАНЖИРОВАНИЕ ПРИ НЕСКОЛЬКИХ СОВПАДЕНИЯХ (12.09.2026, доработка после живых
 * примеров поломки — «рудаки» уводил в «3-й проезд Рудаки» вместо проспекта,
 * «корвон» уводил на улицу с тем же словом в скобках вместо рынка). Внутри
 * тира, где вообще нашлось хоть одно совпадение (следующий тир не трогаем —
 * то же правило «сначала точное, потом префикс, потом нечёткое», что было),
 * собираются ВСЕ кандидаты (а не первый попавшийся) и сортируются по цепочке
 * весов, где каждый следующий уровень решает только когда предыдущий не
 * различил — см. `compareCandidates`:
 *
 *   1. вес типа объекта (`TYPE_WEIGHT`) — район > микрорайон > ориентир >
 *      улица > жилой массив;
 *   2. только для улиц — `Street.kind` (`STREET_KIND_WEIGHT`) и
 *      `Street.housesCount`: проспект с полусотней домов важнее переулка
 *      с тремя;
 *   3. точность совпадения (`PRECISION_WEIGHT`) — совпадение с полным
 *      названием цели весомее совпадения с синонимом (то же «точное» по
 *      тексту, но не то, как называется место официально);
 *   4. «значимость» при равенстве всего остального — у ориентиров это
 *      категория (`LANDMARK_CATEGORY_WEIGHT`): рынок/вокзал/вуз/ТЦ важнее
 *      памятника или хостела.
 *
 * Все веса — константы ниже, подобраны на глаз (владелец, план, раздел
 * «Данные для него уже есть») и будут уточняться по обратной связи агентов,
 * это не измеренные величины.
 *
 * Функция возвращает лучшее совпадение и до `MAX_ALTERNATIVES` следующих по
 * рангу — бот может переспросить («вы про проспект или про проезд?»), а
 * интерфейс показать варианты. Ничего не нашлось на всех трёх тирах —
 * возвращает null и не угадывает: вызывающий код сам решает, что делать с
 * пустым ответом (для бота это обычно задача агенту «отметь на карте», план,
 * блок C).
 */
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { normalizeGeoText, plainStreetQuery } from "./geoNormalize.js";
import { landmarkCategoryKey, readableLandmarkName } from "./landmarkCategory.js";
import { FUZZY_SIMILARITY_THRESHOLD } from "./fuzzySearch.js";

export type GeoTargetType = "building" | "street" | "microdistrict" | "livingArea" | "landmark" | "district";

/** Как именно совпал текст запроса с этим кандидатом — см. докстринг файла,
 *  пункт 3 ранжирования. `fullName`/`synonym` оба относятся к тиру «exact»
 *  (строка совпала буква-в-букву с нормализованным алиасом), различаются
 *  только тем, является ли совпавший алиас официальным названием цели. */
export type MatchPrecision = "fullName" | "synonym" | "prefix" | "fuzzy";

export interface GeoResolveCandidate {
  targetType: GeoTargetType;
  targetId: string;
  /** Каноническое имя цели (не сам текст запроса и не найденный синоним). */
  name: string;
  lat: number;
  lng: number;
  /** Радиус по умолчанию для этого типа места, метры — см. DEFAULT_RADIUS_BY_TYPE. */
  radiusM: number;
  precision: MatchPrecision;
}

export interface GeoResolveResult extends GeoResolveCandidate {
  /** Каким слоем нашли — для отладки и для будущей настройки весов подбора.
   *  Огрублённая версия `precision`: fullName/synonym оба дают "exact". */
  confidence: "exact" | "prefix" | "fuzzy";
  /** Следующие по рангу варианты того же тира, до MAX_ALTERNATIVES штук — для
   *  переспроса бота («вы про проспект Рудаки или про 3-й проезд?») и для
   *  показа вариантов в интерфейсе. */
  alternatives: GeoResolveCandidate[];
}

/** Сколько альтернатив возвращать сверх лучшего совпадения — план просит 3-5. */
const MAX_ALTERNATIVES = 4;

/** Потолок кандидатов, обрабатываемых на одном тире (предел выборки —
 *  обязателен на любом запросе, отдающем массив, правило CLAUDE.md). На живых
 *  данных 12.09.2026 самый спорный алиас («джавонон» — короткие проезды с
 *  общим корнем в названии) собирает 25 разных улиц на одну нормализованную
 *  строку; лимит с запасом, чтобы ранжирование видело всех кандидатов, а не
 *  произвольную часть (запрос без ORDER BY по значимости — Postgres не
 *  гарантирует, что «нужные» 20 из 25 попадут в срез). */
const CANDIDATE_LIMIT = 50;
/** Потолок для ОДНОГО запроса домов — resolveHouseNumber ниже (22.09.2026,
 *  сведение N+1): раньше запрос к Building уходил на КАЖДОГО из до
 *  CANDIDATE_LIMIT кандидатов улицы отдельно (до 50 запросов на один ввод
 *  адреса). Теперь запрос один, но сужение по улицам осталось В SQL (OR по
 *  ключевым словам кандидатов) — брать все дома с этим номером по городу и
 *  фильтровать в памяти нельзя: `take` без ORDER BY даёт произвольный срез, и
 *  нужный дом в него может не попасть (живой случай 14.09 — 242 дома с номером
 *  «2»). Потолок с запасом на все кандидаты улицы разом. */
const BUILDING_HOUSE_NUMBER_LIMIT = CANDIDATE_LIMIT * 20;

/**
 * Радиус по умолчанию для «объект в N м от места» по типу места by default,
 * когда конкретный клиент/запрос не задаёт свой. Числа подобраны на глаз
 * (владелец, 12.09.2026) и будут уточняться по обратной связи агентов —
 * это не измеренная константа, а стартовая точка.
 */
export const DEFAULT_RADIUS_BY_TYPE: Record<GeoTargetType, number> = {
  landmark: 400,
  microdistrict: 1000,
  livingArea: 800,
  street: 600,
  district: 3000,
  // Дом ищется по улице и номеру, а не через словарь синонимов (см.
  // import-geo.ts — для домов алиасы не генерируются), радиус здесь только
  // для полноты типа и на случай прямого резолва конкретного дома.
  building: 150,
};

/** Вес типа объекта при ранжировании — см. докстринг файла, пункт 1. Подобран
 *  на глаз, будет уточняться. Здание не участвует в поиске по алиасам (для
 *  домов синонимы не генерируются), вес указан для полноты типа. */
const TYPE_WEIGHT: Record<GeoTargetType, number> = {
  district: 50,
  microdistrict: 40,
  landmark: 30,
  street: 20,
  livingArea: 10,
  building: 0,
};

/**
 * ПОПРАВКА НА ЖИВЫХ ДАННЫХ (12.09.2026): «ориентир всегда весомее улицы» без
 * оговорок ломается на живом справочнике — в купленных данных есть отдельный
 * памятник, буквально названный «Рудаки» (`osm-node-2527889129`, категория
 * «Памятник»), и без этой поправки он побеждал бы «проспект Рудаки» просто
 * потому что «ориентир» весит больше «улицы», хотя задача прямо требует
 * обратного («рудаки» → проспект, а не переулок/памятник).
 *
 * Формулировка задачи сама подсказывает выход: пункт про вес типа говорит про
 * «ориентир-РЫНОК» отдельно, а пункт про значимость прямо называет памятник
 * менее значимым, чем базар/ТЦ/вокзал/вуз. Поэтому значимость категории
 * (см. LANDMARK_CATEGORY_WEIGHT ниже) не только тай-брейк между двумя
 * ориентирами (дальше по цепочке), но и модификатор веса типа для ориентиров:
 * крупный/известный ориентир (рынок, вокзал, вуз) остаётся весомее улицы,
 * малозначимый (памятник, хостел) — нет и проигрывает даже обычной улице.
 * Формула ниже подобрана так, чтобы «Базар/Вокзал/Аэропорт» и «ТЦ/Вуз»
 * оставались уверенно выше улицы, обычные категории (школа, больница,
 * мечеть...) — тоже выше, а «Памятник/Хостел» — ниже. Категория без записи в
 * таблице (значимость по умолчанию 1) даёт ровно вес улицы — тогда решает уже
 * точность совпадения (пункт 3), а не тип, что и разумно для неизвестной
 * категории.
 */
function effectiveTypeWeight(targetType: GeoTargetType, landmarkCategory?: string): number {
  const base = TYPE_WEIGHT[targetType];
  if (targetType !== "landmark") return base;
  // Категория справочника пишется как в источнике («ВУЗ», «Торговый центр») —
  // ключ таблицы берётся общим правилом, см. landmarkCategory.ts.
  const category = landmarkCategoryKey(landmarkCategory ?? "", LANDMARK_CATEGORY_WEIGHT);
  const significanceWeight = LANDMARK_CATEGORY_WEIGHT[category] ?? DEFAULT_LANDMARK_CATEGORY_WEIGHT;
  return base + (significanceWeight * 5 - 15);
}

/** Вес вида улицы — см. докстринг файла, пункт 2. Подобран на глаз. */
const STREET_KIND_WEIGHT: Record<string, number> = {
  "проспект": 5,
  "улица": 4,
  "жилая улица": 3,
  "проезд": 2,
  "переулок": 1,
};

/** Вес точности совпадения — см. докстринг файла, пункт 3. */
const PRECISION_WEIGHT: Record<MatchPrecision, number> = {
  fullName: 3,
  synonym: 2,
  prefix: 1,
  fuzzy: 0,
};

/**
 * Вес категории ориентира — см. докстринг файла, пункт 4. Подобран на глаз по
 * заказу владельца («базар, ТЦ, вокзал, вуз важнее памятника и хостела»),
 * категории не из списка (в источнике их 46, см. import-geo.ts) получают
 * средний вес по умолчанию, а не ноль — редкая/неучтённая категория не должна
 * автоматически проигрывать даже памятнику.
 */
const LANDMARK_CATEGORY_WEIGHT: Record<string, number> = {
  "Базар": 6,
  "Вокзал": 6,
  "Аэропорт": 6,
  "Автовокзал": 6,
  "ТЦ": 5,
  "Вуз": 5,
  "Больница": 4,
  "Госучреждение": 4,
  "Стадион": 3,
  "Мечеть": 3,
  "Церковь": 3,
  "Школа": 3,
  "Гостиница": 2,
  "Театр": 2,
  "Парк": 2,
  "Памятник": 0,
  "Хостел": 0,
};
const DEFAULT_LANDMARK_CATEGORY_WEIGHT = 1;

interface AliasRow {
  targetType: string;
  targetId: string;
  normalized: string;
}

export interface PlaceInfo {
  name: string;
  lat: number;
  lng: number;
  /** Только у улиц: kind. */
  streetKind?: string;
  /** Только у улиц: housesCount. */
  streetHousesCount?: number;
  /** Только у ориентиров: category. */
  landmarkCategory?: string;
}

interface Candidate extends PlaceInfo {
  targetType: GeoTargetType;
  targetId: string;
  precision: MatchPrecision;
}

async function findExactAll(normalized: string): Promise<AliasRow[]> {
  return prisma.geoAlias.findMany({
    where: { normalized },
    select: { targetType: true, targetId: true, normalized: true },
    take: CANDIDATE_LIMIT,
  });
}

async function findPrefixAll(normalized: string): Promise<AliasRow[]> {
  return prisma.geoAlias.findMany({
    where: { normalized: { startsWith: normalized } },
    orderBy: { normalized: "asc" },
    select: { targetType: true, targetId: true, normalized: true },
    take: CANDIDATE_LIMIT,
  });
}

/** То же по технике, что fuzzyIds в lib/fuzzySearch.ts (SET LOCAL порог перед
 *  запросом, потому что pg_trgm.word_similarity_threshold — настройка сессии,
 *  а не аргумент функции) — здесь своя копия, потому что тот helper приватный. */
async function findFuzzyAll(normalized: string): Promise<AliasRow[]> {
  const threshold = Prisma.raw(String(FUZZY_SIMILARITY_THRESHOLD));
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SET LOCAL pg_trgm.word_similarity_threshold = ${threshold}`);
    return tx.$queryRaw<AliasRow[]>(Prisma.sql`
      SELECT "targetType", "targetId", "normalized" FROM "GeoAlias"
      WHERE "normalized" %> ${normalized}
      ORDER BY similarity("normalized", ${normalized}) DESC
      LIMIT ${CANDIDATE_LIMIT}
    `);
  });
}

/** Экспортирована для `lib/geoSuggest.ts` — подсказка при вводе текстом
 *  грузит те же места по тем же id, второй загрузчик заводить незачем. */
export async function loadGeoPlace(targetType: string, targetId: string): Promise<PlaceInfo | null> {
  switch (targetType) {
    case "building": {
      const b = await prisma.building.findUnique({ where: { id: targetId } });
      if (!b) return null;
      const label = [b.street, b.houseNumber].filter(Boolean).join(", ") || b.microdistrict || b.livingArea || "дом";
      return { name: label, lat: Number(b.lat), lng: Number(b.lng) };
    }
    case "street": {
      const s = await prisma.street.findUnique({ where: { id: targetId } });
      if (!s) return null;
      return { name: s.name, lat: Number(s.lat), lng: Number(s.lng), streetKind: s.kind, streetHousesCount: s.housesCount };
    }
    case "microdistrict": {
      const m = await prisma.microdistrict.findUnique({ where: { id: targetId } });
      return m ? { name: m.name, lat: Number(m.lat), lng: Number(m.lng) } : null;
    }
    case "livingArea": {
      const l = await prisma.livingArea.findUnique({ where: { id: targetId } });
      return l ? { name: l.name, lat: Number(l.lat), lng: Number(l.lng) } : null;
    }
    case "landmark": {
      const lm = await prisma.landmark.findUnique({ where: { id: targetId } });
      // Скрытые ориентиры (enabled=false, блок J докстринга Landmark в
      // schema.prisma) не участвуют в поиске: не удаляем этот файл, но здесь
      // достаточно вернуть null, как и на отсутствующую запись — resolveGeoText
      // не отличает «не нашлось» от «нашлось, но скрыто».
      return lm && lm.enabled
        ? {
            // Подпись в подсказках поиска и адрес, который мастер объекта
            // ставит по выбранному ориентиру, — по-русски, если справочник
            // знает такое имя («Bozori Kabir» → «Бозори Кабир»).
            name: readableLandmarkName(lm.name, lm.aliases) ?? lm.name,
            lat: Number(lm.lat),
            lng: Number(lm.lng),
            landmarkCategory: lm.category,
          }
        : null;
    }
    case "district": {
      const d = await prisma.district.findUnique({ where: { id: targetId } });
      if (!d || d.lat == null || d.lng == null) return null;
      return { name: d.name, lat: Number(d.lat), lng: Number(d.lng) };
    }
    default:
      return null;
  }
}

function streetInternalWeight(c: Candidate): number {
  if (c.targetType !== "street") return 0;
  const kindWeight = STREET_KIND_WEIGHT[c.streetKind ?? ""] ?? 0;
  // Вид улицы решает первым (разрыв 1000 перекрывает почти любой разумный
  // housesCount), число домов — тай-брейк внутри одного вида и подстраховка,
  // когда вид не распознан (kindWeight = 0 у обоих).
  return kindWeight * 1000 + (c.streetHousesCount ?? 0);
}

function significance(c: Candidate): number {
  if (c.targetType !== "landmark") return 0;
  return LANDMARK_CATEGORY_WEIGHT[c.landmarkCategory ?? ""] ?? DEFAULT_LANDMARK_CATEGORY_WEIGHT;
}

/** Сортировка «лучший — первым»: см. докстринг файла, порядок пунктов 1-4.
 *  Экспортирована ради юнит-теста весов без обращения к базе. */
export function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    (effectiveTypeWeight(b.targetType, b.landmarkCategory) - effectiveTypeWeight(a.targetType, a.landmarkCategory)) ||
    (streetInternalWeight(b) - streetInternalWeight(a)) ||
    (PRECISION_WEIGHT[b.precision] - PRECISION_WEIGHT[a.precision]) ||
    (significance(b) - significance(a))
  );
}

function toResolveCandidate(c: Candidate): GeoResolveCandidate {
  return {
    targetType: c.targetType,
    targetId: c.targetId,
    name: c.name,
    lat: c.lat,
    lng: c.lng,
    radiusM: DEFAULT_RADIUS_BY_TYPE[c.targetType] ?? 1000,
    precision: c.precision,
  };
}

function confidenceOf(precision: MatchPrecision): GeoResolveResult["confidence"] {
  if (precision === "fullName" || precision === "synonym") return "exact";
  return precision;
}

/**
 * Кандидаты одного тира → загруженные места, с дедупликацией по цели (одна и
 * та же цель не должна попасть в выдачу дважды, даже если совпало несколько
 * её алиасов — актуально для префиксного и нечёткого тиров, где алиасы одной
 * цели не гарантированно уникальны по совпавшей строке).
 */
async function resolveTier(rows: AliasRow[], tierPrecision: "prefix" | "fuzzy" | "exact-raw"): Promise<Candidate[]> {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const row of rows) {
    const key = `${row.targetType}:${row.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const place = await loadGeoPlace(row.targetType, row.targetId);
    if (!place) continue;
    const targetType = row.targetType as GeoTargetType;
    let precision: MatchPrecision;
    if (tierPrecision === "exact-raw") {
      // Полное имя цели совпало буква-в-букву с запросом — весомее, чем
      // синоним, который тоже совпал точно, но не является официальным
      // названием (см. докстринг файла, пункт 3).
      precision = normalizeGeoText(place.name) === row.normalized ? "fullName" : "synonym";
    } else {
      precision = tierPrecision;
    }
    out.push({ ...place, targetType, targetId: row.targetId, precision });
  }
  return out;
}

/** Номер дома в конце запроса — «рудаки 45», «рудаки, 45а». Один токен, цифры
 *  плюс необязательная одна буква литеры; составные номера через «/»
 *  («12/3») сюда не попадают (после normalizeGeoText «/» уже пробел, второй
 *  токен «3» выглядел бы отдельным словом улицы) — осознанное упрощение,
 *  такие адреса просто не получают точного дома и падают в обычный тир
 *  «улица целиком», как и раньше. */
const HOUSE_NUMBER_RE = /^\d+[a-zа-яё]?$/i;

/** Кандидаты-улицы того же тира (exact/prefix/fuzzy), что и обычный резолв, но
 *  БЕЗ выхода за пределы typeType==="street" — номер дома бессмыслен для
 *  ориентира/района/микрорайона. */
async function resolveStreetCandidates(normalizedStreetPart: string): Promise<Candidate[]> {
  const exactRows = (await findExactAll(normalizedStreetPart)).filter((r) => r.targetType === "street");
  if (exactRows.length > 0) return resolveTier(exactRows, "exact-raw");
  const prefixRows = (await findPrefixAll(normalizedStreetPart)).filter((r) => r.targetType === "street");
  if (prefixRows.length > 0) return resolveTier(prefixRows, "prefix");
  const fuzzyRows = (await findFuzzyAll(normalizedStreetPart)).filter((r) => r.targetType === "street");
  if (fuzzyRows.length > 0) return resolveTier(fuzzyRows, "fuzzy");
  return [];
}

/**
 * «Улица + номер» → точный дом (14.09.2026, дизайн-проход по карте: обычный
 * текстовый поиск матчит только название улицы и отдаёт её ЦЕНТР —
 * `Street.lat/lng`, одна точка на весь проспект в несколько километров.
 * Агент, заводящий объект БЕЗ геометки с фото (см. `docs/TASKS.md`, «мастер
 * объекта с координатой из фото» ждёт PR #293), вводит СВОЙ домашний/рабочий
 * адрес целиком — и улетал на другой конец улицы. Для домов алиасы не
 * генерируются (`import-geo.ts`), поэтому номер приходится сопоставлять
 * здесь, а не через словарь синонимов: находим лучшую улицу по тем же трём
 * тирам, что и обычный поиск, затем ищем `Building` с тем же номером, чья
 * запись `street` (из `дома.json`, СВОЙ текст, не гарантированно совпадающий
 * дословно с `Street.name` из `улицы.json` — разные исходные колонки одного
 * источника) нормализуется в подстроку названия найденной улицы или наоборот.
 * Ничего не нашлось — вызывающий код падает на обычный поиск по улице целиком,
 * не хуже, чем было. */
async function resolveHouseNumber(normalized: string): Promise<Candidate | null> {
  const words = normalized.split(" ");
  const last = words[words.length - 1];
  if (!last || !HOUSE_NUMBER_RE.test(last)) return null;
  const streetPart = words.slice(0, -1).join(" ").trim();
  if (!streetPart) return null;

  const streetCandidates = await resolveStreetCandidates(streetPart);
  if (streetCandidates.length === 0) return null;
  streetCandidates.sort(compareCandidates);

  const houseNumber = last;
  // ОДИН запрос на ВСЮ пачку кандидатов улицы (22.09.2026, сведение N+1) —
  // раньше на каждого из до CANDIDATE_LIMIT кандидатов уходил свой
  // `prisma.building.findMany`, до 50 запросов на один ввод адреса. Сужение по
  // улице осталось в SQL, только теперь одним OR по ключевым словам всех
  // кандидатов сразу, а не отдельным запросом на каждого: иначе `take` без
  // ORDER BY брал бы произвольный срез домов с этим номером по всему городу и
  // нужный дом мог в него не попасть (живой случай 14.09, «рудаки 2»).
  const streetKeywordByCandidate = streetCandidates.map((street) => {
    const words = normalizeGeoText(street.name).split(" ").filter(Boolean);
    return words[words.length - 1] ?? "";
  });
  const uniqueStreetKeywords = [...new Set(streetKeywordByCandidate.filter(Boolean))];
  const allBuildingsByNumber = await prisma.building.findMany({
    where: {
      houseNumber: { equals: houseNumber, mode: "insensitive" },
      ...(uniqueStreetKeywords.length
        ? { OR: uniqueStreetKeywords.map((kw) => ({ street: { contains: kw, mode: "insensitive" as const } })) }
        : { street: { not: null } }),
    },
    select: { id: true, street: true, houseNumber: true, lat: true, lng: true },
    take: BUILDING_HOUSE_NUMBER_LIMIT,
  });
  for (const street of streetCandidates) {
    const streetNameNorm = normalizeGeoText(street.name);
    // Частый номер дома («2», «10») сам по себе встречается по городу сотнями
    // раз (242 дома с номером «2» на живых данных 14.09) — без сужения по
    // улице нужный дом было бы труднее выбрать среди однофамильцев. Последнее
    // слово названия улицы — как правило, и есть отличающее собственное имя
    // («рудаки» из «проспект рудаки», «джураева» из «1-й проезд кандила
    // джураева») — сужаем им список В ПАМЯТИ, тем же приёмом, что раньше был
    // в SQL-фильтре `contains`.
    const streetWords = streetNameNorm.split(" ").filter(Boolean);
    const streetKeyword = streetWords[streetWords.length - 1];
    const buildings = streetKeyword
      ? allBuildingsByNumber.filter((b) => normalizeGeoText(b.street ?? "").includes(streetKeyword))
      : allBuildingsByNumber;
    const match = buildings.find((b) => {
      const buildingStreetNorm = normalizeGeoText(b.street ?? "");
      return (
        buildingStreetNorm.length > 0 &&
        (streetNameNorm.includes(buildingStreetNorm) || buildingStreetNorm.includes(streetNameNorm))
      );
    });
    if (match) {
      return {
        targetType: "building",
        targetId: match.id,
        name: `${street.name}, ${match.houseNumber}`,
        lat: Number(match.lat),
        lng: Number(match.lng),
        precision: street.precision,
      };
    }
  }
  return null;
}

/**
 * Только точный дом справочника по «улица + номер» — для геокодера адреса
 * объекта (lib/geocode.ts, 24.09.2026). В отличие от resolveGeoText не падает
 * на «улицу целиком»: центр проспекта — не точка дома, для карточки объекта
 * это хуже честного «не нашли» (дальше спросят Nominatim). Улицу, угаданную
 * лишь нечётко (pg_trgm), тоже не берём: точка встанет на чужой дом с тем же
 * номером, и никто этого не заметит — там, где ошибка тихая, нужна уверенность.
 */
export async function resolveBuildingByText(rawText: string): Promise<GeoResolveCandidate | null> {
  for (const query of queryVariants(rawText)) {
    const match = await resolveHouseNumber(query);
    if (match && match.precision !== "fuzzy") return toResolveCandidate(match);
  }
  return null;
}

/** Запрос как есть и, если отличается, без таджикского написания
 *  (`plainStreetQuery`, geoNormalize.ts) — вторым заходом. */
function queryVariants(rawText: string): string[] {
  const normalized = normalizeGeoText(rawText);
  if (!normalized) return [];
  const plain = plainStreetQuery(normalized);
  return plain && plain !== normalized ? [normalized, plain] : [normalized];
}

/** Текст → место. `rawText` — как написал человек («82 мкр», «ЦУМ», «у рудаки»,
 *  «рудаки 45»). */
export async function resolveGeoText(rawText: string): Promise<GeoResolveResult | null> {
  // Второй заход — таджикское написание (queryVariants); берём его ответ, только
  // если первый не нашёл ничего или нашёл лишь нечётко.
  let loose: GeoResolveResult | null = null;
  for (const query of queryVariants(rawText)) {
    const found = await resolveNormalizedText(query);
    if (found && found.confidence !== "fuzzy") return found;
    loose ??= found;
  }
  return loose;
}

async function resolveNormalizedText(normalized: string): Promise<GeoResolveResult | null> {
  const houseMatch = await resolveHouseNumber(normalized);
  if (houseMatch) {
    return { ...toResolveCandidate(houseMatch), confidence: confidenceOf(houseMatch.precision), alternatives: [] };
  }

  let candidates: Candidate[] = [];

  const exactRows = await findExactAll(normalized);
  if (exactRows.length > 0) {
    candidates = await resolveTier(exactRows, "exact-raw");
  }
  if (candidates.length === 0) {
    const prefixRows = await findPrefixAll(normalized);
    if (prefixRows.length > 0) candidates = await resolveTier(prefixRows, "prefix");
  }
  if (candidates.length === 0) {
    const fuzzyRows = await findFuzzyAll(normalized);
    if (fuzzyRows.length > 0) candidates = await resolveTier(fuzzyRows, "fuzzy");
  }
  if (candidates.length === 0) return null;

  candidates.sort(compareCandidates);
  const [best, ...rest] = candidates;

  return {
    ...toResolveCandidate(best),
    confidence: confidenceOf(best.precision),
    alternatives: rest.slice(0, MAX_ALTERNATIVES).map(toResolveCandidate),
  };
}
