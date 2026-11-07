import { distanceMeters } from "@royal-home/shared";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { MIN_REAL_PURCHASE_TJS } from "../ai/moneyThresholds.js";
import { boundingBoxAround, MAX_DESIRED_PLACE_RADIUS_M, ADAPTIVE_RADIUS_STEPS, MIN_ADAPTIVE_CANDIDATES } from "./geoDistance.js";
import { findDistrictIdByName } from "./districtLookup.js";
import { loadMoneyContext, priceCeilingFilter } from "./money.js";
import { resolveSearchPlace, type ResolvedSearchPlace } from "./searchPlace.js";
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
 * Права НЕ здесь: корзину (`scope` trash/both) открывает только вызывающий, который
 * проверил `archive.view` (ai/assistant/tools/findPropertiesByPlace.ts).
 */

export type StaffSearchScope = "live" | "trash" | "both";

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

function textMatches(tokens: string[], values: (string | null | undefined)[]): boolean {
  if (tokens.length === 0) return false;
  const hay = values.filter(Boolean).join(" ").toLowerCase();
  return tokens.every((t) => variantsOf(t).some((v) => hay.includes(v)));
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
  const point = place?.place ?? null;
  const tokens = landmarkTokens(input.landmark);
  const textTokens = input.text ? toSearchTokens(input.text).filter((t) => t.length >= 2) : [];
  // Народное название без точки на карте («Воданасос»): зацепка — его район.
  let zoneDistrictId: string | undefined;
  const zoneName = place?.districtName ?? place?.placeDistrictName ?? null;
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
  if (districtId && !hasPlaceQuery) and.push({ districtId });

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
  const shown = hits.slice(0, limit);
  return {
    hits: shown,
    totalFound: hits.length,
    // Счётчики — по ВСЕМУ найденному, а не по обрезанной выдаче: иначе «в Корзине 0» врёт.
    liveCount: hits.filter((h) => h.property.deletedAt === null).length,
    trashCount: hits.filter((h) => h.property.deletedAt !== null).length,
    placeResolved: Boolean(point) || Boolean(zoneDistrictId),
    placeName: point?.name ?? null,
    radiusM: point ? radius : null,
    widened: Boolean(point) && radius > baseRadius,
    scopeSearched: input.scope,
  };
}
