import { PROPERTY_VOICE_PRICE_REACTION_DAYS, PROPERTY_VOICE_WINDOW_DAYS, type PropertyVoiceResponse } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { adsOfPropertiesWhere, loadAdAllocations, shareOf } from "../ads/adAllocation.js";
import { dushanbeDateString } from "../dushanbeTime.js";
import { centsToTjs, fromCents, loadMoneyContext, toCents } from "../money.js";
import { POST_SHOWING_OUTCOME_LABELS } from "../postShowingCallFeed.js";
import {
  foldPropertyVoice,
  MEANINGFUL_COMMENT_STATUSES,
  type PropertyVoiceRaw,
  type RawFeedbackCall,
} from "./aggregate.js";

/**
 * ЗАПРОСЫ ДЛЯ «ГОЛОСА РЫНКА» (03.10.2026) — всё чтение базы в одном месте, счёт в
 * aggregate.ts (чистая свёртка). Каждая выборка ограничена `take` и окном времени,
 * N+1 нет: один проход Promise.all, без запросов в цикле.
 *
 * ЧТО ЧИТАЕТСЯ И ОТКУДА ОБЪЕКТ ИЗВЕСТЕН
 *  • интерес и показы — по `propertyId` самих записей;
 *  • комментарии — `InstagramComment.propertyId` (Instagram/Facebook/YouTube) и
 *    `TelegramGroupComment.propertyId`;
 *  • вопросы собственнику — `OwnerQuestion.propertyId`;
 *  • возражения из звонков — ТОЛЬКО `CallAnalysis.propertyId` (объект доказан);
 *  • отказы после показа — SYSTEM-запись отказа с `propertyId` показа и причина из
 *    карточки клиента (`Client.refusalReason`);
 *  • «голос клиента после показа» — читается ТОЛЬКО при `canSeeShowingFeedback`:
 *    по замыслу его не видят агенты (см. PostShowingCall в schema.prisma);
 *  • деньги рекламы — ТОЛЬКО при `canSeeAdMoney` (finance.view или роль MARKETING, как
 *    GET /ads/property/:id): без права суммы не уходят дальше этого файла;
 *  • сделки — по правилам экрана «Сделки»: без `deals.viewAll` только свои (scopeDealsToOwnAgent),
 *    цена продажи — по `finance.view` или у своей сделки (seesDealMoney в routes/deals.ts).
 */

/** Предел выборки на каждый список: молча обрезать нельзя — число в ответе, не страница. */
const TAKE_EVENTS = 20_000;
const TAKE_TEXTS = 3_000;
const TAKE_SMALL = 500;

/** Начало текста, которым refuseClient подписывает запись отказа (lib/clientRefuse.ts). */
const REFUSAL_NOTE_PREFIX = "Клиент отказался (";

const DAY_MS = 24 * 3600_000;

export interface LoadPropertyVoiceOptions {
  /** Право директора (`dashboard.analytics`): без него раздел showingFeedback не читается вообще. */
  canSeeShowingFeedback: boolean;
  /** Деньги рекламы: `finance.view` или роль MARKETING (то же правило, что в routes/ads.ts «ДЕНЬГИ — ПО ПРАВУ»). */
  canSeeAdMoney: boolean;
  /** Чьи сделки читать: null — все (есть `deals.viewAll`), иначе только этого агента (`scopeDealsToOwnAgent`). */
  dealsOwnAgentId: string | null;
  /** Право `finance.view`: цена ЧУЖОЙ сделки видна только с ним (своей — всегда, как `seesDealMoney`). */
  canSeeAllDealMoney: boolean;
  /** Кто смотрит: нужен, чтобы отличить свою сделку от чужой. */
  viewerId: string;
  now?: Date;
  windowDays?: number;
  /**
   * Реклама только с этой даты (по умолчанию — за всё время). Нужна «Отчёту владельцу»
   * (lib/ownerReport/) для цифры «за неделю»; остальные потребители не передают.
   */
  adsSince?: Date;
  /**
   * Начало окна, если оно не «скользящие windowDays×24 часа» (по умолчанию так и есть).
   * «Отчёт владельцу» режет неделю по календарным суткам Душанбе и передаёт сюда полночь.
   */
  windowFrom?: Date;
  /**
   * Не читать то, что от окна не зависит (история цены, сделки, источники диалогов, последнее
   * событие интереса): вызывающему нужны только счётчики окна. Без флага — всё как раньше;
   * сами эти разделы ответа при флаге пустые, диагнозу по такому ответу верить нельзя.
   */
  skipWindowIndependent?: boolean;
}

function parseRedFlags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") out.push(item);
    else if (item && typeof item === "object") {
      const { category, detail } = item as { category?: unknown; detail?: unknown };
      const text = [category, detail].filter((x): x is string => typeof x === "string" && !!x).join(": ");
      if (text) out.push(text);
    }
  }
  return out;
}

/** Предел объявлений объекта — тот же, что у GET /ads/property/:id. */
const TAKE_ADS = 500;

interface AdsVoice {
  adsCount: number;
  spendTjs: number | null;
  spendOriginal: number | null;
  currency: string | null;
  impressions: number;
  clicks: number;
  conversations: number;
}

/**
 * РЕКЛАМА ОБЪЕКТА — ЕГО ДОЛЯ, А НЕ ВСЁ ОБЪЯВЛЕНИЕ (аудит 03.10.2026).
 *
 * «Гибкое» объявление несёт ролики про несколько квартир, и его деньги делятся по весам
 * (lib/ads/adAllocation.ts) — так же, как в GET /ads/property/:id и в отчёте по объектам. Раньше
 * здесь читалось `where: { ad: { propertyId } }`: основной объект получал 100 % расхода, а
 * остальные три — «реклама не шла». Теперь объявления берутся через `adsOfPropertiesWhere`
 * (с запасным путём для старых строк без AdProperty), а каждая сумма и счётчик объявления
 * делится `allocateCents` внутри `shareOf` целыми сотыми: сумма долей всех объектов равна расходу.
 * Деньги считаются всегда; скрывает их по праву вызывающий (loadPropertyVoice).
 */
async function loadAdsVoice(propertyId: string, since?: Date): Promise<AdsVoice> {
  const ads = await prisma.ad.findMany({
    where: { excluded: false, ...adsOfPropertiesWhere([propertyId]) },
    select: { id: true },
    take: TAKE_ADS,
  });
  if (ads.length === 0) {
    return { adsCount: 0, spendTjs: null, spendOriginal: null, currency: null, impressions: 0, clicks: 0, conversations: 0 };
  }
  const adIds = ads.map((a) => a.id);
  const [allocations, totals, money] = await Promise.all([
    loadAdAllocations(adIds),
    prisma.adSpendDaily.groupBy({
      by: ["adId", "currency"],
      // `since` нужен только «Отчёту владельцу» (за неделю); без него — за всё время, как раньше.
      // `date` — колонка @db.Date: граница это полночь UTC НУЖНОГО календарного дня (как msOfKey
      // в lib/ads/adPacing.ts). Полночь Душанбе — это 19:00 UTC накануне, и без перевода в
      // ключ дня первым попадал лишний восьмой день.
      where: { adId: { in: adIds }, ...(since ? { date: { gte: new Date(`${dushanbeDateString(since)}T00:00:00.000Z`) } } : {}) },
      _sum: { spend: true, impressions: true, clicks: true, conversations: true },
    }),
    loadMoneyContext(),
  ]);

  // Объявление → его суммы: в сомони, по валютам, и счётчики (все в целых).
  interface PerAd {
    tjsCents: number;
    byCurrency: Map<string, number>;
    impressions: number;
    clicks: number;
    conversations: number;
  }
  const perAd = new Map<string, PerAd>();
  for (const row of totals) {
    const acc = perAd.get(row.adId) ?? { tjsCents: 0, byCurrency: new Map<string, number>(), impressions: 0, clicks: 0, conversations: 0 };
    const cents = toCents(row._sum.spend ?? 0);
    acc.tjsCents += centsToTjs(cents, row.currency, money);
    acc.byCurrency.set(row.currency, (acc.byCurrency.get(row.currency) ?? 0) + cents);
    acc.impressions += row._sum.impressions ?? 0;
    acc.clicks += row._sum.clicks ?? 0;
    acc.conversations += row._sum.conversations ?? 0;
    perAd.set(row.adId, acc);
  }

  let tjsCents = 0;
  const originalCents = new Map<string, number>();
  let impressions = 0;
  let clicks = 0;
  let conversations = 0;
  for (const [adId, acc] of perAd) {
    const items = allocations.get(adId) ?? [];
    tjsCents += shareOf(acc.tjsCents, items, propertyId);
    for (const [currency, cents] of acc.byCurrency) {
      originalCents.set(currency, (originalCents.get(currency) ?? 0) + shareOf(cents, items, propertyId));
    }
    impressions += shareOf(acc.impressions, items, propertyId);
    clicks += shareOf(acc.clicks, items, propertyId);
    conversations += shareOf(acc.conversations, items, propertyId);
  }
  const currencies = [...originalCents.keys()];
  const singleCurrency = currencies.length === 1 ? currencies[0] : null;
  return {
    adsCount: ads.length,
    spendTjs: totals.length > 0 ? fromCents(tjsCents) : null,
    spendOriginal: singleCurrency ? fromCents(originalCents.get(singleCurrency) ?? 0) : null,
    currency: singleCurrency,
    impressions,
    clicks,
    conversations,
  };
}

export async function loadPropertyVoice(
  propertyId: string,
  options: LoadPropertyVoiceOptions
): Promise<PropertyVoiceResponse | null> {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? PROPERTY_VOICE_WINDOW_DAYS;
  const windowStart = options.windowFrom ?? new Date(now.getTime() - windowDays * DAY_MS);
  const skipIndependent = options.skipWindowIndependent === true;
  const unlessSkipped = <T>(run: () => Promise<T>, empty: T): Promise<T> =>
    skipIndependent ? Promise.resolve(empty) : run();
  // Запас назад — чтобы сравнить интерес до/после снижения цены, случившегося в начале окна.
  const eventsFrom = new Date(windowStart.getTime() - PROPERTY_VOICE_PRICE_REACTION_DAYS * DAY_MS);

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { id: true, price: true, currency: true, status: true, createdAt: true, stageEnteredAt: true },
  });
  if (!property) return null;
  // Срок в продаже — как в lib/propertyStats.ts: с входа в стадию «в продаже», до неё — с создания.
  const onSale = property.status === "AVAILABLE";
  const saleStart = onSale ? property.stageEnteredAt : property.createdAt;
  const daysOnSale = Math.max(0, Math.floor((now.getTime() - saleStart.getTime()) / DAY_MS));

  const [
    interestEvents,
    lastEvent,
    exposures,
    conversationSources,
    igComments,
    tgComments,
    ownerQuestions,
    callAnalyses,
    showings,
    refusalRows,
    priceChanges,
    deals,
    adsVoice,
    botConversations,
  ] = await Promise.all([
    prisma.propertyInterestEvent.findMany({
      where: { propertyId, createdAt: { gte: eventsFrom } },
      select: { kind: true, createdAt: true, clientId: true, externalAuthorId: true },
      orderBy: { createdAt: "desc" },
      take: TAKE_EVENTS,
    }),
    unlessSkipped(
      () =>
        prisma.propertyInterestEvent.findFirst({
          where: { propertyId },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
      null
    ),
    prisma.propertyExposure.findMany({
      where: { propertyId, sentAt: { gte: windowStart } },
      select: { kind: true, sentAt: true, channel: true, recipientId: true },
      orderBy: { sentAt: "desc" },
      take: TAKE_EVENTS,
    }),
    unlessSkipped(
      () =>
        prisma.conversationProperty.groupBy({
          by: ["source"],
          where: { propertyId },
          _count: { _all: true },
        }),
      []
    ),
    prisma.instagramComment.findMany({
      where: { propertyId, createdAt: { gte: windowStart }, status: { in: [...MEANINGFUL_COMMENT_STATUSES] } },
      select: { channel: true, status: true, note: true, text: true },
      orderBy: { createdAt: "desc" },
      take: TAKE_TEXTS,
    }),
    prisma.telegramGroupComment.findMany({
      where: { propertyId, createdAt: { gte: windowStart }, status: { in: [...MEANINGFUL_COMMENT_STATUSES] } },
      select: { status: true, note: true, text: true },
      orderBy: { createdAt: "desc" },
      take: TAKE_TEXTS,
    }),
    prisma.ownerQuestion.findMany({
      where: { propertyId, askedAt: { gte: windowStart } },
      select: { question: true, answer: true, askedAt: true, answeredAt: true },
      orderBy: { askedAt: "desc" },
      take: TAKE_SMALL,
    }),
    prisma.callAnalysis.findMany({
      where: { propertyId, createdAt: { gte: windowStart } },
      select: { objections: true },
      orderBy: { createdAt: "desc" },
      take: TAKE_SMALL * 2,
    }),
    prisma.interaction.findMany({
      where: { propertyId, type: "SHOWING", createdAt: { gte: windowStart } },
      select: { clientId: true, type: true, declinedAt: true, completedAt: true, nextActionDate: true },
      orderBy: { createdAt: "desc" },
      take: TAKE_TEXTS,
    }),
    prisma.interaction.findMany({
      where: {
        propertyId,
        type: "SYSTEM",
        outcome: "NEGATIVE",
        notes: { startsWith: REFUSAL_NOTE_PREFIX },
        createdAt: { gte: windowStart },
      },
      select: { client: { select: { refusalReason: true } } },
      orderBy: { createdAt: "desc" },
      take: TAKE_SMALL,
    }),
    // История цены — за всё время (30 последних изменений): окно здесь не нужно.
    unlessSkipped(
      () =>
        prisma.priceChange.findMany({
          where: { propertyId },
          select: { createdAt: true, oldPrice: true, newPrice: true, oldCurrency: true, newCurrency: true },
          orderBy: { createdAt: "desc" },
          take: 30,
        }),
      []
    ),
    unlessSkipped(
      () =>
        prisma.deal.findMany({
          where: {
            propertyId,
            soldPrice: { not: null },
            stage: { not: "CANCELLED" },
            ...(options.dealsOwnAgentId ? { agentId: options.dealsOwnAgentId } : {}),
          },
          select: { stage: true, soldPrice: true, currency: true, closedAt: true, agentId: true },
          orderBy: { startedAt: "desc" },
          take: 10,
        }),
      []
    ),
    // Реклама — за всё время; общее объявление делится по весам (loadAdsVoice).
    loadAdsVoice(propertyId, options.adsSince),
    prisma.botConversation.count({
      where: { adPropertyId: propertyId, ...(options.adsSince ? { createdAt: { gte: options.adsSince } } : {}) },
    }),
  ]);

  // Голос клиента после показа — отдельный шаг и ТОЛЬКО для директора: у остальных
  // таблицы не читаются вовсе, так что случайно положить их в ответ нечем.
  let feedback: PropertyVoiceRaw["feedback"] = null;
  if (options.canSeeShowingFeedback) {
    const [postShowing, legacySurvey] = await Promise.all([
      prisma.postShowingCall.findMany({
        where: { propertyId, createdAt: { gte: windowStart }, outcome: { not: null } },
        select: { outcome: true, quote: true, summary: true, redFlags: true },
        orderBy: { createdAt: "desc" },
        take: TAKE_SMALL,
      }),
      prisma.showingSurveyCall.findMany({
        where: { propertyId, createdAt: { gte: windowStart } },
        select: { redFlags: true },
        orderBy: { createdAt: "desc" },
        take: TAKE_SMALL,
      }),
    ]);
    const calls: RawFeedbackCall[] = [
      ...postShowing.map((c) => ({
        outcome: c.outcome,
        outcomeLabel: c.outcome ? POST_SHOWING_OUTCOME_LABELS[c.outcome] : null,
        quote: c.quote,
        summary: c.summary,
        redFlags: c.redFlags,
      })),
      // Прежняя таблица (до 16.09.2026): расшифровку не берём — только находки.
      ...legacySurvey.map((c) => ({
        outcome: null,
        outcomeLabel: null,
        quote: null,
        summary: null,
        redFlags: parseRedFlags(c.redFlags),
      })),
    ];
    feedback = { calls };
  }

  const raw: PropertyVoiceRaw = {
    now,
    windowDays,
    windowStart,
    property: { id: property.id, price: Number(property.price), currency: property.currency, onSale, daysOnSale },
    interestEvents: interestEvents.map((e) => ({
      kind: e.kind,
      createdAt: e.createdAt,
      personKey: e.clientId ? `c:${e.clientId}` : e.externalAuthorId ? `x:${e.externalAuthorId}` : null,
    })),
    lastEventAt: lastEvent?.createdAt ?? null,
    exposures: exposures.map((x) => ({
      kind: x.kind,
      sentAt: x.sentAt,
      personKey: `${x.channel}:${x.recipientId}`,
    })),
    conversationSources: conversationSources.map((g) => ({ source: g.source, count: g._count._all })),
    comments: [
      ...igComments.map((c) => ({ channel: c.channel, status: c.status, note: c.note, text: c.text })),
      ...tgComments.map((c) => ({ channel: "TELEGRAM", status: c.status, note: c.note, text: c.text })),
    ],
    ownerQuestions,
    callObjections: callAnalyses.map((c) => c.objections),
    showings,
    refusalReasons: refusalRows.map((r) => r.client.refusalReason),
    priceChanges: priceChanges.map((c) => ({
      createdAt: c.createdAt,
      oldPrice: Number(c.oldPrice),
      newPrice: Number(c.newPrice),
      oldCurrency: c.oldCurrency,
      newCurrency: c.newCurrency,
    })),
    deals: deals.map((d) => ({
      stage: d.stage,
      // Цена чужой сделки без права на финансы не уходит дальше этой строки (как serializeDealMoney).
      soldPrice: options.canSeeAllDealMoney || d.agentId === options.viewerId ? Number(d.soldPrice) : null,
      currency: d.currency,
      closedAt: d.closedAt,
    })),
    dealsOwnOnly: options.dealsOwnAgentId !== null,
    ads: {
      adsCount: adsVoice.adsCount,
      moneyHidden: !options.canSeeAdMoney,
      spendTjs: options.canSeeAdMoney ? adsVoice.spendTjs : null,
      spendOriginal: options.canSeeAdMoney ? adsVoice.spendOriginal : null,
      currency: options.canSeeAdMoney ? adsVoice.currency : null,
      impressions: adsVoice.impressions,
      clicks: adsVoice.clicks,
      conversations: adsVoice.conversations,
      botConversations,
    },
    feedback,
  };
  return foldPropertyVoice(raw);
}
