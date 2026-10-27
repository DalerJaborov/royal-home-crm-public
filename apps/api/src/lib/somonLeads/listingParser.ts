/** Parse the embedded listing payload. The listing timestamp may describe a bump,
 * so it must never be treated as proof of the first publication time. */

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
  rubric?: { slug?: string; ancestors?: Array<{ name?: string; slug?: string }> };
  seo?: { images?: { alt_texts?: string[] } };
}

export interface ParsedListing {
  sourceId: string;
  sourceUrl: string;
  title: string;
  rooms: number | null;
  areaSqm: number | null;
  floor: number | null;
  landmark: string | null;
  districtName: string | null;
  city: string;
  price: number | null;
  currency: string;
  negotiable: boolean;
  sellerId: string | null;
  sellerName: string | null;
  isAgency: boolean | null;
  photoCount: number;
  hasVideo: boolean;
  isPromoted: boolean;
  publishedText: string | null;
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

/** Районы Душанбе так, как их пишет somon.tj → как они называются у нас. */
const DISTRICT_ALIASES: Record<string, string> = {
  сино: "Сино",
  "и. сомони": "Исмоили Сомони",
  "исмоили сомони": "Исмоили Сомони",
  "и.сомони": "Исмоили Сомони",
  фирдавси: "Фирдавси",
  шохмансур: "Шохмансур",
  шомансур: "Шохмансур",
};

/**
 * Район объявления.
 *
 * В заголовке района чаще нет — там ориентир («Славянский», «Садбарг»). Зато он
 * почти всегда есть в alt-подписи к фотографии, которую сайт собирает сам:
 * «2-комн. квартира, 11 этаж, 66 м², Шохмансур, Душанбе». Оттуда и берём.
 */
export function detectDistrict(ad: SomonRawAd): string | null {
  const alt = ad.seo?.images?.alt_texts?.[0] ?? "";
  const haystack = `${alt} ${ad.title ?? ""}`.toLowerCase();
  for (const [alias, name] of Object.entries(DISTRICT_ALIASES)) {
    if (haystack.includes(alias)) return name;
  }
  return null;
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

/** Тип сделки и объекта — по цепочке рубрик сайта, а не по словам в заголовке. */
export function detectCategory(ad: SomonRawAd): {
  dealType: ParsedListing["dealType"];
  propertyType: ParsedListing["propertyType"];
} {
  const slugs = (ad.rubric?.ancestors ?? []).map((a) => a.slug ?? "").join("/");
  const dealType: ParsedListing["dealType"] = /arenda|sdaetsya|prokat/i.test(slugs) ? "RENT" : "SALE";
  const propertyType: ParsedListing["propertyType"] = /kvartir/i.test(slugs)
    ? "APARTMENT"
    : /dom|kottedzh|dach/i.test(slugs)
      ? "HOUSE"
      : /uchastok|zeml/i.test(slugs)
        ? "LAND"
        : /kommerch|ofis|magazin|sklad/i.test(slugs)
          ? "COMMERCIAL"
          : "APARTMENT";
  return { dealType, propertyType };
}

/** Приводит сырое объявление сайта к нашей форме. */
export function toListing(ad: SomonRawAd): ParsedListing | null {
  if (!ad.url || !ad.id) return null;
  const title = ad.title ?? "";
  const { rooms, floor, areaSqm, landmark } = parseTitle(title);
  const { dealType, propertyType } = detectCategory(ad);

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
    landmark,
    districtName: detectDistrict(ad),
    city: ad.location ?? "Душанбе",
    price: Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : null,
    currency: ad.currency === "USD" ? "USD" : "TJS",
    negotiable: /торг/i.test(ad.price_description ?? ""),
    sellerId: ad.user?.id != null ? String(ad.user.id) : null,
    sellerName: ad.user?.name ?? null,
    isAgency: typeof ad.user?.is_bussiness === "boolean" ? ad.user.is_bussiness : null,
    photoCount: ad.img_count ?? ad.images?.length ?? 0,
    hasVideo: ad.has_video === true,
    isPromoted: Boolean(ad.ad_type?.type && ad.ad_type.type !== "free"),
    publishedText: ad.published ?? null,
    dealType,
    propertyType,
    raw: ad,
  };
}
