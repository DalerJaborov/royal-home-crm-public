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
 *  · Не больше BUYER_ALERT_MAX_PUSHES_PER_DAY пушей на АГЕНТА за сутки ПО ДУШАНБЕ (lib/dushanbeTime.ts):
 *    агент с десятью покупателями не получает тридцать пушей. В одном пуше до BUYER_ALERT_PER_PUSH ближайших
 *    объявлений; те, что не влезли, ждут следующего прогона, пока не закрылось окно «нового».
 *  · При первом включении рубильника всплеска за прошлые сутки нет: «новыми» считаются только объявления,
 *    впервые увиденные ПОСЛЕ включения (Settings.marketBuyerAlertsEnabledAt; первый прогон после включения лишь
 *    ставит эту отметку). Выключили рубильник: отметка сбрасывается, следующее включение снова считает с нуля.
 *  · Покупатель без района (только бюджет) пушей не получает: по одному бюджету под него подходит полгорода,
 *    и пуш приходил бы каждый день. Нужен район; комнаты, площадь и бюджет сужают дальше.
 *  · Без N+1: покупатели, районы, курс, политика, новые объявления, уже отправленное — по одному запросу на весь
 *    прогон; запись и пуш идут только по тем клиентам, у кого что-то нашлось.
 *  · Пара записывается ДО пуша (занята атомарно createMany + skipDuplicates). Упал пуш: запись снимается, и пока
 *    окно «нового» (24 часа) не закрылось, объявление уйдёт со следующим прогоном; после окна оно не оповещается.
 *    Ошибки в журнал через logSystemError, без номеров и текстов; итог прогона с failed > 0 тоже пишется в журнал.
 *  · В пуше нет телефонов продавцов и текста объявлений: площадка, комнаты, площадь, цена, район.
 */
import { formatClientCode, isMarketRealtorListing } from "@royal-home/shared";
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
import { loadOwnersFilter } from "./ownerFilter.js";
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
  /** Сколько пушей агент получил с начала суток по Душанбе (по всем его клиентам). */
  pushesTodayByAgent: ReadonlyMap<string, number>;
}

/** Чистая часть: кому что отправить. Без БД, без времени — тестируется отдельно. */
export function planBuyerAlerts(input: BuyerAlertPlanInput): BuyerAlertPlanItem[] {
  const plan: BuyerAlertPlanItem[] = [];
  // Счёт ведём и внутри прогона: два покупателя одного агента не дают вместе больше предела.
  const used = new Map(input.pushesTodayByAgent);
  for (const buyer of input.buyers) {
    if ((used.get(buyer.agentId) ?? 0) >= BUYER_ALERT_MAX_PUSHES_PER_DAY) continue;
    if (!hasBuyerCriteria(buyer.wants) || buyer.wants.districtName == null) continue;
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
    used.set(buyer.agentId, (used.get(buyer.agentId) ?? 0) + 1);
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
  isAgency: true,
} as const;

function toAlertListing(r: {
  id: string; source: string; sourceUrl: string; title: string; propertyType: string; priceTjs: unknown; pricePerSqmTjs: unknown;
  areaSqm: unknown; rooms: number | null; floor: number | null; totalFloors: number | null; districtName: string | null; city: string | null;
  repair: string | null; firstSeenAt: Date; publishedAt: Date | null; sellerId: string | null; isAgency: boolean;
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
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { marketBuyerAlertsEnabled: true, marketBuyerAlertsEnabledAt: true },
    });
    if (!settings?.marketBuyerAlertsEnabled) {
      // Выключили: сбрасываем отметку, чтобы следующее включение снова не слало прошлое.
      if (settings?.marketBuyerAlertsEnabledAt) {
        await prisma.settings.updateMany({ where: { id: "singleton", marketBuyerAlertsEnabledAt: { not: null } }, data: { marketBuyerAlertsEnabledAt: null } });
      }
      return stats;
    }
    stats.enabled = true;
    if (!settings.marketBuyerAlertsEnabledAt) {
      // Первый прогон после включения: только ставим отметку. «Новое» считается от неё, прошлых суток не будет.
      await prisma.settings.updateMany({ where: { id: "singleton", marketBuyerAlertsEnabledAt: null }, data: { marketBuyerAlertsEnabledAt: now } });
      return stats;
    }

    const windowStart = new Date(now.getTime() - BUYER_ALERT_LOOKBACK_MS);
    const since = settings.marketBuyerAlertsEnabledAt > windowStart ? settings.marketBuyerAlertsEnabledAt : windowStart;
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
    // «Только собственники» (рубильник в Настройках, по умолчанию включён): объявления агентств и риелторов
    // под покупателя не шлём, тем же правилом, что подбор в карточке клиента (ownerFilter.ts).
    const realtors = await loadOwnersFilter();
    const listings = rawListings.map(toAlertListing).filter((l) => !realtors || !isMarketRealtorListing(l, realtors));
    stats.listings = listings.length;
    if (listings.length === 0) return stats;

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
    const [pairs, recent, todayByAgent] = await Promise.all([
      prisma.buyerMarketAlert.findMany({
        where: { clientId: { in: clientIds }, listingId: { in: listings.map((l) => l.id) } },
        select: { clientId: true, listingId: true },
      }),
      prisma.buyerMarketAlert.findMany({
        where: { clientId: { in: clientIds }, notifiedAt: { gte: duplicateSince } },
        select: { clientId: true, notifiedAt: true, listing: { select: LISTING_SELECT } },
      }),
      // Предел на агента считается по ВСЕМ его пушам за сутки, а не только по покупателям этого прогона.
      prisma.buyerMarketAlert.findMany({
        where: { agentId: { in: [...new Set(buyers.map((b) => b.agentId))] }, notifiedAt: { gte: dayStart } },
        select: { agentId: true, clientId: true, notifiedAt: true },
      }),
    ]);
    const previousByClient = new Map<string, AlertListing[]>();
    for (const r of recent) previousByClient.set(r.clientId, [...(previousByClient.get(r.clientId) ?? []), toAlertListing(r.listing)]);
    // Один пуш = одна пара (клиент, момент отправки): несколько объявлений пуша это строки с одним notifiedAt.
    const pushKeysByAgent = new Map<string, Set<string>>();
    for (const r of todayByAgent) {
      pushKeysByAgent.set(r.agentId, (pushKeysByAgent.get(r.agentId) ?? new Set()).add(`${r.clientId}|${r.notifiedAt.getTime()}`));
    }

    const plan = planBuyerAlerts({
      buyers,
      listings,
      alreadyAlerted: new Set(pairs.map((p) => `${p.clientId}|${p.listingId}`)),
      previousByClient,
      pushesTodayByAgent: new Map([...pushKeysByAgent].map(([id, keys]) => [id, keys.size])),
    });

    for (const item of plan) {
      const at = new Date(now.getTime());
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
          kind: "market_buyer",
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
    if (stats.failed > 0) {
      void logSystemError("api", `Оповещение о новых объявлениях: не ушло пушей ${stats.failed} из ${stats.failed + stats.pushed}`, { url: "/market" });
    }
    return stats;
  } finally {
    running = false;
  }
}
