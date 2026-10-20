import {
  NEIGHBORS_COMPARISON_ENABLED,
  PROPERTY_STATS_DAYS,
  dushanbeDayKey,
  isInstagramLink,
  type PropertyFunnelStep,
  type PropertyHealth,
  type PropertyHotSignal,
  type PropertyNeighbors,
  type PropertyPlatformStat,
  type PropertyPlatformsResponse,
  type PropertySiteDay,
  type PropertyStatsResponse,
  type PropertyHealthBrief,
  type PropertiesNeedsHelpResponse,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { conductedShowingBaseWhere } from "./conductedShowing.js";
import { loadMoneyContext, toTjs, type MoneyContext } from "./money.js";
import { loadPropertyPostStats } from "./postStats.js";
import { DUSHANBE_OFFSET_MS } from "./dushanbeTime.js";

/**
 * ВКЛАДКА «СТАТИСТИКА» В КАРТОЧКЕ ОБЪЕКТА (24.09.2026, Dan: путь покупателя,
 * светофор, сравнение с соседями, «объект загорелся»).
 *
 * Всё считается по своей базе — сайт (SitePropertyDay, раз в час с сайта),
 * клиенты, показы, сделки, соседи. Числа площадок (Instagram, Facebook,
 * YouTube, TikTok) — отдельным запросом `loadPropertyPlatforms`: они едут по
 * сети, и экран не должен ждать их, чтобы показать главное.
 *
 * Правила светофора — чистая функция `assessPropertyHealth`, её и проверяет
 * тест. Пороги подобраны под масштаб агентства (десятки просмотров объекта в
 * месяц, а не тысячи) — менять здесь, в одном месте.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Судить объект раньше — рано: первые дни просмотров мало у всех. */
export const HEALTH_MIN_DAYS_ON_SALE = 3;
/** Дороже соседей на столько — жёлтый; на HEALTH_PRICE_RED — красный. */
export const HEALTH_PRICE_YELLOW = 5;
export const HEALTH_PRICE_RED = 15;
/** «Смотрят много»: столько открытий страницы на сайте за 30 дней. */
export const HEALTH_MANY_VIEWS = 30;
/** «Смотрят мало» после недели в продаже. */
export const HEALTH_FEW_VIEWS = 10;
/** «Продаётся дольше похожих»: в столько раз дольше обычного срока. */
export const HEALTH_SLOW_FACTOR = 1.5;
/** Похожих меньше — сравнению не верим. */
export const NEIGHBORS_MIN_SAMPLE = 3;
/** «Загорелся»: за 2 дня не меньше стольких просмотров … */
export const HOT_MIN_VIEWS = 10;
/** … и во столько раз больше обычного. */
export const HOT_MIN_RATIO = 3;

export interface HealthInput {
  status: string;
  daysOnSale: number;
  priceDiffPct: number | null;
  daysToSellTypical: number | null;
  siteConnected: boolean;
  siteViews30: number;
  contacts30: number;
  contactsTotal: number;
  showingsTotal: number;
  photos: number;
  publishedChannels: number;
  /** Ссылка на ролик в карточке: рабочая ссылка Instagram = ролик есть, даже если каналы не отмечены (05.10.2026). */
  instagramUrl?: string | null;
  hot: boolean;
}

interface Problem {
  /** 2 — красный, 1 — жёлтый. */
  weight: 1 | 2;
  headline: string;
  tip: string;
}

function daysWord(n: number): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return "день";
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return "дня";
  return "дней";
}

/** Светофор объекта — чистая функция. */
export function assessPropertyHealth(i: HealthInput): PropertyHealth {
  if (i.status === "SOLD") return { color: "green", headline: "Объект продан", tips: [] };
  if (i.status === "RESERVED") return { color: "green", headline: "Идёт сделка — объект в брони", tips: [] };
  if (i.status === "WITHDRAWN") return { color: "gray", headline: "Объект снят с продажи", tips: [] };
  if (i.status !== "AVAILABLE") {
    return { color: "gray", headline: "Ещё не в продаже", tips: ["Светофор включится, когда объект выйдет на продажу."] };
  }
  if (i.daysOnSale < HEALTH_MIN_DAYS_ON_SALE) {
    return {
      color: "gray",
      headline: `Рано судить: в продаже ${i.daysOnSale} ${daysWord(i.daysOnSale)}`,
      tips: ["Первые дни просмотров мало у всех объектов — оценка появится через пару дней."],
    };
  }

  const problems: Problem[] = [];
  if (i.priceDiffPct != null && i.priceDiffPct >= HEALTH_PRICE_YELLOW) {
    const pct = Math.round(i.priceDiffPct);
    problems.push({
      weight: i.priceDiffPct >= HEALTH_PRICE_RED ? 2 : 1,
      headline: `Цена выше соседей на ${pct}%`,
      tip: `Цена за м² выше похожих в районе на ${pct}% — обсудите с собственником снижение.`,
    });
  }
  if (i.siteConnected && i.siteViews30 >= HEALTH_MANY_VIEWS && i.contacts30 === 0) {
    problems.push({
      weight: 2,
      headline: "Смотрят много, пишут мало",
      tip: "Объект открывают, но не пишут — обновите первое фото и описание, проверьте цену.",
    });
  }
  if (i.siteConnected && i.daysOnSale >= 7 && i.siteViews30 < HEALTH_FEW_VIEWS && !i.hot) {
    problems.push({
      weight: 1,
      headline: "Объект мало смотрят",
      tip: "За месяц объект почти не открывали — выпустите ролик заново или поднимите в рекламе.",
    });
  }
  if (i.contactsTotal >= 3 && i.showingsTotal === 0) {
    problems.push({
      weight: 1,
      headline: "Пишут, но не доходят до показа",
      tip: "Интерес есть, а показов нет — перезвоните всем, кто писал, и предложите время.",
    });
  }
  if (i.daysToSellTypical != null && i.daysOnSale > i.daysToSellTypical * HEALTH_SLOW_FACTOR) {
    problems.push({
      weight: 2,
      headline: "Продаётся дольше похожих",
      tip: `В продаже ${i.daysOnSale} ${daysWord(i.daysOnSale)}, похожие обычно уходят за ${i.daysToSellTypical} — пора пересмотреть цену или подачу.`,
    });
  }
  if (i.photos < 5) {
    problems.push({ weight: 1, headline: "Мало фотографий", tip: `В карточке ${i.photos} фото — добавьте хотя бы 8–10.` });
  }
  if (i.publishedChannels === 0 && !isInstagramLink(i.instagramUrl)) {
    problems.push({ weight: 1, headline: "Ролика нет ни на одной площадке", tip: "Снимите и выпустите ролик — без него объект видят только на сайте." });
  }

  if (problems.length === 0) {
    return {
      color: "green",
      headline: i.hot ? "Объект загорелся — интерес растёт" : "Всё идёт хорошо",
      tips: i.hot ? ["Просмотры резко выросли — сейчас лучшее время обзвонить тех, кто интересовался."] : [],
    };
  }
  // Тяжёлое — первым; при равном весе сохраняется порядок проверок выше.
  problems.sort((a, b) => b.weight - a.weight);
  return {
    color: problems[0].weight === 2 ? "red" : "yellow",
    headline: problems[0].headline,
    tips: problems.slice(0, 3).map((p) => p.tip),
  };
}

/** «Загорелся»: последние 2 дня против обычного за 2 недели до них. `days` — по возрастанию. */
export function detectHot(days: PropertySiteDay[]): PropertyHotSignal {
  const recent = days.slice(-2);
  const base = days.slice(-16, -2);
  const recentViews = recent.reduce((s, d) => s + d.views, 0);
  const baseTwoDays = base.length ? (base.reduce((s, d) => s + d.views, 0) / base.length) * 2 : 0;
  const ratio = baseTwoDays > 0 ? Math.round((recentViews / baseTwoDays) * 10) / 10 : null;
  const hot = recentViews >= HOT_MIN_VIEWS && (ratio == null || ratio >= HOT_MIN_RATIO);
  return { hot, recentViews, ratio, since: hot ? (recent[0]?.day ?? null) : null };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const TYPE_WORDS: Record<string, string> = {
  APARTMENT: "квартиры",
  HOUSE: "дома",
  COMMERCIAL: "коммерческие помещения",
  LAND: "участки",
};

interface NeighborSubject {
  id: string;
  type: string;
  rooms: number | null;
  areaSqm: unknown;
  price: unknown;
  currency: string;
  districtId: string | null;
  districtName: string | null;
  daysOnSale: number;
  onSale: boolean;
}

interface NeighborRow {
  id: string;
  districtId: string | null;
  type: string;
  rooms: number | null;
  areaSqm: unknown;
  price: unknown;
  currency: string;
  status: string;
  createdAt: Date;
  soldAt: Date | null;
}

const NEIGHBOR_SELECT = {
  id: true,
  districtId: true,
  type: true,
  rooms: true,
  areaSqm: true,
  price: true,
  currency: true,
  status: true,
  createdAt: true,
  soldAt: true,
} as const;

/** Похожие в продаже и проданные за год — тот же район и тип. */
function neighborWhere(districtIds: string[], types: string[]) {
  const yearAgo = new Date(Date.now() - 365 * DAY_MS);
  return {
    deletedAt: null,
    districtId: { in: districtIds },
    type: { in: types as never[] },
    OR: [{ status: "AVAILABLE" as const }, { status: "SOLD" as const, soldAt: { gte: yearAgo } }],
  };
}

/**
 * Соседи одного объекта из уже загруженных строк (карточка грузит свой район,
 * список — все районы страницы одним запросом). Тот же район и тип; у квартир —
 * ещё и те же комнаты, если таких в продаже хватает.
 */
function computeNeighbors(p: NeighborSubject, all: NeighborRow[], money: MoneyContext): PropertyNeighbors {
  const area = Number(p.areaSqm);
  const pricePerSqm = area > 0 ? Math.round(toTjs(p.price, p.currency, money) / area) : null;
  const empty: PropertyNeighbors = {
    pricePerSqm,
    medianPerSqm: null,
    diffPct: null,
    sample: 0,
    scope: "",
    typicalDaysToSell: null,
    daysOnSale: p.daysOnSale,
    onSale: p.onSale,
  };
  // Выключено целиком: ни цены соседей, ни «дольше похожих» — светофор их не судит.
  if (!NEIGHBORS_COMPARISON_ENABLED) return empty;
  if (!p.districtId) return { ...empty, scope: "район объекта не указан" };
  const rows = all.filter((r) => r.id !== p.id && r.districtId === p.districtId && r.type === p.type);

  const sameRooms = p.type === "APARTMENT" && p.rooms != null ? rows.filter((r) => r.rooms === p.rooms) : [];
  const useRooms = sameRooms.filter((r) => r.status === "AVAILABLE").length >= NEIGHBORS_MIN_SAMPLE;
  const pool = useRooms ? sameRooms : rows;

  const perSqm = pool
    .filter((r) => r.status === "AVAILABLE" && Number(r.areaSqm) > 0)
    .map((r) => toTjs(r.price, r.currency, money) / Number(r.areaSqm))
    .filter((v) => Number.isFinite(v) && v > 0);
  const sold = pool
    .filter((r) => r.status === "SOLD" && r.soldAt)
    .map((r) => Math.max(0, Math.round((r.soldAt!.getTime() - r.createdAt.getTime()) / DAY_MS)));

  const medianPerSqm = perSqm.length >= NEIGHBORS_MIN_SAMPLE ? Math.round(median(perSqm)!) : null;
  const typicalDaysToSell = sold.length >= NEIGHBORS_MIN_SAMPLE ? Math.round(median(sold)!) : null;
  const scope = [
    useRooms ? `${p.rooms}-комнатные ${TYPE_WORDS[p.type] ?? "объекты"}` : (TYPE_WORDS[p.type] ?? "объекты"),
    p.districtName ?? "",
  ]
    .filter(Boolean)
    .join(", ");
  return {
    pricePerSqm,
    medianPerSqm,
    diffPct:
      pricePerSqm != null && medianPerSqm != null ? Math.round(((pricePerSqm - medianPerSqm) / medianPerSqm) * 1000) / 10 : null,
    sample: perSqm.length,
    scope,
    typicalDaysToSell,
    daysOnSale: p.daysOnSale,
    onSale: p.onSale,
  };
}

async function loadNeighbors(p: NeighborSubject): Promise<PropertyNeighbors> {
  const money = await loadMoneyContext();
  const rows = NEIGHBORS_COMPARISON_ENABLED && p.districtId
    ? await prisma.property.findMany({ where: neighborWhere([p.districtId], [p.type]), select: NEIGHBOR_SELECT, take: 500 })
    : [];
  return computeNeighbors(p, rows, money);
}

/** Полночь дня по Душанбе (в UTC) N дней назад, включая сегодня. */
export function dushanbeDayStartDaysAgo(n: number, now: Date): Date {
  const key = dushanbeDayKey(now);
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - DUSHANBE_OFFSET_MS - n * DAY_MS);
}

/**
 * Просмотры сайта по дням за последние `days` дней, включая сегодня, — с нулями
 * в днях без строк. Одна раскладка на карточку, светофор списком и сигнал
 * «объект загорелся» (lib/propertyHotAlert.ts): иначе три копии цикла
 * разошлись бы на первой же правке границы суток.
 */
export function siteDaysWindow(rows: { day: Date; views: number }[], days: number, now: Date): PropertySiteDay[] {
  const byKey = new Map<string, number>();
  for (const r of rows) byKey.set(dushanbeDayKey(r.day), (byKey.get(dushanbeDayKey(r.day)) ?? 0) + r.views);
  const out: PropertySiteDay[] = [];
  for (let n = days - 1; n >= 0; n--) {
    const key = dushanbeDayKey(new Date(dushanbeDayStartDaysAgo(n, now).getTime() + DAY_MS / 2));
    out.push({ day: key, views: byKey.get(key) ?? 0 });
  }
  return out;
}

/** Сколько дней нужно `detectHot`: 2 последних + 14 обычных до них. */
export const HOT_WINDOW_DAYS = 16;

/** null — объекта нет (или удалён, а корзина закрыта — решает вызывающий). */
export async function loadPropertyStats(propertyId: string, now: Date = new Date()): Promise<PropertyStatsResponse | null> {
  const p = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      id: true,
      status: true,
      type: true,
      rooms: true,
      areaSqm: true,
      price: true,
      currency: true,
      districtId: true,
      district: { select: { name: true } },
      createdAt: true,
      stageEnteredAt: true,
      publishedChannels: true,
      instagramUrl: true,
      _count: { select: { photos: true } },
    },
  });
  if (!p) return null;

  // В продаже — с входа в стадию «в продаже»; до этого объект готовили.
  const saleStart = p.status === "AVAILABLE" ? p.stageEnteredAt : p.createdAt;
  const daysOnSale = Math.max(0, Math.floor((now.getTime() - saleStart.getTime()) / DAY_MS));
  const since30 = dushanbeDayStartDaysAgo(PROPERTY_STATS_DAYS - 1, now);
  const sinceHot = dushanbeDayStartDaysAgo(HOT_WINDOW_DAYS - 1, now);

  const [siteDaysRows, siteAll, siteAny, clientsByMatch, clientsByTouch, interestClients, showings, deals, neighbors] =
    await Promise.all([
      prisma.sitePropertyDay.findMany({
        where: { propertyId, day: { gte: since30 < sinceHot ? since30 : sinceHot } },
        orderBy: { day: "asc" },
      }),
      prisma.sitePropertyDay.aggregate({
        where: { propertyId },
        _sum: { visitors: true, whatsappClicks: true, phoneClicks: true, telegramClicks: true },
      }),
      // Сайт считается подключённым, когда от него хоть раз пришли данные.
      prisma.siteVisitHour.findFirst({ select: { hourStart: true } }),
      prisma.client.findMany({ where: { matchedPropertyId: propertyId }, select: { id: true, createdAt: true }, take: 2000 }),
      prisma.interaction.findMany({
        where: { propertyId, type: { in: ["CALL", "MESSAGE"] } },
        select: { clientId: true, createdAt: true },
        take: 5000,
      }),
      prisma.propertyInterestEvent.findMany({
        where: { propertyId, clientId: { not: null }, kind: { in: ["SHARE_OPENED", "COMMENT"] } },
        select: { clientId: true, createdAt: true },
        take: 5000,
      }),
      // Только ПРОВЕДЁННЫЕ показы (lib/conductedShowing.ts): назначенный на будущее и отменённый
      // не «пришли на показ» и не гасят подсказку светофора (аудит 04.10.2026, APROP02).
      prisma.interaction.findMany({ where: { propertyId, ...conductedShowingBaseWhere(now) }, select: { clientId: true }, take: 5000 }),
      prisma.deal.count({ where: { propertyId, stage: { not: "CANCELLED" } } }),
      loadNeighbors({
        id: p.id,
        type: p.type,
        rooms: p.rooms,
        areaSqm: p.areaSqm,
        price: p.price,
        currency: p.currency,
        districtId: p.districtId,
        districtName: p.district?.name ?? null,
        daysOnSale,
        onSale: p.status === "AVAILABLE",
      }),
    ]);

  // Один человек — один раз, откуда бы он ни пришёл (заявка, звонок, переписка).
  const contactFirst = new Map<string, Date>();
  const touch = (id: string | null, at: Date) => {
    if (!id) return;
    const prev = contactFirst.get(id);
    if (!prev || at < prev) contactFirst.set(id, at);
  };
  for (const c of clientsByMatch) touch(c.id, c.createdAt);
  for (const t of clientsByTouch) touch(t.clientId, t.createdAt);
  for (const e of interestClients) touch(e.clientId, e.createdAt);

  const siteDays = siteDaysWindow(siteDaysRows, PROPERTY_STATS_DAYS, now);
  const hot = detectHot(siteDaysWindow(siteDaysRows, HOT_WINDOW_DAYS, now));

  const last30 = siteDaysRows.filter((r) => r.day >= since30);
  const sum = (k: "views" | "visitors" | "whatsappClicks" | "phoneClicks" | "shareClicks" | "favoriteClicks" | "telegramClicks") =>
    last30.reduce((s, r) => s + r[k], 0);
  const siteTotals = {
    views: sum("views"),
    visitors: sum("visitors"),
    whatsapp: sum("whatsappClicks"),
    phone: sum("phoneClicks") + sum("telegramClicks"),
    share: sum("shareClicks"),
    favorite: sum("favoriteClicks"),
  };
  const siteConnected = siteAny != null;

  const clicksAll =
    (siteAll._sum.whatsappClicks ?? 0) + (siteAll._sum.phoneClicks ?? 0) + (siteAll._sum.telegramClicks ?? 0);
  const clicks30 = siteTotals.whatsapp + siteTotals.phone;
  const contactsTotal = contactFirst.size + clicksAll;
  const contacts30 = [...contactFirst.values()].filter((d) => d >= since30).length + clicks30;
  const showingsTotal = new Set(showings.map((s) => s.clientId)).size;

  const funnel: PropertyFunnelStep[] = [
    { key: "seen", label: "Увидели ролик", count: null, hint: "просмотры роликов на площадках" },
    {
      key: "site",
      label: "Открыли на сайте",
      count: siteConnected ? (siteAll._sum.visitors ?? 0) : null,
      hint: siteConnected ? "люди, открывшие страницу объекта на royalhome.tj" : "статистика сайта ещё не подключена",
    },
    {
      key: "contact",
      label: "Написали или позвонили",
      count: contactsTotal,
      hint: "клиенты в CRM по этому объекту и нажатия WhatsApp на сайте",
    },
    { key: "showing", label: "Пришли на показ", count: showingsTotal, hint: "разные клиенты на показах" },
    { key: "deal", label: "Сделка", count: deals, hint: "сделки по объекту, кроме отменённых" },
  ];

  const health = assessPropertyHealth({
    status: p.status,
    daysOnSale,
    priceDiffPct: neighbors.diffPct,
    daysToSellTypical: neighbors.typicalDaysToSell,
    siteConnected,
    siteViews30: siteTotals.views,
    contacts30,
    contactsTotal,
    showingsTotal,
    photos: p._count.photos,
    publishedChannels: (p.publishedChannels ?? []).length,
    instagramUrl: p.instagramUrl,
    hot: hot.hot,
  });

  return {
    health,
    funnel,
    neighbors,
    siteDays,
    siteTotals,
    siteConnected,
    hot,
    generatedAt: now.toISOString(),
  };

}

const PLATFORM_ORDER: PropertyPlatformStat["channel"][] = ["INSTAGRAM", "FACEBOOK", "YOUTUBE", "TIKTOK", "TELEGRAM"];

/** Площадки объекта — по сети, отдельным запросом. */
export async function loadPropertyPlatforms(propertyId: string): Promise<PropertyPlatformsResponse> {
  const data = await loadPropertyPostStats(propertyId);
  if (!data) return { platforms: [], seen: null };
  const platforms: PropertyPlatformStat[] = [];
  for (const channel of PLATFORM_ORDER) {
    const stat = data.post.stats.find((s) => s.channel === channel);
    if (!stat) continue;
    const platform = data.platforms.find((pl) => pl.channel === channel);
    // Причина по самому посту важнее общей причины площадки: у Instagram лайки могут прочитаться,
    // а просмотры — нет (не то право у ключа), и это надо назвать словами, а не «не отдала число».
    const note =
      stat.views != null
        ? null
        : (stat.note ?? (platform && !platform.available ? platform.reason : null) ?? "площадка не отдала число");
    platforms.push({ channel, views: stat.views, likes: stat.likes, comments: stat.comments, url: stat.url, note });
  }
  const known = platforms.filter((pl) => pl.views != null);
  return { platforms, seen: known.length ? known.reduce((s, pl) => s + (pl.views ?? 0), 0) : null };
}

/**
 * СВЕТОФОР ПАЧКОЙ (24.09.2026) — точка в каталоге и «Объекты, которым нужна
 * помощь». Те же правила (`assessPropertyHealth`), что у вкладки
 * «Статистика», но без N+1: каждое число — один запрос на всю пачку, соседи —
 * один запрос на все районы пачки. Площадки (сеть) сюда не входят: светофор
 * по ним и не судит.
 */
export async function loadHealthBatch(
  ids: string[],
  now: Date = new Date()
): Promise<Map<string, PropertyHealthBrief & { daysOnSale: number; shortId: number; title: string }>> {
  const out = new Map<string, PropertyHealthBrief & { daysOnSale: number; shortId: number; title: string }>();
  if (!ids.length) return out;
  // Удалённые (корзина) — без точки: светофор про объекты в работе.
  const props = await prisma.property.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: {
      id: true,
      shortId: true,
      title: true,
      status: true,
      type: true,
      rooms: true,
      areaSqm: true,
      price: true,
      currency: true,
      districtId: true,
      district: { select: { name: true } },
      createdAt: true,
      stageEnteredAt: true,
      publishedChannels: true,
      instagramUrl: true,
      _count: { select: { photos: true } },
    },
  });
  if (!props.length) return out;
  const found = props.map((p) => p.id);
  const since30 = dushanbeDayStartDaysAgo(PROPERTY_STATS_DAYS - 1, now);
  const sinceHot = dushanbeDayStartDaysAgo(HOT_WINDOW_DAYS - 1, now);
  const districtIds = [...new Set(props.map((p) => p.districtId).filter((x): x is string => !!x))];
  const types = [...new Set(props.map((p) => p.type))];

  const [siteRows, siteAll, siteAny, clients, touches, interests, showings, neighborRows, money] = await Promise.all([
    prisma.sitePropertyDay.findMany({
      where: { propertyId: { in: found }, day: { gte: since30 < sinceHot ? since30 : sinceHot } },
      select: { propertyId: true, day: true, views: true, whatsappClicks: true, phoneClicks: true, telegramClicks: true },
    }),
    prisma.sitePropertyDay.groupBy({
      by: ["propertyId"],
      where: { propertyId: { in: found } },
      _sum: { whatsappClicks: true, phoneClicks: true, telegramClicks: true },
    }),
    prisma.siteVisitHour.findFirst({ select: { hourStart: true } }),
    prisma.client.findMany({ where: { matchedPropertyId: { in: found } }, select: { id: true, matchedPropertyId: true, createdAt: true }, take: 20_000 }),
    prisma.interaction.findMany({
      where: { propertyId: { in: found }, type: { in: ["CALL", "MESSAGE"] } },
      select: { clientId: true, propertyId: true, createdAt: true },
      take: 50_000,
    }),
    prisma.propertyInterestEvent.findMany({
      where: { propertyId: { in: found }, clientId: { not: null }, kind: { in: ["SHARE_OPENED", "COMMENT"] } },
      select: { clientId: true, propertyId: true, createdAt: true },
      take: 50_000,
    }),
    prisma.interaction.findMany({
      where: { propertyId: { in: found }, ...conductedShowingBaseWhere(now) },
      select: { clientId: true, propertyId: true },
      take: 50_000,
    }),
    NEIGHBORS_COMPARISON_ENABLED && districtIds.length
      ? prisma.property.findMany({ where: neighborWhere(districtIds, types), select: NEIGHBOR_SELECT, take: 5000 })
      : Promise.resolve([] as NeighborRow[]),
    loadMoneyContext(),
  ]);

  const siteConnected = siteAny != null;
  const contactFirst = new Map<string, Map<string, Date>>();
  const touch = (propertyId: string | null, clientId: string | null, at: Date) => {
    if (!propertyId || !clientId) return;
    let m = contactFirst.get(propertyId);
    if (!m) contactFirst.set(propertyId, (m = new Map()));
    const prev = m.get(clientId);
    if (!prev || at < prev) m.set(clientId, at);
  };
  for (const c of clients) touch(c.matchedPropertyId, c.id, c.createdAt);
  for (const t of touches) touch(t.propertyId, t.clientId, t.createdAt);
  for (const e of interests) touch(e.propertyId, e.clientId, e.createdAt);
  const showingsBy = new Map<string, Set<string>>();
  for (const s of showings) {
    if (!s.propertyId) continue;
    if (!showingsBy.has(s.propertyId)) showingsBy.set(s.propertyId, new Set());
    showingsBy.get(s.propertyId)!.add(s.clientId);
  }
  const clicksAllBy = new Map(
    siteAll.map((r) => [r.propertyId, (r._sum.whatsappClicks ?? 0) + (r._sum.phoneClicks ?? 0) + (r._sum.telegramClicks ?? 0)])
  );
  const siteBy = new Map<string, typeof siteRows>();
  for (const r of siteRows) {
    if (!siteBy.has(r.propertyId)) siteBy.set(r.propertyId, []);
    siteBy.get(r.propertyId)!.push(r);
  }

  for (const p of props) {
    const saleStart = p.status === "AVAILABLE" ? p.stageEnteredAt : p.createdAt;
    const daysOnSale = Math.max(0, Math.floor((now.getTime() - saleStart.getTime()) / DAY_MS));
    const neighbors = computeNeighbors(
      {
        id: p.id,
        type: p.type,
        rooms: p.rooms,
        areaSqm: p.areaSqm,
        price: p.price,
        currency: p.currency,
        districtId: p.districtId,
        districtName: p.district?.name ?? null,
        daysOnSale,
        onSale: p.status === "AVAILABLE",
      },
      neighborRows,
      money
    );
    const rows = siteBy.get(p.id) ?? [];
    const hotDays = siteDaysWindow(rows, HOT_WINDOW_DAYS, now);
    const last30 = rows.filter((r) => r.day >= since30);
    const siteViews30 = last30.reduce((s, r) => s + r.views, 0);
    const clicks30 = last30.reduce((s, r) => s + r.whatsappClicks + r.phoneClicks + r.telegramClicks, 0);
    const contacts = contactFirst.get(p.id) ?? new Map<string, Date>();
    const health = assessPropertyHealth({
      status: p.status,
      daysOnSale,
      priceDiffPct: neighbors.diffPct,
      daysToSellTypical: neighbors.typicalDaysToSell,
      siteConnected,
      siteViews30,
      contacts30: [...contacts.values()].filter((d) => d >= since30).length + clicks30,
      contactsTotal: contacts.size + (clicksAllBy.get(p.id) ?? 0),
      showingsTotal: showingsBy.get(p.id)?.size ?? 0,
      photos: p._count.photos,
      publishedChannels: (p.publishedChannels ?? []).length,
      instagramUrl: p.instagramUrl,
      hot: detectHot(hotDays).hot,
    });
    out.set(p.id, {
      color: health.color,
      headline: health.headline,
      tip: health.tips[0] ?? null,
      daysOnSale,
      shortId: p.shortId,
      title: p.title,
    });
  }
  return out;
}

/** Сколько объектов в продаже проверяет «Объекты, которым нужна помощь». */
const NEEDS_HELP_SCAN = 500;
const NEEDS_HELP_SHOWN = 10;

export async function loadNeedsHelp(now: Date = new Date()): Promise<PropertiesNeedsHelpResponse> {
  const onSale = await prisma.property.findMany({
    where: { deletedAt: null, status: "AVAILABLE" },
    select: { id: true },
    orderBy: { stageEnteredAt: "asc" },
    take: NEEDS_HELP_SCAN,
  });
  const batch = await loadHealthBatch(
    onSale.map((p) => p.id),
    now
  );
  const all = [...batch.entries()].map(([id, h]) => ({ id, ...h }));
  const red = all.filter((h) => h.color === "red");
  const yellow = all.filter((h) => h.color === "yellow");
  const items = [...red, ...yellow]
    .sort((a, b) => (a.color === b.color ? b.daysOnSale - a.daysOnSale : a.color === "red" ? -1 : 1))
    .slice(0, NEEDS_HELP_SHOWN);
  return { items, checked: all.length, red: red.length, yellow: yellow.length };
}
