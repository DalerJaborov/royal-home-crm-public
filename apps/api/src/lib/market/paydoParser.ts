/**
 * РАЗБОР ОБЪЯВЛЕНИЙ Paydo.tj (JSON API api.paydo.tj, ТОЛЬКО ЧТЕНИЕ).
 *
 * Форма ответа снята с живого API 02.11.2026: `POST /api/v1/search/` отдаёт
 * `advertisements.advertisements[]`. Все нужные для оценки поля лежат уже в
 * СПИСКЕ — в массиве `characteristics` пар «название → значение» на русском.
 * Читаем по названию характеристики, а не по позиции: порядок у объявлений
 * разный, а набор зависит от типа объекта (у домов нет площади и этажа).
 *
 * Чистая функция: без сети и без базы. Нет цены или площади — это не повод
 * выбрасывать объявление здесь; такие отсеивает marketStore.
 */

import { normalizeDistrictName } from "./districtName.js";
import type { ParsedListing, SomonRawAd } from "./somonParser.js";

export const PAYDO_SOURCE = "paydo.tj";

export interface PaydoCharacteristic {
  name?: string;
  value?: string | null;
}

export interface PaydoRawAd {
  id: number;
  subcategory_id?: number;
  title?: string;
  subtitle1?: string | null;
  subtitle2?: string | null;
  price?: string | number | null;
  slug?: string;
  share_url?: string;
  promotion_type?: string | null;
  status?: string;
  images?: Array<{ url?: string }>;
  media?: Array<{ url?: string; type?: string }>;
  characteristics?: PaydoCharacteristic[];
  description_fields?: Array<{ title?: string; text?: string | null }>;
  details?: {
    location?: { address?: string | null; latitude?: number | null; longitude?: number | null } | null;
  } | null;
  publisher_info?: { id?: number | string; name?: string | null; is_verified?: boolean; marketplace?: unknown } | null;
}

/** 201 — квартиры (продажа), 203 — дома и хавли. */
export type PaydoSubcategory = 201 | 203;

const DUSHANBE_OFFSET_MS = 5 * 3600_000;

function chars(ad: PaydoRawAd): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of ad.characteristics ?? []) {
    if (c.name && typeof c.value === "string" && c.value.trim()) map.set(c.name.trim(), c.value.trim());
  }
  return map;
}

function num(text: string | undefined): number | null {
  if (!text) return null;
  const m = text.replace(/\s/g, "").replace(",", ".").match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) ? v : null;
}

/** «Без ремонта / Коробка» → SHELL и т. д.; незнакомое значение → null, а не выдумка. */
export function mapRepair(text: string | undefined): ParsedListing["repair"] {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes("дизайн")) return "DESIGNER";
  if (t.includes("предчист")) return "WHITE";
  if (t.includes("коробк") || t.includes("без ремонта")) return "SHELL";
  if (t.includes("средн") || t.includes("косметич")) return "PARTIAL";
  if (t.includes("евро") || t.includes("с ремонтом")) return "RENOVATED";
  return null;
}

/** «Сегодня, 10:57» / «Вчера, 09:00» / «01.07.2026, 11:40» → Date (время Душанбе, UTC+5). */
export function parsePaydoDate(text: string | undefined, now: Date = new Date()): Date | null {
  if (!text) return null;
  const time = text.match(/(\d{1,2}):(\d{2})\s*$/);
  const hh = time ? Number(time[1]) : 0;
  const mm = time ? Number(time[2]) : 0;
  const local = new Date(now.getTime() + DUSHANBE_OFFSET_MS); // «настенные» часы Душанбе в UTC-полях
  let y: number, mo: number, d: number;
  const abs = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (abs) {
    d = Number(abs[1]);
    mo = Number(abs[2]) - 1;
    y = Number(abs[3]);
  } else if (/сегодня/i.test(text)) {
    y = local.getUTCFullYear();
    mo = local.getUTCMonth();
    d = local.getUTCDate();
  } else if (/вчера/i.test(text)) {
    const yest = new Date(local.getTime() - 86_400_000);
    y = yest.getUTCFullYear();
    mo = yest.getUTCMonth();
    d = yest.getUTCDate();
  } else {
    return null;
  }
  const ts = Date.UTC(y, mo, d, hh, mm) - DUSHANBE_OFFSET_MS;
  return Number.isFinite(ts) ? new Date(ts) : null;
}

function yesNo(text: string | undefined): boolean | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t === "да") return true;
  if (t === "нет") return false;
  return null;
}

function mapReady(text: string | undefined): boolean | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes("строится") || t.includes("строител")) return false;
  if (t.includes("готов") || t.includes("сдан")) return true;
  return null;
}

/** «Душанбе | И. Сомони» → район после черты, сведённый к названию справочника; нет черты — null. */
export function districtOf(subtitle2: string | null | undefined): string | null {
  if (!subtitle2) return null;
  const parts = subtitle2.split("|").map((s) => s.trim());
  return parts.length > 1 && parts[1] ? normalizeDistrictName(parts[1]) : null;
}

export function parsePaydoAd(
  ad: PaydoRawAd,
  subcategory: PaydoSubcategory,
  now: Date = new Date()
): ParsedListing | null {
  if (!ad || ad.id == null) return null;
  const c = chars(ad);
  const isHouse = subcategory === 203;

  const priceNum = num(typeof ad.price === "number" ? String(ad.price) : ad.price ?? undefined);
  const price = priceNum != null && priceNum > 0 ? priceNum : null;
  const currency = /USD|\$/i.test(ad.subtitle1 ?? "") ? "USD" : "TJS";

  // Этаж: у квартир «9 из 18»; у домов «Количество этажей» — это этажность дома, не этаж квартиры.
  let floor: number | null = null;
  let totalFloors: number | null = null;
  const floorText = c.get("Этаж");
  if (floorText) {
    const m = floorText.match(/(\d+)\s*(?:из\s*(\d+))?/);
    if (m) {
      floor = Number(m[1]);
      totalFloors = m[2] ? Number(m[2]) : null;
    }
  }
  if (isHouse) totalFloors = totalFloors ?? num(c.get("Количество этажей"));

  const buildingKind = c.get("Тип");
  const location = ad.details?.location ?? null;
  const published = c.get("Дата публикации");
  const sellerId = ad.publisher_info?.id != null ? String(ad.publisher_info.id) : null;
  const images = (ad.images ?? []).map((i) => i.url).filter((u): u is string => !!u);
  const sourceUrl = ad.share_url || (ad.slug ? `https://paydo.tj/advertisement/${ad.slug}` : `https://paydo.tj/advertisement/${ad.id}`);

  // Компактный raw в форме, совместимой с общим типом (не тащим в базу описание и профиль продавца).
  const raw: SomonRawAd = {
    id: ad.id,
    title: ad.title,
    url: sourceUrl,
    price: ad.subtitle1 ?? undefined,
    price_without_currency: price != null ? String(price) : undefined,
    currency,
    published,
    location: ad.subtitle2 ?? undefined,
    img_count: images.length,
    images: images.slice(0, 3),
    user: sellerId ? { id: Number(sellerId) || undefined, name: ad.publisher_info?.name ?? undefined } : undefined,
  };

  return {
    sourceId: String(ad.id),
    sourceUrl,
    title: ad.title ?? "",
    rooms: num(c.get("Количество комнат")),
    areaSqm: num(c.get("Общая площадь")),
    floor,
    totalFloors,
    landmark: location?.address?.trim() || null,
    districtName: districtOf(ad.subtitle2),
    description: (ad.description_fields ?? []).map((d) => d.text ?? "").filter(Boolean).join("\n") || null,
    city: "Душанбе",
    price,
    currency,
    negotiable: yesNo(c.get("Торг")) ?? false,
    sellerId,
    sellerName: ad.publisher_info?.name?.trim() || null,
    // Оценка: у Paydo нет признака «агентство» в списке; профиль-магазин (marketplace) — ближайший.
    isAgency: Boolean(ad.publisher_info?.marketplace),
    photoCount: images.length,
    hasVideo: (ad.media ?? []).some((m) => m.type === "VIDEO"),
    isPromoted: !!ad.promotion_type,
    publishedText: published ?? null,
    publishedAt: parsePaydoDate(published, now),
    repair: mapRepair(c.get("Ремонт")),
    buildingType: isHouse ? c.get("Тип дома") ?? null : buildingKind ?? null,
    isNewBuilding: isHouse ? null : buildingKind ? /новостро/i.test(buildingKind) : null,
    buildingReady: mapReady(c.get("Готовность дома")),
    exchangePossible: yesNo(c.get("Обмен")),
    latitude: typeof location?.latitude === "number" ? location.latitude : null,
    longitude: typeof location?.longitude === "number" ? location.longitude : null,
    dealType: "SALE",
    propertyType: isHouse ? "HOUSE" : "APARTMENT",
    raw,
  };
}
