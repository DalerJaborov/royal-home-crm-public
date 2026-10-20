/**
 * ИМПОРТ ГЕО-СПРАВОЧНИКА ДУШАНБЕ (12.09.2026, docs/geo-match-plan-12-09.md,
 * блок B). Владелец купил и лицензировал адресный слой города — шесть файлов
 * в `.data-geo/` (вне git, 14 МБ, уже в .gitignore): дома, улицы, микрорайоны,
 * жилые массивы, районы, ориентиры. Разовая выгрузка, наполняется этим
 * скриптом, не миграцией — в 338 миграциях репозитория `INSERT INTO` не
 * встречается ни разу (прецеденты: migrate-properties-view-all.ts,
 * migrate-theme-2026.ts в этой же папке).
 *
 * Плюс словарь синонимов (дополнение владельца 12.09.2026 к тому же блоку):
 * «82 мкр» в переписке клиента не совпадает строкой с «82-й микрорайон» в
 * базе — этот скрипт заодно генерирует варианты написания в GeoAlias,
 * используя ту же normalizeGeoText, которой пользуется поиск (lib/geoResolve.ts).
 *
 * ПОРЯДОК ЗАГРУЗКИ (районы → микрорайоны → жилые массивы → улицы → ориентиры →
 * дома) — из плана: районы уже есть в базе (см. seed.ts), им только дописываются
 * geo-поля; дома грузятся последними, им нужен districtId уже существующих
 * районов.
 *
 * ИДЕМПОТЕНТНОСТЬ: upsert по sourceId для каждой сущности. Словарь синонимов
 * (source "import"/"generated") при каждом запуске удаляется и собирается
 * заново из текущих данных и текущей логики генерации — так повторный запуск
 * после правки генератора не оставляет мусора от старой версии. Синонимы с
 * source "agent" (ручная правка, будущее) этим не затрагиваются.
 *
 * ЗАПУСК (из apps/api, там же .env с DATABASE_URL):
 *   npx tsx prisma/scripts/import-geo.ts                 — загрузка, папка по
 *                                                           умолчанию .data-geo
 *                                                           от корня репозитория
 *   npx tsx prisma/scripts/import-geo.ts D:\путь\к\папке  — загрузка из другой папки
 *   npx tsx prisma/scripts/import-geo.ts --check          — только проверка уже
 *                                                           загруженных данных,
 *                                                           без повторной загрузки
 *
 * После обычной загрузки проверка запускается автоматически — раздел 3 плана
 * требует её каждый раз после загрузки, а не только по требованию.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../../src/db.js";
import { geoMatchKey, normalizeGeoText } from "../../src/lib/geoNormalize.js";
import { landmarkCategoryKey } from "../../src/lib/landmarkCategory.js";
import { parseWktPolygonRing, polygonIssues, isInsideDushanbe, distanceMeters } from "../../src/lib/geo.js";
import { isGenericLandmarkName, landmarkNamesLookAlike } from "../../src/lib/landmarkDedup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/api/prisma/scripts -> корень репозитория (4 уровня вверх).
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const DEFAULT_DATA_DIR = path.join(REPO_ROOT, ".data-geo");

/** Дома грузятся пачками — 24 325 записей поштучно заняло бы получаса
 *  (правило репозитория, «дома в транзакции по 500–1000»). */
const BUILDING_BATCH_SIZE = 750;
/** Тот же предел для словаря синонимов — вставка одним запросом на весь
 *  справочник (несколько тысяч строк) прошла бы, но батчинг дешевле для
 *  памяти движка и одинаково быстр. */
const ALIAS_BATCH_SIZE = 1000;

/**
 * Категории ориентиров из Викиданных, не являющиеся физическим местом на
 * карте — списки-статьи, историко-административные понятия, единичное
 * событие. Список составлен просмотром всех 46 категорий источника вручную
 * (12.09.2026, см. отчёт агента). Настоящие типы места («Авеню», «Дорога» —
 * несмотря на непривычное название, это конкретная точка/линия на карте) в
 * список НЕ входят.
 */
const EXCLUDED_LANDMARK_CATEGORIES = new Set<string>([
  "Статья-список в проекте викимедиа",
  "Асср в составе союзных республик ссср",
  "Союзная республика в составе ссср",
  "Столица",
  "Этнические беспорядки",
]);

// ---------------------------------------------------------------------------
// Разбор сырых значений источника
// ---------------------------------------------------------------------------

function emptyToNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function parseIntSafe(v: unknown): number | null {
  const s = emptyToNull(v);
  if (s == null) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function parseDecimalSafe(v: unknown): number | null {
  const s = emptyToNull(v);
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function readJsonArray<T>(dir: string, file: string): T[] {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) {
    console.error(`  ФАЙЛ НЕ НАЙДЕН: ${p}`);
    return [];
  }
  const raw = fs.readFileSync(p, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    console.error(`  ${file}: верхний уровень не массив, пропускаю`);
    return [];
  }
  return data as T[];
}

async function chunks<T>(items: T[], size: number, fn: (batch: T[], index: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await fn(items.slice(i, i + size), i);
  }
}

// ---------------------------------------------------------------------------
// Генерация синонимов
// ---------------------------------------------------------------------------

type AliasSource = "import" | "generated";
interface AliasDraft {
  text: string;
  source: AliasSource;
}
interface AliasRow extends AliasDraft {
  normalized: string;
  targetType: string;
  targetId: string;
}

const STREET_KIND_ABBR: Record<string, string | undefined> = {
  "улица": "ул",
  "проспект": "пр",
  "переулок": "пер",
  "проезд": undefined,
  "жилая улица": undefined,
};

// Префиксы (русские и таджикские), которые могут стоять перед именем улицы —
// иногда по нескольку сразу («1-й пр. ул. Негмата Карабаева»). Снимаются по
// одному, пока начало строки совпадает с одним из них.
const STREET_PREFIX_RE = new RegExp(
  "^(" +
    [
      "\\d+-?(?:й|я|го|ый|ой)?\\.?",
      "проезд\\.?", // «проезд» целиком — «пр-?д?» ниже ловит только сокращения (пр., пр-д)
      "пр-?д?\\.?",
      "ул(?:ица|ицы)?\\.?",
      "просп(?:ект)?\\.?",
      "пер(?:еулок)?\\.?",
      "кӯчаи",
      "кучаи",
      "гузари",
      "гузаргохи",
      "гӯзаргоҳи",
      "хиёбони",
    ].join("|") +
  ")\\s+",
  "i",
);

function stripStreetPrefixes(name: string): string {
  let s = name.trim();
  for (let i = 0; i < 5; i++) {
    const next = s.replace(STREET_PREFIX_RE, "").trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

/** «проспект Рудаки» → «рудаки», «пр рудаки», «проспект рудаки» + сама строка;
 *  «улица Бухоро» → «бухоро», «ул бухоро», «улица бухоро»; плюс таджикское
 *  название и его форма без «кӯчаи»/«хиёбони»; плюс содержимое скобок
 *  («2-гузари Крупская (Корвон)» → «Корвон» отдельным синонимом). */
function generateStreetAliases(name: string, nameTj: string | null, kind: string): AliasDraft[] {
  const out: AliasDraft[] = [{ text: name, source: "import" }];
  const seen = new Set<string>([name]);
  const add = (text: string, source: AliasSource) => {
    if (!text || seen.has(text)) return;
    seen.add(text);
    out.push({ text, source });
  };

  const bare = stripStreetPrefixes(name);
  add(bare, "generated");
  if (bare) {
    add(`${kind} ${bare}`, "generated");
    const abbr = STREET_KIND_ABBR[kind];
    if (abbr) add(`${abbr} ${bare}`, "generated");
  }

  const paren = /\(([^)]+)\)/.exec(name);
  if (paren) {
    add(paren[1], "import"); // народное название в скобках — такое же прямое, как основное
    add(name.replace(/\s*\([^)]+\)/, "").trim(), "generated");
  }

  if (nameTj) {
    add(nameTj, "import");
    add(stripStreetPrefixes(nameTj), "generated");
  }

  return out;
}

/** «82-й микрорайон» / «15 микрорайон» (без дефиса — источник не единообразен,
 *  число вытаскивается регуляркой, а не по позиции) → «82», «82 мкр», «82-й
 *  мкр», «82 микрорайон», «82-й микрорайон», «82-юм микрорайон», «мкр 82». */
function generateMicrodistrictAliases(name: string, nameTj: string | null): AliasDraft[] {
  const out: AliasDraft[] = [{ text: name, source: "import" }];
  const m = /(\d+)/.exec(name);
  if (m) {
    const num = m[1];
    for (const text of [
      num,
      `${num} мкр`,
      `${num}-й мкр`,
      `${num} микрорайон`,
      `${num}-й микрорайон`,
      `${num}-юм микрорайон`,
      `мкр ${num}`,
    ]) {
      out.push({ text, source: "generated" });
    }
  }
  if (nameTj) out.push({ text: nameTj, source: "import" });
  return out;
}

function generateNameOnlyAliases(name: string, nameTj: string | null): AliasDraft[] {
  const out: AliasDraft[] = [{ text: name, source: "import" }];
  if (nameTj) out.push({ text: nameTj, source: "import" });
  return out;
}

/** Ориентиры: само название + каждая запись «Альтернативные названия»,
 *  разбитая по «;» (таджикское и английское названия в одной строке). */
/**
 * Общеупотребимое слово-описатель, которым часто начинается название
 * ориентира («Рынок "Корвон"», «ТЦ Мехргон», «Парк Рудаки»), но которое люди
 * в разговоре обычно опускают («на Корвоне», «у Мехргона»). Без этого алиаса
 * бот находит ориентир только если человек назвал его ПОЛНОСТЬЮ — живой
 * пример: рынок «Корвон» после дедупликации (см. dedupLandmarks выше) несёт
 * названия «Рынок "Корвон"» и «Bozori Korvon», но нигде в купленных данных
 * нет отдельной записи с голым «Корвон» — сравни с «Мехргон», где голая форма
 * попала в синонимы просто потому, что источник ОТДЕЛЬНО перечислил её как
 * второй ориентир (см. dedupLandmarks). Полагаться на такое везение нельзя,
 * поэтому описатель отрезается тем же приёмом, что и у улиц
 * (stripStreetPrefixes), только по своему списку слов.
 *
 * Список НАРОЧНО короткий — только «рынок/базар/тц», ровно то, что нужно для
 * живых примеров задачи (Корвон, Мехргон). «Парк», «памятник» и подобные сюда
 * не добавлены: живая проверка показала, что «Парк Рудаки» — реальный парк в
 * купленных данных, и голый алиас «рудаки» для него сталкивает парк с
 * проспектом Рудаки за то же самое слово, порождая ЛИШНЮЮ неоднозначность,
 * которой не было в исходном отчёте владельца. Расширять список — отдельным
 * решением, только вместе с проверкой, что оно не плодит новых столкновений.
 */
const LANDMARK_GENERIC_PREFIX_RE = /^(рынок|базар|тц|торговый\s+центр)\s+/i;

function stripLandmarkGenericPrefix(name: string): string | null {
  const m = LANDMARK_GENERIC_PREFIX_RE.exec(name.trim());
  if (!m) return null;
  const rest = name.trim().slice(m[0].length).trim();
  return rest || null;
}

function generateLandmarkAliases(name: string, aliasesRaw: string | null): AliasDraft[] {
  const out: AliasDraft[] = [{ text: name, source: "import" }];
  const seen = new Set<string>([name]);
  if (aliasesRaw) {
    for (const part of aliasesRaw.split(";")) {
      const t = part.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push({ text: t, source: "import" });
      }
    }
  }
  const bare = stripLandmarkGenericPrefix(name);
  if (bare && !seen.has(bare)) {
    seen.add(bare);
    out.push({ text: bare, source: "generated" });
  }
  return out;
}

function collectAliases(
  drafts: AliasDraft[],
  targetType: string,
  targetId: string,
  sink: AliasRow[],
): void {
  const seenNormalized = new Set<string>();
  for (const d of drafts) {
    const normalized = normalizeGeoText(d.text);
    if (!normalized || seenNormalized.has(normalized)) continue;
    seenNormalized.add(normalized);
    sink.push({ ...d, normalized, targetType, targetId });
  }
}

// ---------------------------------------------------------------------------
// Статистика отчёта
// ---------------------------------------------------------------------------

interface Stats {
  created: Record<string, number>;
  updated: Record<string, number>;
  skipped: Record<string, string[]>; // причина -> список примеров (обрезано)
}

function newStats(): Stats {
  return { created: {}, updated: {}, skipped: {} };
}
function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}
function skip(stats: Stats, reason: string, example: string): void {
  const list = (stats.skipped[reason] ??= []);
  if (list.length < 10) list.push(example);
  else if (list.length === 10) list.push("… (остальные не показаны)");
  if (list.length <= 11) stats.skipped[reason] = list;
}

// ---------------------------------------------------------------------------
// Импорт по сущностям
// ---------------------------------------------------------------------------

interface RawDistrict {
  id: string;
  "Название": string;
  "Название (тадж.)": string;
  "Широта": number | string;
  "Долгота": number | string;
  "Граница (WKT, WGS84)": string;
}

async function importDistricts(dataDir: string, stats: Stats, aliases: AliasRow[]): Promise<void> {
  const rows = readJsonArray<RawDistrict>(dataDir, "районы.json");
  console.log(`районы.json: ${rows.length} записей`);
  for (const r of rows) {
    const name = r["Название"];
    const existing = await prisma.district.findUnique({ where: { name } });
    if (!existing) {
      // Новые районы этим скриптом не заводятся (план: «17 существующих
      // объектов чистят агенты сами», а районов ровно четыре и они уже есть).
      skip(stats, "район не найден в базе (не создаём новые районы)", name);
      continue;
    }
    const nameTj = emptyToNull(r["Название (тадж.)"]);
    await prisma.district.update({
      where: { id: existing.id },
      data: {
        sourceId: r.id,
        nameTj,
        lat: parseDecimalSafe(r["Широта"]),
        lng: parseDecimalSafe(r["Долгота"]),
        boundary: emptyToNull(r["Граница (WKT, WGS84)"]),
      },
    });
    bump(stats.updated, "district");
    collectAliases(generateNameOnlyAliases(name, nameTj), "district", existing.id, aliases);
  }
}

interface RawMicrodistrict {
  id: string;
  "Название": string;
  "Название (тадж.)": string;
  "Широта": number | string;
  "Долгота": number | string;
  "Граница (WKT, WGS84)": string;
}

async function importMicrodistricts(dataDir: string, stats: Stats, aliases: AliasRow[]): Promise<void> {
  const rows = readJsonArray<RawMicrodistrict>(dataDir, "микрорайоны.json");
  console.log(`микрорайоны.json: ${rows.length} записей`);
  for (const r of rows) {
    const name = r["Название"];
    const nameTj = emptyToNull(r["Название (тадж.)"]);
    const lat = parseDecimalSafe(r["Широта"]);
    const lng = parseDecimalSafe(r["Долгота"]);
    const boundary = emptyToNull(r["Граница (WKT, WGS84)"]);
    if (lat == null || lng == null || !boundary) {
      skip(stats, "микрорайон без координаты/границы", `${r.id} ${name}`);
      continue;
    }
    const row = await prisma.microdistrict.upsert({
      where: { sourceId: r.id },
      create: { sourceId: r.id, name, nameTj, lat, lng, boundary },
      update: { name, nameTj, lat, lng, boundary },
    });
    bump(stats.updated, "microdistrict");
    collectAliases(generateMicrodistrictAliases(name, nameTj), "microdistrict", row.id, aliases);
  }
}

interface RawLivingArea {
  id: string;
  "Название": string;
  "Название (тадж.)": string;
  "Широта": number | string;
  "Долгота": number | string;
  "Граница (WKT, WGS84)": string;
}

async function importLivingAreas(dataDir: string, stats: Stats, aliases: AliasRow[]): Promise<void> {
  const rows = readJsonArray<RawLivingArea>(dataDir, "жилые_массивы.json");
  console.log(`жилые_массивы.json: ${rows.length} записей`);
  for (const r of rows) {
    const name = r["Название"];
    const nameTj = emptyToNull(r["Название (тадж.)"]);
    const lat = parseDecimalSafe(r["Широта"]);
    const lng = parseDecimalSafe(r["Долгота"]);
    if (lat == null || lng == null) {
      skip(stats, "жилой массив без координаты", `${r.id} ${name}`);
      continue;
    }
    const row = await prisma.livingArea.upsert({
      where: { sourceId: r.id },
      create: { sourceId: r.id, name, nameTj, lat, lng, boundary: emptyToNull(r["Граница (WKT, WGS84)"]) },
      update: { name, nameTj, lat, lng, boundary: emptyToNull(r["Граница (WKT, WGS84)"]) },
    });
    bump(stats.updated, "livingArea");
    collectAliases(generateNameOnlyAliases(name, nameTj), "livingArea", row.id, aliases);
  }
}

interface RawStreet {
  id: string;
  "Полное название": string;
  "Название (тадж.)": string;
  "Тип": string;
  "Район": string;
  "Домов с адресом": number | string;
  "Широта (центр)": number | string;
  "Долгота (центр)": number | string;
  "Геометрия (WKT, WGS84)": string;
}

async function importStreets(
  dataDir: string,
  stats: Stats,
  aliases: AliasRow[],
  districtByName: Map<string, string>,
): Promise<void> {
  const rows = readJsonArray<RawStreet>(dataDir, "улицы.json");
  console.log(`улицы.json: ${rows.length} записей`);
  for (const r of rows) {
    const name = r["Полное название"];
    const nameTj = emptyToNull(r["Название (тадж.)"]);
    const kind = r["Тип"];
    const lat = parseDecimalSafe(r["Широта (центр)"]);
    const lng = parseDecimalSafe(r["Долгота (центр)"]);
    if (lat == null || lng == null) {
      skip(stats, "улица без координаты центра", `${r.id} ${name}`);
      continue;
    }
    // Улица может лежать в нескольких районах сразу («Сино, Фирдавси») —
    // тогда однозначный FK невозможен, districtId остаётся null (см.
    // докстринг Street в schema.prisma).
    const districtNames = r["Район"].split(",").map((s) => s.trim()).filter(Boolean);
    const districtId =
      districtNames.length === 1 ? districtByName.get(districtNames[0]) ?? null : null;

    const row = await prisma.street.upsert({
      where: { sourceId: r.id },
      create: {
        sourceId: r.id,
        name,
        nameTj,
        kind,
        districtId,
        lat,
        lng,
        geometry: emptyToNull(r["Геометрия (WKT, WGS84)"]),
        housesCount: parseIntSafe(r["Домов с адресом"]) ?? 0,
      },
      update: {
        name,
        nameTj,
        kind,
        districtId,
        lat,
        lng,
        geometry: emptyToNull(r["Геометрия (WKT, WGS84)"]),
        housesCount: parseIntSafe(r["Домов с адресом"]) ?? 0,
      },
    });
    bump(stats.updated, "street");
    collectAliases(generateStreetAliases(name, nameTj, kind), "street", row.id, aliases);
  }
}

interface RawLandmark {
  id: string;
  "Название": string;
  "Альтернативные названия": string;
  "Категория": string;
  "Адрес": string;
  "Широта": number | string;
  "Долгота": number | string;
  "Район": string;
}

// ---------------------------------------------------------------------------
// Дедупликация ориентиров (12.09.2026, docs/geo-match-plan-12-09.md, блок G) —
// купленные данные несут один физический объект несколькими записями:
// «Корвон» — три («Bozori Korvon», «Рынок "Корвон"» дважды), «Мехргон» — две
// («Мехргон», «ТЦ Мехргон»). Для бота и подбора это значит, что один и тот же
// рынок несколько раз попадает в выдачу расстояний под разными именами.
// ---------------------------------------------------------------------------

/** Базовый радиус слияния дублей, метры — «одна и та же точка, дважды
 *  выгруженная источником». Подобран на глаз (владелец, план). */
const DEDUP_RADIUS_M = 150;

/**
 * Расширенный радиус для категорий с физически большой площадью — базар, ТЦ,
 * вокзал, вуз, стадион, аэропорт. Проверено на живых данных: три записи
 * рынка «Корвон» лежат друг от друга на 225, 260 и 480 метров (разные
 * строения/входы одного и того же базара, не три разных места) — базового
 * 150-метрового радиуса для этой категории заведомо недостаточно, отдельные
 * записи остались бы отдельными ориентирами. Названия категорий — как в
 * источнике (см. `RawLandmark["Категория"]`).
 */
const DEDUP_RADIUS_BY_CATEGORY: Record<string, number> = {
  "Базар": 500,
  "ТЦ": 400,
  "Вокзал": 500,
  "Вуз": 500,
  "Стадион": 400,
  "Аэропорт": 1000,
};

/** «Название» + разбор «Альтернативные названия» → нормализованные варианты
 *  написания одной записи, для сравнения с вариантами другой. */
function landmarkNameVariants(name: string, aliasesRaw: string | null): string[] {
  const raw = [name, ...(aliasesRaw ? aliasesRaw.split(";") : [])];
  // geoMatchKey, а не normalizeGeoText (29.09.2026): «Bozori Korvon» и «Бозори
  // Корвон», «Деҳотӣ» и «Дехоти» — одно имя; иначе дубли не склеивались.
  return raw.map((s) => geoMatchKey(s.trim())).filter(Boolean);
}

/** Категория для склейки дублей — тем же правилом, что весы ориентиров
 *  (lib/landmarkCategory.ts): «ВУЗ», «Вуз» и «Академическое учебное заведение» —
 *  одна категория (29.09.2026: аграрный университет был заведён 4 раза). */
function dedupCategory(category: string): string {
  return landmarkCategoryKey(category, DEDUP_RADIUS_BY_CATEGORY).toLowerCase();
}

function landmarksLookLikeDuplicates(a: RawLandmark, b: RawLandmark): boolean {
  if (isGenericLandmarkName(a["Название"]) || isGenericLandmarkName(b["Название"])) return false;
  const va = landmarkNameVariants(a["Название"], emptyToNull(a["Альтернативные названия"]));
  const vb = landmarkNameVariants(b["Название"], emptyToNull(b["Альтернативные названия"]));
  for (const x of va) {
    for (const y of vb) {
      if (landmarkNamesLookAlike(x, y)) return true;
    }
  }
  return false;
}

/** «Значимость» названия для выбора победителя кластера: кириллица весомее
 *  латинской транслитерации (агенты и бот работают по-русски/по-таджикски
 *  кириллицей — см. известные слабые места купленных данных, план, блок B),
 *  при равенстве — длина нормализованного имени. */
function landmarkNameScore(name: string): number {
  const hasCyrillic = /[а-яёіўғқҳҷӣ]/i.test(name);
  return (hasCyrillic ? 1000 : 0) + normalizeGeoText(name).length;
}

interface LandmarkDedupCluster {
  winnerSourceId: string;
  winnerName: string;
  loserSourceIds: string[];
  loserNames: string[];
}

interface LandmarkDedupResult {
  /** Строки к загрузке — по одной на кластер, у победителя дописаны синонимы
   *  проигравших в «Альтернативные названия». */
  kept: RawLandmark[];
  /** sourceId проигравших — на случай, если предыдущий (до этой правки) запуск
   *  импорта уже создал по ним отдельные записи Landmark: их надо убрать,
   *  иначе повторный запуск не идемпотентен. */
  droppedSourceIds: string[];
  clusters: LandmarkDedupCluster[];
}

/**
 * Схлопывает записи одной категории, чьи координаты ближе радиуса дедупа
 * (см. DEDUP_RADIUS_BY_CATEGORY/DEDUP_RADIUS_M) и чьи названия похожи
 * (landmarksLookLikeDuplicates), в одну — простой union-find по парам,
 * без внешних зависимостей (записей 857, O(n²) по категории дёшево: самая
 * крупная категория — школы, 155 штук).
 */
function dedupLandmarks(rows: RawLandmark[]): LandmarkDedupResult {
  const n = rows.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(x: number, y: number): void {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[rx] = ry;
  }

  for (let i = 0; i < n; i++) {
    const a = rows[i];
    const latA = parseDecimalSafe(a["Широта"]);
    const lngA = parseDecimalSafe(a["Долгота"]);
    if (latA == null || lngA == null) continue;
    for (let j = i + 1; j < n; j++) {
      const b = rows[j];
      if (dedupCategory(a["Категория"]) !== dedupCategory(b["Категория"])) continue;
      const latB = parseDecimalSafe(b["Широта"]);
      const lngB = parseDecimalSafe(b["Долгота"]);
      if (latB == null || lngB == null) continue;
      const radius = DEDUP_RADIUS_BY_CATEGORY[landmarkCategoryKey(a["Категория"], DEDUP_RADIUS_BY_CATEGORY)] ?? DEDUP_RADIUS_M;
      if (distanceMeters(latA, lngA, latB, lngB) > radius) continue;
      if (!landmarksLookLikeDuplicates(a, b)) continue;
      union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  }

  const kept: RawLandmark[] = [];
  const droppedSourceIds: string[] = [];
  const clusters: LandmarkDedupCluster[] = [];

  for (const indices of groups.values()) {
    if (indices.length === 1) {
      kept.push(rows[indices[0]]);
      continue;
    }
    let winnerIdx = indices[0];
    let winnerScore = landmarkNameScore(rows[winnerIdx]["Название"]);
    for (const idx of indices.slice(1)) {
      const s = landmarkNameScore(rows[idx]["Название"]);
      if (s > winnerScore) {
        winnerIdx = idx;
        winnerScore = s;
      }
    }
    const winner = rows[winnerIdx];
    const loserIdxs = indices.filter((idx) => idx !== winnerIdx);
    const winnerOwnVariants = new Set(landmarkNameVariants(winner["Название"], null));
    const extraSynonyms: string[] = [];
    const seenSynonym = new Set<string>();
    for (const idx of loserIdxs) {
      const loser = rows[idx];
      const candidates = [loser["Название"], ...(loser["Альтернативные названия"] ? loser["Альтернативные названия"].split(";") : [])];
      for (const raw of candidates) {
        const text = raw.trim();
        if (!text) continue;
        const normalized = normalizeGeoText(text);
        if (winnerOwnVariants.has(normalized) || seenSynonym.has(normalized)) continue;
        seenSynonym.add(normalized);
        extraSynonyms.push(text);
      }
      droppedSourceIds.push(loser.id);
    }
    const existingAliases = winner["Альтернативные названия"]
      ? winner["Альтернативные названия"].split(";").map((s) => s.trim()).filter(Boolean)
      : [];
    kept.push({ ...winner, "Альтернативные названия": [...existingAliases, ...extraSynonyms].join("; ") });
    clusters.push({
      winnerSourceId: winner.id,
      winnerName: winner["Название"],
      loserSourceIds: loserIdxs.map((idx) => rows[idx].id),
      loserNames: loserIdxs.map((idx) => rows[idx]["Название"]),
    });
  }

  return { kept, droppedSourceIds, clusters };
}

async function importLandmarks(
  dataDir: string,
  stats: Stats,
  aliases: AliasRow[],
  districtByName: Map<string, string>,
): Promise<void> {
  const allRows = readJsonArray<RawLandmark>(dataDir, "ориентиры.json");
  console.log(`ориентиры.json: ${allRows.length} записей`);

  const notExcluded = allRows.filter((r) => {
    if (EXCLUDED_LANDMARK_CATEGORIES.has(r["Категория"])) {
      skip(stats, "ориентир: мусорная категория Викиданных", `${r.id} ${r["Название"]} (${r["Категория"]})`);
      return false;
    }
    return true;
  });

  const dedup = dedupLandmarks(notExcluded);
  console.log(`  дедупликация: ${notExcluded.length} записей → ${dedup.kept.length} после схлопывания дублей (кластеров со сдвоенными записями: ${dedup.clusters.length})`);
  for (const c of dedup.clusters) {
    console.log(`    "${c.winnerName}" (${c.winnerSourceId}) ← ${c.loserNames.map((n, i) => `"${n}" (${c.loserSourceIds[i]})`).join(", ")}`);
  }
  if (dedup.droppedSourceIds.length > 0) {
    // Идемпотентность повторного запуска: если ДО этой правки импорт уже
    // успел создать отдельные записи по проигравшим sourceId, убираем их —
    // иначе они остались бы сиротами, которых этот скрипт больше не трогает.
    const removed = await prisma.landmark.deleteMany({ where: { sourceId: { in: dedup.droppedSourceIds } } });
    if (removed.count > 0) {
      console.log(`  удалено ${removed.count} ранее загруженных записей-дублей (sourceId из проигравших кластеров)`);
    }
  }

  for (const r of dedup.kept) {
    const category = r["Категория"];
    const name = r["Название"];
    const lat = parseDecimalSafe(r["Широта"]);
    const lng = parseDecimalSafe(r["Долгота"]);
    if (lat == null || lng == null) {
      skip(stats, "ориентир без координаты", `${r.id} ${name}`);
      continue;
    }
    const districtId = districtByName.get(r["Район"]) ?? null;
    const aliasesRaw = emptyToNull(r["Альтернативные названия"]);

    /**
     * ЗАПИСИ, ЗАВЕДЁННЫЕ АГЕНТОМ (source="agent"), ЭТОТ ИМПОРТ НЕ ТРОГАЕТ (блок J,
     * решение владельца 12.09.2026) — иначе следующий запуск воскресил бы то, что
     * агент скрыл/поправил, и он решил бы, что справочник его не слушает.
     *
     * Структурно это и так гарантировано: у агентских записей sourceId пуст
     * (schema.prisma), а upsert ниже ищет строго по sourceId ИЗ ФАЙЛА
     * источника — совпасть с пустым полем он не может. Проверка ниже —
     * защита на случай, если чей-то ручной SQL/будущая правка когда-нибудь
     * проставит агентской записи sourceId: тогда upsert молча перезаписал бы
     * её данными поставки вместо того, чтобы отказаться.
     */
    const existing = await prisma.landmark.findUnique({
      where: { sourceId: r.id },
      select: { id: true, source: true },
    });
    if (existing?.source === "agent") {
      skip(stats, "ориентир: sourceId занят агентской записью, импорт её не трогает", `${r.id} ${name}`);
      continue;
    }

    const row = await prisma.landmark.upsert({
      where: { sourceId: r.id },
      create: {
        sourceId: r.id,
        name,
        aliases: aliasesRaw ? aliasesRaw.split(";").map((s) => s.trim()).filter(Boolean) : [],
        category,
        address: emptyToNull(r["Адрес"]),
        districtId,
        lat,
        lng,
      },
      update: {
        name,
        aliases: aliasesRaw ? aliasesRaw.split(";").map((s) => s.trim()).filter(Boolean) : [],
        category,
        address: emptyToNull(r["Адрес"]),
        districtId,
        lat,
        lng,
        // enabled и source НЕ переписываются: скрытая руководителем запись должна
        // остаться скрытой и после переимпорта (блок J), а source — маркер того,
        // ОТКУДА взялась запись, а не то, что в неё сейчас пишет импорт.
      },
    });
    bump(stats.updated, "landmark");
    collectAliases(generateLandmarkAliases(name, aliasesRaw), "landmark", row.id, aliases);
  }
}

interface RawBuilding {
  id: string;
  "Улица": string;
  "Номер дома": string;
  "Микрорайон": string;
  "Жилой массив": string;
  "Район": string;
  "Широта": number | string;
  "Долгота": number | string;
  "Назначение": string;
  "Название": string;
  "Этажность": number | string;
  "Материал стен": string;
  "Подъезды": number | string;
  "Год постройки": number | string;
  "Квартир": number | string;
  "Контур (WKT, WGS84)": string;
}

async function importBuildings(
  dataDir: string,
  stats: Stats,
  districtByName: Map<string, string>,
): Promise<void> {
  const rows = readJsonArray<RawBuilding>(dataDir, "дома.json");
  console.log(`дома.json: ${rows.length} записей`);

  await chunks(rows, BUILDING_BATCH_SIZE, async (batch, index) => {
    // Таймаут по умолчанию (5 с) рассчитан на короткие интерактивные
    // транзакции — пачка из BUILDING_BATCH_SIZE последовательных upsert
    // изредка перешагивает его на живой базе (замечено на 21751-й записи из
    // 24 325: «query cannot be executed on an expired transaction»),
    // обрывая импорт на середине и оставляя базу частично загруженной.
    await prisma.$transaction(async (tx) => {
      for (const r of batch) {
        const lat = parseDecimalSafe(r["Широта"]);
        const lng = parseDecimalSafe(r["Долгота"]);
        const districtId = districtByName.get(r["Район"]) ?? null;
        if (lat == null || lng == null) {
          skip(stats, "дом без координаты", `${r.id}`);
          continue;
        }
        if (!districtId) {
          skip(stats, "дом: неизвестный район", `${r.id} ${r["Район"]}`);
          continue;
        }
        await tx.building.upsert({
          where: { sourceId: r.id },
          create: {
            sourceId: r.id,
            street: emptyToNull(r["Улица"]),
            houseNumber: r["Номер дома"],
            microdistrict: emptyToNull(r["Микрорайон"]),
            livingArea: emptyToNull(r["Жилой массив"]),
            districtId,
            lat,
            lng,
            purpose: emptyToNull(r["Назначение"]),
            floors: parseIntSafe(r["Этажность"]),
            wallMaterial: emptyToNull(r["Материал стен"]),
            entrances: parseIntSafe(r["Подъезды"]),
            apartments: parseIntSafe(r["Квартир"]),
            builtYear: parseIntSafe(r["Год постройки"]),
            outline: emptyToNull(r["Контур (WKT, WGS84)"]),
          },
          update: {
            street: emptyToNull(r["Улица"]),
            houseNumber: r["Номер дома"],
            microdistrict: emptyToNull(r["Микрорайон"]),
            livingArea: emptyToNull(r["Жилой массив"]),
            districtId,
            lat,
            lng,
            purpose: emptyToNull(r["Назначение"]),
            floors: parseIntSafe(r["Этажность"]),
            wallMaterial: emptyToNull(r["Материал стен"]),
            entrances: parseIntSafe(r["Подъезды"]),
            apartments: parseIntSafe(r["Квартир"]),
            builtYear: parseIntSafe(r["Год постройки"]),
            outline: emptyToNull(r["Контур (WKT, WGS84)"]),
          },
        });
        bump(stats.updated, "building");
      }
    }, { timeout: 30_000 });
    console.log(`  дома: обработана пачка ${index + 1}–${index + batch.length} из ${rows.length}`);
  });
}

async function insertAliases(aliases: AliasRow[]): Promise<void> {
  console.log(`Словарь синонимов: пересобираю (source in import/generated), новых строк: ${aliases.length}`);
  await prisma.geoAlias.deleteMany({ where: { source: { in: ["import", "generated"] } } });
  await chunks(aliases, ALIAS_BATCH_SIZE, async (batch) => {
    await prisma.geoAlias.createMany({
      data: batch.map((a) => ({
        text: a.text,
        normalized: a.normalized,
        targetType: a.targetType,
        targetId: a.targetId,
        source: a.source,
      })),
      skipDuplicates: true,
    });
  });
}

// ---------------------------------------------------------------------------
// Проверка (--check)
// ---------------------------------------------------------------------------

async function runCheck(dataDir: string | null): Promise<void> {
  console.log("\n=== ПРОВЕРКА ===");

  // 1. Координаты внутри Душанбе.
  const tables: Array<{ label: string; rows: Array<{ lat: unknown; lng: unknown }> }> = [
    { label: "Building", rows: await prisma.building.findMany({ select: { lat: true, lng: true } }) },
    { label: "Street", rows: await prisma.street.findMany({ select: { lat: true, lng: true } }) },
    { label: "Microdistrict", rows: await prisma.microdistrict.findMany({ select: { lat: true, lng: true } }) },
    { label: "LivingArea", rows: await prisma.livingArea.findMany({ select: { lat: true, lng: true } }) },
    { label: "Landmark", rows: await prisma.landmark.findMany({ select: { lat: true, lng: true } }) },
  ];
  let totalOutliers = 0;
  for (const t of tables) {
    let outliers = 0;
    for (const row of t.rows) {
      const lat = Number(row.lat);
      const lng = Number(row.lng);
      if (!isInsideDushanbe(lat, lng)) outliers++;
    }
    totalOutliers += outliers;
    console.log(`  ${t.label}: ${t.rows.length} записей, вне bbox Душанбе — ${outliers}`);
  }
  console.log(`  ИТОГО вне bbox: ${totalOutliers}`);

  // 2. Дома без района.
  //    districtId в Building NOT NULL — упасть без района запись физически не
  //    может, поэтому 0 гарантирован структурой таблицы. Дома, которые импорт
  //    не смог привязать, в неё вообще не попали — см. stats.skipped при
  //    самой загрузке ("дом: неизвестный район"). Отдельно считаем здесь,
  //    сколько домов В ИСТОЧНИКЕ ссылаются на район, которого нет в базе —
  //    это то же самое число, посчитанное независимо от лога последней загрузки.
  if (dataDir && fs.existsSync(path.join(dataDir, "дома.json"))) {
    const districts = await prisma.district.findMany({ select: { name: true } });
    const known = new Set(districts.map((d) => d.name));
    const raw = readJsonArray<RawBuilding>(dataDir, "дома.json");
    const unresolvable = raw.filter((r) => !known.has(r["Район"])).length;
    console.log(`  Домов в источнике со неизвестным районом (не попадут/не попали в базу): ${unresolvable}`);
  } else {
    console.log("  Домов без района: папка с исходными файлами недоступна для повторной сверки — пропущено.");
  }
  const buildingsInDb = await prisma.building.count();
  console.log(`  Домов загружено в базу: ${buildingsInDb}`);

  // 3. Незамкнутые полигоны / меньше 4 точек.
  const polygonSources: Array<{ label: string; wkts: (string | null)[] }> = [
    { label: "Building.outline", wkts: (await prisma.building.findMany({ select: { outline: true } })).map((r) => r.outline) },
    { label: "Microdistrict.boundary", wkts: (await prisma.microdistrict.findMany({ select: { boundary: true } })).map((r) => r.boundary) },
    { label: "LivingArea.boundary", wkts: (await prisma.livingArea.findMany({ select: { boundary: true } })).map((r) => r.boundary) },
    { label: "District.boundary", wkts: (await prisma.district.findMany({ select: { boundary: true } })).map((r) => r.boundary) },
  ];
  for (const src of polygonSources) {
    let checked = 0;
    let unclosed = 0;
    let tooFewPoints = 0;
    for (const wkt of src.wkts) {
      if (!wkt) continue;
      const ring = parseWktPolygonRing(wkt);
      if (!ring) continue;
      checked++;
      const issues = polygonIssues(ring);
      if (!issues.closed) unclosed++;
      if (!issues.enoughPoints) tooFewPoints++;
    }
    console.log(`  ${src.label}: полигонов ${checked}, не замкнуто — ${unclosed}, меньше 4 точек — ${tooFewPoints}`);
  }

  // 4. Дубли по sourceId (в источнике — DB это гарантирует уникальным индексом)
  //    и по паре улица+номер (легитимно для нескольких секций одного дома, но
  //    печатаем для информации, не как ошибку).
  if (dataDir) {
    for (const file of ["дома.json", "улицы.json", "микрорайоны.json", "жилые_массивы.json", "районы.json", "ориентиры.json"]) {
      if (!fs.existsSync(path.join(dataDir, file))) continue;
      const raw = readJsonArray<{ id: string }>(dataDir, file);
      const ids = new Map<string, number>();
      for (const r of raw) ids.set(r.id, (ids.get(r.id) ?? 0) + 1);
      const dupCount = [...ids.values()].filter((n) => n > 1).length;
      if (dupCount > 0) console.log(`  ${file}: дублей sourceId в источнике — ${dupCount}`);
    }
  }
  const dupStreetHouse = await prisma.$queryRaw<Array<{ street: string; houseNumber: string; n: bigint }>>`
    SELECT "street", "houseNumber", COUNT(*) AS n
    FROM "Building"
    WHERE "street" IS NOT NULL
    GROUP BY "street", "houseNumber"
    HAVING COUNT(*) > 1
  `;
  console.log(`  Пар улица+номер с более чем одной записью дома: ${dupStreetHouse.length} (норма для домов с несколькими корпусами/секциями)`);

  // 5. Словарь синонимов: сколько по типам, и нет ли конфликтов (один
  //    normalized ведёт на разные targetId одного targetType).
  const aliasCountsByType = await prisma.geoAlias.groupBy({ by: ["targetType"], _count: { _all: true } });
  console.log("  Синонимов по типам:");
  for (const row of aliasCountsByType) {
    console.log(`    ${row.targetType}: ${row._count._all}`);
  }
  const conflicts = await prisma.$queryRaw<Array<{ normalized: string; targetType: string; n: bigint }>>`
    SELECT "normalized", "targetType", COUNT(DISTINCT "targetId") AS n
    FROM "GeoAlias"
    GROUP BY "normalized", "targetType"
    HAVING COUNT(DISTINCT "targetId") > 1
    ORDER BY n DESC
    LIMIT 20
  `;
  console.log(`  Конфликтующих синонимов (один текст → несколько целей одного типа): ${conflicts.length}`);
  for (const c of conflicts) {
    console.log(`    "${c.normalized}" (${c.targetType}) → ${c.n} целей`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function printReport(stats: Stats): void {
  console.log("\n=== ОТЧЁТ ЗАГРУЗКИ ===");
  console.log("Обновлено/создано (upsert не различает — идемпотентность важнее счётчика):");
  for (const [k, v] of Object.entries(stats.updated)) console.log(`  ${k}: ${v}`);
  console.log("Пропущено:");
  const reasons = Object.entries(stats.skipped);
  if (reasons.length === 0) console.log("  (ничего)");
  for (const [reason, examples] of reasons) {
    console.log(`  ${reason}: примеры — ${examples.join("; ")}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes("--check");
  const posArgs = argv.filter((a) => !a.startsWith("--"));
  const dataDir = posArgs[0] ? path.resolve(posArgs[0]) : DEFAULT_DATA_DIR;

  if (checkOnly) {
    await runCheck(fs.existsSync(dataDir) ? dataDir : null);
    return;
  }

  console.log(`Папка данных: ${dataDir}`);
  if (!fs.existsSync(dataDir)) {
    console.error(`Папка не найдена: ${dataDir}. Укажите путь аргументом или положите файлы в .data-geo от корня репозитория.`);
    process.exitCode = 1;
    return;
  }

  const stats = newStats();
  const aliases: AliasRow[] = [];

  await importDistricts(dataDir, stats, aliases);

  // Карта имя района -> id, после того как районы гарантированно в базе с
  // актуальными данными (использует и уже существующие 4 района, если файла
  // не было).
  const allDistricts = await prisma.district.findMany({ select: { id: true, name: true } });
  const districtByName = new Map(allDistricts.map((d) => [d.name, d.id]));

  await importMicrodistricts(dataDir, stats, aliases);
  await importLivingAreas(dataDir, stats, aliases);
  await importStreets(dataDir, stats, aliases, districtByName);
  await importLandmarks(dataDir, stats, aliases, districtByName);
  await importBuildings(dataDir, stats, districtByName);

  await insertAliases(aliases);

  printReport(stats);
  await runCheck(dataDir);
}

main()
  .catch((err) => {
    console.error("[import-geo] упало:", err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
