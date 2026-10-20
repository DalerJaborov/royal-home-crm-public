import { distanceMeters, isInstagramLink } from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { placesMentioned, sameWord, type IndexedPlace } from "../ai/geoMentions.js";
import { geoMatchKey } from "./geoNormalize.js";
import { budgetWindowTjs, loadMatchPolicy } from "./matchPolicy.js";
import { loadMoneyContext, priceCeilingFilter, toTjs } from "./money.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";
import { isSuburbanProperty } from "./suburbanProperty.js";
import { siteListingUrl } from "./siteListingUrl.js";
import { resolveCallPropertyHint } from "./telephony/resolveCallProperty.js";

/**
 * ПОДБОР ОБЪЕКТОВ ПОД ЗАПРОС ПОКУПАТЕЛЯ — ОДИН НА ВСЕ КАНАЛЫ (вынесено 24.09.2026).
 *
 * Жил внутри чат-бота (ai/leadQualifier.ts::searchMatchingProperties). Консультант
 * на телефоне ищет квартиры тем же запросом (lib/telephony/liveVoiceConsultant.ts):
 * две копии разошлись бы в первом же исправлении — скажем, в пересчёте бюджета по
 * курсу, — и клиенту в WhatsApp и по телефону называли бы разные квартиры под одну
 * и ту же просьбу. Здесь — ЧТО найти и в каком порядке; как это сказать, решает
 * канал.
 *
 * Показываем только то, что можно предложить: правило BOTS_OFFER_MODE ниже.
 */

/**
 * ЧТО БОТАМ МОЖНО ПРЕДЛАГАТЬ — ОДНО ПРАВИЛО (10.10.2026, аудит поиска P0-5).
 *
 * Решение владельца 10.10.2026: «показывай, если в продаже и есть публикация». До
 * него боты (чат и голос) видели только опубликованное на сайте: 9 объектов в
 * продаже не на сайте (у 8 — ролик в Instagram, цена там публичная) подбор не
 * находил никогда, а робот по объявлению из рилса отвечал «только лично, без цены».
 *
 * Режимы — чтобы правило менялось одной строкой, а не правкой четырёх каналов:
 *  - "site_only" — только опубликованное на сайте (как было до 10.10.2026);
 *  - "site_or_publication" — на сайте ИЛИ есть публичная публикация (по умолчанию):
 *    ссылка на Instagram в `instagramUrl` (именно instagram.com — телеграм-ссылка на
 *    закрытый канал публикацией не считается, правило владельца 13.08.2026, см.
 *    packages/shared/src/instagramLink.ts) либо непустой `publishedChannels` —
 *    каналы, куда CRM реально выложила ролик (FB, YouTube, Telegram-канал, TikTok,
 *    Threads; фантомы оттуда вычёркивает ночная сверка lib/publishedChannelsAudit.ts);
 *  - "all" — всё в продаже, кроме закрытых.
 *
 * В любом режиме: только в продаже или в брони (AVAILABLE/RESERVED; подбор сверху
 * сужает до AVAILABLE), не в Корзине и НИКОГДА не закрытое «только для своих»
 * (offSite — его цену знают только свои, решение владельца 14.09.2026).
 *
 * Два вида одного правила: условие выборки (`botOfferableWhere`) и проверка уже
 * прочитанной карточки (`botMayOffer`). Расходиться им нельзя — сверяет тест
 * bots-offer-rule.test.ts на одних и тех же карточках в базе.
 */
export type BotOfferMode = "site_only" | "site_or_publication" | "all";
export const BOTS_OFFER_MODE: BotOfferMode = "site_or_publication";

/** Статусы «в продаже» для ботов: бронь — тоже, честно с пометкой «в брони». */
const BOT_OFFER_STATUSES = ["AVAILABLE", "RESERVED"] as const;

/**
 * Ссылка на Instagram — та же граница, что `isInstagramLink` (начало адреса, без
 * учёта регистра), но в виде, который база проверяет ровно так же: префиксы ниже
 * и `startsWith` без учёта регистра. Отличие от `isInstagramLink` одно — пробел в
 * начале строки здесь не прощается (базе его не обрезать), — и это сознательно:
 * так выборка и проверка карточки дают один результат на любой строке.
 */
const INSTAGRAM_PREFIXES = ["https://instagram.com/", "http://instagram.com/", "https://www.instagram.com/", "http://www.instagram.com/"];

function hasInstagramPublication(url: string | null | undefined): boolean {
  if (!url) return false;
  const low = url.toLowerCase();
  return INSTAGRAM_PREFIXES.some((prefix) => low.startsWith(prefix));
}

/** Поля карточки, по которым решается «можно предлагать». Все обязательны:
 *  забытое в select поле иначе молча превратилось бы в «нельзя». */
export interface BotOfferFields {
  status: string;
  deletedAt: Date | null;
  offSite: boolean;
  publishedOnSite: boolean;
  instagramUrl: string | null;
  publishedChannels: string[];
}

/** Условие выборки «можно предлагать ботом» — для всех запросов каналов. Кладётся
 *  в `AND`, а не разворачивается в where: внутри есть свой `OR`. */
export function botOfferableWhere(mode: BotOfferMode = BOTS_OFFER_MODE): Prisma.PropertyWhereInput {
  const base: Prisma.PropertyWhereInput = { status: { in: [...BOT_OFFER_STATUSES] }, deletedAt: null, offSite: false };
  if (mode === "all") return base;
  if (mode === "site_only") return { ...base, publishedOnSite: true };
  return {
    ...base,
    OR: [
      { publishedOnSite: true },
      { OR: INSTAGRAM_PREFIXES.map((prefix) => ({ instagramUrl: { startsWith: prefix, mode: "insensitive" as const } })) },
      { publishedChannels: { isEmpty: false } },
    ],
  };
}

/** То же для уже прочитанной карточки: можно ли называть цену и адрес. */
export function botMayOffer(p: BotOfferFields, mode: BotOfferMode = BOTS_OFFER_MODE): boolean {
  if (p.deletedAt || p.offSite || !(BOT_OFFER_STATUSES as readonly string[]).includes(p.status)) return false;
  if (mode === "all") return true;
  if (mode === "site_only") return p.publishedOnSite;
  return p.publishedOnSite || hasInstagramPublication(p.instagramUrl) || p.publishedChannels.length > 0;
}

/** Что выбрать из базы, чтобы решить botMayOffer и собрать botOfferLink. */
export const BOT_OFFER_SELECT = {
  status: true,
  deletedAt: true,
  offSite: true,
  publishedOnSite: true,
  instagramUrl: true,
  publishedChannels: true,
  siteListingId: true,
} as const;

/**
 * ССЫЛКА НА ОБЪЕКТ ДЛЯ КЛИЕНТА — ОДНА НА ВСЕ КАНАЛЫ БОТОВ (10.10.2026).
 *
 * Страница на сайте есть только у опубликованного там объекта; у остального
 * предлагаемого ссылка — публикация в Instagram. Нет ни того ни другого (объект
 * виден ботам по ролику в другом канале, адрес которого не хранится) — `null`:
 * ссылку не отправляем и не придумываем (раньше сюда подставлялся by-crm адрес
 * сайта, который для неопубликованного объекта ведёт на пустую страницу).
 *
 * Порядок: в чате сайта — сайт первым (посетитель уже там, см. propertyLink в
 * ai/leadQualifier.ts); в мессенджерах — пост Instagram первым (открывается внутри
 * приложения); в СМС и остальном — сайт первым (там фото, видео и карта).
 */
export function botOfferLink(
  p: { id: string; publishedOnSite: boolean; siteListingId?: number | null; instagramUrl?: string | null },
  prefer: "site" | "instagram" = "site"
): string | null {
  const site = siteListingUrl({ id: p.id, publishedOnSite: p.publishedOnSite, siteListingId: p.siteListingId ?? null });
  const instagram = isInstagramLink(p.instagramUrl) ? p.instagramUrl.trim() : null;
  return prefer === "instagram" ? instagram ?? site : site ?? instagram;
}

/** Место, названное клиентом, с точкой на карте (ai/geoMentions.ts). */
export interface MatchPlace {
  name: string;
  lat: number;
  lng: number;
  /** Насколько далеко от места объект ещё «рядом». */
  radiusM: number;
}

export interface PropertyMatchQuery {
  /** Официальный район (District.name) — как его пишет чат-бот в districtName. */
  districtName?: string | null;
  type?: string | null;
  /**
   * Сколько комнат просили. Точное число — первым; ±допуск политики
   * (`roomsTolerance`, по умолчанию 1) — следом, с пометкой; дальше — не предлагаем
   * (P0-1: «двушка» не превращается в семикомнатную).
   */
  rooms?: number | null;
  /** Бюджет в СОМОНИ: цены в базе бывают и в долларах, пересчёт по курсу здесь. */
  budgetMin?: number | null;
  budgetMax?: number | null;
  /** Место с точкой: район ИЛИ радиус, ближе — выше (P1-1). */
  place?: MatchPlace | null;
  /** Слова ориентира — сверяются с «Ориентиром», адресом и заголовком карточки. */
  placeText?: string | null;
  /** Ищет за городом (Вахдат, Варзоб, дача) — true; иначе загородное не подсовываем (P0-4). */
  suburban?: boolean | null;
  /** «Подешевле» — по цене, а не по близости к запросу (P1-7). */
  sort?: "best" | "cheap" | null;
  /** С ремонтом / без ремонта (коробка). */
  renovation?: "with" | "without" | null;
  /** Новостройка / вторичка. */
  market?: "NEW_BUILD" | "SECONDARY" | null;
  /** Признаки из «Характеристик» (Property.details). */
  furniture?: boolean | null;
  parking?: boolean | null;
  material?: string | null;
}

/** Насколько объект подходит — каналу, чтобы сказать честно («на комнату больше»). */
export interface MatchFit {
  score: number;
  /** Комнат больше (+) или меньше (−) просимого; 0 — ровно; null — не сравнивали. */
  roomsDelta: number | null;
  /** Дороже названного потолка, но в допуске политики. */
  overBudget: boolean;
  /** Дешевле названного минимума больше допуска. */
  belowBudget: boolean;
  /** Метры до названного места; null — места нет или у объекта нет точки. */
  distanceM: number | null;
  /** Не в названном районе — попал по близости к месту. */
  outsideDistrict: boolean;
  suburban: boolean;
}

/** Предел выборки: каталог — десятки объектов, но запрос идёт в живом ходе разговора. */
export const PROPERTY_MATCH_POOL = 500;

const ROOMS_EXACT = 3;
const ROOMS_NEAR = 1;
const BUDGET_INSIDE = 2;
const BUDGET_NEAR_MIN = 1;
const PLACE_NEAR = 3;
const PLACE_CLOSE_BONUS = 1;
const PLACE_WORDS = 2;
const WISH_MATCH = 2;
const WISH_MISMATCH = -2;
const SUBURB_UNASKED = -3;

/** Слова районов не выделяют объект: «Сино» есть в адресе у каждого третьего. */
const DISTRICT_WORDS = ["сино", "фирдавси", "шохмансур", "исмоили", "сомони"];

function placeWords(text: string | null | undefined): string[] {
  return words(text).filter((w) => !DISTRICT_WORDS.some((d) => sameWord(d, w)));
}

function detailValue(details: unknown, key: string): string | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const v = (details as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Совпадение пожелания с признаком карточки: +, −, 0 (признак не заполнен). */
function wish(wanted: boolean | null | undefined, has: boolean | null): number {
  if (wanted == null || has == null) return 0;
  return wanted === has ? WISH_MATCH : WISH_MISMATCH;
}

export async function findMatchingProperties(
  query: PropertyMatchQuery,
  options: {
    alreadyShownShortIds?: number[];
    limit?: number;
    /** Сужение выборки (тест-каталог, отдельная витрина). */
    scope?: Prisma.PropertyWhereInput;
  } = {}
) {
  let districtId: string | undefined;
  if (query.districtName) {
    const d = await prisma.district.findFirst({ where: { name: query.districtName } });
    districtId = d?.id;
  }
  // Бюджет клиента — в сомони, цены в базе бывают и в долларах: курс нужен обеим
  // границам, берём его один раз и только когда бюджет вообще назван.
  const budgetNamed = !!(query.budgetMin || query.budgetMax);
  const [usdToTjs, policy] = await Promise.all([
    // «Подешевле» сравнивает цены в разных валютах — курс нужен и ему.
    budgetNamed || query.sort === "cheap" ? loadMoneyContext().then((m) => m.usdToTjs) : Promise.resolve(1),
    loadMatchPolicy(),
  ]);
  // Допуск бюджета и комнат — те же, что у подбора агентам (lib/matchPolicy.ts, P1-2).
  const window = budgetWindowTjs(query.budgetMin || null, query.budgetMax || null, policy);
  const roomsAsked = query.rooms && query.type !== "LAND" ? query.rooms : null;
  const and: Prisma.PropertyWhereInput[] = [];
  if (window.max !== null) and.push(priceCeilingFilter(window.max, "TJS", usdToTjs));
  if (roomsAsked) {
    and.push({
      OR: [{ rooms: null }, { rooms: { gte: roomsAsked - policy.roomsTolerance, lte: roomsAsked + policy.roomsTolerance } }],
    });
  }
  if (options.scope) and.push(options.scope);
  // Что ботам можно предлагать — одно правило (botOfferableWhere выше, P0-5).
  and.push(botOfferableWhere());
  const place = query.place ?? null;
  const pool = await prisma.property.findMany({
    where: {
      status: "AVAILABLE",
      deletedAt: null,
      // Есть место с точкой или ищут за городом — район проверяем ниже (район ИЛИ радиус).
      ...(districtId && !place && !query.suburban ? { districtId } : {}),
      ...(query.type ? { type: query.type as never } : {}),
      AND: and,
    },
    include: { district: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: PROPERTY_MATCH_POOL,
  });

  const priceTjs = (p: { price: unknown; currency: string }): number =>
    p.currency === "USD" ? Number(p.price) * usdToTjs : Number(p.price);
  const askedWords = placeWords([query.placeText, place?.name].filter(Boolean).join(" "));

  /**
   * РАНЖИРОВАНИЕ ВМЕСТО «СВЕЖЕСТИ» (10.10.2026, аудит поиска P0-1, P1-1, P1-3, P1-7).
   *
   * Раньше пул из 24 самых свежих резался до трёх только по нижней границе бюджета:
   * на «двушку в Исмоили Сомони» первыми шли две семикомнатные, а все три настоящие
   * двушки района в выдачу не попадали. Теперь каждый объект получает баллы за
   * близость к запросу: точные комнаты, бюджет, место (по карте и словами), признаки
   * из «Характеристик»; свежесть — только последний ключ (сортировка стабильная).
   */
  const ranked: { p: (typeof pool)[number]; fit: MatchFit }[] = [];
  for (const p of pool) {
    const suburban = isSuburbanProperty(p);
    if (query.suburban && !suburban) continue;
    // Район или место названы — загородный дом «в Шохмансуре» не предлагаем (P0-4).
    if (!query.suburban && suburban && (districtId || place)) continue;

    const lat = p.lat != null ? Number(p.lat) : NaN;
    const lng = p.lng != null ? Number(p.lng) : NaN;
    const distanceM =
      place && Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 ? Math.round(distanceMeters(place.lat, place.lng, lat, lng)) : null;
    const near = distanceM !== null && place !== null && distanceM <= place.radiusM;
    const inDistrict = !!districtId && p.districtId === districtId;
    // Район ИЛИ радиус — как у подбора агентам (routes/matching.ts::districtOrRadiusMatch).
    if (place && districtId && !query.suburban && !inDistrict && !near) continue;

    let score = 0;
    let roomsDelta: number | null = null;
    if (roomsAsked && p.rooms != null) {
      roomsDelta = p.rooms - roomsAsked;
      score += roomsDelta === 0 ? ROOMS_EXACT : ROOMS_NEAR;
    }

    const price = priceTjs(p);
    let overBudget = false;
    let belowBudget = false;
    if (budgetNamed) {
      const min = query.budgetMin || null;
      const max = query.budgetMax || null;
      if ((min === null || price >= min) && (max === null || price <= max)) score += BUDGET_INSIDE;
      else if (max !== null && price > max) overBudget = true;
      else if (min !== null && window.min !== null && price >= window.min) score += BUDGET_NEAR_MIN;
      else if (min !== null) {
        // Чем дальше ниже названного минимума, тем ниже: «от 600 тысяч» за 150 — в хвост.
        belowBudget = true;
        score -= 2 + Math.round(((min - price) / min) * 10);
      }
    }

    if (near) score += PLACE_NEAR + (distanceM! <= place!.radiusM / 2 ? PLACE_CLOSE_BONUS : 0);
    if (askedWords.length > 0 && anySameWord(askedWords, words([p.landmark, p.address, p.title].filter(Boolean).join(" "))) > 0) {
      score += PLACE_WORDS;
    }

    if (query.renovation) {
      const renovated = p.condition === "GOOD" || p.condition === "EXCELLENT" ? true : p.condition === "NEEDS_REPAIR" ? false : null;
      score += wish(query.renovation === "with", renovated);
    }
    if (query.market && p.marketType) score += p.marketType === query.market ? WISH_MATCH : WISH_MISMATCH;
    const furniture = detailValue(p.details, "furniture");
    score += wish(query.furniture, furniture ? furniture !== "Без мебели" : null);
    const parking = detailValue(p.details, "parking");
    score += wish(query.parking, parking ? parking !== "Нет" : null);
    const material = detailValue(p.details, "material");
    if (query.material && material) score += material === query.material ? WISH_MATCH : WISH_MISMATCH;

    // Тип назван, района нет — загородное в хвост и с пометкой.
    if (suburban && !query.suburban) score += SUBURB_UNASKED;

    ranked.push({
      p,
      fit: { score, roomsDelta, overBudget, belowBudget, distanceM, outsideDistrict: !!districtId && !inDistrict, suburban },
    });
  }

  const byFit =
    query.sort === "cheap"
      ? (a: (typeof ranked)[number], b: (typeof ranked)[number]) => priceTjs(a.p) - priceTjs(b.p) || b.fit.score - a.fit.score
      : (a: (typeof ranked)[number], b: (typeof ranked)[number]) => b.fit.score - a.fit.score;
  // Уже показанные — в хвост (20.09.2026: «у вас всего три квартиры»), но не вон:
  // если другого под запрос нет, список не пустеет.
  const shown = new Set(options.alreadyShownShortIds ?? []);
  return [
    ...ranked.filter((r) => !shown.has(r.p.shortId)).sort(byFit),
    ...ranked.filter((r) => shown.has(r.p.shortId)).sort(byFit),
  ]
    .slice(0, options.limit ?? 3)
    .map((r) => ({ ...r.p, match: r.fit }));
}

export type MatchedProperty = Awaited<ReturnType<typeof findMatchingProperties>>[number];

/**
 * Пометка подбора словами — одна на оба канала: чат-бот печатает её в строке объекта,
 * голос получает в ответе функции. Пусто — объект подходит ровно.
 */
export function matchFitNote(fit: MatchFit): string | null {
  const notes: string[] = [];
  if (fit.roomsDelta && fit.roomsDelta > 0) notes.push(`комнат на ${fit.roomsDelta} больше, чем просили`);
  if (fit.roomsDelta && fit.roomsDelta < 0) notes.push(`комнат на ${-fit.roomsDelta} меньше, чем просили`);
  if (fit.overBudget) notes.push("чуть дороже названного бюджета");
  if (fit.belowBudget) notes.push("заметно дешевле названного минимума");
  if (fit.outsideDistrict) notes.push("в соседнем районе, но рядом с названным местом");
  if (fit.suburban) notes.push("за городом");
  return notes.length ? notes.join("; ") : null;
}

/**
 * КАКОЙ ИМЕННО НАШ ОБЪЕКТ ИМЕЕТ В ВИДУ ЗВОНЯЩИЙ (24.09.2026).
 *
 * Владелец 24.09, после ПК-000475: «если клиент сразу сказал, что видел
 * объявление, и явно интересуется нашим объектом, который уже в публикации, —
 * и робозвонок, и звонок оператору должны определить его точно, по всем
 * параметрам… все объекты на ладони… и ориентиры, и по карте».
 *
 * Одна функция на оба пути, чтобы по одному и тому же описанию оператор и
 * робозвонок находили один и тот же объект:
 *  - разбор звонка оператора (lib/telephony/qualifyIncoming.ts) — найденный
 *    объект уводит лид его агенту (own_property_explicit);
 *  - робозвонок (get_property в lib/telephony/liveVoicePropertyTools.ts) —
 *    рассказывает про объект или переспрашивает, если подходят несколько.
 *
 * Живёт рядом с подбором (findMatchingProperties выше): там — несколько
 * вариантов под запрос («двушка в Сино до 50 тысяч»), здесь — ОДИН объект,
 * который человек уже видел. Один модуль на все каналы, чтобы правило «что мы
 * показываем и как понимаем приметы» было в одном месте.
 *
 * КАК. Сначала прежний прямой поиск по номеру, ЖК, адресу (resolveCallPropertyHint):
 * нашёл ровно один — это он. Иначе каждый опубликованный объект в продаже
 * объект в продаже (и в брони) получает баллы за совпавшие приметы:
 *  - цена (с учётом валюты — сравнение в сомони по курсу справочника);
 *  - ориентир словами — в поле «Ориентир», адресе или заголовке карточки;
 *  - ориентир по карте — место из справочника города (ориентиры, улицы, мкр,
 *    народные точки — ai/geoMentions.ts) и расстояние от него до точки объекта;
 *  - район, комнаты, этаж, этажность, площадь.
 * Проданный за последние 90 дней объект тоже узнаётся — со статусом, чтобы
 * канал честно сказал «этот уже продан» и предложил похожие, а не молчал.
 * Противоречие снимает баллы, а не вычёркивает (24.09.2026, ОБ-000118): тип и
 * комнаты в карточке заводит человек, а в звонке их называет человек и
 * пересказывает модель, — ошибиться может любая сторона. Вычёркивает только
 * ЦЕНА ОБЪЯВЛЕНИЯ дальше 20 % (`priceTjs`); бюджет клиента (`budgetTjs`) —
 * не цена объекта, по нему не вычёркиваем.
 *
 * ЧТОБЫ НЕ ПРОМАХНУТЬСЯ. Объект считается найденным, только если среди примет
 * есть МЕСТО (ориентир словами, по карте или слово из адреса — район один не в
 * счёт: он слишком широк) либо точное описание: цена + площадь + район или, по
 * решению владельца 24.09.2026, цена + площадь + комнаты + этаж; баллов хватает и отрыв от второго кандидата не меньше
 * двух баллов. Иначе ответ «не знаю» и список лучших кандидатов: оператору лид
 * уходит обычной раздачей, робозвонок переспрашивает. Ошибиться здесь дороже,
 * чем промолчать: чужой агент получит клиента чужого объекта.
 */

export interface PropertyClues {
  /** Номер объекта, ЖК, адрес, ссылка — как сказал человек. */
  text?: string | null;
  /** Место, возле которого объект: «у фабрики Гулдаст», «82 мкр», «напротив Ашана». */
  place?: string | null;
  /** Район по имени (робозвонок) или по id (разбор звонка) — что есть. */
  districtName?: string | null;
  districtId?: string | null;
  type?: string | null;
  rooms?: number | null;
  floor?: number | null;
  totalFloors?: number | null;
  areaSqm?: number | null;
  /** Цена ИЗ ОБЪЯВЛЕНИЯ, которую человек назвал, уже в сомони. Дальше 20 % — не тот объект. */
  priceTjs?: number | null;
  /**
   * Бюджет клиента в сомони (24.09.2026). Не цена объекта: «ищу до 400, видел
   * вашу за 300» — нормальный разговор. Близкая сумма даёт баллы как цена, далёкая
   * только снимает их, но объект не вычёркивает.
   */
  budgetTjs?: number | null;
  /** Площадь участка в сотках — у участков и домов её называют так, а не в метрах. */
  landSotka?: number | null;
}

export interface IdentifiedCandidate {
  id: string;
  /** Код объекта — тот же номер, что в карточке и в ссылке сайта. */
  shortId: number;
  status: string;
  /** Агент объекта (lib/propertyOwner.ts) — кому уходит лид и кого назвать. */
  agentId: string | null;
  agentName: string | null;
  score: number;
  /** Какие приметы совпали — для журнала и для переспроса. */
  signals: string[];
}

export interface PropertyIdentification {
  /** Найденный объект; null — не нашли или подходят несколько. */
  propertyId: string | null;
  /** hint — по номеру/ЖК/адресу, description — по приметам. */
  via: "hint" | "description" | null;
  /** Лучшие кандидаты по убыванию баллов (до трёх), для переспроса. */
  candidates: IdentifiedCandidate[];
}

/** Цена в пределах — «та самая» (человек округляет, модель пересчитывает валюту). */
const PRICE_MATCH = 0.1;
/** Дальше этого — точно другой объект. */
const PRICE_VETO = 0.2;
/** Сколько баллов нужно, чтобы назвать объект уверенно. */
const MIN_SCORE = 5;
/** Отрыв от второго кандидата. */
const MIN_LEAD = 2;
/** Предел выборки: опубликованных объектов в продаже сотни, не десятки тысяч. */
const POOL_LIMIT = 5000;
/** Сколько дней проданный объект ещё узнаём по объявлению. */
const SOLD_RECENT_DAYS = 90;

/** Как далеко от названного места может стоять объект. Ориентир и улица —
 *  точка; микрорайон и жилой массив — область, их точка — середина. */
export function radiusFor(place: Pick<IndexedPlace, "rank">): number {
  if (place.rank === 2) return 1000;
  if (place.rank === 1) return 1500;
  return 800;
}

/** Слова, которые есть в описании половины мест города и объект не выделяют:
 *  «у фабрики Гулдаст» узнаётся по «Гулдаст», а не по «фабрике». */
const GENERIC_PLACE_WORDS = [
  "улица", "кучаи", "проспект", "шоҳроҳ", "рынок", "базар", "бозор", "бозорчаи", "фабрика", "завод",
  "школа", "мактаб", "магазин", "торговый", "центр", "маркази", "остановка", "напротив", "возле",
  "рядом", "около", "наздики", "микрорайон", "мкрн", "район", "ноҳия", "квартира", "хонаи", "дома",
  "здание", "новостройка", "элитка", "объявление", "продаётся", "продается",
].map((w) => geoMatchKey(w));

function words(text: string | null | undefined): string[] {
  return text
    ? geoMatchKey(text)
        .split(" ")
        .filter((w) => w.length >= 4 && !GENERIC_PLACE_WORDS.some((g) => sameWord(g, w)))
    : [];
}

/** Название места — одни общие слова («Школа», «Рынок»): по нему одному место не найти. */
export function isGenericPlaceName(name: string): boolean {
  return words(name).length === 0;
}

function anySameWord(said: string[], card: string[]): number {
  return said.filter((w) => card.some((c) => sameWord(w, c))).length;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const CARD_SELECT = {
  id: true,
  shortId: true,
  status: true,
  title: true,
  address: true,
  landmark: true,
  type: true,
  rooms: true,
  floor: true,
  totalFloors: true,
  areaSqm: true,
  landAreaSotka: true,
  price: true,
  currency: true,
  lat: true,
  lng: true,
  districtId: true,
  district: { select: { name: true } },
  intakeAgentId: true,
  assignedAgentId: true,
  createdById: true,
} as const;

/** Имена агентов лучших кандидатов — одним запросом, не по одному. */
async function withAgents(list: Omit<IdentifiedCandidate, "agentName">[]): Promise<IdentifiedCandidate[]> {
  const ids = [...new Set(list.map((c) => c.agentId).filter((id): id is string => !!id))];
  const agents = ids.length
    ? await prisma.agent.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, isActive: true } })
    : [];
  return list.map((c) => {
    const a = agents.find((x) => x.id === c.agentId);
    return { ...c, agentName: a?.isActive && a.fullName.trim() ? a.fullName.trim() : null };
  });
}

export async function identifyProperty(clues: PropertyClues): Promise<PropertyIdentification> {
  const text = clues.text?.trim() || null;
  if (text) {
    const byHint = await resolveCallPropertyHint(text);
    if (byHint) {
      const p = await prisma.property.findUnique({ where: { id: byHint }, select: CARD_SELECT });
      if (p) {
        const [c] = await withAgents([
          { id: p.id, shortId: p.shortId, status: p.status, agentId: propertyOwnerAgentId(p), score: 99, signals: ["номер/адрес"] },
        ]);
        return { propertyId: p.id, via: "hint", candidates: [c] };
      }
    }
  }

  const placeText = clues.place?.trim() || null;
  const placeWords = words(placeText);
  const textWords = words(text);
  const [places, pool, money] = await Promise.all([
    placeText || text ? placesMentioned([placeText, text].filter(Boolean).join(" "), { loose: true }) : Promise.resolve([]),
    prisma.property.findMany({
      where: {
        deletedAt: null,
        OR: [
          // Не только опубликованные на сайте: объявление крутится и в Instagram,
          // и в группах, а флаг сайта у части объектов в продаже снят. Что из
          // найденного можно говорить вслух, решает канал (закрытый объект —
          // «подробности даст агент»), а узнать объект нужно в любом случае.
          { status: { in: ["AVAILABLE", "RESERVED"] } },
          { status: "SOLD", soldAt: { gte: new Date(Date.now() - SOLD_RECENT_DAYS * 86_400_000) } },
        ],
      },
      select: CARD_SELECT,
      orderBy: { shortId: "desc" },
      take: POOL_LIMIT,
    }),
    loadMoneyContext(),
  ]);

  const scored: (Omit<IdentifiedCandidate, "agentName"> & { located: boolean })[] = [];
  for (const p of pool) {
    const signals: string[] = [];
    let score = 0;
    let located = false;
    let priceExact = false;
    let roomsMatch = false;
    let floorMatch = false;

    /**
     * ТИП — НЕ ПРИГОВОР, А ПРИМЕТА (24.09.2026, живой звонок про ОБ-000118).
     * Клиент говорил о квартире 34 м² за 300 000 сомони у Бодомзора, а в
     * карточке объект заведён «Участком»: вычеркнув по типу, узнавание
     * отбросило ровно тот объект, о котором шла речь, и лид ушёл раздачей.
     * Тип ошибается с обеих сторон — агент выбрал не то в карточке, модель
     * или человек назвали жильё по-своему («дом» про квартиру в доме), —
     * поэтому несовпадение только снимает балл.
     */
    const typeMismatch = !!clues.type && p.type !== clues.type;
    if (typeMismatch) score -= 1;
    /**
     * КОМНАТЫ — ТОЖЕ ПРИМЕТА (24.09.2026, проход по классам после ОБ-000118).
     * Раньше чужое число комнат вычёркивало объект, как и тип. Но в разборе
     * звонка это может быть и «сколько нужно», и «сколько в объявлении», а агент
     * может посчитать «3 хона» иначе, чем клиент. Противоречие снимает три балла:
     * при цене и ориентире объект уже не «узнан уверенно», но остаётся в похожих.
     */
    if (clues.rooms && p.rooms && p.rooms !== clues.rooms) score -= 3;

    if (clues.priceTjs && clues.priceTjs > 0) {
      const tjs = toTjs(p.price, p.currency, money);
      const diff = tjs > 0 ? Math.abs(tjs - clues.priceTjs) / clues.priceTjs : 1;
      if (diff > PRICE_VETO) continue;
      if (diff <= 0.03) {
        score += 4;
        priceExact = true;
        signals.push("цена");
      } else if (diff <= PRICE_MATCH) {
        score += 3;
        signals.push("цена");
      }
    } else if (clues.budgetTjs && clues.budgetTjs > 0) {
      // Бюджет: близко к цене — та же примета, намного дороже — улика против, но не приговор.
      const tjs = toTjs(p.price, p.currency, money);
      const diff = tjs > 0 ? Math.abs(tjs - clues.budgetTjs) / clues.budgetTjs : 1;
      if (diff <= 0.03) {
        score += 4;
        priceExact = true;
        signals.push("цена");
      } else if (diff <= PRICE_MATCH) {
        score += 3;
        signals.push("цена");
      } else if (tjs > clues.budgetTjs * (1 + PRICE_VETO)) {
        // Дороже бюджета — улика против. Дешевле — нет: «ищу до 400, видел за 300».
        score -= 2;
      }
    }

    const cardWords = words([p.landmark, p.address, p.title].filter(Boolean).join(" "));
    if (anySameWord(placeWords, cardWords) > 0) {
      score += 3;
      located = true;
      signals.push("ориентир");
    }

    const lat = num(p.lat);
    const lng = num(p.lng);
    if (lat !== null && lng !== null) {
      const near = places.find((pl) => distanceMeters(pl.lat, pl.lng, lat, lng) <= radiusFor(pl));
      if (near) {
        score += near.rank === 1 || near.rank === 2 ? 2 : 3;
        located = true;
        signals.push(`рядом «${near.name}»`);
      }
    }

    if (textWords.length > 0) {
      const hits = anySameWord(textWords, cardWords);
      if (hits > 0) {
        score += Math.min(3, hits);
        located = true;
        signals.push("адрес/ЖК");
      }
    }

    const sameDistrict = clues.districtId
      ? p.districtId
        ? p.districtId === clues.districtId
        : null
      : clues.districtName && p.district?.name
        ? geoMatchKey(p.district.name) === geoMatchKey(clues.districtName)
        : null;
    if (sameDistrict === true) {
      score += 1;
      signals.push("район");
    } else if (sameDistrict === false) {
      score -= 2;
    }
    if (clues.rooms && p.rooms === clues.rooms) {
      score += 2;
      roomsMatch = true;
      signals.push("комнаты");
    }
    if (clues.floor && p.floor) {
      if (p.floor === clues.floor) {
        score += 2;
        floorMatch = true;
        signals.push("этаж");
      } else {
        score -= 2;
      }
    }
    if (clues.totalFloors && p.totalFloors === clues.totalFloors) {
      score += 1;
      signals.push("этажность");
    }
    const area = num(p.areaSqm);
    let areaMatch = false;
    if (clues.areaSqm && area) {
      const d = Math.abs(area - clues.areaSqm) / clues.areaSqm;
      if (d <= 0.03) {
        score += 2;
        areaMatch = true;
        signals.push("площадь");
      } else if (d <= 0.07) {
        score += 1;
        areaMatch = true;
        signals.push("площадь");
      } else if (d > 0.15) {
        // Названная площадь не та — такая же улика против, как чужой этаж.
        score -= 2;
      }
    }

    /**
     * ЦЕНА, ПЛОЩАДЬ И РАЙОН ВМЕСТЕ — ТОЖЕ МЕСТО (24.09.2026). Ориентир клиент
     * называет своими словами («Бодомзор»), а в карточке его может не быть вовсе.
     * Три независимые приметы разом — цена почти точная, площадь та же, район тот
     * же — описывают один объект не хуже ориентира; отрыв от второго кандидата
     * по-прежнему обязателен.
     */
    const sotka = num(p.landAreaSotka);
    if (clues.landSotka && sotka) {
      const d = Math.abs(sotka - clues.landSotka) / clues.landSotka;
      if (d <= 0.05) {
        score += 2;
        areaMatch = true;
        signals.push("сотки");
      } else if (d > 0.2) {
        score -= 2;
      }
    }

    if (priceExact && areaMatch && sameDistrict === true) located = true;
    /**
     * БЕЗ РАЙОНА И ОРИЕНТИРА — ЧЕТЫРЕ ТОЧНЫЕ ПРИМЕТЫ (владелец 24.09.2026,
     * «Узнавать»): «2 комнаты, 5 этаж, 64 метра, 520 000» описывает один объект.
     * Второй такой же — и отрыв от него не наберётся, узнавание честно не угадает.
     */
    if (priceExact && areaMatch && roomsMatch && floorMatch) located = true;

    if (score > 0) {
      scored.push({ id: p.id, shortId: p.shortId, status: p.status, agentId: propertyOwnerAgentId(p), score, signals, located });
    }
  }

  scored.sort((a, b) => b.score - a.score || b.shortId - a.shortId);
  const candidates = await withAgents(scored.slice(0, 3).map(({ located: _located, ...c }) => c));
  const [top, second] = scored;
  const sure = !!top && top.located && top.score >= MIN_SCORE && (!second || top.score - second.score >= MIN_LEAD);
  return { propertyId: sure ? top.id : null, via: sure ? "description" : null, candidates };
}
