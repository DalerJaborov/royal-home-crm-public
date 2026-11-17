import { distanceMeters } from "@royal-home/shared";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { MIN_REAL_PURCHASE_TJS } from "../ai/moneyThresholds.js";
import { boundingBoxAround, MAX_DESIRED_PLACE_RADIUS_M, ADAPTIVE_RADIUS_STEPS, MIN_ADAPTIVE_CANDIDATES } from "./geoDistance.js";
import { findDistrictIdByName } from "./districtLookup.js";
import { loadMoneyContext, priceCeilingFilter } from "./money.js";
import { officialDistrictIn, resolveSearchPlace, type ResolvedSearchPlace } from "./searchPlace.js";
import { toSearchTokens, toTokenVariants } from "./searchTokens.js";

/**
 * ПОИСК ОБЪЕКТОВ ДЛЯ СОТРУДНИКА: ОРИЕНТИР + РАДИУС + ПРИЗНАКИ + КОРЗИНА
 * (07.11.2026, «Шабнам не нашла коробку у Ашана и дом у Воданасоса»).
 *
 * ОДНО правило ориентиров на весь продукт: место разбирает `resolveSearchPlace`
 * (тот же код, что у голосового консультанта и чат-бота), радиус по умолчанию — из
 * справочника мест (`radiusFor`), здесь он только расширяется шагами 1×→2×→3×
 * (`ADAPTIVE_RADIUS_STEPS`), пока не наберётся хотя бы три варианта. Объект подходит,
 * если он ближе радиуса ИЛИ в его адресе/ориентире/заголовке/описании встречается
 * название места словами (карточки без координат тоже находятся) ИЛИ он в районе,
 * названном явно.
 *
 * Права НЕ здесь: корзину (`scope` trash/both) открывает вызывающий по общему правилу
 * Корзины (lib/trashAccess.ts; ai/assistant/tools/findPropertiesByPlace.ts).
 *
 * РАЙОН ОТ МОДЕЛИ НЕ ПЕРЕБИВАЕТ МЕСТО (07.11.2026, «дом у Воданасоса» — ответ домами из Сино).
 * Если ориентир разобран (точка на карте или народное название с районом), а модель
 * подставила ДРУГОЙ район, район отбрасывается и это сказано в ответе (`districtIgnored`):
 * иначе «район ИЛИ радиус» отдавал весь чужой район как «рядом с ориентиром». Но если этот
 * район назвал сам человек («школа 5 в Сино»), главнее он: ищем в нём, точку из другого
 * района не берём (`placeOutsideDistrict`). Номер
 * («91 мкр») совпадает в тексте карточки только целым числом: «191 мкр» и «1991» — не он.
 */

export type StaffSearchScope = "live" | "trash" | "both";

/** Сколько удалённых объектов показывать рядом с живыми при поиске «везде». */
export const STAFF_TRASH_SHOWN_WITH_LIVE = 5;

export interface StaffPropertySearchInput {
  /** Ориентир словами человека: «Ашан», «в стороне Воданасоса», «82 мкр». */
  landmark?: string;
  /** Радиус в метрах; пусто — по справочнику мест. */
  radiusM?: number;
  /** Слова адреса/названия/описания. */
  text?: string;
  districtName?: string;
  type?: "APARTMENT" | "HOUSE" | "COMMERCIAL" | "LAND";
  minRooms?: number;
  maxRooms?: number;
  minFloor?: number;
  maxFloor?: number;
  minAreaSqm?: number;
  maxAreaSqm?: number;
  minPrice?: number;
  maxPrice?: number;
  currency?: "TJS" | "USD";
  /** «Коробка»: стадия SHELL ИЛИ слово в описании. */
  shell?: boolean;
  condition?: "NEEDS_REPAIR" | "GOOD" | "EXCELLENT" | "NEW_BUILDING";
  status?: "AVAILABLE" | "RESERVED" | "SOLD" | "WITHDRAWN";
  scope: StaffSearchScope;
  /**
   * Слова самого человека (его вопрос). По ним видно, назвал ли район он сам или район
   * додумала модель (`districtName` приходит от модели). Пусто — смотрим на `landmark`.
   */
  humanText?: string;
  /** Прячет объекты со своей висящей заявкой на удаление (у кого нет properties.delete). */
  hideOwnPendingDeleteFor?: string;
  limit?: number;
}

/** Слова-связки в «около Ашана», «в стороне Воданасоса»: ориентир они не выделяют. */
const LANDMARK_STOPWORDS = new Set([
  "около", "возле", "рядом", "недалеко", "от", "у", "в", "на", "за", "до", "по", "с", "со", "к",
  "стороне", "сторону", "стороны", "сторона", "районе", "район", "области", "напротив", "близко",
  "наздик", "наздики", "назди", "дар", "мухити", "атрофи", "паҳлуи", "пахлуи", "дохили",
  "обьект", "объект", "дом", "хавли", "ховли", "хонаи",
  "мкр", "мкрн", "микр", "микрорайон", "микрорайона", "микрорайоне", "мик",
]);

export function landmarkTokens(landmark: string | undefined): string[] {
  if (!landmark) return [];
  return toSearchTokens(landmark).filter(
    (t) => !LANDMARK_STOPWORDS.has(t.toLowerCase()) && (t.length >= 3 || /^\d{1,3}$/.test(t)),
  );
}

/** Падежное окончание не мешает: «у Ашана» находит «Ашан», «Воданасоса» — «Воданасос». */
function variantsOf(token: string): string[] {
  const base = toTokenVariants(token);
  const stems = base
    .filter((v) => v.length >= 5)
    .map((v) => v.replace(/(ом|ов|ах|ям|ами|ра|да|ро|[аяуюеоиыьй])$/u, ""))
    .filter((v) => v.length >= 4);
  return [...new Set([...base, ...stems])];
}

const SHELL_WORDS = ["коробк", "без ремонта", "черновая", "сухая"];
const TEXT_FIELDS = ["address", "landmark", "title", "description"] as const;

const INCLUDE = {
  district: { select: { name: true } },
  assignedAgent: { select: { fullName: true } },
  deletedBy: { select: { fullName: true } },
} as const;

export type StaffPropertyRow = Prisma.PropertyGetPayload<{ include: typeof INCLUDE }>;

export interface StaffPropertyHit {
  property: StaffPropertyRow;
  distanceM: number | null;
  /** Совпало по словам ориентира в тексте карточки. */
  byText: boolean;
}

export interface StaffPropertySearchResult {
  hits: StaffPropertyHit[];
  totalFound: number;
  liveCount: number;
  trashCount: number;
  placeResolved: boolean;
  placeName: string | null;
  radiusM: number | null;
  /** Радиус пришлось расширить — найденное дальше исходного круга. */
  widened: boolean;
  scopeSearched: StaffSearchScope;
  /** Точки места на карте нет — искали по его району (народное название, например «Воданасос»). */
  zoneOnly?: string;
  /** Район, отброшенный потому, что противоречит району ориентира (его додумала модель). */
  districtIgnored?: string;
  /** Место на карте в другом районе, чем назвал сам человек, — искали в названном районе. */
  placeOutsideDistrict?: string;
  error?: string;
}

function textVariantsClause(tokens: string[]): Prisma.PropertyWhereInput {
  return {
    AND: tokens.map((token) => ({
      OR: variantsOf(token).flatMap((variant) =>
        TEXT_FIELDS.map((f) => ({ [f]: { contains: variant, mode: "insensitive" as const } }) as Prisma.PropertyWhereInput),
      ),
    })),
  };
}

/** Число ищется целым: «91» не находится в «191 мкр» и «1991», но находится в «91 мкр» и «91-й». */
function hayHas(hay: string, variant: string): boolean {
  if (/^\d+$/.test(variant)) return new RegExp(`(^|[^\\d])${variant}(?![\\d])`).test(hay);
  return hay.includes(variant);
}

function textMatches(tokens: string[], values: (string | null | undefined)[]): boolean {
  if (tokens.length === 0) return false;
  const hay = values.filter(Boolean).join(" ").toLowerCase();
  return tokens.every((t) => variantsOf(t).some((v) => hayHas(hay, v.toLowerCase())));
}

export async function searchPropertiesForStaff(input: StaffPropertySearchInput): Promise<StaffPropertySearchResult> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 10), 1), 20);
  const fail = (error: string): StaffPropertySearchResult => ({
    hits: [], totalFound: 0, liveCount: 0, trashCount: 0, placeResolved: false, placeName: null, radiusM: null, widened: false,
    scopeSearched: input.scope, error,
  });

  const priceNamed = (input.minPrice ?? 0) > 0 || (input.maxPrice ?? 0) > 0;
  const statedPrice = Math.max(input.minPrice ?? 0, input.maxPrice ?? 0);
  if (priceNamed && !input.currency && statedPrice < MIN_REAL_PURCHASE_TJS) {
    return fail("Валюта цены не названа, а сумма мала для сомони — спроси человека: «в долларах или в сомони?»");
  }
  const currency = input.currency ?? "TJS";

  let districtId: string | undefined;
  if (input.districtName?.trim()) {
    const name = input.districtName.trim();
    districtId =
      (await findDistrictIdByName(name)) ??
      (await prisma.district.findFirst({ where: { name: { contains: name, mode: "insensitive" } }, select: { id: true } }))?.id;
    if (!districtId) return fail(`Района «${name}» нет в справочнике — уточните название`);
  }

  const hasPlaceQuery = Boolean(input.landmark?.trim());
  const place: ResolvedSearchPlace | null = hasPlaceQuery ? await resolveSearchPlace(input.landmark) : null;
  let point = place?.place ?? null;
  const tokens = landmarkTokens(input.landmark);
  const textTokens = input.text ? toSearchTokens(input.text).filter((t) => t.length >= 2) : [];
  let zoneName = place?.districtName ?? place?.placeDistrictName ?? null;
  // Район против района самого места (см. шапку файла). Кто его назвал — решает:
  //  - модель додумала (в словах человека района нет) — место главнее, район отбрасываем;
  //  - человек сам назвал район («школа 5 в Сино») — главнее он: точку из другого района не
  //    берём, ищем в его районе (по словам ориентира и по району), и это сказано в ответе.
  let districtIgnored: string | undefined;
  let placeOutsideDistrict: string | undefined;
  let humanDistrictOnly = false;
  if (districtId && zoneName) {
    const placeDistrictId = await findDistrictIdByName(zoneName).catch(() => undefined);
    if (placeDistrictId && placeDistrictId !== districtId) {
      const humanSaid = officialDistrictIn(input.humanText ?? input.landmark);
      const humanDistrictId = humanSaid ? await findDistrictIdByName(humanSaid).catch(() => undefined) : undefined;
      if (humanDistrictId === districtId) {
        placeOutsideDistrict = `«${input.landmark!.trim()}» на карте в районе ${zoneName}, а названо ${input.districtName!.trim()} — искала в ${input.districtName!.trim()}`;
        point = null;
        zoneName = null;
        humanDistrictOnly = true;
      } else {
        districtIgnored = input.districtName!.trim();
        districtId = undefined;
      }
    }
  }
  // Народное название без точки на карте («Воданасос»): зацепка — его район.
  let zoneDistrictId: string | undefined;
  if (zoneName && !point && !districtId) zoneDistrictId = await findDistrictIdByName(zoneName).catch(() => undefined);
  const baseRadius = Math.min(Math.max(Math.round(input.radiusM ?? point?.radiusM ?? 2000), 100), MAX_DESIRED_PLACE_RADIUS_M);
  if (hasPlaceQuery && !point && tokens.length === 0 && !districtId && !zoneDistrictId) {
    return fail("Не поняла ориентир — назовите его точнее (улица, заметное здание, микрорайон)");
  }

  const and: Prisma.PropertyWhereInput[] = [];
  if (input.scope === "live") and.push({ deletedAt: null });
  else if (input.scope === "trash") and.push({ deletedAt: { not: null } });
  if (input.hideOwnPendingDeleteFor) {
    and.push({ deleteRequests: { none: { status: "PENDING", requestedById: input.hideOwnPendingDeleteFor } } });
  }
  if (input.status) and.push({ status: input.status });
  if (input.type) and.push({ type: input.type });
  if (input.condition) and.push({ condition: input.condition });
  if (input.minRooms !== undefined || input.maxRooms !== undefined) and.push({ rooms: { gte: input.minRooms, lte: input.maxRooms } });
  if (input.minFloor !== undefined || input.maxFloor !== undefined) and.push({ floor: { gte: input.minFloor, lte: input.maxFloor } });
  if (input.minAreaSqm !== undefined || input.maxAreaSqm !== undefined) and.push({ areaSqm: { gte: input.minAreaSqm, lte: input.maxAreaSqm } });
  if (priceNamed) {
    const usdToTjs = (await loadMoneyContext()).usdToTjs;
    if (input.maxPrice) and.push(priceCeilingFilter(input.maxPrice, currency, usdToTjs));
    if (input.minPrice) {
      const tjsMin = currency === "USD" ? input.minPrice * usdToTjs : input.minPrice;
      const usdMin = currency === "USD" ? input.minPrice : input.minPrice / usdToTjs;
      and.push({ OR: [{ currency: "TJS", price: { gte: tjsMin } }, { currency: "USD", price: { gte: usdMin } }] });
    }
  }
  if (input.shell) {
    and.push({
      OR: [
        { stage: "SHELL" },
        ...SHELL_WORDS.flatMap((w) => [
          { description: { contains: w, mode: "insensitive" as const } },
          { title: { contains: w, mode: "insensitive" as const } },
          { landmark: { contains: w, mode: "insensitive" as const } },
        ]),
      ],
    });
  }
  if (textTokens.length) and.push(textVariantsClause(textTokens));
  // Район без места — жёсткий фильтр; с местом — одна из зацепок («район ИЛИ радиус»).
  // Район, названный самим человеком против района места, — тоже жёсткий (см. выше).
  if (districtId && (!hasPlaceQuery || humanDistrictOnly)) and.push({ districtId });

  let radius = baseRadius;
  let hits: StaffPropertyHit[] = [];
  const steps: readonly number[] = point ? ADAPTIVE_RADIUS_STEPS : [1];
  for (const step of steps) {
    radius = Math.min(baseRadius * step, MAX_DESIRED_PLACE_RADIUS_M);
    const placeOr: Prisma.PropertyWhereInput[] = [];
    if (point) {
      const box = boundingBoxAround(point.lat, point.lng, radius);
      placeOr.push({ lat: { gte: box.minLat, lte: box.maxLat }, lng: { gte: box.minLng, lte: box.maxLng } });
    }
    if (tokens.length) placeOr.push(textVariantsClause(tokens));
    if (hasPlaceQuery && (districtId ?? zoneDistrictId)) placeOr.push({ districtId: (districtId ?? zoneDistrictId)! });
    const rows = await prisma.property.findMany({
      where: { AND: hasPlaceQuery && placeOr.length ? [...and, { OR: placeOr }] : and },
      include: INCLUDE,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 500,
    });
    hits = rows
      .map((p): StaffPropertyHit => {
        const lat = p.lat != null ? Number(p.lat) : NaN;
        const lng = p.lng != null ? Number(p.lng) : NaN;
        const distanceM =
          point && Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0
            ? Math.round(distanceMeters(point.lat, point.lng, lat, lng))
            : null;
        return { property: p, distanceM, byText: textMatches(tokens, [p.address, p.landmark, p.title, p.description]) };
      })
      .filter((h) => {
        if (!hasPlaceQuery) return true;
        if (h.byText) return true;
        if (h.distanceM !== null && h.distanceM <= radius) return true;
        const zone = districtId ?? zoneDistrictId;
        return Boolean(zone) && h.property.districtId === zone;
      });
    if (hits.length >= MIN_ADAPTIVE_CANDIDATES || !point) break;
  }

  hits.sort((a, b) => {
    // Есть точка на карте — ближе выше; нет точки — совпавшие словами выше.
    if (!point && a.byText !== b.byText) return a.byText ? -1 : 1;
    const da = a.distanceM ?? Number.MAX_SAFE_INTEGER;
    const db = b.distanceM ?? Number.MAX_SAFE_INTEGER;
    return da - db || b.property.createdAt.getTime() - a.property.createdAt.getTime();
  });
  // Живые выше удалённых, и предел у них свой: Корзина не вытесняет живые из выдачи.
  // Удалённых при поиске «везде» — не больше пяти (сколько их всего — в trashCount).
  const liveHits = hits.filter((h) => h.property.deletedAt === null);
  const trashHits = hits.filter((h) => h.property.deletedAt !== null);
  const trashLimit = input.scope === "trash" ? limit : Math.min(limit, STAFF_TRASH_SHOWN_WITH_LIVE);
  const shown = [...liveHits.slice(0, limit), ...trashHits.slice(0, trashLimit)];
  return {
    hits: shown,
    totalFound: hits.length,
    // Счётчики — по ВСЕМУ найденному, а не по обрезанной выдаче: иначе «в Корзине 0» врёт.
    liveCount: liveHits.length,
    trashCount: trashHits.length,
    placeResolved: Boolean(point) || Boolean(zoneDistrictId),
    placeName: point?.name ?? null,
    radiusM: point ? radius : null,
    widened: Boolean(point) && radius > baseRadius,
    scopeSearched: input.scope,
    ...(!point && zoneDistrictId
      ? { zoneOnly: `Точки «${input.landmark!.trim()}» на карте нет — искала по его району (${zoneName}) и по словам в карточках` }
      : {}),
    ...(districtIgnored ? { districtIgnored: `Район «${districtIgnored}» не совпадает с районом места — искала по месту` } : {}),
    ...(placeOutsideDistrict ? { placeOutsideDistrict } : {}),
  };
}
