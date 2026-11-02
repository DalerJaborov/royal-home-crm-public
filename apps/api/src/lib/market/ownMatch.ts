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
 *    объявлении или координаты точки ближе 150 м.
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

// ───────────────────────────── Правила совпадения ─────────────────────────────

/** Насколько может разойтись площадь одного объекта в двух записях (как в listingDedupe). */
export const OWN_AREA_TOLERANCE_SQM = 3;
/** Допуск по цене: владелец мог выставить дороже/дешевле нас, но не вдвое. */
export const OWN_PRICE_TOLERANCE = 0.15;
/** Точка ближе этого — «тот же дом». */
export const OWN_GEO_NEAR_M = 150;
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

/** Номера из свободной строки контакта: «+992 927 12 34 56, жена 900 11 22 33». */
export function extractPhoneTails(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const tails = new Set<string>();
  for (const chunk of raw.match(/\+?\d[\d\s\-().]{7,}\d/g) ?? []) {
    const tail = phoneTail(chunk);
    if (tail.length === PHONE_TAIL_LEN) tails.add(tail);
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
  const phoneMatched = sellerTail.length === PHONE_TAIL_LEN && p.ownerPhoneTails.includes(sellerTail);
  if (phoneMatched) {
    score += 40;
    reasons.push({ code: "phone", label: "Телефон владельца совпал с телефоном в объявлении" });
  }
  const geoNear = distance != null && distance <= OWN_GEO_NEAR_M;
  if (geoNear) {
    score += 25;
    reasons.push({ code: "geo", label: `Точка на карте в ${Math.max(10, Math.round((distance as number) / 10) * 10)} м от нашего объекта` });
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
/** Окно по координатам для выборки: ~0,0025° ≈ 280 м по широте. */
const GEO_BOX_DEG = 0.0025;

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

/** Условие выборки кандидатов одного объекта: тип, комнаты, площадь, и (район | телефон | точка). */
function candidateWhere(row: PropertyRow, mp: OwnMatchProperty): Prisma.MarketListingWhereInput {
  const anyOf: Prisma.MarketListingWhereInput[] = [];
  if (mp.districtName) anyOf.push({ districtName: { equals: mp.districtName, mode: "insensitive" } });
  if (mp.ownerPhoneTails.length) anyOf.push({ sellerPhone: { in: mp.ownerPhoneTails.map((t) => `+992${t}`) } });
  if (mp.lat != null && mp.lng != null) {
    anyOf.push({
      latitude: { gte: mp.lat - GEO_BOX_DEG, lte: mp.lat + GEO_BOX_DEG },
      longitude: { gte: mp.lng - GEO_BOX_DEG, lte: mp.lng + GEO_BOX_DEG },
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
        },
        select: {
          id: true, propertyType: true, districtName: true, rooms: true, areaSqm: true, floor: true, totalFloors: true,
          priceTjs: true, latitude: true, longitude: true, sellerPhone: true,
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
        });
        if (!verdict.candidate) continue;
        const prev = existingByKey.get(`${row.id}:${l.id}`);
        if (!prev) {
          toCreate.push({
            propertyId: row.id, listingId: l.id, score: verdict.score, reasons: verdict.reasons as unknown as Prisma.InputJsonValue,
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

/**
 * Рассылка. Метку занимаем updateMany с условием ДО отправки: два параллельных
 * прогона увидят одну и ту же строку, но count === 1 получит только один. Цена
 * потери — если отправка упала после занятия метки, пуш не повторится; запись в
 * ленте уведомлений создаёт сам sendPushToAgent, так что агент её не потеряет.
 */
async function notifyPending(stats: OwnMatchingStats): Promise<void> {
  const rows = await prisma.propertyMarketMatch.findMany({
    where: {
      status: { in: ["CANDIDATE", "CONFIRMED"] },
      property: { status: "AVAILABLE", deletedAt: null, assignedAgentId: { not: null } },
      OR: [
        { notifiedAt: null, listing: { isActive: true } },
        { notifiedAt: { not: null }, listing: { isActive: true }, lastPriceTjs: { not: null } },
        { notifiedAt: { not: null }, listing: { isActive: false }, goneNotifiedAt: null },
      ],
    },
    select: {
      id: true, notifiedAt: true, lastPriceTjs: true, goneNotifiedAt: true,
      property: { select: { id: true, shortId: true, title: true, price: true, currency: true, assignedAgentId: true } },
      listing: { select: { source: true, priceTjs: true, isActive: true } },
    },
    take: 500,
  });
  if (rows.length === 0) return;
  const money = await loadMoneyContext();

  for (const m of rows) {
    const agentId = m.property.assignedAgentId;
    if (!agentId) continue;
    const site = platformName(m.listing.source);
    const listingPrice = num(m.listing.priceTjs);
    const ourPrice = m.property.price != null ? Math.round(toTjs(m.property.price, m.property.currency, money)) : null;
    const title = shortTitle(m.property.title);
    const base = {
      kind: "hot" as const,
      url: `/properties/${m.property.shortId}`,
      tag: `own-market-match:${m.id}`,
    };
    const ours = ourPrice != null ? ` (у нас ${fmt(ourPrice)})` : "";

    if (!m.listing.isActive) {
      const claim = await prisma.propertyMarketMatch.updateMany({
        where: { id: m.id, goneNotifiedAt: null },
        data: { goneNotifiedAt: new Date() },
      });
      if (claim.count !== 1) continue;
      await safePush(agentId, { ...base, title: "Объявление сняли с площадки", body: `Ваш объект «${title}» больше не виден на ${site}` });
      stats.goneNotified++;
      continue;
    }

    if (m.notifiedAt == null) {
      const claim = await prisma.propertyMarketMatch.updateMany({
        where: { id: m.id, notifiedAt: null },
        data: { notifiedAt: new Date(), lastPriceTjs: listingPrice },
      });
      if (claim.count !== 1) continue;
      const price = listingPrice != null ? `: ${fmt(listingPrice)} с${ours}` : "";
      await safePush(agentId, { ...base, title: "Ваш объект есть на площадке", body: `Ваш объект «${title}» найден на ${site}${price}` });
      stats.newNotified++;
      continue;
    }

    const last = num(m.lastPriceTjs);
    if (listingPrice == null || last == null || last <= 0) continue;
    if (Math.abs(listingPrice - last) / last < OWN_PRICE_RENOTIFY_SHARE) continue;
    // Оптимистичная блокировка по прежней цене: второй прогон увидит уже новую и промолчит.
    const claim = await prisma.propertyMarketMatch.updateMany({
      where: { id: m.id, lastPriceTjs: m.lastPriceTjs },
      data: { lastPriceTjs: listingPrice },
    });
    if (claim.count !== 1) continue;
    await safePush(agentId, {
      ...base,
      title: "Цена на площадке изменилась",
      body: `«${title}» на ${site}: ${fmt(last)} → ${fmt(listingPrice)} с${ours}`,
    });
    stats.priceNotified++;
  }
}

async function safePush(agentId: string, payload: Parameters<typeof sendPushToAgent>[1]): Promise<void> {
  try {
    await sendPushToAgent(agentId, payload);
  } catch (err) {
    console.error("[own-match] пуш агенту:", err instanceof Error ? err.message : err);
  }
}
