import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { loadMoneyContext } from "./money.js";
import { crmPublicBase } from "./crmPublicUrl.js";
import { siteHomeUrl } from "./siteListingUrl.js";
import { logSystemError } from "./systemError.js";

/**
 * ФИД КАТАЛОГА META ДЛЯ РЕКЛАМЫ (Advantage+ catalog ads, вертикаль `home_listings`,
 * 28.09.2026, docs/agent-briefs/meta-catalog-feed-28-09.md).
 *
 * Meta забирает CSV по расписанию (раз в час/день) по адресу
 * GET /api/v1/public/meta-catalog/home-listings.csv?key=... (routes/publicFeed.ts).
 * Здесь — только сбор данных и рендер строки, без HTTP.
 *
 * ТОЧНЫЙ АДРЕС И ЭТАЖ НА ПУБЛИЧНЫЕ ПОВЕРХНОСТИ НЕ ВЫДАЮТСЯ (решение владельца,
 * docs/journal/2026-09-24-publichnaya-ssylka-bez-tochnogo-adresa.md): `addr1` и
 * `neighborhood[0]` — название района, не улица/дом.
 *
 * АРЕНДЫ В КАТАЛОГЕ НЕТ: агентство ею не занимается (решение владельца 11.09.2026,
 * см. enum MarketType в schema.prisma — там нет и не будет оси аренды), поэтому
 * `listing_type` у каждой строки всегда `for_sale` — честно, а не догадкой по
 * marketType/stage, у которых просто нет значения «аренда».
 */

/** Сколько колонок с картинками отдаёт Meta для home_listings (её собственный предел). */
export const META_CATALOG_MAX_IMAGES = 20;

/** Живёт SOLD-объект в каталоге ровно столько дней после продажи (задание, п.4 «Факты о коде»). */
const SOLD_RECENT_DAYS = 30;

/** Сколько минут строки фида живут в памяти, не пересчитываясь на каждый запрос Meta. */
const CACHE_TTL_MS = 10 * 60 * 1000;

export type CatalogProperty = Prisma.PropertyGetPayload<{
  include: { district: true; photos: { orderBy: { order: "asc" } } };
}>;

export interface HomeListingRow {
  home_listing_id: string;
  name: string;
  description: string;
  availability: "for_sale" | "sold";
  addr1: string;
  city: string;
  region: string;
  country: string;
  postal_code: string;
  latitude: string;
  longitude: string;
  neighborhood: string;
  /** До META_CATALOG_MAX_IMAGES штук, первой идёт квадратная обложка (как на сайте,
   *  см. lib/siteSync.ts::siteImageUrls) — тот же приём, другой потолок. */
  images: string[];
  listing_type: "for_sale";
  /** Строка вида "450000 TJS" — формат Meta для home_listings. */
  price: string;
  url: string;
  num_beds: string;
  /** Нет колонки о санузлах в Property — честно пусто, а не выдумка (Zod/схема не хранит это поле). */
  num_baths: string;
  property_type: "apartment" | "house" | "land" | "other";
  /** Нет года постройки в Property — честно пусто. */
  year_built: string;
  custom_label_0: string;
}

const CSV_HEADER_FIXED_BEFORE_IMAGES = [
  "home_listing_id",
  "name",
  "description",
  "availability",
  "address.addr1",
  "address.city",
  "address.region",
  "address.country",
  "address.postal_code",
  "latitude",
  "longitude",
  "neighborhood[0]",
] as const;

const CSV_HEADER_FIXED_AFTER_IMAGES = [
  "listing_type",
  "price",
  "url",
  "num_beds",
  "num_baths",
  "property_type",
  "year_built",
  "custom_label_0",
] as const;

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * CSV с заголовком, запятой, `\r\n` (формат Meta). Ширина колонок image[N].url
 * считается ОДИН РАЗ по самой длинной строке (не всегда META_CATALOG_MAX_IMAGES) —
 * у остальных строк недостающие клетки просто пустые, как и разрешает документация
 * («пустые значения допустимы»).
 */
export function renderHomeListingCsv(rows: HomeListingRow[]): string {
  const maxImages = rows.reduce((max, r) => Math.max(max, r.images.length), 0);
  const imageHeaders = Array.from({ length: maxImages }, (_, i) => `image[${i}].url`);
  const header = [...CSV_HEADER_FIXED_BEFORE_IMAGES, ...imageHeaders, ...CSV_HEADER_FIXED_AFTER_IMAGES];

  const lines = rows.map((r) => {
    const images = Array.from({ length: maxImages }, (_, i) => r.images[i] ?? "");
    const cells = [
      r.home_listing_id,
      r.name,
      r.description,
      r.availability,
      r.addr1,
      r.city,
      r.region,
      r.country,
      r.postal_code,
      r.latitude,
      r.longitude,
      r.neighborhood,
      ...images,
      r.listing_type,
      r.price,
      r.url,
      r.num_beds,
      r.num_baths,
      r.property_type,
      r.year_built,
      r.custom_label_0,
    ];
    return cells.map(csvCell).join(",");
  });

  return [header.map(csvCell).join(","), ...lines].join("\r\n");
}

function toPropertyType(type: CatalogProperty["type"]): HomeListingRow["property_type"] {
  switch (type) {
    case "APARTMENT":
      return "apartment";
    case "HOUSE":
      return "house";
    case "LAND":
      return "land";
    default:
      // COMMERCIAL и любой будущий вид — Meta такого значения не знает.
      return "other";
  }
}

function toAvailability(status: CatalogProperty["status"]): HomeListingRow["availability"] | null {
  if (status === "AVAILABLE" || status === "RESERVED") return "for_sale";
  if (status === "SOLD") return "sold";
  return null;
}

/** Квадратная обложка первой, затем фото по порядку — тот же приём, что и на
 *  сайте (siteImageUrls), но со своим потолком и без чтения окружения внутри:
 *  crmBase приходит параметром, чтобы функция оставалась чистой и проверяемой. */
function catalogImageUrls(property: CatalogProperty, crmBase: string): string[] {
  const photoUrls = property.photos.flatMap((p) => (p.url.startsWith("/uploads/") ? [`${crmBase}${p.url}`] : []));
  const cover =
    property.socialCoverSquareUrl && property.socialCoverSquareUrl.startsWith("/uploads/")
      ? `${crmBase}${property.socialCoverSquareUrl}`
      : null;
  const urls = cover ? [cover, ...photoUrls.filter((u) => u !== cover)] : photoUrls;
  return urls.slice(0, META_CATALOG_MAX_IMAGES);
}

export interface BuildHomeListingRowsOptions {
  /** Публичный адрес сайта royalhome.tj (без хвостового слэша) — для колонки `url`. */
  siteBase: string;
  /** Публичный адрес CRM (без хвостового слэша), откуда отдаются `/uploads/...`
   *  фото. undefined — CRM_PUBLIC_URL не настроен: без него нет ни одной
   *  ссылки на фото, а Meta требует хотя бы одну, поэтому такие объекты
   *  честно выпадают из фида (та же логика, что и с координатами ниже). */
  crmBase: string | undefined;
  /** Курс USD→TJS (Settings.usdToTjsRate, с тем же запасным значением, что и
   *  везде в CRM — см. lib/money.ts::loadMoneyContext). Объекты в TJS его не используют. */
  usdToTjsRate: number;
}

/**
 * Строки фида из объектов — ЧИСТАЯ ФУНКЦИЯ: никакого обращения к БД или
 * process.env внутри, только данные и параметры. Объект пропускается (не
 * попадает в результат), если ему нечем закрыть обязательное поле Meta:
 * координаты (широта/долгота) или хотя бы одна картинка.
 */
export function buildHomeListingRows(
  properties: CatalogProperty[],
  { siteBase, crmBase, usdToTjsRate }: BuildHomeListingRowsOptions
): HomeListingRow[] {
  const rows: HomeListingRow[] = [];

  for (const property of properties) {
    const availability = toAvailability(property.status);
    if (!availability) continue;

    // Координаты объекта, а если их нет — центр района (задание, п. «Факты о коде»).
    const lat = property.lat != null ? Number(property.lat) : property.district?.lat != null ? Number(property.district.lat) : null;
    const lng = property.lng != null ? Number(property.lng) : property.district?.lng != null ? Number(property.district.lng) : null;
    if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const images = crmBase ? catalogImageUrls(property, crmBase) : [];
    if (images.length === 0) continue;

    const priceNum =
      property.currency === "USD" ? Math.round(Number(property.price) * usdToTjsRate) : Math.round(Number(property.price));
    if (!Number.isFinite(priceNum)) continue;

    const districtName = property.district?.name ?? "";
    const url =
      property.siteListingId != null ? `${siteBase}/listing/${property.siteListingId}` : `${siteBase}/listing/by-crm/${property.id}`;

    rows.push({
      home_listing_id: String(property.shortId),
      name: property.title,
      description: property.description ?? "",
      availability,
      addr1: districtName,
      city: property.district?.city ?? "",
      region: "",
      country: "TJ",
      postal_code: "",
      latitude: String(lat),
      longitude: String(lng),
      neighborhood: districtName,
      images,
      listing_type: "for_sale",
      price: `${priceNum} TJS`,
      url,
      num_beds: property.rooms != null ? String(property.rooms) : "",
      num_baths: "",
      property_type: toPropertyType(property.type),
      year_built: "",
      custom_label_0: districtName,
    });
  }

  return rows;
}

let cache: { at: number; rows: HomeListingRow[] } | null = null;

/**
 * Объекты каталога: AVAILABLE/RESERVED + опубликован на сайте + не offSite +
 * хотя бы одно фото; SOLD — только последние SOLD_RECENT_DAYS дней (архив
 * продаж рекламировать незачем и Meta это не нужно).
 *
 * Кэш на CACHE_TTL_MS в памяти процесса — Meta дёргает адрес раз в час/день, а
 * не на каждый показ объявления, но при параллельных запусках API (несколько
 * процессов/деплой) кэш не общий, только на дольше, чем нужно Meta, это не бьёт.
 */
export async function loadCatalogProperties(): Promise<HomeListingRow[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;

  const [properties, moneyCtx] = await Promise.all([
    prisma.property.findMany({
      where: {
        deletedAt: null,
        publishedOnSite: true,
        offSite: false,
        photos: { some: {} },
        OR: [
          { status: { in: ["AVAILABLE", "RESERVED"] } },
          { status: "SOLD", soldAt: { gte: new Date(Date.now() - SOLD_RECENT_DAYS * 86_400_000) } },
        ],
      },
      include: { district: true, photos: { orderBy: { order: "asc" } } },
      orderBy: { updatedAt: "desc" },
    }),
    loadMoneyContext(),
  ]);

  const crmBase = crmPublicBase();
  if (!crmBase) {
    // Без адреса CRM у феда не будет ни одной ссылки на фото — Meta отвергнет
    // весь файл. Честно логируем, а не отдаём молча пустой каталог.
    void logSystemError("meta", "Фид каталога Meta пуст: не настроен CRM_PUBLIC_URL, ссылок на фото нет");
  }

  const rows = buildHomeListingRows(properties, {
    siteBase: siteHomeUrl(),
    crmBase,
    usdToTjsRate: moneyCtx.usdToTjs,
  });

  cache = { at: Date.now(), rows };
  return rows;
}

/** Сброс кэша — только для тестов (иначе второй тест в том же процессе видит
 *  данные первого до истечения CACHE_TTL_MS). */
export function resetMetaCatalogFeedCacheForTests(): void {
  cache = null;
}
