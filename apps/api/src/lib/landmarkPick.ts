/**
 * ОПИСАНИЕ МЕСТА ОДНОЙ СТРОКОЙ (12.09.2026, дополнение владельца к блоку J,
 * docs/geo-match-plan-12-09.md, правка того же дня). Первая версия по образцу
 * Booking.com («400 м до ЦУМа · 1,2 км до рынка Мехргон · 600 м до школы №81 ·
 * 15 мин до аэропорта») ОТМЕНЕНА владельцем: «мы не Букинг, мы просто чтобы
 * люди знали конкретно, где это — и агент, и обычный человек».
 *
 * ЧТО ДЕЛАЕТ ФУНКЦИЯ ТЕПЕРЬ — одна строка, как сказал бы местный местному:
 *   «82-й микрорайон, рядом Мехргон»
 *   «Сино, 400 м от ЦУМа»
 * То есть: микрорайон (или жилой массив, или район) + НЕ БОЛЕЕ ОДНОГО самого
 * узнаваемого ориентира рядом. Ориентир добавляется, только если он
 * действительно близко (свой потолок расстояния на категорию) и действительно
 * значим (Landmark.weight) — нет такого, остаётся одна область.
 *
 * ПОЧЕМУ НЕ ПРОСТО «БЛИЖАЙШИЙ». Рядом с точкой может быть пять объектов, а
 * назвать нужно тот один, который назвал бы местный — школа в 50 м может быть
 * безымянной рядовой школой, а рынок в 400 м знает весь город. Поэтому отбор
 * ранжирует не по расстоянию, а по (значимость+1)/расстояние, и категория
 * даёт потолок: дальше него ориентир не годится для строки вовсе, какой бы
 * значимый он ни был.
 *
 * ЕДИНАЯ ТОЧКА ВХОДА. Карта, карточка объекта и уведомления подбора обязаны
 * звать `describePlace` отсюда — второй копии этого правила быть не должно
 * (класс дефектов «копия логики вместо самой логики», CLAUDE.md).
 *
 * ОБЛАСТЬ (микрорайон/жилой массив/район) БЕРЁТСЯ ПО БЛИЖАЙШЕМУ ЦЕНТРУ, А НЕ
 * ПО ПОЛИГОНУ. Точное попадание точки в контур (Building → микрорайон/жилой
 * массив/район) — это блок H («автозаполнение по точке», parallel work,
 * lib/geoLookup.ts) и не входит в эту задачу: этот файл её не трогает и не
 * дублирует. Для ОДНОЙ ЧЕЛОВЕКОЧИТАЕМОЙ СТРОКИ (не для канонического адреса)
 * ближайший центр — достаточное приближение: 27 микрорайонов и 4 района на
 * весь город, промах на соседнюю область у самой границы не критичен для
 * подписи, но был бы недопустим для самого адреса объекта.
 */
import { prisma } from "../db.js";
import { distanceMeters } from "./geo.js";
import { landmarkCategoryKey, readableLandmarkName } from "./landmarkCategory.js";
import { findNearestStreetName, loadStreetPoints, type StreetPoint } from "./geoLookup.js";

/**
 * ПОТОЛОК РАССТОЯНИЯ ПО КАТЕГОРИИ, метры — дальше него ориентир этой
 * категории не годится для строки описания вовсе, даже если он самый
 * значимый в городе (аэропорт в 15 км не «рядом», как его ни взвешивай).
 * Числа подобраны НА ГЛАЗ (владелец, 12.09.2026) и будут уточняться по
 * обратной связи агентов — тот же статус, что у DEFAULT_RADIUS_BY_TYPE в
 * geoResolve.ts.
 *
 * Ключ — категория ТОЧНО как в источнике (Landmark.category, свободная
 * строка без enum). Категория без записи здесь получает DEFAULT_CEILING_M.
 */
export const CATEGORY_DISTANCE_CEILING_M: Record<string, number> = {
  Аэропорт: 10_000,
  Вокзал: 10_000,
  Автовокзал: 10_000,
  Базар: 2_000,
  ТЦ: 2_000,
  Парк: 1_500,
  Стадион: 1_500,
  Вуз: 1_500,
  Больница: 1_500,
  Школа: 800,
  Поликлиника: 800,
  Мечеть: 800,
  Кафе: 400,
  Ресторан: 400,
  Гостиница: 400,
  Памятник: 700,
  Музей: 700,
  Театр: 700,
};

/** Потолок для категории, которой нет в таблице выше. */
const DEFAULT_CEILING_M = 1_000;

/**
 * ЗНАЧИМОСТЬ ПО КАТЕГОРИИ, когда своя не проставлена (20.09.2026, владелец:
 * «самое главное не отправлять просто ориентиры, которые люди не знают, а
 * именно самые знаменитые»).
 *
 * `Landmark.weight` заводился под ручную разметку в Настройках (0 / 50 / 100), и
 * у подавляющего большинства из 857 записей он так и остался нулём. При weight=0
 * отбор вырождался в «ближайший из тех, кто влез в потолок категории»: безымянное
 * кафе в 50 метрах (score 1/50) побеждало рынок Мехргон в 400 метрах (1/400),
 * хотя рынок знает весь город, а кафе — соседний подъезд.
 *
 * Поэтому у категории есть своя базовая значимость, и она работает ровно там, где
 * человек ничего не размечал. Проставленный руками вес сильнее: владелец, открывший
 * справочник и выбравший «важный», знает про это место больше таблицы.
 *
 * Числа на глаз, как и потолки расстояний рядом, и уточняются обратной связью.
 * Порядок в них честный: то, по чему в Душанбе объясняют дорогу (аэропорт, вокзал,
 * рынок, крупный ТЦ, парк), против того, по чему не объясняют (кафе, гостиница).
 */
const CATEGORY_BASE_WEIGHT: Record<string, number> = {
  Аэропорт: 100,
  Вокзал: 90,
  Автовокзал: 80,
  Базар: 80,
  ТЦ: 70,
  Стадион: 60,
  Парк: 60,
  Вуз: 50,
  Театр: 40,
  Больница: 40,
  Музей: 30,
  Мечеть: 20,
  Школа: 15,
  Поликлиника: 15,
  Памятник: 10,
  Кафе: 0,
  Ресторан: 0,
  Гостиница: 0,
};

/** Категория без записи выше — середина между «по этому объясняют дорогу» и «нет». */
const DEFAULT_BASE_WEIGHT = 10;

/** Вес, с которым ориентир участвует в отборе: свой, если его проставили руками,
 *  иначе базовый по категории. */
function effectiveWeight(weight: number, category: string): number {
  if (weight > 0) return weight;
  return CATEGORY_BASE_WEIGHT[landmarkCategoryKey(category, CATEGORY_BASE_WEIGHT)] ?? DEFAULT_BASE_WEIGHT;
}

/** Ближе этого — говорим «рядом с …», без числа (так говорит местный).
 *  Дальше — называем расстояние («650 м от …», «1,2 км от …»). На глаз, как и
 *  сами потолки; агенты уточнят по обратной связи. */
const NEAR_WITHOUT_DISTANCE_M = 300;

function categoryCeiling(category: string): number {
  return CATEGORY_DISTANCE_CEILING_M[landmarkCategoryKey(category, CATEGORY_DISTANCE_CEILING_M)] ?? DEFAULT_CEILING_M;
}

/** «650 м» / «1,2 км» — без указания «от»/«до»: предлог и падеж названия
 *  собираются в describePlace, здесь только число. */
function humanDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters / 10) * 10} м`;
  return `${(meters / 1000).toFixed(1).replace(".", ",")} км`;
}

export interface PickedLandmark {
  id: string;
  name: string;
  category: string;
  distanceM: number;
}

export interface PlaceArea {
  kind: "microdistrict" | "livingArea" | "district";
  id: string;
  name: string;
}

export interface PlaceDescription {
  /** Готовая строка для карточки/карты/уведомления, например «Сино, 400 м от ЦУМа».
   *  Пустая строка — координата вне справочника (за пределами Душанбе). */
  text: string;
  area: PlaceArea | null;
  /** Отобранный ориентир, если нашёлся — карте нужны его координаты для метки. */
  landmark: (PickedLandmark & { lat: number; lng: number }) | null;
}

/**
 * СПРАВОЧНИКИ ДЛЯ МНОГИХ ТОЧЕК РАЗОМ (24.09.2026, карта объектов). Один вызов
 * describePlace — это три таблицы областей, ориентиры и до четырёх запросов
 * улиц; карта звала его на каждый из ~300 объектов и делала 1500-2400
 * запросов на одно открытие. Вызывающий, которому нужно много точек,
 * загружает справочники ОДИН раз (`loadPlaceContext`) и передаёт их третьим
 * аргументом; правило отбора при этом одно и то же — те же прямоугольники,
 * те же потолки, та же формула, только кандидаты берутся из памяти. Одиночные
 * вызовы (бот, карточка) идут как шли, без контекста.
 */
interface AreaPoint {
  kind: PlaceArea["kind"];
  id: string;
  name: string;
  lat: number;
  lng: number;
}

interface LandmarkPoint {
  id: string;
  name: string;
  aliases: string[];
  category: string;
  lat: number;
  lng: number;
  weight: number;
}

export interface PlaceContext {
  areas: AreaPoint[];
  /** Только включённые (`enabled: true`) — ровно как в запросе без контекста. */
  landmarks: LandmarkPoint[];
  streets: StreetPoint[];
}

async function loadAreas(): Promise<AreaPoint[]> {
  // Три маленькие таблицы (27 + 117 + 4 записи) — дешевле загрузить целиком и
  // сравнить в памяти, чем городить три отдельных ORDER BY LIMIT 1 запроса с
  // расчётом haversine на стороне базы.
  const [microdistricts, livingAreas, districts] = await Promise.all([
    prisma.microdistrict.findMany({ select: { id: true, name: true, lat: true, lng: true } }),
    prisma.livingArea.findMany({ select: { id: true, name: true, lat: true, lng: true } }),
    prisma.district.findMany({ where: { lat: { not: null }, lng: { not: null } }, select: { id: true, name: true, lat: true, lng: true } }),
  ]);
  return [
    ...microdistricts.map((r) => ({ kind: "microdistrict" as const, id: r.id, name: r.name, lat: Number(r.lat), lng: Number(r.lng) })),
    ...livingAreas.map((r) => ({ kind: "livingArea" as const, id: r.id, name: r.name, lat: Number(r.lat), lng: Number(r.lng) })),
    ...districts.map((r) => ({ kind: "district" as const, id: r.id, name: r.name, lat: Number(r.lat), lng: Number(r.lng) })),
  ];
}

/** Все справочники describePlace одним заходом — для вызывающих, которые
 *  описывают много точек подряд (карта объектов). */
export async function loadPlaceContext(): Promise<PlaceContext> {
  const [areas, landmarks, streets] = await Promise.all([
    loadAreas(),
    prisma.landmark.findMany({
      where: { enabled: true },
      select: { id: true, name: true, aliases: true, category: true, lat: true, lng: true, weight: true },
    }),
    loadStreetPoints(),
  ]);
  return {
    areas,
    landmarks: landmarks.map((c) => ({ ...c, lat: Number(c.lat), lng: Number(c.lng) })),
    streets,
  };
}

async function nearestArea(lat: number, lng: number, ctx?: PlaceContext): Promise<PlaceArea | null> {
  const areas = ctx?.areas ?? (await loadAreas());
  const all: { kind: PlaceArea["kind"]; id: string; name: string; distanceM: number }[] = areas.map((r) => ({
    kind: r.kind,
    id: r.id,
    name: r.name,
    distanceM: distanceMeters(lat, lng, r.lat, r.lng),
  }));

  const best = all.reduce<(typeof all)[number] | null>(
    (acc, r) => (!acc || r.distanceM < acc.distanceM ? r : acc),
    null
  );
  return best ? { kind: best.kind, id: best.id, name: best.name } : null;
}

type RankedLandmark = PickedLandmark & { lat: number; lng: number };

/** Ориентиры у точки в порядке «кого назвал бы местный»: каждый в пределах
 *  потолка своей категории, отсортированы по (значимость+1)/расстояние. Одно
 *  правило и для строки места (`describePlace` берёт первый), и для подсказки
 *  поля «Ориентир» в мастере (`suggestLandmarks` берёт до двух). */
async function rankLandmarks(lat: number, lng: number, ctx?: PlaceContext): Promise<RankedLandmark[]> {
  const maxCeiling = Math.max(...Object.values(CATEGORY_DISTANCE_CEILING_M), DEFAULT_CEILING_M);
  const degPad = maxCeiling / 111_000; // ~111 км на градус широты, с запасом
  const candidates: { id: string; name: string; aliases: string[]; category: string; lat: unknown; lng: unknown; weight: number }[] = ctx
    ? ctx.landmarks.filter(
        (c) => c.lat >= lat - degPad && c.lat <= lat + degPad && c.lng >= lng - degPad && c.lng <= lng + degPad
      )
    : await prisma.landmark.findMany({
        where: {
          enabled: true,
          lat: { gte: lat - degPad, lte: lat + degPad },
          lng: { gte: lng - degPad, lte: lng + degPad },
        },
        select: { id: true, name: true, aliases: true, category: true, lat: true, lng: true, weight: true },
      });

  const scored: (RankedLandmark & { score: number })[] = [];
  for (const c of candidates) {
    const name = readableLandmarkName(c.name, c.aliases);
    if (!name) continue;
    const distanceM = distanceMeters(lat, lng, Number(c.lat), Number(c.lng));
    if (distanceM > categoryCeiling(c.category)) continue;
    // +1 у веса — ориентир с нулевой значимостью (кафе, ресторан) не даёт
    // числитель 0 и не выпадает из сравнения совсем: если рядом нет ничего
    // другого, лучше назвать кафе, чем не назвать ничего. Расстояние не
    // меньше метра — точка ровно на ориентире не делит на ноль.
    const score = (effectiveWeight(c.weight, c.category) + 1) / Math.max(distanceM, 1);
    scored.push({ id: c.id, name, category: c.category, distanceM, lat: Number(c.lat), lng: Number(c.lng), score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ score: _score, ...rest }) => rest);
}

/**
 * ЧТО РЯДОМ — НЕСКОЛЬКО РАЗНЫХ МЕСТ (09.10.2026, робот-консультант, вопрос «а что там
 * рядом — школа, базар?»). То же правило отбора, что у строки места и подсказки
 * «Ориентир» (rankLandmarks): потолок расстояния своей категории, значимость. Одно
 * место на категорию — иначе у школьного квартала список состоял бы из трёх школ.
 */
export async function nearbyLandmarks(lat: number, lng: number, limit = 4): Promise<PickedLandmark[]> {
  const seen = new Set<string>();
  const picked: PickedLandmark[] = [];
  for (const l of await rankLandmarks(lat, lng)) {
    const key = l.category.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({ id: l.id, name: l.name, category: l.category, distanceM: l.distanceM });
    if (picked.length >= limit) break;
  }
  return picked;
}

/** Ближайшая область (микрорайон, массив, район) к точке — для справки о месте. */
export async function nearestPlaceArea(lat: number, lng: number): Promise<PlaceArea | null> {
  return nearestArea(lat, lng);
}

async function bestLandmark(lat: number, lng: number, ctx?: PlaceContext): Promise<RankedLandmark | null> {
  return (await rankLandmarks(lat, lng, ctx))[0] ?? null;
}

/** «рядом Мехргон» / «650 м от ЦУМа». Название сознательно НЕ склоняется —
 *  программно верно просклонять произвольное русское существительное нельзя
 *  без словаря, а неверный падеж читается хуже именительного. Ровно так дан и
 *  пример владельца: «рядом Мехргон», а не «рядом с Мехргоном». */
function landmarkPhrase(landmark: PickedLandmark): string {
  return landmark.distanceM <= NEAR_WITHOUT_DISTANCE_M
    ? `рядом ${landmark.name}`
    : `${humanDistance(landmark.distanceM)} от ${landmark.name}`;
}

/** Предел поля `Property.landmark` (packages/shared, `landmark: max(120)`). */
const LANDMARK_FIELD_MAX = 120;

/**
 * НЕ ДАЛЬШЕ ПАРЫ СОТЕН МЕТРОВ (владелец 28.09.2026: «ориентиры настолько далеко,
 * что можно заблудиться»). Строка места на карте может назвать рынок в полутора
 * километрах — это «где район». Поле «Ориентир» — «как найти дом», поэтому здесь
 * свой, тесный предел: обычный ориентир — до 400 м, то, что знает весь город
 * (базар, вокзал, аэропорт, крупный ТЦ; базовая значимость от 70), — до 800 м.
 */
const SUGGEST_NEAR_M = 400;
const SUGGEST_FAMOUS_M = 800;
const SUGGEST_FAMOUS_WEIGHT = 70;

/**
 * ОРИЕНТИРЫ, КОТОРЫЕ ВПИСАЛИ АГЕНТЫ (выбор владельца 28.09.2026, «Агенты учат»).
 * В справочнике только школы, вузы, рынки и парки — Додо пиццы и супермаркета Б1
 * там нет. Зато их пишут сами агенты в поле «Ориентир» у соседних объектов: такой
 * текст и есть то, как место знает город. Берём его у объектов в пределах
 * `AGENT_HINT_RADIUS_M` от точки — чаще повторённое и ближнее выше.
 *
 * Отдельной таблицы нет намеренно: подсказки живут в самих карточках объектов,
 * агент поправил или стёр ориентир — подсказка ушла вместе с ним, а в
 * справочник ориентиров (по нему бот узнаёт места в переписке) чужие фразы вроде
 * «напротив Додо пиццы» не попадают. Фразы, собранные самим сайтом
 * («рядом …», «400 м от …»), подсказками не считаются — это эхо справочника.
 */
const AGENT_HINT_RADIUS_M = 150;
const AGENT_HINT_LIMIT = 200;
// «рядом ТЦ Садбарг», «400 м от ЦУМа» — так пишет сам сайт; «рядом с Б1» — агент.
const AUTO_PHRASE = /^(рядом\s(?!со?\s)|\d+(?:,\d+)?\s(?:м|км)\sот\s)/i;
/** Подсказка — короткое название места, а не заметка: номер телефона или
 *  длинная фраза из чужой карточки соседям не предлагается. */
const AGENT_HINT_MAX = 60;
const LOOKS_LIKE_PHONE = /\d{5,}/;

async function agentHints(lat: number, lng: number): Promise<string[]> {
  const pad = AGENT_HINT_RADIUS_M / 111_000;
  const lngPad = pad / Math.max(Math.cos((lat * Math.PI) / 180), 0.2);
  const rows = await prisma.property.findMany({
    where: {
      deletedAt: null,
      landmark: { not: null },
      lat: { gte: lat - pad, lte: lat + pad },
      lng: { gte: lng - lngPad, lte: lng + lngPad },
    },
    select: { landmark: true, lat: true, lng: true },
    orderBy: { updatedAt: "desc" },
    take: AGENT_HINT_LIMIT,
  });
  const byKey = new Map<string, { text: string; count: number; nearestM: number }>();
  for (const r of rows) {
    const distanceM = distanceMeters(lat, lng, Number(r.lat), Number(r.lng));
    if (distanceM > AGENT_HINT_RADIUS_M) continue;
    for (const raw of (r.landmark ?? "").split(",")) {
      const text = raw.trim().replace(/\s+/g, " ");
      if (text.length < 3 || text.length > AGENT_HINT_MAX) continue;
      if (AUTO_PHRASE.test(text) || LOOKS_LIKE_PHONE.test(text.replace(/[\s\-()]/g, ""))) continue;
      const key = text.toLowerCase().replace(/ё/g, "е");
      const seen = byKey.get(key);
      if (seen) {
        seen.count += 1;
        seen.nearestM = Math.min(seen.nearestM, distanceM);
      } else {
        byKey.set(key, { text, count: 1, nearestM: distanceM });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.nearestM - b.nearestM).map((h) => h.text);
}

export interface LandmarkSuggestion {
  /** Готовый текст для поля «Ориентир», например «напротив Додо пиццы, рядом
   *  Аграрный университет». Пустая строка — рядом с точкой нет ни одного годного
   *  ориентира. */
  text: string;
  /** Ориентиры справочника, вошедшие в текст (фразы агентов сюда не входят). */
  landmarks: PickedLandmark[];
}

/**
 * ОРИЕНТИР ДЛЯ НОВОГО ОБЪЕКТА (владелец 25.09.2026: «когда добавляешь объект,
 * они сами должны ставиться автоматически, один ориентир или два, как обычно
 * ставят»). Мастер объекта подставляет этот текст в поле «Ориентир» под
 * адресом, агент может его поправить.
 *
 * До двух частей: сперва фраза, которую агенты уже писали у соседних объектов
 * (`agentHints`), затем ориентиры справочника тем же отбором, что у строки места
 * (`rankLandmarks`), но не дальше `SUGGEST_NEAR_M`/`SUGGEST_FAMOUS_M`. Повтор
 * названия пропускается (один ТЦ бывает заведён дважды), строка обязана влезть в
 * поле. Улица сюда НЕ идёт: она и так есть в адресе строкой выше.
 */
export async function suggestLandmarks(lat: number, lng: number, ctx?: PlaceContext): Promise<LandmarkSuggestion> {
  const [hints, ranked] = await Promise.all([agentHints(lat, lng), rankLandmarks(lat, lng, ctx)]);
  const parts: string[] = [];
  const keys: string[] = [];
  const picked: PickedLandmark[] = [];
  const fits = (phrase: string) => [...parts, phrase].join(", ").length <= LANDMARK_FIELD_MAX;
  const repeats = (name: string) => {
    const key = name.trim().toLowerCase().replace(/ё/g, "е");
    return keys.some((k) => k.includes(key) || key.includes(k));
  };

  for (const hint of hints) {
    if (parts.length >= 2) break;
    if (repeats(hint) || !fits(hint)) continue;
    parts.push(hint);
    keys.push(hint.trim().toLowerCase().replace(/ё/g, "е"));
  }
  for (const l of ranked) {
    if (parts.length >= 2) break;
    const famous = effectiveWeight(0, l.category) >= SUGGEST_FAMOUS_WEIGHT;
    if (l.distanceM > (famous ? SUGGEST_FAMOUS_M : SUGGEST_NEAR_M)) continue;
    const phrase = landmarkPhrase(l);
    if (repeats(l.name) || !fits(phrase)) continue;
    parts.push(phrase);
    keys.push(l.name.trim().toLowerCase().replace(/ё/g, "е"));
    picked.push({ id: l.id, name: l.name, category: l.category, distanceM: l.distanceM });
  }
  return { text: parts.join(", "), landmarks: picked };
}

/** По координате — одна строка описания места + разобранные части (область,
 *  отобранный ориентир) на случай, если вызывающему коду нужны не только
 *  готовый текст, но и метка на карте. `ctx` — справочники, загруженные
 *  заранее (`loadPlaceContext`), когда точек много; без него всё читается из
 *  базы, как раньше. */
export async function describePlace(lat: number, lng: number, ctx?: PlaceContext): Promise<PlaceDescription> {
  const [area, landmark] = await Promise.all([nearestArea(lat, lng, ctx), bestLandmark(lat, lng, ctx)]);

  let phrase: string | null = null;
  if (landmark) {
    phrase = landmarkPhrase(landmark);
  } else {
    // Ни один ориентир не подошёл ни по расстоянию, ни по значимости — частый
    // случай на окраинах и в новых микрорайонах (733 ориентира на весь город,
    // у каждой категории свой тесный потолок расстояния). Без этого строка
    // схлопывалась до голого названия района — владелец 14.09.2026: «всё
    // получается Сомони, Сино и так далее», один и тот же десяток названий на
    // 24 тысячи объектов. Второй запасной уровень — ближайшая улица (920 в
    // справочнике, покрытие намного плотнее ориентиров), тот же запрос, что
    // уже использует мастер объекта на шаге «Где» (`lib/geoLookup.ts`).
    // Название улицы в справочнике уже с типом («улица Дружбы Народов»,
    // «проспект Рудаки») — вставляется как есть, без «рядом»/«от»: для линии,
    // а не точки, это звучит естественнее.
    const street = await findNearestStreetName(lat, lng, ctx?.streets);
    if (street) phrase = street;
  }

  const text = area ? (phrase ? `${area.name}, ${phrase}` : area.name) : (phrase ?? "");
  return { text, area, landmark };
}
