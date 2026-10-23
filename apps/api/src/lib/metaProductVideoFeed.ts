import {
  catalogImageUrls,
  catalogListingUrl,
  catalogPriceTjs,
  queryCatalogProperties,
  type CatalogProperty,
} from "./metaCatalogFeed.js";
import { crmPublicBase } from "./crmPublicUrl.js";
import { siteHomeUrl } from "./siteListingUrl.js";
import { propertyPublicVideoUrl } from "./propertyPublicVideo.js";

/**
 * ТЕСТОВЫЙ ТОВАРНЫЙ ФИД META С ВИДЕО (23.10.2026) — обычный product feed
 * (Commerce Manager → «Товары»), где у каждого объекта есть `video[0].url`.
 * Только объекты, чей готовый ролик публично открыт (isPropertyVideoPublic):
 * Meta требует прямую скачиваемую ссылку на файл. `id` — тот же shortId, что и
 * `home_listing_id` в home-listings.csv и content_ids пикселя сайта.
 *
 * Адрес: GET /api/v1/public/meta-catalog/products-video.csv?key=... — ключ и
 * тумблер те же, что у home-listings (routes/publicFeed.ts). Здесь — сбор и
 * рендер без HTTP; отбор объектов общий (queryCatalogProperties).
 */

export interface ProductVideoRow {
  id: string;
  title: string;
  description: string;
  availability: "in stock" | "out of stock";
  condition: "new";
  /** Строка вида "450000 TJS". */
  price: string;
  link: string;
  image_link: string;
  brand: "Royal Home";
  "video[0].url": string;
  custom_label_0: string;
}

const PRODUCT_VIDEO_HEADER: Array<keyof ProductVideoRow> = [
  "id",
  "title",
  "description",
  "availability",
  "condition",
  "price",
  "link",
  "image_link",
  "brand",
  "video[0].url",
  "custom_label_0",
];

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** CSV с заголовком, запятой и `\r\n` — тот же формат, что у home-listings. */
export function renderProductVideoCsv(rows: ProductVideoRow[]): string {
  const lines = rows.map((r) => PRODUCT_VIDEO_HEADER.map((h) => csvCell(r[h])).join(","));
  return [PRODUCT_VIDEO_HEADER.map(csvCell).join(","), ...lines].join("\r\n");
}

export interface BuildProductVideoRowsOptions {
  siteBase: string;
  /** undefined — CRM_PUBLIC_URL не настроен: ни фото, ни видео по ссылке не отдать, строк нет. */
  crmBase: string | undefined;
  usdToTjsRate: number;
}

/**
 * Строки фида из объектов — ЧИСТАЯ ФУНКЦИЯ. В фид идут только объекты с
 * публичным роликом, хотя бы одной картинкой и понятной ценой.
 */
export function buildProductVideoRows(
  properties: CatalogProperty[],
  { siteBase, crmBase, usdToTjsRate }: BuildProductVideoRowsOptions
): ProductVideoRow[] {
  const rows: ProductVideoRow[] = [];
  if (!crmBase) return rows;

  for (const property of properties) {
    const videoUrl = propertyPublicVideoUrl(property, crmBase);
    if (!videoUrl) continue;

    const [imageLink] = catalogImageUrls(property, crmBase);
    if (!imageLink) continue;

    const priceNum = catalogPriceTjs(property, usdToTjsRate);
    if (!Number.isFinite(priceNum)) continue;

    let availability: ProductVideoRow["availability"];
    if (property.status === "AVAILABLE" || property.status === "RESERVED") availability = "in stock";
    else if (property.status === "SOLD") availability = "out of stock";
    else continue;

    rows.push({
      id: String(property.shortId),
      title: property.title,
      description: property.description?.trim() ? property.description : property.title,
      availability,
      condition: "new",
      price: `${priceNum} TJS`,
      link: catalogListingUrl(property, siteBase),
      image_link: imageLink,
      brand: "Royal Home",
      "video[0].url": videoUrl,
      custom_label_0: property.district?.name ?? "",
    });
  }
  return rows;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { at: number; rows: ProductVideoRow[] } | null = null;

/** Строки товарного фида с видео; кэш в памяти процесса — тот же приём, что у home-listings. */
export async function loadProductVideoRows(): Promise<ProductVideoRow[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  const { properties, usdToTjsRate } = await queryCatalogProperties();
  const rows = buildProductVideoRows(properties, { siteBase: siteHomeUrl(), crmBase: crmPublicBase(), usdToTjsRate });
  cache = { at: Date.now(), rows };
  return rows;
}

/** Сброс кэша — только для тестов. */
export function resetMetaProductVideoFeedCacheForTests(): void {
  cache = null;
}
