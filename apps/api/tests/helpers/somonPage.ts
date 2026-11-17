import { SOMON_REAL_ESTATE_RUBRICS } from "../../src/lib/market/somonRubrics.js";

/**
 * Страница списка Somon для тестов — в той же форме, что живая (проверено 12.11.2026): Next-payload
 * с метаданными списка (`next_page`, `rubric` самой страницы, `location_ids`) и массивом `adverts`,
 * где у каждого объявления своя рубрика `{ id, slug, ancestors }`.
 *
 * Рубрики: страница квартир 216 (объявления 2829–2839), страница домов 218 (объявления 218).
 * Общая лента «Все объявления» — `pageRubricId: null` (у сайта там `"rubric":{}`).
 */

export const RUBRIC_FLATS_PAGE = 216;
export const RUBRIC_FLAT_2 = 2831;
export const RUBRIC_HOUSES = 218;
/** Чужая рубрика: «Автосервис и ремонт» (живой пример из общей ленты). */
export const RUBRIC_FOREIGN = 155;

export interface TestAd {
  id: number;
  title?: string;
  rubricId?: number;
  [key: string]: unknown;
}

export function somonAd(ad: TestAd): Record<string, unknown> {
  const { rubricId = RUBRIC_FLAT_2, title = "2-комн. квартира, 3 этаж, 50 м², Сино", ...rest } = ad;
  const ancestors =
    rubricId === RUBRIC_HOUSES
      ? [{ id: 121, slug: "nedvizhimost" }]
      : rubricId >= 2829 && rubricId <= 2839
        ? [{ id: 121, slug: "nedvizhimost" }, { id: 216, slug: "prodazha-kvartir" }]
        : [{ id: 122, slug: "transport" }];
  // Порядок ключей как у сайта: разбор узнаёт объявление по якорю `{"id":…,"title":`.
  return {
    id: ad.id,
    title,
    url: `/adv/${ad.id}_stand/`,
    price_without_currency: "500000",
    currency: "TJS",
    ...rest,
    rubric: { id: rubricId, slug: `r${rubricId}`, ancestors },
  };
}

export interface PageOptions {
  /** Рубрика самой страницы; null — общая лента (`"rubric":{}`). */
  pageRubricId?: number | null;
  /** Сколько ссылок пагинации на странице (последняя известная страница). */
  links?: number;
}

export function somonListPageHtml(ads: TestAd[], options: PageOptions = {}): string {
  const { pageRubricId = RUBRIC_FLATS_PAGE, links = 1 } = options;
  const adverts = ads.map(somonAd);
  const data = JSON.stringify({
    // Как у сайта: в next_page нет «page=» (курсор), номера страниц — только в ссылках пагинации.
    next_page: `?location=1&rubric=${pageRubricId ?? ""}&cursor=1&page_size=${adverts.length}`,
    rubric: pageRubricId == null ? {} : { id: pageRubricId, slug: pageRubricId === RUBRIC_FLATS_PAGE ? "prodazha-kvartir" : "prodazha-domov-havli-i-dach" },
    location_ids: [1],
    adverts,
  });
  const anchors = Array.from({ length: links }, (_, i) => `<a href="?page=${i + 1}">${i + 1}</a>`).join("");
  return `${anchors}<script>self.__next_f.push([1,${JSON.stringify(data)}]);</script>`;
}

/**
 * Сырьё строки каталога для тестов чтения: у Somon читаются только строки рубрик недвижимости
 * (`marketCatalogWhere`), поэтому тестовая строка Somon несёт рубрику под свой тип и сделку.
 * Чужие площадки — пустое сырьё, как раньше.
 */
export function catalogRaw(over: { source?: unknown; propertyType?: unknown; dealType?: unknown } = {}): Record<string, unknown> {
  const source = typeof over.source === "string" ? over.source : "somon.tj";
  if (source !== "somon.tj") return {};
  const dealType = typeof over.dealType === "string" ? over.dealType : "SALE";
  const propertyType = typeof over.propertyType === "string" ? over.propertyType : "APARTMENT";
  const rubric = SOMON_REAL_ESTATE_RUBRICS.find((r) => r.dealType === dealType && r.propertyType === propertyType);
  return rubric ? { rubric: { id: rubric.id } } : {};
}
