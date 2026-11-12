/**
 * ДИНАМИКА РЫНКА ПО «УШЕДШИМ» ОБЪЯВЛЕНИЯМ (владелец 02.11.2026).
 *
 * Объявление, которое пропало из выдачи Somon/Paydo, мы не удаляем, а помечаем
 * (marketStore.ts: isActive=false, disappearedAt). Эта память даёт то, чего сайты
 * не показывают: как быстро объекты уходят, по какой цене, снижали ли цену и кто
 * продаёт — риелторы или собственники.
 *
 * ЧЕСТНОСТЬ ПРО СЛОВА. «Пропало» не равно «продано»: объявление могло быть
 * снято, истечь по сроку или уйти в чужой дубль. Поэтому везде — «ушло с
 * площадки». Срок жизни считается от первого появления В НАШЕМ каталоге: у
 * объявлений, висевших до начала сбора, он занижен — это нижняя оценка.
 *
 * Чистая часть (buildDynamics) не знает про БД и тестируется отдельно; запрос
 * (findDynamics) только достаёт строки и отдаёт ей.
 */

import { prisma } from "../../db.js";
import { MIN_SAMPLE } from "./comps.js";
import { marketCatalogWhere } from "./somonRubrics.js";
import { dedupeListings, ownListingIds, WINDOW_DAYS as ACTIVE_WINDOW_DAYS } from "./similarComps.js";

export const DYNAMICS_WINDOW_DAYS = 90;
/** Снимки цены, отличающиеся меньше этого, — шум округления/курса, не снижение. */
export const PRICE_NOISE_SHARE = 0.005;
/** Ушедшее объявление с историей короче этого — артефакт молодого каталога, не «продали». */
export const MIN_HISTORY_DAYS = 3;
/** Продавец с таким числом активных объявлений — риелтор, даже если площадка не пометила. */
export const REALTOR_LISTINGS_THRESHOLD = 5;
/** Допуск по площади относительно объекта (владелец: ±25%). */
export const AREA_TOLERANCE = 0.25;
const FETCH_LIMIT = 800;
const TOP_GONE = 5;
const DAY_MS = 24 * 3600_000;

export interface DynamicsSubject {
  /** Наш объект: найденные/подтверждённые как его объявления из выборки исключаются. */
  propertyId?: string;
  propertyType: "APARTMENT" | "HOUSE";
  city?: string;
  districtName: string | null;
  rooms: number | null;
  areaSqm: number;
}

export interface GonePricePoint {
  priceTjs: number;
  seenAt: Date;
}

export interface GoneRow {
  sourceUrl: string;
  source: string;
  title: string;
  priceTjs: number | null;
  pricePerSqmTjs: number | null;
  firstSeenAt: Date;
  /** Когда его последний раз ВИДЕЛИ в выдаче — конец срока жизни (disappearedAt ставит недельный обход, он позже). */
  lastSeenAt: Date;
  /** Когда обход заметил пропажу — только для сортировки «недавно ушли» и подписи «N дней назад». */
  disappearedAt: Date;
  sellerId: string | null;
  sellerName: string | null;
  sellerPhone: string | null;
  isAgency: boolean;
  snapshots: GonePricePoint[];
  // Признаки для склейки дублей между площадками (нет — не склеиваем).
  districtName?: string | null;
  rooms?: number | null;
  areaSqm?: number | null;
  floor?: number | null;
}

export interface ActiveRow {
  source: string;
  pricePerSqmTjs: number | null;
  priceTjs?: number | null;
  districtName?: string | null;
  rooms?: number | null;
  areaSqm?: number | null;
  floor?: number | null;
  sellerId: string | null;
  sellerPhone: string | null;
  isAgency: boolean;
}

/** Сколько активных объявлений у продавца: ключ `<источник>:<sellerId>` (id продавца уникален только внутри площадки) или `ph:<телефон>`. */
export type SellerCounts = Record<string, number>;

export interface GoneListing {
  sourceUrl: string;
  source: string;
  title: string;
  priceTjs: number | null;
  /** За сколько дней ушло (от первого появления в каталоге). */
  daysListed: number;
  /** Сколько дней назад пропало. */
  goneDaysAgo: number;
  /** На сколько % снижали цену до ухода (null — не снижали). */
  priceCutPercent: number | null;
  isRealtor: boolean;
  sellerName: string | null;
  /** Публичный номер из объявления — только в списке «недавно ушли». */
  sellerPhone: string | null;
}

export interface DynamicsResult {
  status: "ok" | "insufficient" | "unsupported";
  windowDays: number;
  minSample: number;
  minHistoryDays: number;
  basis: string;
  goneCount: number;
  activeCount: number;
  speed: { sampleSize: number; medianDays: number | null };
  price: {
    goneSampleSize: number;
    activeSampleSize: number;
    goneMedianPerSqm: number | null;
    activeMedianPerSqm: number | null;
    /** (ушедшие − висящие) / висящие, %: минус — ушли дешевле тех, что висят. */
    diffPercent: number | null;
    cutSampleSize: number;
    cutSharePercent: number | null;
    avgCutPercent: number | null;
  };
  sellers: { sampleSize: number; realtorPercent: number | null; ownerPercent: number | null; realtorListings: number };
  recentlyGone: GoneListing[];
}

export function emptyDynamics(basis: string, status: "insufficient" | "unsupported" = "insufficient"): DynamicsResult {
  return {
    status,
    windowDays: DYNAMICS_WINDOW_DAYS,
    minSample: MIN_SAMPLE,
    minHistoryDays: MIN_HISTORY_DAYS,
    basis,
    goneCount: 0,
    activeCount: 0,
    speed: { sampleSize: 0, medianDays: null },
    price: {
      goneSampleSize: 0,
      activeSampleSize: 0,
      goneMedianPerSqm: null,
      activeMedianPerSqm: null,
      diffPercent: null,
      cutSampleSize: 0,
      cutSharePercent: null,
      avgCutPercent: null,
    },
    sellers: { sampleSize: 0, realtorPercent: null, ownerPercent: null, realtorListings: 0 },
    recentlyGone: [],
  };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function sellerKey(r: { source: string; sellerId: string | null; sellerPhone: string | null }): string | null {
  if (r.sellerId) return `${r.source}:${r.sellerId}`;
  if (r.sellerPhone) return `ph:${r.sellerPhone}`;
  return null;
}

/** Риелтор: площадка пометила агентством ИЛИ у продавца ≥ 5 активных объявлений. */
export function isRealtorSeller(
  r: { source: string; sellerId: string | null; sellerPhone: string | null; isAgency: boolean },
  counts: SellerCounts
): boolean {
  if (r.isAgency) return true;
  const key = sellerKey(r);
  return key != null && (counts[key] ?? 0) >= REALTOR_LISTINGS_THRESHOLD;
}

/**
 * Срок жизни объявления в днях (дробный) — от первого появления до ПОСЛЕДНЕГО раза, когда его
 * видели. Не до disappearedAt: тот ставится при недельном обходе и накидывал бы до недели.
 */
export function daysListed(r: Pick<GoneRow, "firstSeenAt" | "lastSeenAt">): number {
  return Math.max(0, (r.lastSeenAt.getTime() - r.firstSeenAt.getTime()) / DAY_MS);
}

/**
 * Снижение цены до ухода в %: первая известная цена против последней. Пишется
 * снимок на каждое изменение (marketStore), первый снимок — цена при появлении.
 * Соседние снимки, отличающиеся меньше PRICE_NOISE_SHARE (0,5%), — шум округления и
 * пересчёта по курсу у долларовых объявлений: они не двигают базу сравнения, а «снижение»
 * засчитывается, только если последняя цена ≤ первой × 0,995.
 * null — меньше двух значимых снимков (нечего сравнивать) или цена не падала.
 */
export function priceCutPercent(snapshots: GonePricePoint[]): number | null {
  if (snapshots.length < 2) return null;
  const sorted = [...snapshots].sort((a, b) => a.seenAt.getTime() - b.seenAt.getTime());
  const first = sorted[0].priceTjs;
  if (!(first > 0)) return null;
  let last = first;
  for (const s of sorted.slice(1)) {
    if (Math.abs(s.priceTjs - last) / last < PRICE_NOISE_SHARE) continue;
    last = s.priceTjs;
  }
  if (last > first * (1 - PRICE_NOISE_SHARE)) return null;
  return ((first - last) / first) * 100;
}

function describe(subject: DynamicsSubject): string {
  const parts: string[] = [subject.districtName ?? "весь город"];
  if (subject.propertyType === "APARTMENT" && subject.rooms) parts.push(`${subject.rooms}-комнатные`);
  parts.push(`${Math.round(subject.areaSqm * (1 - AREA_TOLERANCE))}–${Math.round(subject.areaSqm * (1 + AREA_TOLERANCE))} м²`);
  return parts.join(", ");
}

const roundPct = (v: number) => Math.round(v);

/** Чистая часть: из строк ушедших и висящих объявлений — цифры динамики. */
export function buildDynamics(
  goneRows: GoneRow[],
  activeRowsRaw: ActiveRow[],
  sellerCounts: SellerCounts,
  subject: DynamicsSubject,
  now: Date = new Date()
): DynamicsResult {
  const basis = `${describe(subject)}; ушедшие за ${DYNAMICS_WINDOW_DAYS} дней, висящие за ${ACTIVE_WINDOW_DAYS}`;

  // «Ушло» засчитываем только при истории не короче порога (первое появление → последний раз видели) —
  // иначе это молодой каталог. Один объект на двух площадках считается раз (как в similarComps).
  const gone = dedupeListings(goneRows.filter((r) => daysListed(r) >= MIN_HISTORY_DAYS));
  const activeRows = dedupeListings(activeRowsRaw);

  const result = emptyDynamics(basis, "insufficient");
  result.goneCount = gone.length;
  result.activeCount = activeRows.length;

  // 1. Как быстро уходит.
  const lifetimes = gone.map(daysListed);
  result.speed.sampleSize = lifetimes.length;
  if (lifetimes.length >= MIN_SAMPLE) result.speed.medianDays = Math.max(1, Math.round(median(lifetimes) as number));

  // 2. Что уходит по цене.
  const goneSqm = gone.map((r) => r.pricePerSqmTjs).filter((v): v is number => v != null && v > 0);
  const activeSqm = activeRows.map((r) => r.pricePerSqmTjs).filter((v): v is number => v != null && v > 0);
  result.price.goneSampleSize = goneSqm.length;
  result.price.activeSampleSize = activeSqm.length;
  if (goneSqm.length >= MIN_SAMPLE && activeSqm.length >= MIN_SAMPLE) {
    const g = median(goneSqm) as number;
    const a = median(activeSqm) as number;
    result.price.goneMedianPerSqm = Math.round(g);
    result.price.activeMedianPerSqm = Math.round(a);
    result.price.diffPercent = roundPct(((g - a) / a) * 100);
  }

  // Снижали ли цену: берём ушедшие, у которых есть хоть один снимок.
  const withHistory = gone.filter((r) => r.snapshots.length > 0);
  result.price.cutSampleSize = withHistory.length;
  if (withHistory.length >= MIN_SAMPLE) {
    const cuts = withHistory.map((r) => priceCutPercent(r.snapshots)).filter((v): v is number => v != null);
    result.price.cutSharePercent = roundPct((cuts.length / withHistory.length) * 100);
    result.price.avgCutPercent = cuts.length ? roundPct(cuts.reduce((s, v) => s + v, 0) / cuts.length) : null;
  }

  // 3. Кто продаёт: ушедшие и висящие вместе — вся районная выдача.
  const sellerRows = [...gone, ...activeRows];
  const realtors = sellerRows.filter((r) => isRealtorSeller(r, sellerCounts)).length;
  result.sellers.sampleSize = sellerRows.length;
  result.sellers.realtorListings = realtors;
  if (sellerRows.length >= MIN_SAMPLE) {
    result.sellers.realtorPercent = roundPct((realtors / sellerRows.length) * 100);
    result.sellers.ownerPercent = 100 - result.sellers.realtorPercent;
  }

  // 4. Недавно ушедшие — свежие первыми.
  result.recentlyGone = [...gone]
    .sort((a, b) => b.disappearedAt.getTime() - a.disappearedAt.getTime())
    .slice(0, TOP_GONE)
    .map((r) => {
      const cut = priceCutPercent(r.snapshots);
      return {
        sourceUrl: r.sourceUrl,
        source: r.source,
        title: r.title,
        priceTjs: r.priceTjs,
        daysListed: Math.max(1, Math.round(daysListed(r))),
        goneDaysAgo: Math.max(0, Math.floor((now.getTime() - r.disappearedAt.getTime()) / DAY_MS)),
        priceCutPercent: cut == null ? null : roundPct(cut),
        isRealtor: isRealtorSeller(r, sellerCounts),
        sellerName: r.sellerName,
        sellerPhone: r.sellerPhone,
      };
    });

  const hasAny =
    result.speed.medianDays != null ||
    result.price.diffPercent != null ||
    result.price.cutSharePercent != null ||
    result.sellers.realtorPercent != null;
  result.status = hasAny ? "ok" : "insufficient";
  return result;
}

const num = (v: { toString(): string } | null): number | null => (v == null ? null : Number(v));

export async function findDynamics(subject: DynamicsSubject, now: Date = new Date()): Promise<DynamicsResult> {
  const city = subject.city ?? "Душанбе";
  const goneSince = new Date(now.getTime() - DYNAMICS_WINDOW_DAYS * DAY_MS);
  const activeSince = new Date(now.getTime() - ACTIVE_WINDOW_DAYS * DAY_MS);
  const own = await ownListingIds(subject.propertyId);
  const base = {
    ...(own.length ? { id: { notIn: own } } : {}),
    dealType: "SALE",
    propertyType: subject.propertyType,
    city,
    areaSqm: { gte: subject.areaSqm * (1 - AREA_TOLERANCE), lte: subject.areaSqm * (1 + AREA_TOLERANCE) },
    ...(subject.districtName ? { districtName: subject.districtName } : {}),
    // У домов комнатность ничего не значит (как в similarComps).
    ...(subject.propertyType === "APARTMENT" && subject.rooms ? { rooms: subject.rooms } : {}),
    AND: [marketCatalogWhere()],
  };

  const [goneDb, activeDb] = await Promise.all([
    prisma.marketListing.findMany({
      where: { ...base, isActive: false, disappearedAt: { gte: goneSince } },
      select: {
        sourceUrl: true, source: true, title: true, priceTjs: true, pricePerSqmTjs: true, firstSeenAt: true, lastSeenAt: true,
        disappearedAt: true, sellerId: true, sellerName: true, sellerPhone: true, isAgency: true,
        districtName: true, rooms: true, areaSqm: true, floor: true,
        priceSnapshots: { select: { priceTjs: true, seenAt: true }, orderBy: { seenAt: "asc" } },
      },
      orderBy: { disappearedAt: "desc" },
      take: FETCH_LIMIT,
    }),
    prisma.marketListing.findMany({
      where: { ...base, isActive: true, lastSeenAt: { gte: activeSince } },
      select: {
        source: true, pricePerSqmTjs: true, priceTjs: true, sellerId: true, sellerPhone: true, isAgency: true,
        districtName: true, rooms: true, areaSqm: true, floor: true,
      },
      orderBy: { lastSeenAt: "desc" },
      take: FETCH_LIMIT,
    }),
  ]);

  const goneRows: GoneRow[] = goneDb.flatMap((r) =>
    r.disappearedAt
      ? [{
          sourceUrl: r.sourceUrl, source: r.source, title: r.title,
          priceTjs: num(r.priceTjs), pricePerSqmTjs: num(r.pricePerSqmTjs),
          firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt, disappearedAt: r.disappearedAt,
          districtName: r.districtName, rooms: r.rooms, areaSqm: num(r.areaSqm), floor: r.floor,
          sellerId: r.sellerId, sellerName: r.sellerName, sellerPhone: r.sellerPhone, isAgency: r.isAgency,
          snapshots: r.priceSnapshots.map((s) => ({ priceTjs: Number(s.priceTjs), seenAt: s.seenAt })),
        }]
      : []
  );
  const activeRows: ActiveRow[] = activeDb.map((r) => ({
    source: r.source, pricePerSqmTjs: num(r.pricePerSqmTjs), priceTjs: num(r.priceTjs),
    districtName: r.districtName, rooms: r.rooms, areaSqm: num(r.areaSqm), floor: r.floor,
    sellerId: r.sellerId, sellerPhone: r.sellerPhone, isAgency: r.isAgency,
  }));

  // Сколько активных объявлений у продавцов выборки — по ВСЕМУ каталогу, не только по району:
  // риелтор с 40 объявлениями по городу остаётся риелтором, даже если в районе у него два.
  const ids = [...new Set([...goneRows, ...activeRows].map((r) => r.sellerId).filter((v): v is string => !!v))];
  const phones = [...new Set([...goneRows, ...activeRows].filter((r) => !r.sellerId).map((r) => r.sellerPhone).filter((v): v is string => !!v))];
  const counts: SellerCounts = {};
  const [byId, byPhone] = await Promise.all([
    ids.length
      ? prisma.marketListing.groupBy({ by: ["source", "sellerId"], where: { isActive: true, dealType: "SALE", sellerId: { in: ids }, AND: [marketCatalogWhere()] }, _count: { _all: true } })
      : Promise.resolve([]),
    phones.length
      ? prisma.marketListing.groupBy({ by: ["sellerPhone"], where: { isActive: true, dealType: "SALE", sellerId: null, sellerPhone: { in: phones }, AND: [marketCatalogWhere()] }, _count: { _all: true } })
      : Promise.resolve([]),
  ]);
  // id продавца уникален только внутри площадки: у Somon и Paydo «123» — разные люди.
  for (const g of byId) if (g.sellerId) counts[`${g.source}:${g.sellerId}`] = g._count._all;
  for (const g of byPhone) if (g.sellerPhone) counts[`ph:${g.sellerPhone}`] = g._count._all;

  return buildDynamics(goneRows, activeRows, counts, subject, now);
}
