/**
 * ОПОВЕЩЕНИЕ АГЕНТА: НА ПЛОЩАДКЕ ПОЯВИЛОСЬ ОБЪЯВЛЕНИЕ ПОД ЕГО ПОКУПАТЕЛЯ (14.11.2026).
 *
 * Для наших объектов такой пуш уже есть (ownMatch.ts, PropertyMarketMatch). Здесь обратная сторона:
 * новое чужое объявление Somon/Paydo подошло активному покупателю агента, и агент узнаёт об этом сам,
 * не открывая карточку.
 *
 * ПРАВИЛА (все проверены тестом tests/market-buyer-alerts.test.ts).
 *  · Выключатель в Настройках (Settings.marketBuyerAlertsEnabled), по умолчанию ВЫКЛ: выключен — прогон
 *    ничего не читает и не пишет, кроме самой настройки.
 *  · «Подошло» решает та же одна дверь допусков, что у подбора в карточке клиента: buyerMatch.ts
 *    (бюджет, комнаты, площадь из политики Настроек; район и тип — точным совпадением). Ждущих покупателей
 *    выбирает та же waitingBuyerWhere, что у автоподбора объектов (клиент назначен агенту и принят им).
 *  · «Новое» — первое появление в каталоге за последние сутки (firstSeenAt) И не старое по самой площадке
 *    (опубликовано не раньше, чем двое суток до окна): первый обход новой рубрики не должен выдать сотни
 *    давних объявлений за «новые». Объявление, признанное нашим объектом (ownMatches), не считается.
 *  · ОДИН РАЗ НА ПАРУ клиент+объявление: уникальный ключ BuyerMarketAlert (clientId, listingId). Тот же
 *    объект на второй площадке или перевыложенный (dedupeListings, isDuplicateListing) повторного пуша не даёт.
 *  · Не больше BUYER_ALERT_MAX_PUSHES_PER_DAY пушей на клиента за сутки ПО ДУШАНБЕ (lib/dushanbeTime.ts);
 *    в одном пуше до BUYER_ALERT_PER_PUSH ближайших объявлений, остальные ждут следующего прогона в пределах окна.
 *  · Без N+1: покупатели, районы, курс, политика, новые объявления, уже отправленное — по одному запросу на весь
 *    прогон; запись и пуш идут только по тем клиентам, у кого что-то нашлось.
 *  · Пара записывается ДО пуша (занята атомарно createMany + skipDuplicates), упал пуш — запись снимается
 *    и объявление уйдёт со следующим прогоном. Ошибки — в журнал через logSystemError, без номеров и текстов.
 *  · В пуше нет телефонов продавцов и текста объявлений: площадка, комнаты, площадь, цена, район.
 */
import { formatClientCode } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { sendPushToAgent } from "../../push.js";
import { currentBuyerMatchingCriteria } from "../clientPropertyMatching.js";
import { dushanbeStartOfToday } from "../dushanbeTime.js";
import { loadMatchPolicy, waitingBuyerWhere } from "../matchPolicy.js";
import { loadMoneyContext } from "../money.js";
import { logSystemError } from "../systemError.js";
import {
  buildBuyerWants, buyerDistance, hasBuyerCriteria, listingFitsBuyer, type BuyerRow, type BuyerWants,
} from "./buyerMatch.js";
import { plausibleSaleWhere } from "./plausible.js";
import { dedupeListings, isDuplicateListing } from "./similarComps.js";
import { marketCatalogWhere } from "./somonRubrics.js";

/** Окно «нового»: сколько назад смотрим первое появление объявления в каталоге. */
export const BUYER_ALERT_LOOKBACK_MS = 24 * 3600_000;
/** Объявление, опубликованное на самой площадке раньше окна больше чем на столько, «новым» не считается. */
const PUBLISHED_SLACK_MS = 2 * 24 * 3600_000;
export const BUYER_ALERT_MAX_PUSHES_PER_DAY = 3;
export const BUYER_ALERT_PER_PUSH = 3;
export const BUYER_ALERT_BUYER_LIMIT = 1500;
export const BUYER_ALERT_LISTING_LIMIT = 500;
/** Сколько дней назад смотрим уже отправленные, чтобы не слать «двойника» с другой площадки. */
const DUPLICATE_LOOKBACK_DAYS = 14;

export interface AlertListing extends BuyerRow {
  id: string;
  city: string | null;
  repair: string | null;
}

export interface AlertBuyer {
  clientId: string;
  shortId: number;
  kind: string | null;
  agentId: string;
  wants: BuyerWants;
}

export interface BuyerAlertPlanItem {
  buyer: AlertBuyer;
  listings: AlertListing[];
}

export interface BuyerAlertPlanInput {
  buyers: AlertBuyer[];
  listings: AlertListing[];
  /** Пары «клиент|объявление», по которым пуш уже уходил. */
  alreadyAlerted: ReadonlySet<string>;
  /** Ранее отправленные клиенту объявления: «двойник» уже отправленного не шлём. */
  previousByClient: ReadonlyMap<string, readonly AlertListing[]>;
  /** Сколько пушей клиент получил с начала суток по Душанбе. */
  pushesTodayByClient: ReadonlyMap<string, number>;
}

/** Чистая часть: кому что отправить. Без БД, без времени — тестируется отдельно. */
export function planBuyerAlerts(input: BuyerAlertPlanInput): BuyerAlertPlanItem[] {
  const plan: BuyerAlertPlanItem[] = [];
  for (const buyer of input.buyers) {
    if ((input.pushesTodayByClient.get(buyer.clientId) ?? 0) >= BUYER_ALERT_MAX_PUSHES_PER_DAY) continue;
    if (!hasBuyerCriteria(buyer.wants)) continue;
    const previous = input.previousByClient.get(buyer.clientId) ?? [];
    const fitting = input.listings
      .filter((l) => !input.alreadyAlerted.has(`${buyer.clientId}|${l.id}`) && listingFitsBuyer(l, buyer.wants))
      .map((l) => ({ l, d: buyerDistance(l, buyer.wants) }))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.l);
    // Ближайшие первыми; повтор одного объекта (две площадки, перевыкладка) остаётся одним, а двойник уже отправленного отпадает.
    const fresh = dedupeListings(fitting).filter((l) => !previous.some((p) => isDuplicateListing(l, p)));
    if (fresh.length === 0) continue;
    plan.push({ buyer, listings: fresh.slice(0, BUYER_ALERT_PER_PUSH) });
  }
  return plan;
}

function fmt(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function platform(source: string): string {
  const s = source.toLowerCase();
  if (s.includes("somon")) return "Somon";
  if (s.includes("paydo")) return "Paydo";
  return source.replace(/\.tj$/i, "").replace(/^./, (c) => c.toUpperCase());
}

/** Текст пуша: первое объявление словами, остальные числом. Без телефонов и текста объявления. */
export function buyerAlertText(buyer: Pick<AlertBuyer, "shortId" | "kind">, listings: readonly AlertListing[]): { title: string; body: string } {
  const first = listings[0];
  const parts = [
    first.rooms ? `${first.rooms} к` : null,
    first.areaSqm ? `${Math.round(first.areaSqm)} м²` : null,
    `${fmt(first.priceTjs)} сомони`,
    first.districtName,
  ].filter(Boolean);
  const more = listings.length > 1 ? ` Ещё подходящих: ${listings.length - 1}.` : "";
  return {
    title: listings.length > 1 ? "Новые объявления под вашего покупателя" : "Новое объявление под вашего покупателя",
    body: `${formatClientCode(buyer.shortId, buyer.kind as never)}: на ${platform(first.source)} ${parts.join(", ")}.${more}`,
  };
}

export interface BuyerAlertStats {
  enabled: boolean;
  buyers: number;
  listings: number;
  pushed: number;
  alertsRecorded: number;
  failed: number;
}

let running = false;

const LISTING_SELECT = {
  id: true, source: true, sourceUrl: true, title: true, propertyType: true, priceTjs: true, pricePerSqmTjs: true, areaSqm: true,
  rooms: true, floor: true, totalFloors: true, districtName: true, city: true, repair: true, firstSeenAt: true, publishedAt: true, sellerId: true,
} as const;

function toAlertListing(r: {
  id: string; source: string; sourceUrl: string; title: string; propertyType: string; priceTjs: unknown; pricePerSqmTjs: unknown;
  areaSqm: unknown; rooms: number | null; floor: number | null; totalFloors: number | null; districtName: string | null; city: string | null;
  repair: string | null; firstSeenAt: Date; publishedAt: Date | null; sellerId: string | null;
}): AlertListing {
  return {
    ...r,
    priceTjs: Number(r.priceTjs),
    pricePerSqmTjs: r.pricePerSqmTjs != null ? Number(r.pricePerSqmTjs) : null,
    areaSqm: r.areaSqm != null ? Number(r.areaSqm) : null,
  };
}

/**
 * Прогон оповещения. Вызывать из cron после инкрементального сбора. Безопасен при повторе и параллельном
 * запуске: пара занимается уникальным ключом до отправки, второй прогон её не увидит свободной.
 */
export async function runBuyerMarketAlerts(now: Date = new Date()): Promise<BuyerAlertStats> {
  const stats: BuyerAlertStats = { enabled: false, buyers: 0, listings: 0, pushed: 0, alertsRecorded: 0, failed: 0 };
  if (running) return stats;
  running = true;
  try {
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { marketBuyerAlertsEnabled: true } });
    if (!settings?.marketBuyerAlertsEnabled) return stats;
    stats.enabled = true;

    const since = new Date(now.getTime() - BUYER_ALERT_LOOKBACK_MS);
    const publishedAfter = new Date(since.getTime() - PUBLISHED_SLACK_MS);
    const rawListings = await prisma.marketListing.findMany({
      where: {
        dealType: "SALE",
        isActive: true,
        firstSeenAt: { gte: since },
        ownMatches: { none: { status: { in: ["CONFIRMED", "CANDIDATE"] } } },
        AND: [{ OR: [{ publishedAt: null }, { publishedAt: { gte: publishedAfter } }] }, ...plausibleSaleWhere(null), marketCatalogWhere()],
      },
      select: LISTING_SELECT,
      orderBy: { firstSeenAt: "desc" },
      take: BUYER_ALERT_LISTING_LIMIT,
    });
    stats.listings = rawListings.length;
    if (rawListings.length === 0) return stats;
    const listings = rawListings.map(toAlertListing);

    const policy = await loadMatchPolicy();
    const clients = await prisma.client.findMany({
      where: { ...waitingBuyerWhere(policy, now), assignedAgentId: { not: null }, acceptedAt: { not: null } },
      select: {
        id: true, shortId: true, kind: true, assignedAgentId: true, currency: true, budgetMin: true, budgetMax: true,
        desiredDistrictId: true, desiredType: true, desiredRooms: true, desiredAreaMin: true, requirementsFieldsKind: true,
      },
      orderBy: { lastContactAt: "desc" },
      take: BUYER_ALERT_BUYER_LIMIT,
    });
    if (clients.length === 0) return stats;

    // Районы и курс — по одному запросу на весь прогон.
    const districtIds = [...new Set(clients.map((c) => c.desiredDistrictId).filter((id): id is string => id != null))];
    const [districts, money] = await Promise.all([
      districtIds.length
        ? prisma.district.findMany({ where: { id: { in: districtIds } }, select: { id: true, name: true, city: true } })
        : Promise.resolve([]),
      loadMoneyContext(),
    ]);
    const districtById = new Map(districts.map((d) => [d.id, d]));
    const buyers: AlertBuyer[] = clients.flatMap((c) => {
      if (!c.assignedAgentId) return [];
      const criteria = currentBuyerMatchingCriteria(c);
      const wants = buildBuyerWants(criteria, criteria.desiredDistrictId ? districtById.get(criteria.desiredDistrictId) ?? null : null, money, policy);
      return hasBuyerCriteria(wants) ? [{ clientId: c.id, shortId: c.shortId, kind: c.kind, agentId: c.assignedAgentId, wants }] : [];
    });
    stats.buyers = buyers.length;
    if (buyers.length === 0) return stats;

    // Уже отправленное: пары по этим объявлениям, недавние отправки клиентам (двойники) и пуши за сегодня.
    const clientIds = buyers.map((b) => b.clientId);
    const dayStart = dushanbeStartOfToday(now);
    const duplicateSince = new Date(now.getTime() - DUPLICATE_LOOKBACK_DAYS * 24 * 3600_000);
    const [pairs, recent] = await Promise.all([
      prisma.buyerMarketAlert.findMany({
        where: { clientId: { in: clientIds }, listingId: { in: listings.map((l) => l.id) } },
        select: { clientId: true, listingId: true },
      }),
      prisma.buyerMarketAlert.findMany({
        where: { clientId: { in: clientIds }, notifiedAt: { gte: duplicateSince } },
        select: { clientId: true, notifiedAt: true, listing: { select: LISTING_SELECT } },
      }),
    ]);
    const previousByClient = new Map<string, AlertListing[]>();
    const pushTimesToday = new Map<string, Set<number>>();
    for (const r of recent) {
      previousByClient.set(r.clientId, [...(previousByClient.get(r.clientId) ?? []), toAlertListing(r.listing)]);
      if (r.notifiedAt >= dayStart) pushTimesToday.set(r.clientId, (pushTimesToday.get(r.clientId) ?? new Set()).add(r.notifiedAt.getTime()));
    }

    const plan = planBuyerAlerts({
      buyers,
      listings,
      alreadyAlerted: new Set(pairs.map((p) => `${p.clientId}|${p.listingId}`)),
      previousByClient,
      pushesTodayByClient: new Map([...pushTimesToday].map(([id, times]) => [id, times.size])),
    });

    for (const item of plan) {
      const at = new Date();
      const claimed = await prisma.buyerMarketAlert.createMany({
        data: item.listings.map((l) => ({ clientId: item.buyer.clientId, listingId: l.id, agentId: item.buyer.agentId, notifiedAt: at })),
        skipDuplicates: true,
      });
      if (claimed.count === 0) continue;
      // Пуш только о тех, что занял именно этот прогон (параллельный мог занять часть пар раньше).
      const owned = claimed.count === item.listings.length
        ? new Set(item.listings.map((l) => l.id))
        : new Set((await prisma.buyerMarketAlert.findMany({ where: { clientId: item.buyer.clientId, notifiedAt: at }, select: { listingId: true } })).map((r) => r.listingId));
      const toTell = item.listings.filter((l) => owned.has(l.id));
      if (toTell.length === 0) continue;
      stats.alertsRecorded += toTell.length;
      const text = buyerAlertText(item.buyer, toTell);
      try {
        await sendPushToAgent(item.buyer.agentId, {
          kind: "market",
          title: text.title,
          body: text.body,
          url: `/clients/${item.buyer.shortId}`,
          tag: `buyer-market:${item.buyer.clientId}:${at.getTime()}`,
        });
        stats.pushed++;
      } catch (err) {
        stats.failed++;
        stats.alertsRecorded -= toTell.length;
        // Пуш не ушёл: снимаем занятые пары, объявления уйдут со следующим прогоном.
        await prisma.buyerMarketAlert.deleteMany({ where: { clientId: item.buyer.clientId, notifiedAt: at } });
        void logSystemError("api", `Пуш о новом объявлении под покупателя не ушёл: ${err instanceof Error ? err.name : "ошибка"}`, {
          url: `/clients/${item.buyer.shortId}`,
        });
      }
    }
    return stats;
  } finally {
    running = false;
  }
}
