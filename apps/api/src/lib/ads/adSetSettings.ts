import { prisma } from "../../db.js";
import { Prisma } from "../../generated/prisma/client.js";

/**
 * НАСТРОЙКИ ГРУППЫ ОБЪЯВЛЕНИЙ ИЗ META → ТАБЛИЦА AdSetSettings (04.10.2026).
 *
 * Сырьё для базы «какие настройки давали какую цену переписки» (читателя сейчас нет:
 * «Студия запуска рекламы» убрана 12.10.2026, данные копятся на будущее). ТОЛЬКО ЧТЕНИЕ:
 * ничего в Meta не запускается и не меняется.
 *
 * Здесь два слоя. parseAdSetSettings — чистая функция «ответ Graph → наши поля», без
 * базы и сети: на ней держатся тесты фикстурами. saveAdSetSettings — запись в базу.
 * Сам запрос к Graph живёт рядом с остальными рекламными запросами (metaAdsApi.ts).
 */

/**
 * Группа объявлений в том виде, как её отдаёт Graph (`/{act}/adsets`). Поля сверены с
 * Marketing API reference/ad-campaign (04.10.2026). Бюджеты Meta отдаёт СТРОКАМИ и в
 * минимальных единицах валюты кабинета (центы) — подтверждено страницей Budgets.
 */
export interface GraphAdSet {
  id: string;
  name?: string;
  daily_budget?: string | number;
  lifetime_budget?: string | number;
  budget_remaining?: string | number;
  bid_strategy?: string;
  billing_event?: string;
  optimization_goal?: string;
  destination_type?: string;
  promoted_object?: Record<string, unknown>;
  start_time?: string;
  end_time?: string;
  targeting?: GraphTargeting;
}

interface GraphGeoPlace {
  key?: string;
  name?: string;
  radius?: number;
  distance_unit?: string;
  country?: string;
  country_code?: string;
  region?: string;
  latitude?: number;
  longitude?: number;
  address_string?: string;
}

interface GraphGeoLocations {
  countries?: string[];
  regions?: GraphGeoPlace[];
  cities?: GraphGeoPlace[];
  custom_locations?: GraphGeoPlace[];
  location_types?: string[];
}

export interface GraphTargeting {
  geo_locations?: GraphGeoLocations;
  age_min?: number;
  age_max?: number;
  genders?: number[];
  publisher_platforms?: string[];
  facebook_positions?: string[];
  instagram_positions?: string[];
  messenger_positions?: string[];
  audience_network_positions?: string[];
  targeting_automation?: { advantage_audience?: number | boolean; individual_setting?: Record<string, unknown> };
  custom_audiences?: unknown[];
  excluded_custom_audiences?: unknown[];
  flexible_spec?: unknown[];
  locales?: number[];
}

export type GeoScope = "TJ" | "DUSHANBE" | "OTHER" | "MIXED";

/** Разобранные настройки — один в один колонки AdSetSettings (без adId и syncedAt). */
export interface ParsedAdSetSettings {
  adsetId: string;
  destination: string | null;
  optimizationGoal: string | null;
  bidStrategy: string | null;
  billingEvent: string | null;
  dailyBudgetCents: number | null;
  lifetimeBudgetCents: number | null;
  startAt: Date | null;
  endAt: Date | null;
  durationDays: number | null;
  geoScope: GeoScope | null;
  geoRaw: Prisma.InputJsonValue | null;
  ageMin: number | null;
  ageMax: number | null;
  genders: number[];
  advantageAudience: boolean | null;
  placementsMode: "AUTOMATIC" | "MANUAL" | null;
  platforms: string[];
  promotedObject: Prisma.InputJsonValue | null;
  rawTargeting: Prisma.InputJsonValue | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Целое Postgres INTEGER: больше не кладём (бюджет в сотых доли валюты не должен до него доходить). */
const INT4_MAX = 2_147_483_647;
/** Сколько мест каждого вида кладём в урезанные копии: больше — шум, а не сигнал. */
const MAX_PLACES = 10;

/** «500», 500, "" → число; мусор и переполнение → null. */
function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > INT4_MAX) return null;
  return Math.round(n);
}

/** Дата из ответа Meta («2026-10-02T12:00:00+0500»); пусто и мусор → null. */
function toDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

/**
 * Душанбе ли это место. По названию (город и подписанная точка) или, у точки на карте
 * («булавка» на улице — самый частый вид гео в кабинете агентства), по координатам: рамка
 * вокруг города с запасом на Вахдат и Гиссар. Страна обязана быть Таджикистаном, если указана.
 */
export function isDushanbePlace(p: GraphGeoPlace): boolean {
  const country = p.country ?? p.country_code;
  if (country && country !== "TJ") return false;
  const label = `${p.name ?? ""} ${p.address_string ?? ""}`;
  if (/dushanbe|душанбе|dushanbé/i.test(label)) return true;
  if (typeof p.latitude === "number" && typeof p.longitude === "number") {
    return p.latitude >= 38.4 && p.latitude <= 38.7 && p.longitude >= 68.6 && p.longitude <= 68.95;
  }
  return false;
}

/**
 * Куда показывается реклама: "TJ" (вся страна), "DUSHANBE" (город или точка в нём),
 * "OTHER" (любое другое место, включая другие города Таджикистана и другие страны),
 * "MIXED" (несколько разных видов сразу). Страна целиком покрывает свои города: «TJ +
 * точка в Душанбе» остаётся "TJ". null — гео не задано/не прочитано.
 */
export function classifyGeoScope(geo: GraphGeoLocations | undefined): GeoScope | null {
  if (!geo) return null;
  const kinds = new Set<"TJ" | "DUSHANBE" | "OTHER">();
  for (const c of strings(geo.countries)) kinds.add(c === "TJ" ? "TJ" : "OTHER");
  for (const place of [...(geo.cities ?? []), ...(geo.custom_locations ?? []), ...(geo.regions ?? [])]) {
    kinds.add(isDushanbePlace(place) ? "DUSHANBE" : "OTHER");
  }
  if (kinds.size === 0) return null;
  if (kinds.has("TJ") && kinds.size === 2 && kinds.has("DUSHANBE")) return "TJ";
  if (kinds.size === 1) return Array.from(kinds)[0];
  return "MIXED";
}

function trimPlace(p: GraphGeoPlace): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["key", "name", "radius", "distance_unit", "country", "country_code", "latitude", "longitude"] as const) {
    if (p[k] !== undefined) out[k] = p[k];
  }
  return out;
}

function trimGeo(geo: GraphGeoLocations | undefined): Prisma.InputJsonValue | null {
  if (!geo) return null;
  const out: Record<string, unknown> = {};
  const countries = strings(geo.countries);
  if (countries.length > 0) out.countries = countries.slice(0, MAX_PLACES);
  const types = strings(geo.location_types);
  if (types.length > 0) out.location_types = types;
  for (const key of ["regions", "cities", "custom_locations"] as const) {
    const list = geo[key];
    if (Array.isArray(list) && list.length > 0) out[key] = list.slice(0, MAX_PLACES).map(trimPlace);
  }
  return Object.keys(out).length > 0 ? (out as Prisma.InputJsonValue) : null;
}

/**
 * Урезанный таргетинг для хранения: всё, что влияет на цену и читается человеком, и
 * ничего лишнего. Пользовательские аудитории и интересы поимённо не храним (это данные
 * о клиентах агентства и громоздко) — только сколько их.
 */
function trimTargeting(t: GraphTargeting): Prisma.InputJsonValue | null {
  const out: Record<string, unknown> = {};
  const geo = trimGeo(t.geo_locations);
  if (geo) out.geo_locations = geo;
  if (t.age_min !== undefined) out.age_min = t.age_min;
  if (t.age_max !== undefined) out.age_max = t.age_max;
  if (Array.isArray(t.genders) && t.genders.length > 0) out.genders = t.genders;
  for (const key of [
    "publisher_platforms",
    "facebook_positions",
    "instagram_positions",
    "messenger_positions",
    "audience_network_positions",
  ] as const) {
    const list = strings(t[key]);
    if (list.length > 0) out[key] = list;
  }
  if (t.targeting_automation) out.targeting_automation = t.targeting_automation;
  if (Array.isArray(t.locales) && t.locales.length > 0) out.locales = t.locales;
  if (Array.isArray(t.custom_audiences) && t.custom_audiences.length > 0) out.custom_audiences_count = t.custom_audiences.length;
  if (Array.isArray(t.excluded_custom_audiences) && t.excluded_custom_audiences.length > 0) {
    out.excluded_custom_audiences_count = t.excluded_custom_audiences.length;
  }
  if (Array.isArray(t.flexible_spec) && t.flexible_spec.length > 0) out.flexible_spec_count = t.flexible_spec.length;
  return Object.keys(out).length > 0 ? (out as Prisma.InputJsonValue) : null;
}

/** Срок показа в сутках (вверх). Нет начала или конца, либо конец не позже начала — null. */
export function durationDaysOf(start: Date | null, end: Date | null): number | null {
  if (!start || !end) return null;
  const ms = end.getTime() - start.getTime();
  if (ms <= 0) return null;
  return Math.max(1, Math.ceil(ms / DAY_MS));
}

/** Ответ Graph → наши поля. Чистая функция: ни базы, ни сети, ни исключений на кривом вводе. */
export function parseAdSetSettings(raw: GraphAdSet): ParsedAdSetSettings {
  const t = raw.targeting;
  const startAt = toDate(raw.start_time);
  const endAt = toDate(raw.end_time);

  const advantageRaw = t?.targeting_automation?.advantage_audience;
  const advantageAudience = advantageRaw === undefined || advantageRaw === null ? null : advantageRaw === 1 || advantageRaw === true;

  const platforms = strings(t?.publisher_platforms);
  const hasPositions = [
    t?.facebook_positions,
    t?.instagram_positions,
    t?.messenger_positions,
    t?.audience_network_positions,
  ].some((p) => strings(p).length > 0);
  const placementsMode = t ? (platforms.length > 0 || hasPositions ? "MANUAL" : "AUTOMATIC") : null;

  return {
    adsetId: raw.id,
    destination: raw.destination_type ?? null,
    optimizationGoal: raw.optimization_goal ?? null,
    bidStrategy: raw.bid_strategy ?? null,
    billingEvent: raw.billing_event ?? null,
    dailyBudgetCents: toInt(raw.daily_budget),
    lifetimeBudgetCents: toInt(raw.lifetime_budget),
    startAt,
    endAt,
    durationDays: durationDaysOf(startAt, endAt),
    geoScope: classifyGeoScope(t?.geo_locations),
    geoRaw: trimGeo(t?.geo_locations),
    ageMin: toInt(t?.age_min),
    ageMax: toInt(t?.age_max),
    genders: Array.isArray(t?.genders) ? t.genders.filter((g) => g === 1 || g === 2) : [],
    advantageAudience,
    placementsMode,
    platforms,
    promotedObject: raw.promoted_object && Object.keys(raw.promoted_object).length > 0 ? (raw.promoted_object as Prisma.InputJsonValue) : null,
    rawTargeting: t ? trimTargeting(t) : null,
  };
}

/**
 * Записать настройки объявления (одна строка на объявление, перезапись каждым прогоном).
 *
 * `partial` — группа прочитана по ОБЛЕГЧЁННОМУ набору полей (Meta отказала на targeting):
 * таргетинг и аудитория в этом ответе неизвестны, поэтому уже записанные раньше значения
 * НЕ затираются пустыми — обновляются только поля, которые облегчённый набор отдаёт.
 */
export async function saveAdSetSettings(
  adId: string,
  parsed: ParsedAdSetSettings,
  partial = false,
  /** Валюта кабинета: в ней Meta отдаёт бюджеты. Не передана — колонку не трогаем. */
  currency: "USD" | "TJS" | null = null
): Promise<void> {
  const base = {
    adsetId: parsed.adsetId,
    ...(currency ? { currency } : {}),
    destination: parsed.destination,
    optimizationGoal: parsed.optimizationGoal,
    bidStrategy: parsed.bidStrategy,
    billingEvent: parsed.billingEvent,
    dailyBudgetCents: parsed.dailyBudgetCents,
    lifetimeBudgetCents: parsed.lifetimeBudgetCents,
    startAt: parsed.startAt,
    endAt: parsed.endAt,
    durationDays: parsed.durationDays,
  };
  const targeting = {
    geoScope: parsed.geoScope,
    geoRaw: parsed.geoRaw ?? Prisma.DbNull,
    ageMin: parsed.ageMin,
    ageMax: parsed.ageMax,
    genders: parsed.genders,
    advantageAudience: parsed.advantageAudience,
    placementsMode: parsed.placementsMode,
    platforms: parsed.platforms,
    promotedObject: parsed.promotedObject ?? Prisma.DbNull,
    rawTargeting: parsed.rawTargeting ?? Prisma.DbNull,
  };
  await prisma.adSetSettings.upsert({
    where: { adId },
    create: { adId, ...base, ...targeting },
    update: partial ? base : { ...base, ...targeting },
  });
}
