/**
 * «НАШ ОБЪЕКТ ВИСИТ ЕЩЁ И НА SOMON/PAYDO» (владелец, 02.11.2026).
 *
 * Клиент продаёт квартиру через нас и параллельно выставляет её сам. Агент должен
 * узнать об этом первым: сравнить цены и условия, поговорить с владельцем. Здесь
 * две части:
 *
 *  1. scoreOwnMatch — ЧИСТАЯ оценка «это объявление — тот же объект?» (без базы).
 *  2. runOwnMatching — прогон по всем нашим активным объектам: находит кандидатов в
 *     каталоге MarketListing, пишет PropertyMarketMatch и шлёт агенту пуш.
 *
 * ЛОЖНАЯ ТРЕВОГА ХУЖЕ ПРОПУСКА. Лишний пуш «ваш объект найден на Somon» про чужую
 * квартиру приучает агента не открывать такие уведомления вовсе — и тогда
 * пропадает и настоящее. Поэтому:
 *
 *  · Совпадение параметров САМО ПО СЕБЕ кандидата не даёт. Панельные 3-комнатные на
 *    5-м этаже девятиэтажки с одной площадью стоят в десятках одинаковых домов
 *    района — район + комнаты + площадь + этаж + цена не отличают нашу квартиру от
 *    соседской. Параметры (максимум 80 баллов) лишь подтверждают, а «ТОТ ЖЕ
 *    ОБЪЕКТ» говорит один из двух опознавательных признаков: телефон владельца в
 *    объявлении (но только личный: номер, стоящий на трёх и более объявлениях или
 *    на объявлении агентства, склеивает всё подряд и признаком не считается) или
 *    координаты точки ближе 50 м при известном и совпавшем этаже (в 150 м стоят
 *    дома-близнецы, без этажа точка «тот же объект» не говорит).
 *  · Противоречие отбрасывает пару сразу: другое число комнат, площадь дальше
 *    чем на 3 м², другой этаж или этажность, цена дальше ±15%, точка дальше 2 км.
 *    «Неизвестно» противоречием не считается, но и баллов не даёт.
 *  · Порог: с телефоном ≥ 70, без него (по точке) ≥ 85.
 *
 * ТЕЛЕФОН ВЛАДЕЛЬЦА ПОПАДАЕТ ТОЛЬКО В СРАВНЕНИЕ. Ни в причины, ни в лог, ни в пуш
 * номер целиком не пишется (в логе — маска `+992•••••56`).
 *
 * Одна дверь на «объект ↔ площадка»: сравнивает только эта функция, остальные
 * места (cron, маршруты) её зовут, своих правил совпадения не заводят.
 */

import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { sendPushToAgent } from "../../push.js";
import { phoneTail, PHONE_TAIL_LEN } from "../clientPhones.js";
import { maskClientPhone } from "../clientPhone.js";
import { distanceMeters } from "../geo.js";
import { loadMoneyContext, toTjs } from "../money.js";
import { logSystemError } from "../systemError.js";
import { marketCatalogWhere } from "./somonRubrics.js";

// ───────────────────────────── Правила совпадения ─────────────────────────────

/** Насколько может разойтись площадь одного объекта в двух записях (как в listingDedupe). */
export const OWN_AREA_TOLERANCE_SQM = 3;
/** Допуск по цене: владелец мог выставить дороже/дешевле нас, но не вдвое. */
export const OWN_PRICE_TOLERANCE = 0.15;
/** Точка ближе этого И с известным совпавшим этажом — «тот же объект» (дома-близнецы стоят в 100–150 м). */
export const OWN_GEO_NEAR_M = 50;
/** Номер, стоящий на большем числе активных объявлений каталога, — номер посредника, а не владельца. */
export const OWN_PHONE_MAX_LISTINGS = 2;
/** Точки дальше этого — противоречие (координаты площадок приблизительны, 2 км — с запасом). */
export const OWN_GEO_FAR_M = 2000;
export const OWN_THRESHOLD_WITH_PHONE = 70;
export const OWN_THRESHOLD_WITHOUT_PHONE = 85;
/** Повторный пуш о цене — только если она на площадке сдвинулась хотя бы на столько. */
export const OWN_PRICE_RENOTIFY_SHARE = 0.03;

export interface OwnMatchProperty {
  type: string;
  rooms: number | null;
  areaSqm: number | null;
  floor: number | null;
  totalFloors: number | null;
  /** Цена в сомони (доллары приводятся снаружи по курсу). */
  priceTjs: number | null;
  districtName: string | null;
  lat: number | null;
  lng: number | null;
  /** Последние 9 цифр каждого номера владельца. */
  ownerPhoneTails: string[];
}

export interface OwnMatchListing {
  propertyType: string;
  districtName: string | null;
  rooms: number | null;
  areaSqm: number | null;
  floor: number | null;
  totalFloors: number | null;
  priceTjs: number | null;
  latitude: number | null;
  longitude: number | null;
  sellerPhone: string | null;
  /** Объявление агентства/застройщика: его номер склеивает чужие объекты. Не задано — не агентство. */
  isAgency?: boolean;
  /** Сколько активных объявлений каталога стоит на этом номере. Не задано — считаем, что одно. */
  sellerPhoneListings?: number;
}

export interface MatchReason {
  code: "phone" | "geo" | "district" | "rooms" | "area" | "floor" | "totalFloors" | "price";
  label: string;
}

export interface OwnMatchVerdict {
  score: number;
  reasons: MatchReason[];
  /** Прошла порог — стоит записать совпадение. */
  candidate: boolean;
  phoneMatched: boolean;
  /** Если пара отброшена как противоречивая — почему (для тестов и отладки). */
  rejected: string | null;
}

function normDistrict(name: string | null): string | null {
  const s = (name ?? "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return s || null;
}

/**
 * Номера из свободной строки контакта: «+992 927 12 34 56, жена 900 11 22 33».
 *
 * Строка режется по буквам, запятым и «+»; внутри куска цифры склеиваются, а если их
 * больше 12 — это два номера через пробел («900 00 00 56 927 11 22 33»): отрезаем по
 * 12 цифр, когда начинается с кода 992, иначе по 9. Один номер из цифр в 9–12 берём целиком.
 */
export function extractPhoneTails(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const tails = new Set<string>();
  for (const chunk of raw.split(/(?=\+)|[^\d\s\-().+]+/u)) {
    let digits = chunk.replace(/\D/g, "");
    while (digits.length >= PHONE_TAIL_LEN) {
      const take = digits.length > 12 ? (digits.startsWith("992") ? 12 : PHONE_TAIL_LEN) : digits.length;
      tails.add(phoneTail(digits.slice(0, take)));
      digits = digits.slice(take);
    }
  }
  return [...tails];
}

/** Маска номера для лога: `+992•••••56`. */
export function maskTail(tail: string): string {
  return maskClientPhone(`+992${tail}`);
}

const REJECT = (why: string): OwnMatchVerdict => ({ score: 0, reasons: [], candidate: false, phoneMatched: false, rejected: why });

export function scoreOwnMatch(p: OwnMatchProperty, l: OwnMatchListing): OwnMatchVerdict {
  // ── Противоречия: любое из них закрывает пару. ──
  if (p.type !== l.propertyType) return REJECT("type");
  if (p.rooms != null && l.rooms != null && p.rooms !== l.rooms) return REJECT("rooms");
  if (p.areaSqm != null && l.areaSqm != null && Math.abs(p.areaSqm - l.areaSqm) > OWN_AREA_TOLERANCE_SQM) return REJECT("area");
  if (p.floor != null && l.floor != null && p.floor !== l.floor) return REJECT("floor");
  if (p.totalFloors != null && l.totalFloors != null && p.totalFloors !== l.totalFloors) return REJECT("totalFloors");
  let priceShare: number | null = null;
  if (p.priceTjs != null && l.priceTjs != null && p.priceTjs > 0 && l.priceTjs > 0) {
    priceShare = Math.abs(p.priceTjs - l.priceTjs) / Math.min(p.priceTjs, l.priceTjs);
    if (priceShare > OWN_PRICE_TOLERANCE) return REJECT("price");
  }
  let distance: number | null = null;
  if (p.lat != null && p.lng != null && l.latitude != null && l.longitude != null) {
    distance = distanceMeters(p.lat, p.lng, l.latitude, l.longitude);
    if (distance > OWN_GEO_FAR_M) return REJECT("geo");
  }

  const reasons: MatchReason[] = [];
  let score = 0;

  // ── Опознавательные признаки: «тот же объект», а не «похожий». ──
  const sellerTail = l.sellerPhone ? phoneTail(l.sellerPhone) : "";
  const personalPhone = !l.isAgency && (l.sellerPhoneListings ?? 1) <= OWN_PHONE_MAX_LISTINGS;
  const phoneMatched = personalPhone && sellerTail.length === PHONE_TAIL_LEN && p.ownerPhoneTails.includes(sellerTail);
  if (phoneMatched) {
    score += 40;
    reasons.push({ code: "phone", label: "Телефон владельца совпал с телефоном в объявлении" });
  }
  // Точка сама по себе дом-близнец не отличает: «тот же объект» только при известном с обеих
  // сторон этаже (совпадение этажа уже проверено выше — разные этажи отброшены).
  const geoNear = distance != null && distance <= OWN_GEO_NEAR_M && p.floor != null && l.floor != null;
  if (geoNear) {
    score += 25;
    reasons.push({ code: "geo", label: `Точка на карте в ${Math.max(10, Math.round((distance as number) / 10) * 10)} м от нашего объекта, этаж тот же` });
  }

  // ── Подтверждающие параметры (вместе максимум 80). ──
  const dp = normDistrict(p.districtName);
  const dl = normDistrict(l.districtName);
  if (dp && dl && dp === dl) {
    score += 15;
    reasons.push({ code: "district", label: "Тот же район" });
  }
  if (p.rooms != null && l.rooms != null) {
    score += 10;
    reasons.push({ code: "rooms", label: `${l.rooms} комн.` });
  }
  if (p.areaSqm != null && l.areaSqm != null) {
    const diff = Math.abs(p.areaSqm - l.areaSqm);
    score += diff <= 1 ? 20 : 12;
    reasons.push({ code: "area", label: diff < 0.05 ? "Площадь совпала" : `Площадь отличается на ${diff.toFixed(1)} м²` });
  }
  if (p.floor != null && l.floor != null) {
    score += 15;
    reasons.push({ code: "floor", label: `Тот же этаж (${l.floor})` });
  }
  if (p.totalFloors != null && l.totalFloors != null) {
    score += 5;
    reasons.push({ code: "totalFloors", label: `Та же этажность (${l.totalFloors})` });
  }
  if (priceShare != null) {
    score += priceShare <= 0.02 ? 15 : priceShare <= 0.05 ? 10 : 5;
    reasons.push({ code: "price", label: priceShare < 0.005 ? "Цена та же" : `Цена отличается на ${Math.round(priceShare * 100)}%` });
  }

  score = Math.min(100, score);
  const hasIdentity = phoneMatched || geoNear;
  const threshold = phoneMatched ? OWN_THRESHOLD_WITH_PHONE : OWN_THRESHOLD_WITHOUT_PHONE;
  return { score, reasons, candidate: hasIdentity && score >= threshold, phoneMatched, rejected: null };
}

// ───────────────────────────── Прогон по объектам ─────────────────────────────

/** Сколько объектов обрабатываем одним запросом в каталог (OR по объектам, а не запрос на каждый). */
const PROPERTY_CHUNK = 40;
/** Потолок объявлений на один запрос — защита от неограниченной выборки. */
const LISTING_TAKE = 4000;
/** Потолок объектов за прогон. */
const PROPERTY_LIMIT = 3000;
/** Окно по координатам для выборки: ~0,001° ≈ 110 м по широте — с запасом над точкой «тот же объект» (50 м). */
const GEO_BOX_DEG = 0.001;
/** Сколько строк рассылки читаем за один запрос (страницы идут по курсору, потолка на прогон нет). */
const NOTIFY_PAGE = 500;
/** Защита от бесконечного цикла по страницам: 500 x 200 = 100 000 пар. */
const NOTIFY_MAX_PAGES = 200;

export interface OwnMatchingStats {
  properties: number;
  created: number;
  updated: number;
  newNotified: number;
  priceNotified: number;
  goneNotified: number;
}

/** Площадка человеческим именем для текста пуша: "somon.tj" → "Somon". */
export function platformName(source: string): string {
  const s = source.toLowerCase();
  if (s.includes("somon")) return "Somon";
  if (s.includes("paydo")) return "Paydo";
  return source.replace(/\.tj$/i, "").replace(/^./, (c) => c.toUpperCase());
}

/** 1 120 000 — пробелы обычные, не NBSP: так число не переносится в середине и читается в шторке. */
function fmt(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function shortTitle(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  return t.length > 40 ? `${t.slice(0, 39)}…` : t;
}

function num(v: { toString(): string } | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v.toString());
  return Number.isFinite(n) ? n : null;
}

type PropertyRow = Prisma.PropertyGetPayload<{
  select: {
    id: true; shortId: true; title: true; type: true; rooms: true; areaSqm: true; floor: true; totalFloors: true;
    price: true; currency: true; lat: true; lng: true; ownerContact: true; assignedAgentId: true;
    district: { select: { name: true } };
  };
}>;

const PROPERTY_SELECT = {
  id: true, shortId: true, title: true, type: true, rooms: true, areaSqm: true, floor: true, totalFloors: true,
  price: true, currency: true, lat: true, lng: true, ownerContact: true, assignedAgentId: true,
  district: { select: { name: true } },
} as const;

function toMatchProperty(row: PropertyRow, priceTjs: number | null): OwnMatchProperty {
  return {
    type: row.type,
    rooms: row.rooms,
    areaSqm: num(row.areaSqm),
    floor: row.floor,
    totalFloors: row.totalFloors,
    priceTjs,
    districtName: row.district?.name ?? null,
    lat: num(row.lat),
    lng: num(row.lng),
    ownerPhoneTails: extractPhoneTails(row.ownerContact),
  };
}

/**
 * Условие выборки кандидатов одного объекта: тип, комнаты, площадь, и (телефон | точка).
 * Район в условие НЕ входит: одним районом пара кандидатом стать не может (нужен
 * опознавательный признак), а условие раздувало выборку и вытесняло давние объявления.
 * Для точки при известном этаже требуем тот же этаж — иначе дом-близнец не отсечь.
 */
function candidateWhere(row: PropertyRow, mp: OwnMatchProperty): Prisma.MarketListingWhereInput {
  const anyOf: Prisma.MarketListingWhereInput[] = [];
  if (mp.ownerPhoneTails.length) anyOf.push({ sellerPhone: { in: mp.ownerPhoneTails.map((t) => `+992${t}`) } });
  if (mp.lat != null && mp.lng != null && mp.floor != null) {
    anyOf.push({
      latitude: { gte: mp.lat - GEO_BOX_DEG, lte: mp.lat + GEO_BOX_DEG },
      longitude: { gte: mp.lng - GEO_BOX_DEG, lte: mp.lng + GEO_BOX_DEG },
      floor: mp.floor,
    });
  }
  return {
    propertyType: row.type,
    ...(mp.rooms != null ? { rooms: mp.rooms } : {}),
    ...(mp.areaSqm != null
      ? { areaSqm: { gte: mp.areaSqm - OWN_AREA_TOLERANCE_SQM, lte: mp.areaSqm + OWN_AREA_TOLERANCE_SQM } }
      : {}),
    OR: anyOf,
  };
}

/** Сколько активных объявлений каталога стоит на каждом из номеров (ключ — номер как в базе). */
async function countListingsByPhone(phones: string[]): Promise<Map<string, number>> {
  if (phones.length === 0) return new Map();
  const groups = await prisma.marketListing.groupBy({
    by: ["sellerPhone"],
    where: { isActive: true, sellerPhone: { in: phones }, AND: [marketCatalogWhere()] },
    _count: { _all: true },
  });
  return new Map(groups.filter((g) => g.sellerPhone).map((g) => [g.sellerPhone as string, g._count._all]));
}

/**
 * Прогон: найти наши объекты на площадках и уведомить агентов.
 *
 * Вызывать из cron после сбора каталога: `await runOwnMatching()`. Безопасно
 * запускать повторно и параллельно — пуш уходит один раз (метка notifiedAt
 * занимается атомарным updateMany ДО отправки, считаем count).
 */
export async function runOwnMatching(): Promise<OwnMatchingStats> {
  const stats: OwnMatchingStats = { properties: 0, created: 0, updated: 0, newNotified: 0, priceNotified: 0, goneNotified: 0 };

  const [properties, money] = await Promise.all([
    prisma.property.findMany({
      where: { status: "AVAILABLE", deletedAt: null, type: { in: ["APARTMENT", "HOUSE"] } },
      select: PROPERTY_SELECT,
      orderBy: { createdAt: "desc" },
      take: PROPERTY_LIMIT,
    }),
    loadMoneyContext(),
  ]);
  stats.properties = properties.length;
  if (properties.length === 0) return stats;

  const prepared = properties.map((row) => {
    const priceTjs = row.price != null ? Math.round(toTjs(row.price, row.currency, money)) : null;
    return { row, mp: toMatchProperty(row, priceTjs) };
  });

  for (let i = 0; i < prepared.length; i += PROPERTY_CHUNK) {
    const chunk = prepared.slice(i, i + PROPERTY_CHUNK).filter((x) => candidateWhere(x.row, x.mp).OR?.length);
    if (chunk.length === 0) continue;

    const [listings, existing] = await Promise.all([
      prisma.marketListing.findMany({
        where: {
          isActive: true,
          dealType: "SALE",
          OR: chunk.map((x) => candidateWhere(x.row, x.mp)),
          AND: [marketCatalogWhere()],
        },
        select: {
          id: true, propertyType: true, districtName: true, rooms: true, areaSqm: true, floor: true, totalFloors: true,
          priceTjs: true, latitude: true, longitude: true, sellerPhone: true, isAgency: true,
        },
        orderBy: { lastSeenAt: "desc" },
        take: LISTING_TAKE,
      }),
      prisma.propertyMarketMatch.findMany({
        where: { propertyId: { in: chunk.map((x) => x.row.id) } },
        select: { id: true, propertyId: true, listingId: true, status: true, score: true },
      }),
    ]);
    if (listings.length >= LISTING_TAKE) {
      console.warn(`[own-match] выборка упёрлась в потолок ${LISTING_TAKE} объявлений — часть кандидатов могла не попасть в прогон`);
    }
    const existingByKey = new Map(existing.map((m) => [`${m.propertyId}:${m.listingId}`, m]));
    const phoneCounts = await countListingsByPhone([...new Set(listings.map((l) => l.sellerPhone).filter((x): x is string => !!x))]);

    const toCreate: Prisma.PropertyMarketMatchCreateManyInput[] = [];
    for (const { row, mp } of chunk) {
      for (const l of listings) {
        const verdict = scoreOwnMatch(mp, {
          propertyType: l.propertyType,
          districtName: l.districtName,
          rooms: l.rooms,
          areaSqm: num(l.areaSqm),
          floor: l.floor,
          totalFloors: l.totalFloors,
          priceTjs: num(l.priceTjs),
          latitude: num(l.latitude),
          longitude: num(l.longitude),
          sellerPhone: l.sellerPhone,
          isAgency: l.isAgency,
          sellerPhoneListings: l.sellerPhone ? (phoneCounts.get(l.sellerPhone) ?? 1) : undefined,
        });
        if (!verdict.candidate) continue;
        const prev = existingByKey.get(`${row.id}:${l.id}`);
        if (!prev) {
          toCreate.push({
            propertyId: row.id, listingId: l.id, score: verdict.score, reasons: verdict.reasons as unknown as Prisma.InputJsonValue,
            // Цена на момент находки — точка отсчёта для «цена сдвинулась»: без неё пара с пустой
            // ценой на первом пуше навсегда лишалась бы повторных уведомлений о цене.
            lastPriceTjs: num(l.priceTjs),
          });
        } else if (prev.status !== "DISMISSED" && prev.score !== verdict.score) {
          await prisma.propertyMarketMatch.update({
            where: { id: prev.id },
            data: { score: verdict.score, reasons: verdict.reasons as unknown as Prisma.InputJsonValue },
          });
          stats.updated++;
        }
      }
    }
    if (toCreate.length) {
      // skipDuplicates: параллельный прогон мог создать ту же пару между чтением и записью.
      const res = await prisma.propertyMarketMatch.createMany({ data: toCreate, skipDuplicates: true });
      stats.created += res.count;
    }
  }

  await notifyPending(stats);
  return stats;
}

const NOTIFY_SELECT = {
  id: true, notifiedAt: true, lastPriceTjs: true, goneNotifiedAt: true,
  property: { select: { id: true, shortId: true, title: true, price: true, currency: true, assignedAgentId: true } },
  listing: { select: { source: true, priceTjs: true, isActive: true } },
} satisfies Prisma.PropertyMarketMatchSelect;

type NotifyRow = Prisma.PropertyMarketMatchGetPayload<{ select: typeof NOTIFY_SELECT }>;

const LIVE_PROPERTY = { status: "AVAILABLE", deletedAt: null, assignedAgentId: { not: null } } as const;

/**
 * Читает строки рассылки страницами по курсору (id) и отдаёт каждую страницу обработчику.
 * Раньше был один запрос `take: 500` без порядка: 500 давно уведомлённых пар вытесняли
 * новые, и новые совпадения переставали доходить до агента. Теперь выборок три (новые,
 * снятые, цена), и каждая читается ДО КОНЦА — потолка на прогон нет.
 */
async function forEachPendingPage(
  where: Prisma.PropertyMarketMatchWhereInput,
  handle: (rows: NotifyRow[]) => Promise<void>,
): Promise<void> {
  let cursor: string | undefined;
  for (let page = 0; page < NOTIFY_MAX_PAGES; page++) {
    const rows = await prisma.propertyMarketMatch.findMany({
      where,
      select: NOTIFY_SELECT,
      orderBy: { id: "asc" },
      take: NOTIFY_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) return;
    await handle(rows);
    if (rows.length < NOTIFY_PAGE) return;
    cursor = rows[rows.length - 1].id;
  }
  console.warn(`[own-match] рассылка упёрлась в ${NOTIFY_MAX_PAGES} страниц — остаток уйдёт в следующем прогоне`);
}

/**
 * Рассылка. Метку занимаем updateMany с условием ДО отправки: два параллельных
 * прогона увидят одну и ту же строку, но count === 1 получит только один. Если
 * отправка упала (sendPushToAgent бросил) — метку СНИМАЕМ, и следующий прогон
 * повторит: иначе сбой оставлял бы агента без находки навсегда.
 *
 * ОГРАНИЧЕНИЕ (без миграции): кому ушёл пуш, не хранится. Если ответственного за
 * объект сменили после первого пуша, новый агент узнает о находке только из блока
 * «На площадках» в карточке и при изменении цены/снятии объявления; отдельного
 * «вам передали объект с находкой» нет. Нужна колонка notifiedAgentId.
 */
async function notifyPending(stats: OwnMatchingStats): Promise<void> {
  // Объявление снова появилось на площадке — пуш «сняли» должен суметь уйти снова.
  await prisma.propertyMarketMatch.updateMany({
    where: { goneNotifiedAt: { not: null }, listing: { isActive: true } },
    data: { goneNotifiedAt: null },
  });

  const status = { in: ["CANDIDATE", "CONFIRMED"] };
  const money = await loadMoneyContext();
  const handle = (rows: NotifyRow[]) => notifyRows(rows, money, stats);

  // 1) Новые находки.
  await forEachPendingPage({ status, property: LIVE_PROPERTY, notifiedAt: null, listing: { isActive: true } }, handle);
  // 2) Объявление сняли.
  await forEachPendingPage(
    { status, property: LIVE_PROPERTY, notifiedAt: { not: null }, listing: { isActive: false }, goneNotifiedAt: null },
    handle,
  );
  // 3) Цена на площадке (сравнение с прежней — в notifyRows).
  await forEachPendingPage({ status, property: LIVE_PROPERTY, notifiedAt: { not: null }, listing: { isActive: true } }, handle);
}

async function notifyRows(rows: NotifyRow[], money: Awaited<ReturnType<typeof loadMoneyContext>>, stats: OwnMatchingStats): Promise<void> {
  for (const m of rows) {
    const agentId = m.property.assignedAgentId;
    if (!agentId) continue;
    const site = platformName(m.listing.source);
    const listingPrice = num(m.listing.priceTjs);
    const ourPrice = m.property.price != null ? Math.round(toTjs(m.property.price, m.property.currency, money)) : null;
    const title = shortTitle(m.property.title);
    const base = {
      kind: "market" as const,
      url: `/properties/${m.property.shortId}`,
      tag: `own-market-match:${m.id}`,
    };
    const ours = ourPrice != null ? ` (у нас ${fmt(ourPrice)})` : "";

    if (!m.listing.isActive) {
      const at = new Date();
      const claim = await prisma.propertyMarketMatch.updateMany({
        where: { id: m.id, goneNotifiedAt: null },
        data: { goneNotifiedAt: at },
      });
      if (claim.count !== 1) continue;
      const sent = await safePush(agentId, { ...base, title: "Объявление сняли с площадки", body: `Ваш объект «${title}» больше не виден на ${site}` });
      if (!sent) {
        await prisma.propertyMarketMatch.updateMany({ where: { id: m.id, goneNotifiedAt: at }, data: { goneNotifiedAt: null } });
        continue;
      }
      stats.goneNotified++;
      continue;
    }

    if (m.notifiedAt == null) {
      const at = new Date();
      const claim = await prisma.propertyMarketMatch.updateMany({
        where: { id: m.id, notifiedAt: null },
        data: { notifiedAt: at, lastPriceTjs: listingPrice },
      });
      if (claim.count !== 1) continue;
      const price = listingPrice != null ? `: ${fmt(listingPrice)} с${ours}` : "";
      const sent = await safePush(agentId, { ...base, title: "Ваш объект есть на площадке", body: `Ваш объект «${title}» найден на ${site}${price}` });
      if (!sent) {
        await prisma.propertyMarketMatch.updateMany({ where: { id: m.id, notifiedAt: at }, data: { notifiedAt: null } });
        continue;
      }
      stats.newNotified++;
      continue;
    }

    if (listingPrice == null) continue;
    const last = num(m.lastPriceTjs);
    if (last == null || last <= 0) {
      // Цены на момент находки не было, теперь есть: запоминаем как точку отсчёта, без пуша.
      await prisma.propertyMarketMatch.updateMany({ where: { id: m.id, lastPriceTjs: null }, data: { lastPriceTjs: listingPrice } });
      continue;
    }
    if (Math.abs(listingPrice - last) / last < OWN_PRICE_RENOTIFY_SHARE) continue;
    // Оптимистичная блокировка по прежней цене: второй прогон увидит уже новую и промолчит.
    const claim = await prisma.propertyMarketMatch.updateMany({
      where: { id: m.id, lastPriceTjs: m.lastPriceTjs },
      data: { lastPriceTjs: listingPrice },
    });
    if (claim.count !== 1) continue;
    const sent = await safePush(agentId, {
      ...base,
      title: "Цена на площадке изменилась",
      body: `«${title}» на ${site}: ${fmt(last)} → ${fmt(listingPrice)} с${ours}`,
    });
    if (!sent) {
      await prisma.propertyMarketMatch.updateMany({ where: { id: m.id, lastPriceTjs: listingPrice }, data: { lastPriceTjs: m.lastPriceTjs } });
      continue;
    }
    stats.priceNotified++;
  }
}

/** true — отправка не бросила. Ошибка пишется в журнал без номеров и текста пуша. */
async function safePush(agentId: string, payload: Parameters<typeof sendPushToAgent>[1]): Promise<boolean> {
  try {
    await sendPushToAgent(agentId, payload);
    return true;
  } catch (err) {
    void logSystemError("api", `Пуш о совпадении с площадкой не ушёл: ${err instanceof Error ? err.name : "ошибка"}`, { url: payload.url });
    return false;
  }
}
