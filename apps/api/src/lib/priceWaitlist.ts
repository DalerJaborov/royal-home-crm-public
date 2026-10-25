import {
  PRICE_WAITLIST_DROPS_PCT,
  PRICE_WAITLIST_MIN_SAMPLE,
  PRICE_WAITLIST_TAKE,
  PRICE_WAITLIST_VISIBLE_MAX,
  type PriceWaitlistResponse,
  type PriceWaitlistStep,
  type PriceWaitlistVisibleClient,
} from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { clientMatchesProperty } from "../routes/matching.js";
import { clientRequirementsForPropertyWhere, loadMatchPolicy, waitingBuyerWhere, type MatchPolicy } from "./matchPolicy.js";
import { MAX_DESIRED_PLACE_RADIUS_M, pointBboxWhere } from "./geoDistance.js";
import { loadMoneyContext, toTjs, type MoneyContext } from "./money.js";

/**
 * ЛИСТ ОЖИДАНИЯ ПО ЦЕНЕ (03.10.2026) — «3 клиента посмотрят, если цена будет не выше X».
 *
 * ЧТО СЧИТАЕТСЯ. Ждущие покупатели, которые подходят объекту ВО ВСЁМ, кроме цены:
 * район или радиус, тип, комнаты, площадь, этаж. Это не второе определение, а то же:
 *  • «ждущий» — `waitingBuyerWhere` (lib/matchPolicy.ts), как у счётчика спроса и списка «Кому подойдёт»;
 *  • соответствие — `clientMatchesProperty` (routes/matching.ts) с вычеркнутым бюджетом клиента:
 *    ровно та же проверка, в которой просто нет условия по деньгам;
 *  • допуск бюджета — `policy.budgetToleranceRatio` из Настроек (по умолчанию ±10 %), как в подборе:
 *    «подходит по цене» здесь значит ровно то же, что «подходит» в списке «Кому подойдёт».
 *
 * ФАЙЛ ДЕЛИТСЯ НА ДВЕ ЧАСТИ. foldPriceWaitlist — чистая свёртка (деньги и клиенты на входе,
 * числа и ступени на выходе, без базы); loadPriceWaitlist — запросы. Тесты ступеней идут
 * по свёртке, права и состав выборки — по настоящей базе.
 *
 * ЧТО НАМЕРЕННО ПРОСТО.
 *  • Ступень считает клиентов, чей ВЕРХНИЙ предел бюджета (с допуском) не ниже цены ступени.
 *    Нижний предел на ступенях не проверяется: чтобы «накопительно и монотонно» было правдой.
 *    Клиент, чей нижний предел выше цены (объект для него «слишком дёшев»), сидит отдельно
 *    в `belowBudget` и в ступени не входит.
 *  • Клиент без бюджета (ни min, ни max) в ступени не входит — его «подходит» нечем подтвердить;
 *    он считается отдельно в `noBudget`.
 *  • Клиенты с одной только нижней границей: цена выше неё не мешает, поэтому они «подходят сейчас».
 */

/** Клиент, как его видит свёртка: деньги уже в сомони. */
export interface WaitlistClientInput {
  id: string;
  shortId: number;
  fullName: string;
  assignedAgentId: string | null;
  /** Нижняя/верхняя граница бюджета в сомони; null — не указана. Допуск подбора свёртка применяет сама. */
  budgetMinTjs: number | null;
  budgetMaxTjs: number | null;
  /** Исходные верхняя граница и валюта клиента — для списка `visibleClients`. */
  budgetMaxOriginal: number | null;
  budgetCurrency: string | null;
}

export interface FoldPriceWaitlistInput {
  propertyId: string;
  /** Цена объекта в его валюте. */
  price: number;
  currency: string;
  onSale: boolean;
  /** Перевод суммы в валюте объекта в сомони (toTjs с курсом) — подаётся снаружи, чтобы свёртка была чистой. */
  priceToTjs: (amount: number) => number;
  /** Допуск бюджета подбора, доля (0.1 = ±10 %). */
  budgetTolerance: number;
  /** Покупатели, прошедшие подбор по всему, кроме цены. */
  clients: WaitlistClientInput[];
  truncated: boolean;
  /** Чьих клиентов можно перечислить: undefined — всех, иначе только закреплённых за этим агентом. */
  visibleToAgentId?: string;
  now?: Date;
}

/**
 * Цена ступени: на dropPct ниже текущей, вниз до целого — обещание «не выше X» не должно округляться вверх.
 * Умножение на целое (100 − dropPct) и одно деление: `price * (1 − 0,03)` давало 48499,99… вместо 48500.
 */
export function stepPrice(price: number, dropPct: number): number {
  return Math.floor((price * (100 - dropPct)) / 100);
}

export function foldPriceWaitlist(input: FoldPriceWaitlistInput): PriceWaitlistResponse {
  const tol = input.budgetTolerance;
  const currentTjs = input.priceToTjs(input.price);
  const steps = PRICE_WAITLIST_DROPS_PCT.map((dropPct) => {
    const price = stepPrice(input.price, dropPct);
    return { dropPct, price, tjs: input.priceToTjs(price) };
  });

  let fitNow = 0;
  let overBudget = 0;
  let belowBudget = 0;
  let noBudget = 0;
  let beyondLadder = 0;
  const additional = steps.map(() => 0);
  const visible: PriceWaitlistVisibleClient[] = [];

  for (const c of input.clients) {
    if (c.budgetMinTjs == null && c.budgetMaxTjs == null) {
      noBudget += 1;
      continue;
    }
    const maxEff = c.budgetMaxTjs != null ? c.budgetMaxTjs * (1 + tol) : null;
    const minEff = c.budgetMinTjs != null ? c.budgetMinTjs * (1 - tol) : null;

    let fitsAtDropPct: number | null = null; // 0 — уже подходит; null — не подойдёт и при самой глубокой ступени
    if (maxEff != null && currentTjs > maxEff) {
      overBudget += 1;
      const firstStep = steps.findIndex((s) => s.tjs <= maxEff);
      if (firstStep === -1) {
        beyondLadder += 1;
      } else {
        // Клиент подходит на этой ступени и на всех глубже — отсюда накопительность и монотонность.
        for (let i = firstStep; i < steps.length; i++) additional[i] += 1;
        fitsAtDropPct = steps[firstStep].dropPct;
      }
    } else if (minEff != null && currentTjs < minEff) {
      belowBudget += 1;
    } else {
      fitNow += 1;
      fitsAtDropPct = 0;
    }

    if (
      fitsAtDropPct != null &&
      (input.visibleToAgentId === undefined || c.assignedAgentId === input.visibleToAgentId)
    ) {
      visible.push({
        id: c.id,
        shortId: c.shortId,
        fullName: c.fullName,
        budgetMax: c.budgetMaxOriginal,
        budgetCurrency: c.budgetCurrency,
        fitsAtDropPct,
      });
    }
  }

  const sample = fitNow + overBudget + belowBudget;
  const outSteps: PriceWaitlistStep[] = steps.map((s, i) => ({
    dropPct: s.dropPct,
    price: s.price,
    additional: additional[i],
    total: fitNow + additional[i],
  }));

  // Сначала те, кому снижение нужно меньше всего, а внутри ступени — по номеру клиента: порядок не прыгает между запросами.
  // Подходящих уже сейчас (0) среди них нет смысла выпячивать, но они нужны агенту, поэтому идут в конце.
  visible.sort((a, b) => {
    const ka = a.fitsAtDropPct === 0 ? 1000 : a.fitsAtDropPct;
    const kb = b.fitsAtDropPct === 0 ? 1000 : b.fitsAtDropPct;
    return ka - kb || a.shortId - b.shortId;
  });

  return {
    propertyId: input.propertyId,
    generatedAt: (input.now ?? new Date()).toISOString(),
    price: input.price,
    currency: input.currency,
    onSale: input.onSale,
    sample,
    enoughData: sample >= PRICE_WAITLIST_MIN_SAMPLE,
    fitNow,
    overBudget,
    beyondLadder,
    belowBudget,
    noBudget,
    truncated: input.truncated,
    steps: outSteps,
    visibleScope: input.visibleToAgentId === undefined ? "all" : "own",
    visibleClients: visible.slice(0, PRICE_WAITLIST_VISIBLE_MAX),
  };
}

export interface LoadPriceWaitlistOptions {
  /** undefined — перечислять всех клиентов (есть `clients.viewAll`), иначе только закреплённых за этим агентом. */
  visibleToAgentId?: string;
  now?: Date;
}

/** Выбранные поля покупателя: ровно то, что нужно clientMatchesProperty и свёртке. */
const CLIENT_SELECT = {
  id: true,
  shortId: true,
  fullName: true,
  assignedAgentId: true,
  budgetMin: true,
  budgetMax: true,
  currency: true,
  desiredDistrictId: true,
  desiredRooms: true,
  desiredType: true,
  desiredAreaMin: true,
  desiredFloorMin: true,
  desiredFloorMax: true,
  desiredTotalFloors: true,
  desiredPlaces: { select: { lat: true, lng: true, radiusM: true, label: true } },
} satisfies Prisma.ClientSelect;

/**
 * Лист ожидания по цене для одного объекта. null — объекта нет (или в Корзине: цену удалённому не советуем).
 * Один запрос покупателей с потолком PRICE_WAITLIST_TAKE и без запросов в цикле.
 */
export async function loadPriceWaitlist(propertyId: string, options: LoadPriceWaitlistOptions = {}): Promise<PriceWaitlistResponse | null> {
  const property = await prisma.property.findFirst({
    where: { id: propertyId, deletedAt: null },
    select: {
      id: true,
      sellerClientId: true,
      status: true,
      price: true,
      currency: true,
      districtId: true,
      rooms: true,
      type: true,
      areaSqm: true,
      floor: true,
      totalFloors: true,
      lat: true,
      lng: true,
    },
  });
  if (!property) return null;

  const [policy, money] = await Promise.all([loadMatchPolicy(), loadMoneyContext()]);
  const clients = await loadWaitingClientsExceptPrice(property, policy, money);

  const budgetOf = (v: unknown): number | null => (v == null ? null : Number(v));
  const inputs: WaitlistClientInput[] = clients.rows.map((c) => ({
    id: c.id,
    shortId: c.shortId,
    fullName: c.fullName,
    assignedAgentId: c.assignedAgentId,
    budgetMinTjs: c.budgetMin != null ? toTjs(c.budgetMin, c.currency, money) : null,
    budgetMaxTjs: c.budgetMax != null ? toTjs(c.budgetMax, c.currency, money) : null,
    budgetMaxOriginal: budgetOf(c.budgetMax),
    budgetCurrency: c.currency ?? null,
  }));

  return foldPriceWaitlist({
    propertyId: property.id,
    price: Number(property.price),
    currency: property.currency,
    onSale: property.status === "AVAILABLE",
    priceToTjs: (amount) => toTjs(amount, property.currency, money),
    budgetTolerance: policy.budgetToleranceRatio,
    clients: inputs,
    truncated: clients.truncated,
    visibleToAgentId: options.visibleToAgentId,
    now: options.now,
  });
}

interface WaitlistProperty {
  sellerClientId: string | null;
  price: unknown;
  currency: string | null;
  districtId: string | null;
  rooms: number | null;
  type: string | null;
  areaSqm: unknown;
  floor: number | null;
  totalFloors: number | null;
  lat: unknown;
  lng: unknown;
}

/**
 * Ждущие покупатели, подходящие объекту по всему, кроме цены. Предфильтр в запросе — те же условия, что у
 * «Кому подойдёт» (район или радиус + требования к объекту), но без бюджета; точная проверка — в JS,
 * `clientMatchesProperty` с вычеркнутым бюджетом, чтобы лишний кандидат отсеялся, а нужный не потерялся.
 */
async function loadWaitingClientsExceptPrice(
  property: WaitlistProperty,
  policy: MatchPolicy,
  money: MoneyContext
): Promise<{ rows: Awaited<ReturnType<typeof fetchClients>>; truncated: boolean }> {
  const { rows: capped, truncated } = capWaitlistFetch(await fetchClients(property, policy, money));
  const rows = capped;
  const matchable = { ...property, id: "price-waitlist" };
  const filtered = rows.filter((c) =>
    clientMatchesProperty({ ...c, budgetMin: null, budgetMax: null }, matchable, money, policy)
  );
  return { rows: filtered, truncated };
}

/**
 * Выборка берётся с запасом в одну строку (`PRICE_WAITLIST_TAKE + 1`): ровно PRICE_WAITLIST_TAKE покупателей —
 * это полный список, а «числа занижены» верно только когда нашлась лишняя, 501-я строка.
 */
export function capWaitlistFetch<T>(fetched: readonly T[]): { rows: T[]; truncated: boolean } {
  return { rows: fetched.slice(0, PRICE_WAITLIST_TAKE), truncated: fetched.length > PRICE_WAITLIST_TAKE };
}

async function fetchClients(property: WaitlistProperty, policy: MatchPolicy, money: MoneyContext) {
  const districtOrRadiusOr: Prisma.ClientWhereInput[] = [{ desiredDistrictId: property.districtId }, { desiredDistrictId: null }];
  if (property.lat != null && property.lng != null) {
    districtOrRadiusOr.push({
      desiredPlaces: { some: pointBboxWhere(Number(property.lat), Number(property.lng), MAX_DESIRED_PLACE_RADIUS_M) },
    });
  }
  const waiting = waitingBuyerWhere(policy);
  return prisma.client.findMany({
    where: {
      ...waiting,
      ...(property.sellerClientId ? { id: { not: property.sellerClientId } } : {}),
      AND: [
        ...(Array.isArray(waiting.AND) ? waiting.AND : []),
        { OR: districtOrRadiusOr },
        ...clientRequirementsForPropertyWhere(property, money.usdToTjs, policy, { skipBudget: true }),
      ],
    },
    select: CLIENT_SELECT,
    orderBy: { createdAt: "desc" },
    take: PRICE_WAITLIST_TAKE + 1,
  });
}
