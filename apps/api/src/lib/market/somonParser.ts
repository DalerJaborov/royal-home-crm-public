/**
 * РАЗБОР СТРАНИЦЫ СПИСКА somon.tj.
 *
 * Сайт собран на Next.js, и весь список объявлений лежит на странице ГОТОВЫМ
 * JSON внутри тегов `self.__next_f.push([1,"..."])` — тем самым, из которого
 * страница рисуется в браузере. Читаем именно его, а не вёрстку: классы и
 * разметку меняют при каждом редизайне, а поля данных живут годами. Это же
 * избавляет от необходимости запускать браузер — обычного HTTP-запроса хватает.
 *
 * ЧТО ВАЖНО: всё нужное есть уже В СПИСКЕ, заходить в карточку не нужно вовсе.
 * 171 страница вместо 10 000 запросов — и чужому сайту легче, и нам быстрее.
 * Внутри карточки лежит только телефон и полное описание; за ними ходим отдельно
 * и только за новыми, если понадобится.
 */

import { detectDistrictInText } from "./districtName.js";
import { somonRubricOf } from "./somonRubrics.js";

export interface SomonRawAd {
  id: number;
  title?: string;
  url?: string;
  price?: string;
  price_without_currency?: string;
  price_description?: string;
  currency?: string;
  published?: string;
  location?: string;
  img_count?: number;
  images?: string[];
  has_video?: boolean;
  ad_type?: { type?: string; text?: string };
  user?: { id?: number; name?: string; is_bussiness?: boolean };
  rubric?: { id?: number; slug?: string; ancestors?: Array<{ id?: number; name?: string; slug?: string }> };
  seo?: { images?: { alt_texts?: string[] } };
}

export interface ParsedListing {
  sourceId: string;
  sourceUrl: string;
  title: string;
  rooms: number | null;
  areaSqm: number | null;
  floor: number | null;
  /** Этажность дома. Даёт её sk.tj («7/16 этаж») и дома Somon («3 этажн. дом»); у остальных null. */
  totalFloors?: number | null;
  /** Участок в сотках (дома Somon: «3 соток», «1.60 сотки»). */
  landSotki?: number | null;
  landmark: string | null;
  districtName: string | null;
  city: string;
  price: number | null;
  currency: string;
  negotiable: boolean;
  sellerId: string | null;
  sellerName: string | null;
  /** Телефон из объявления, если площадка показывает его прямо в списке.
   *  Есть только у arzon.tj; у остальных источников остаётся null — и это
   *  нормально, поле необязательное именно поэтому. */
  sellerPhone?: string | null;
  isAgency: boolean;
  photoCount: number;
  hasVideo: boolean;
  isPromoted: boolean;
  publishedText: string | null;
  /** Дата публикации, если сайт даёт её в разборном виде. */
  publishedAt?: Date | null;
  /** Признаки для подбора ПОХОЖИХ (02.11.2026). Источник не отдал — null. */
  repair?: "SHELL" | "WHITE" | "PARTIAL" | "RENOVATED" | "DESIGNER" | null;
  buildingType?: string | null;
  /** Современный дом («новостройка» в РТ — признак дома, не первый владелец). */
  isNewBuilding?: boolean | null;
  /** Дом сдан (true) или строится (false). */
  buildingReady?: boolean | null;
  exchangePossible?: boolean | null;
  latitude?: number | null;
  longitude?: number | null;
  dealType: "SALE" | "RENT";
  propertyType: "APARTMENT" | "HOUSE" | "COMMERCIAL" | "LAND";
  raw: SomonRawAd;
}

/**
 * Собирает JSON-payload Next.js из HTML страницы.
 *
 * Приходит он кусками по несколько килобайт: каждый `push` добавляет фрагмент
 * ОДНОЙ длинной строки, и разрезать её могут где угодно — хоть посреди слова.
 * Поэтому сначала склеиваем всё, и только потом ищем данные; разбор каждого
 * куска по отдельности терял бы объявления на границах.
 */
export function extractNextPayload(html: string): string {
  const chunks: string[] = [];
  const re = /self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      chunks.push(JSON.parse(m[1]) as string);
    } catch {
      // Один битый кусок не повод терять всю страницу.
    }
  }
  return chunks.join("");
}

/**
 * Вытаскивает объекты объявлений из склеенного payload.
 *
 * Ищем не по структуре (она у Next.js меняется от версии к версии), а по
 * якорю `{"id":<число>,"title":` с последующим `"url":"/adv/`: так объявление
 * узнаётся по собственным полям, а не по месту в дереве.
 */
export function extractAds(payload: string): SomonRawAd[] {
  const ads: SomonRawAd[] = [];
  const seen = new Set<number>();
  const re = /\{"id":(\d+),"title":/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(payload)) !== null) {
    const start = m.index;
    const json = sliceBalancedObject(payload, start);
    if (!json) continue;
    let ad: SomonRawAd;
    try {
      ad = JSON.parse(json) as SomonRawAd;
    } catch {
      continue;
    }
    // Объявление — то, у чего есть ссылка вида /adv/. Всё прочее (рубрики,
    // баннеры, элементы меню) тоже имеет id и title, но ссылки такой не имеет.
    if (!ad.url || !ad.url.startsWith("/adv/")) continue;
    if (seen.has(ad.id)) continue;
    seen.add(ad.id);
    ads.push(ad);
  }
  return ads;
}

/** Вырезает сбалансированный по скобкам JSON-объект, начиная с позиции `start`. */
function sliceBalancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
    // Объявление — компактный объект; если ушли на десятки килобайт, значит
    // якорь поймал что-то не то, и дальше искать бессмысленно.
    if (i - start > 60_000) return null;
  }
  return null;
}

/**
 * Район объявления.
 *
 * В заголовке района чаще нет — там ориентир («Славянский», «Садбарг»). Зато он
 * почти всегда есть в alt-подписи к фотографии, которую сайт собирает сам:
 * «2-комн. квартира, 11 этаж, 66 м², Шохмансур, Душанбе». Оттуда и берём.
 */
export function detectDistrict(ad: SomonRawAd): string | null {
  const alt = ad.seo?.images?.alt_texts?.[0] ?? "";
  // Названия районов — общая дверь districtName.ts (Paydo ходит через неё же).
  return detectDistrictInText(`${alt} ${ad.title ?? ""}`);
}

/**
 * Комнаты, этаж и площадь из заголовка: «3-комн. квартира, 12 этаж, 81 м², Славянский».
 *
 * Формат заголовка сайт собирает сам по полям формы, поэтому он однороден —
 * это надёжнее, чем казалось бы для разбора текста. Всё, что не нашлось,
 * оставляем null: пустое поле честнее выдуманного.
 */
export function parseTitle(title: string): {
  rooms: number | null;
  floor: number | null;
  areaSqm: number | null;
  landmark: string | null;
} {
  const rooms = /(\d+)\s*-?\s*комн/i.exec(title);
  const floor = /(\d+)\s*этаж/i.exec(title);
  const area = /([\d.,]+)\s*м²/i.exec(title);
  // Ориентир — последний кусок после запятой, если он не про комнаты/этаж/площадь.
  const parts = title.split(",").map((p) => p.trim()).filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  const landmark = /комн|этаж|м²/i.test(last) ? null : last || null;

  return {
    rooms: rooms ? Number(rooms[1]) : null,
    floor: floor ? Number(floor[1]) : null,
    areaSqm: area ? Number(area[1].replace(",", ".")) : null,
    landmark,
  };
}

/**
 * Тип сделки и объекта — ТОЛЬКО по номеру рубрики из списка `somonRubrics.ts`. null — объявление
 * не из недвижимости (автозапчасти, услуги, ноутбуки): писать его в каталог нельзя.
 *
 * Прежде тип угадывался по словам в предках рубрики, а всё неопознанное становилось «квартирой»:
 * так 11.11.2026 в каталог «квартирами» легли 13 тыс. чужих объявлений, а дома (рубрика 218,
 * её предок — просто «nedvizhimost») — тоже «квартирами».
 */
export function detectCategory(ad: SomonRawAd): {
  dealType: ParsedListing["dealType"];
  propertyType: ParsedListing["propertyType"];
} | null {
  const rubric = somonRubricOf(ad);
  return rubric ? { dealType: rubric.dealType, propertyType: rubric.propertyType } : null;
}

/**
 * Заголовок дома Somon: «3 этажн. 6-комн. дом, 3 соток, Конституция, Бозори Балх»,
 * «1 этажн. 3-комн. дом, 1.60 сотки, Фирдавси» (живая страница рубрики 218, 12.11.2026).
 * «этажн.» — этажность дома (не этаж квартиры), участок — в сотках. Площади самого дома в
 * заголовке обычно нет: тогда null, а не выдумка. Если продавец её всё же указал («150 м²») — берём.
 */
export function parseHouseTitle(title: string): {
  rooms: number | null;
  totalFloors: number | null;
  areaSqm: number | null;
  landSotki: number | null;
  landmark: string | null;
} {
  const storeys = /(\d+)\s*-?\s*этажн/i.exec(title);
  const rooms = /(\d+)\s*-?\s*комн/i.exec(title);
  const area = /([\d.,]+)\s*м²/i.exec(title);
  const land = /([\d]+(?:[.,]\d+)?)\s*сот(?:ок|ки|ка|\.)?/i.exec(title);
  const num = (m: RegExpExecArray | null) => (m ? Number(m[1].replace(",", ".")) : null);
  const parts = title.split(",").map((p) => p.trim()).filter(Boolean);
  // Ориентир — первый кусок после описания дома, который не про этажи/комнаты/площадь/сотки.
  const landmark = parts.slice(1).find((p) => !/этажн|комн|м²|сот/i.test(p)) ?? null;
  const landSotki = num(land);
  return {
    rooms: rooms ? Number(rooms[1]) : null,
    totalFloors: storeys ? Number(storeys[1]) : null,
    areaSqm: num(area),
    landSotki: landSotki != null && Number.isFinite(landSotki) && landSotki > 0 ? landSotki : null,
    landmark,
  };
}

/**
 * Ремонт словами (как пишут площадки и люди) → наш код.
 * Порядок важен: «евроремонт» содержит «ремонт», «без ремонта» — тоже.
 */
export function normalizeRepair(text: string | null | undefined): ParsedListing["repair"] {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return null;
  if (/дизайн/.test(t)) return "DESIGNER";
  if (/коробк|чернов|без отделк|shell/.test(t)) return "SHELL";
  if (/предчистов|белая|white/.test(t)) return "WHITE";
  if (/частичн|требует|косметич/.test(t)) return "PARTIAL";
  if (/евро|капитал|с ремонтом|хороший ремонт|отличн|renovat/.test(t)) return "RENOVATED";
  return null;
}

/** Приводит сырое объявление сайта к нашей форме. null — не объявление или не недвижимость. */
export function toListing(ad: SomonRawAd): ParsedListing | null {
  if (!ad.url || !ad.id) return null;
  const category = detectCategory(ad);
  if (!category) return null;
  const { dealType, propertyType } = category;
  const title = ad.title ?? "";
  const isHouse = propertyType === "HOUSE";
  const house = isHouse ? parseHouseTitle(title) : null;
  const flat = isHouse ? null : parseTitle(title);
  const rooms = house ? house.rooms : flat!.rooms;
  const areaSqm = house ? house.areaSqm : flat!.areaSqm;
  const floor = house ? null : flat!.floor;
  const landmark = house ? house.landmark : flat!.landmark;

  // price_without_currency — уже очищенное число самого сайта; строку «1 694 000 c.»
  // разбирать вручную не нужно и не стоит: формат пробелов там меняется.
  const rawPrice = ad.price_without_currency ? Number(ad.price_without_currency) : NaN;

  return {
    sourceId: String(ad.id),
    sourceUrl: `https://somon.tj${ad.url}`,
    title,
    rooms,
    areaSqm,
    floor,
    ...(house ? { totalFloors: house.totalFloors, landSotki: house.landSotki } : {}),
    landmark,
    districtName: detectDistrict(ad),
    city: ad.location ?? "Душанбе",
    price: Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : null,
    currency: ad.currency === "USD" ? "USD" : "TJS",
    negotiable: /торг/i.test(ad.price_description ?? ""),
    sellerId: ad.user?.id != null ? String(ad.user.id) : null,
    sellerName: ad.user?.name ?? null,
    isAgency: ad.user?.is_bussiness === true,
    photoCount: ad.img_count ?? ad.images?.length ?? 0,
    hasVideo: ad.has_video === true,
    // Платные типы у somon.tj — "premium" (VIP) и "top" (ТОП); обычное бесплатное
    // объявление помечено "regular". Проверять «не free» было ошибкой: такого
    // значения у сайта нет вовсе, и платным оказывалось АБСОЛЮТНО каждое объявление.
    isPromoted: ad.ad_type?.type === "premium" || ad.ad_type?.type === "top",
    publishedText: ad.published ?? null,
    // Проверено 02.11.2026 по живой странице списка: в объявлении somon.tj нет
    // ни ремонта, ни типа/статуса дома, ни обмена, ни координат (features пуст,
    // is_new = «новое объявление»). Не выдумываем — null; признаки подтянет
    // разбор текста/карточки, когда понадобится.
    repair: null,
    buildingType: null,
    isNewBuilding: null,
    buildingReady: null,
    exchangePossible: null,
    latitude: null,
    longitude: null,
    dealType,
    propertyType,
    raw: ad,
  };
}
