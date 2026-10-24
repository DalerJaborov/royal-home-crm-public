import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  setAdPropertiesBodySchema,
  type AdBoardProperty,
  type AdOfPropertyShare,
  type AdLeadStats,
  type AdLeaderboardRow,
  type AdTrendPoint,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { logAudit } from "../lib/audit.js";
import { buildAdSpendReport, currentMonth } from "../lib/ads/adSpendReport.js";
import { adSpendToTjsCents, centsToTjs, fromCents, loadMoneyContext, toCents } from "../lib/money.js";
import {
  loadMetaAdsCredentials,
  isMetaAdsConfigured,
  fetchAdAccountDetails,
  type AdAccountDetails,
} from "../lib/ads/metaAdsApi.js";
import { adDelivery, deliveryAsOf, type AdDelivery } from "../lib/ads/adDelivery.js";
import { textHasPrice, textHasRooms } from "../lib/ads/adMatching.js";
import { EW } from "../ai/wordBoundary.js";
import { dushanbeDateString } from "../lib/dushanbeTime.js";
import { reportCalendarDaySchema, reportCalendarMonthSchema } from "../lib/reportPeriod.js";
import { syncMetaAds, syncMetaAdsQuietly, FULL_SYNC_DAYS } from "../lib/ads/syncMetaAds.js";
import { buildConnectUrl, completeConnect, MetaAdsConnectError } from "../lib/ads/metaAdsOAuth.js";
import { agentAccessCanWriteAds } from "../lib/ads/adsWriteAccess.js";
import { buildAdInsights } from "../lib/ads/adInsights.js";
import {
  adNeedsReview,
  adsOfPropertiesWhere,
  allocateCents,
  loadAdAllocations,
  setAdProperties,
} from "../lib/ads/adAllocation.js";
import { buildReconcileReport } from "../lib/ads/adReconcile.js";
import { buildCreativeRanking } from "../lib/ads/adCreativeRank.js";
import { buildAdPacing, PACING_ACCOUNTS_MAX_AGE_MS } from "../lib/ads/adPacing.js";
import { firstLine } from "../lib/ads/adSubject.js";
import { leadStatsOf, loadAdAttribution, periodInstants } from "../lib/ads/adLeadAttribution.js";
import { describeError } from "../lib/describeError.js";
import { logSystemError } from "../lib/systemError.js";
import { getAllOwnMedia } from "../messengers/instagramFeed.js";
import { crmPublicBase } from "../lib/crmPublicUrl.js";
import { createReelsAutoBoostRouter } from "./adsReelsAutoBoost.js";

/**
 * РЕКЛАМА: сколько денег вложено в каждый объект.
 *
 * ДОСТУП. Читать — тем, кому и так открыты деньги (право «Финансы»), плюс роли
 * MARKETING: маркетологу этот отчёт нужнее всех, но полного доступа к финансам у
 * него нет и быть не должно. Править привязку и запускать синхронизацию — тем, кто
 * ведёт финансы (finance.manage), маркетингу и директору.
 *
 * Отдельный раздел, а не вкладка в /marketing: там очередь подготовки объектов
 * (фото, видео, монтаж), здесь деньги. Смешивать их в одном роутере значило бы
 * раздать очереди монтажа доступ к расходам.
 */
export const adsRouter = Router();

/**
 * Группа порядка строк доски: 0 — идёт; 1 — живое без трат (включено, но не тратит /
 * на проверке); 2 — остальное (завершено, выключено, отклонено, ни разу не тратило).
 */
export function boardGroupOf(delivery: AdDelivery): 0 | 1 | 2 {
  if (delivery === "RUNNING") return 0;
  if (delivery === "STALLED" || delivery === "REVIEW") return 1;
  return 2;
}

adsRouter.use(requireAuth);

function requireAdsRead<P>(req: Request<P>, res: Response, next: NextFunction) {
  if (!req.agent) return res.status(401).json({ error: "Требуется авторизация" });
  if (req.agent.role === "MARKETING" || req.agent.permissions.has("finance.view")) return next();
  return res.status(403).json({ error: "Недостаточно прав" });
}

function requireAdsWrite<P>(req: Request<P>, res: Response, next: NextFunction) {
  if (!req.agent) return res.status(401).json({ error: "Требуется авторизация" });
  if (agentAccessCanWriteAds(req.agent.role, req.agent.permissions)) return next();
  return res.status(403).json({ error: "Недостаточно прав" });
}

// Автопродвижение роликов: статус, настройки, «проверить сейчас» (права — как у остальной рекламы).
adsRouter.use("/reels-autoboost", createReelsAutoBoostRouter({ read: requireAdsRead, write: requireAdsWrite }));

const monthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, "Месяц указывается как ГГГГ-ММ")
  .optional();

/** Данные старше этого срока при открытии раздела освежаются сами. Короче не
 *  имеет смысла: Meta пересчитывает статистику раз в 15–60 минут. */
const STALE_AFTER_MS = 15 * 60 * 1000;
let backgroundSyncRunning = false;

/**
 * Отчёт по объектам за месяц. Месяц не указан — текущий по Душанбе.
 *
 * «РЕАЛЬНОЕ ВРЕМЯ» ПО-ЧЕСТНОМУ: если человек открыл раздел, а последняя сверка
 * старше 15 минут — отдаём что есть СРАЗУ (ждать кабинет 5–10 секунд на каждое
 * открытие недопустимо) и параллельно запускаем сверку в фоне. Ответ несёт
 * refreshing: true — интерфейс перечитывает отчёт через полминуты и показывает
 * свежие цифры без участия человека.
 */
interface AdsFreshness {
  syncedAt: Date | null;
  enabled: boolean;
  refreshing: boolean;
}

/**
 * Состояние данных раздела + фоновая сверка, если они протухли.
 *
 * Общая для отчёта и для списка объявлений: список стал главным экраном раздела,
 * и обновлять данные только при открытии «по объектам» значило бы, что человек
 * весь день смотрит на вчерашние цифры, ни разу не заглянув на вторую вкладку.
 */
async function adsFreshness(): Promise<AdsFreshness> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaAdsSyncedAt: true, metaAdsEnabled: true },
  });

  let refreshing = false;
  const syncedAgo = settings?.metaAdsSyncedAt ? Date.now() - settings.metaAdsSyncedAt.getTime() : Infinity;
  if (settings?.metaAdsEnabled && syncedAgo > STALE_AFTER_MS && !backgroundSyncRunning) {
    backgroundSyncRunning = true;
    refreshing = true;
    // Нарочно без await: человек уже смотрит на экран.
    void syncMetaAdsQuietly()
      .catch(() => null)
      .finally(() => {
        backgroundSyncRunning = false;
      });
  } else if (backgroundSyncRunning) {
    refreshing = true;
  }

  return { syncedAt: settings?.metaAdsSyncedAt ?? null, enabled: !!settings?.metaAdsEnabled, refreshing };
}

adsRouter.get("/report", requireAdsRead, async (req, res) => {
  // Период у раздела один на все вкладки: «по объектам» слушается того же
  // переключателя, что и список объявлений. Старый ?month=ГГГГ-ММ продолжает
  // работать — на него ведут ссылки из уведомлений и ИИ-разбора.
  const parsed = periodSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверный период", details: parsed.error.flatten() });
  }
  const period = resolvePeriod(parsed.data);
  if (!period) return res.status(400).json({ error: "Неверный период: несуществующая календарная дата" });

  const freshness = await adsFreshness();
  const report = await buildAdSpendReport({ from: period.from, to: period.to });
  res.json({ ...report, label: period.label, ...freshness });
});

const unmatchedQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
});

/**
 * Объявления, которым не нашлось объекта, — рабочий список для ручной привязки.
 * С пределом выборки: в кабинете агентства рядом с недвижимостью крутится реклама
 * других бизнесов, и таких строк со временем накопится больше, чем помещается на
 * экран.
 */
/**
 * ОБЪЯВЛЕНИЯ БЕЗ ОБЪЕКТА — рабочий экран привязки.
 *
 * На живых данных агентства (20.08.2026) автоматика не привязала ни одного из 25
 * объявлений, и причина оказалась не в коде: реклама крутится на постах, ссылок
 * на которые нет ни в одной карточке (там лежат ссылки на видео-обзоры, а у 17
 * карточек — вообще t.me), а номера объекта в подписях агентство не пишет.
 * Машине не за что зацепиться, и честный ответ на это — не выдумывать привязку,
 * а дать человеку привязать за один клик, показав публикацию целиком.
 *
 * Поэтому вместе с объявлением отдаём: превью и подпись публикации из НАШЕЙ ленты
 * Instagram (по коду поста) и до пяти кандидатов-объектов, отобранных по словам
 * из этой подписи. Дальше человек жмёт на нужный — и связь запоминается навсегда.
 */
adsRouter.get("/unmatched", requireAdsRead, async (req, res) => {
  const parsed = unmatchedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные параметры", details: parsed.error.flatten() });
  }
  const pageSize = 20;
  // Реклама самого агентства сюда не входит: объекта у неё нет и не будет, а
  // список «без объекта» — это очередь работы, которая должна опустеть.
  const where = { propertyId: null, properties: { none: {} }, excluded: false, brand: false };
  const [items, total] = await Promise.all([
    prisma.ad.findMany({
      where,
      select: {
        id: true,
        platform: true,
        name: true,
        campaignName: true,
        postUrl: true,
        postShortcode: true,
        mediaId: true,
        thumbnailUrl: true,
        caption: true,
        lastSyncedAt: true,
        spend: { select: { spend: true, currency: true, conversations: true, impressions: true } },
      },
      orderBy: [{ lastSyncedAt: "desc" }, { id: "desc" }],
      skip: (parsed.data.page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.ad.count({ where }),
  ]);

  const enriched = await enrichUnmatched(items);
  res.json({ items: enriched, total, page: parsed.data.page, pageSize });
});

const linkSchema = z.object({
  /** null — снять привязку и вернуть объявление в общий список. */
  propertyId: z.guid().nullable(),
});

/**
 * Ручная привязка объявления к объекту. Записывается источником MANUAL, и с этого
 * момента синхронизация её не трогает — это единственный способ удержать связь,
 * которую машина не выводит (реклама у блогера, объявление сразу про два объекта,
 * пост без номера в подписи).
 */
adsRouter.patch("/:id/property", requireAdsWrite, async (req, res) => {
  const parsed = linkSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const ad = await prisma.ad.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!ad) return res.status(404).json({ error: "Объявление не найдено" });

  if (parsed.data.propertyId) {
    const property = await prisma.property.findFirst({
      where: { id: parsed.data.propertyId, deletedAt: null },
      select: { id: true },
    });
    if (!property) return res.status(404).json({ error: "Объект не найден" });
  }

  // Единственная запись связи — общий хелпер (Ad.propertyId и AdProperty в одной
  // транзакции). Старая ручка «один объект» — частный случай: весь список заменяется
  // одним объектом или очищается.
  // Снятая привязка возвращает объявление машине: на следующем прогоне она
  // попробует найти объект заново. Иначе «отвязать» означало бы «выключить
  // навсегда», а это не то, что человек имеет в виду.
  const { propertyId } = await setAdProperties(
    ad.id,
    parsed.data.propertyId ? [{ propertyId: parsed.data.propertyId, weight: 1 }] : [],
    "MANUAL"
  );
  const updated = { id: ad.id, propertyId, matchSource: propertyId ? "MANUAL" : null };
  logAudit(req, "UPDATE", "Ad", updated.id, { propertyId: updated.propertyId });
  res.json(updated);
});

/**
 * ВСЕ ОБЪЕКТЫ ОБЪЯВЛЕНИЯ ЗА ОДИН РАЗ (03.10.2026). «Гибкое» объявление несёт
 * несколько роликов про разные квартиры, и человек раскладывает его по объектам с
 * весами. Список заменяется целиком; пустой список снимает привязку. Источник —
 * MANUAL: синхронизация эту связь не трогает никогда.
 */
adsRouter.patch("/:id/properties", requireAdsWrite, async (req, res) => {
  const parsed = setAdPropertiesBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const ad = await prisma.ad.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!ad) return res.status(404).json({ error: "Объявление не найдено" });

  const wanted = Array.from(new Set(parsed.data.items.map((i) => i.propertyId)));
  if (wanted.length > 0) {
    const found = await prisma.property.count({ where: { id: { in: wanted }, deletedAt: null } });
    if (found !== wanted.length) return res.status(404).json({ error: "Объект не найден" });
  }

  const { propertyId } = await setAdProperties(ad.id, parsed.data.items, "MANUAL");
  const properties = await loadAdAllocations([ad.id]);
  logAudit(req, "UPDATE", "Ad", ad.id, { properties: parsed.data.items });
  res.json({
    id: ad.id,
    propertyId,
    matchSource: propertyId ? "MANUAL" : null,
    items: properties.get(ad.id) ?? [],
  });
});

const linkPostSchema = z.object({
  propertyId: z.guid(),
  postUrl: z.string().trim().min(1).max(500),
});

/**
 * ПРИВЯЗАТЬ ПОСТ, КОТОРЫЙ ЛИД-МАГНИТ НЕ УЗНАЁТ, К ОБЪЕКТУ (П-13, 18.09.2026,
 * `docs/audit/recon-17-09/06-chats-misrouting-30d.md` §5.2). Список таких постов
 * приходит в утренний отчёт (`MorningNumbers.unlinkedAdPosts`) — комментаторы под
 * ними не получают лида «своему» агенту через `lib/instagramPostLead.ts`, потому
 * что ссылка ни у одного объекта не значится в `Property.instagramUrl`.
 *
 * Простая привязка НА БУДУЩЕЕ: проставляет `instagramUrl`, если у объекта его ещё
 * нет (не перезаписывает уже выбранный человеком видеообзор). Уже пришедшие
 * комментарии задним числом не переразбираются — это только для следующих.
 */
adsRouter.post("/link-post", requireAdsWrite, async (req, res) => {
  const parsed = linkPostSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const property = await prisma.property.findFirst({
    where: { id: parsed.data.propertyId, deletedAt: null },
    select: { id: true, instagramUrl: true },
  });
  if (!property) return res.status(404).json({ error: "Объект не найден" });
  if (property.instagramUrl) {
    return res.status(409).json({ error: "У объекта уже есть привязанное видео — снимите старую ссылку в карточке объекта, затем привяжите новую" });
  }

  const updated = await prisma.property.update({
    where: { id: property.id },
    data: { instagramUrl: parsed.data.postUrl },
    select: { id: true, shortId: true, instagramUrl: true },
  });
  logAudit(req, "UPDATE", "Property", updated.id, { instagramUrl: updated.instagramUrl, source: "morning-report.link-post" });
  res.json(updated);
});

/** Ручной запуск синхронизации из Настроек: обычный (7 дней) или полный (квартал). */
adsRouter.post("/sync", requireAdsWrite, async (req, res) => {
  const full = req.body?.full === true;
  const credentials = await loadMetaAdsCredentials();
  if (!isMetaAdsConfigured(credentials)) {
    return res.status(400).json({
      error: "Рекламный кабинет не подключён: в Настройках нужны маркер с правом ads_read и идентификатор кабинета",
    });
  }
  try {
    const result = await syncMetaAds(full ? FULL_SYNC_DAYS : undefined);
    // skipped: сверка уже шла (кроном), этот запуск ничего не делал — экран не должен
    // объявлять «обновлено», а честно сказать, что данные подтянет уже идущий прогон.
    const skipped = result.skipped === true;
    if (!skipped) {
      logAudit(req, "SYNC", "Ad", "meta-ads", { days: result.days, ads: result.ads, spendRows: result.spendRows });
    }
    res.json({ ...result, skipped });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Рекламный кабинет не ответил" });
  }
});

/**
 * Реклама из общего кабинета подрядчика, признанная ЧУЖОЙ (другие его клиенты).
 * Отдельным списком, а не молча выброшенная: только так можно объяснить разницу
 * между суммой в CRM и суммой в Ads Manager — и вернуть объявление себе, если
 * машина ошиблась.
 */
adsRouter.get("/foreign", requireAdsRead, async (req, res) => {
  const parsed = unmatchedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные параметры", details: parsed.error.flatten() });
  }
  const pageSize = 50;
  const where = { excluded: true };
  const [items, total] = await Promise.all([
    prisma.ad.findMany({
      where,
      select: {
        id: true,
        adAccountId: true,
        name: true,
        campaignName: true,
        postUrl: true,
        thumbnailUrl: true,
        lastSyncedAt: true,
        spend: { select: { spend: true, currency: true } },
      },
      orderBy: [{ lastSyncedAt: "desc" }, { id: "desc" }],
      skip: (parsed.data.page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.ad.count({ where }),
  ]);

  res.json({
    items: items.map((ad) => ({
      id: ad.id,
      adAccountId: ad.adAccountId,
      name: ad.name,
      campaignName: ad.campaignName,
      postUrl: ad.postUrl,
      thumbnailUrl: ad.thumbnailUrl,
      lastSyncedAt: ad.lastSyncedAt,
      spendOriginal: fromCents(ad.spend.reduce((sum, s) => sum + toCents(s.spend), 0)),
      currency: ad.spend[0]?.currency ?? "USD",
    })),
    total,
    page: parsed.data.page,
    pageSize,
  });
});

const ownershipSchema = z.object({ ours: z.boolean() });

/**
 * «Это наше» / «это не наше» — ручной вердикт по объявлению.
 *
 * Держится сам по себе, отдельно от привязки к объекту: реклама бренда, вакансий
 * или лид-магнита — наша и должна считаться в расходах, хотя конкретной квартиры
 * за ней нет.
 */
adsRouter.patch("/:id/ownership", requireAdsWrite, async (req, res) => {
  const parsed = ownershipSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const ad = await prisma.ad.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!ad) return res.status(404).json({ error: "Объявление не найдено" });

  const updated = await prisma.ad.update({
    where: { id: ad.id },
    data: { excluded: !parsed.data.ours },
    select: { id: true, excluded: true },
  });
  logAudit(req, "UPDATE", "Ad", updated.id, { excluded: updated.excluded });
  res.json(updated);
});

/**
 * ПЕРИОД ОТЧЁТА — не только месяц (просьба владельца 21.08.2026).
 *
 * Либо готовый пресет (сегодня, вчера, 7 или 30 дней, этот и прошлый месяц, всё
 * время), либо произвольные даты from/to. Пресеты закрывают девять случаев из
 * десяти, а произвольные даты нужны, когда сверяют конкретную неделю запуска.
 */
const periodSchema = z.object({
  preset: z.enum(["today", "yesterday", "7d", "30d", "month", "prev_month", "all"]).optional(),
  from: reportCalendarDaySchema.optional(),
  to: reportCalendarDaySchema.optional(),
  /** Совместимость: старые ссылки и вкладки всё ещё передают месяц. */
  month: reportCalendarMonthSchema.optional(),
});

function resolvePeriod(q: z.infer<typeof periodSchema>): { from: Date; to: Date; label: string } | null {
  const day = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Сутки считаем по Душанбе — как и весь остальной учёт в CRM.
  const wall = new Date(Date.now() + 5 * 60 * 60 * 1000);
  const today = day(wall);
  const shift = (base: Date, days: number) => new Date(base.getTime() + days * 86400000);
  const monthLabel = (d: Date) => d.toLocaleDateString("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });

  if (q.from && q.to) {
    const from = new Date(`${q.from}T00:00:00.000Z`);
    const to = new Date(`${q.to}T00:00:00.000Z`);
    // Validate the effective range before any report query. Each caller maps
    // null to its existing structured 400 response.
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return null;
    return { from, to, label: `${q.from} — ${q.to}` };
  }
  if (q.month) {
    const from = new Date(`${q.month}-01T00:00:00.000Z`);
    const to = new Date(from);
    to.setUTCMonth(to.getUTCMonth() + 1, 0);
    return { from, to, label: monthLabel(from) };
  }

  switch (q.preset ?? "30d") {
    case "today":
      return { from: today, to: today, label: "сегодня" };
    case "yesterday": {
      const y = shift(today, -1);
      return { from: y, to: y, label: "вчера" };
    }
    case "7d":
      return { from: shift(today, -6), to: today, label: "последние 7 дней" };
    case "month": {
      const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      return { from, to: today, label: monthLabel(from) };
    }
    case "prev_month": {
      const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
      const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
      return { from, to, label: monthLabel(from) };
    }
    case "all":
      return { from: new Date(Date.UTC(2020, 0, 1)), to: today, label: "всё время" };
    default:
      return { from: shift(today, -29), to: today, label: "последние 30 дней" };
  }
}

/**
 * ДАШБОРД ОБЪЯВЛЕНИЙ — «что вообще крутится и сколько это стоит».
 *
 * Просьба владельца 21.08.2026 после первого живого отчёта: там половина строк
 * показывала ноль, и было непонятно почему. Причина простая — отчёт считал только
 * выбранный месяц, а объявления работали в другие. Здесь у каждой строки ДВА
 * числа: за выбранный период и за всё время, плюс сроки (когда запущено, сколько
 * дней идёт) и состояние. Ноль перестаёт быть загадкой: видно, что объявление
 * остановлено полгода назад или запущено вчера.
 *
 * Отдаём разом всё, что нужно экрану: объект (если привязан), публикацию, деньги,
 * показы, обращения, цену обращения. Директору хватит первых двух колонок,
 * маркетологу — остальных.
 */
adsRouter.get("/board", requireAdsRead, async (req, res) => {
  const parsed = periodSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверный период", details: parsed.error.flatten() });
  }
  const period = resolvePeriod(parsed.data);
  if (!period) return res.status(400).json({ error: "Неверный период: несуществующая календарная дата" });
  const { from, to, label } = period;

  const BOARD_LIMIT = 500;
  const freshness = await adsFreshness();
  const [ads, foreignCount, asOf] = await Promise.all([
    prisma.ad.findMany({
      where: { excluded: false },
      select: {
        id: true,
        externalId: true,
        name: true,
        campaignName: true,
        status: true,
        objective: true,
        createdTime: true,
        startTime: true,
        stopTime: true,
        postUrl: true,
        thumbnailUrl: true,
        caption: true,
        brand: true,
        matchSource: true,
        assetCount: true,
        spend: { select: { date: true, spend: true, currency: true, impressions: true, clicks: true, conversations: true } },
      },
      // Порядок детерминированный: lastSyncedAt у всех объявлений один и тот же
      // (его проставляет один прогон сверки), и при обрезке списка выпадали
      // случайные строки, а итоги молча считались по неполному набору.
      orderBy: [{ createdTime: "desc" }, { firstSeenAt: "desc" }],
      take: BOARD_LIMIT + 1,
    }),
    // Сколько объявлений признано чужими: вкладка «Чужая реклама» показывает
    // это число на ярлыке и не открывается вхолостую, когда чужого нет.
    prisma.ad.count({ where: { excluded: true } }),
    deliveryAsOf(),
  ]);
  const truncated = ads.length > BOARD_LIMIT;
  if (truncated) ads.length = BOARD_LIMIT;

  /**
   * ОБЪЕКТЫ ОБЪЯВЛЕНИЙ (03.10.2026): объявление может платить сразу за несколько
   * объектов. Доли читаются одним запросом на всю доску, объекты — вторым; деньги и
   * обращения делятся по весам (lib/ads/adAllocation.ts) так, что сумма по объектам
   * равна расходу объявления до дирама.
   */
  const allocations = await loadAdAllocations(ads.map((a) => a.id));
  const propertyIds = Array.from(
    new Set(Array.from(allocations.values()).flatMap((items) => items.map((i) => i.propertyId)))
  );
  const propertyRows =
    propertyIds.length > 0
      ? await prisma.property.findMany({
          where: { id: { in: propertyIds } },
          select: {
            id: true,
            shortId: true,
            title: true,
            status: true,
            photos: { select: { thumbUrl: true }, orderBy: { order: "asc" }, take: 1 },
          },
        })
      : [];
  const propertyById = new Map(propertyRows.map((p) => [p.id, p]));

  const money = await loadMoneyContext();
  // Сутки по Душанбе, а не по UTC (lib/dushanbeTime.ts); дата расхода в базе — календарная.
  const todayKey = dushanbeDateString();
  const rows = ads.map((ad) => {
    const inMonth = ad.spend.filter((s) => s.date >= from && s.date <= to);
    /**
     * Деньги складываются целыми сотыми, курс применяется к СУММЕ объявления по
     * валюте, ровно один раз (money.ts::adSpendToTjsCents) — так же, как в отчёте
     * по объектам, поэтому доска и отчёт не расходятся на цент. Итог страницы
     * складывается из этих же чисел, колонка сходится с итогом до дирама.
     */
    const sum = (list: typeof ad.spend) => ({
      spendTjs: fromCents(adSpendToTjsCents(list, money)),
      spendOriginal: fromCents(list.reduce((acc, s) => acc + toCents(s.spend), 0)),
      impressions: list.reduce((acc, s) => acc + s.impressions, 0),
      clicks: list.reduce((acc, s) => acc + s.clicks, 0),
      conversations: list.reduce((acc, s) => acc + s.conversations, 0),
    });
    const period = sum(inMonth);
    const lifetime = sum(ad.spend);
    // Дни, в которые реально были траты, — честнее «срока показа»: заданный срок
    // может быть открыт, а объявление стоять на паузе.
    const activeDays = new Set(ad.spend.filter((s) => Number(s.spend) > 0).map((s) => s.date.toISOString().slice(0, 10)));
    const dates = ad.spend.map((s) => s.date).sort((a, b) => a.getTime() - b.getTime());
    // Последний день с ТРАТАМИ, а не последняя присланная строка: нулевые дни
    // Meta шлёт и по объявлениям, которые давно стоят.
    const spentDates = ad.spend
      .filter((s) => Number(s.spend) > 0)
      .map((s) => s.date)
      .sort((a, b) => a.getTime() - b.getTime());
    const lastSpendAt = spentDates[spentDates.length - 1] ?? null;
    // Расход за СЕГОДНЯ по Душанбе — всё объявление целиком, без деления на объекты.
    const todayTjs = fromCents(
      adSpendToTjsCents(ad.spend.filter((s) => s.date.toISOString().slice(0, 10) === todayKey), money)
    );

    // Доли объектов за выбранный период. allocateCents делит ровно то число, что
    // показано в колонке объявления, — сумма по объектам сходится с ним до дирама.
    const items = allocations.get(ad.id) ?? [];
    const weightSum = items.reduce((acc, i) => acc + i.weight, 0);
    const spendShares = allocateCents(toCents(period.spendTjs), items);
    const conversationShares = allocateCents(period.conversations, items);
    const properties: AdBoardProperty[] = [];
    items.forEach((item, i) => {
      const p = propertyById.get(item.propertyId);
      if (!p) return;
      properties.push({
        id: p.id,
        shortId: p.shortId,
        title: p.title,
        status: p.status,
        thumbUrl: p.photos[0]?.thumbUrl ?? null,
        share: weightSum > 0 ? item.weight / weightSum : 0,
        spendTjs: fromCents(spendShares[i].cents),
        conversations: conversationShares[i].cents,
      });
    });
    const primary = properties[0] ?? null;

    return {
      id: ad.id,
      name: ad.name,
      campaignName: ad.campaignName,
      status: ad.status,
      /**
       * ЧТО НА САМОМ ДЕЛЕ ПРОИСХОДИТ С ОБЪЯВЛЕНИЕМ (lib/ads/adDelivery.ts).
       * Статус Meta для этого не годится: у завершённого объявления он навсегда
       * остаётся ACTIVE, и раздел месяцами писал «Идёт сейчас» на рекламе,
       * закончившейся весной.
       */
      delivery: adDelivery({ status: ad.status, stopTime: ad.stopTime, lastSpendAt, asOf }),
      objective: ad.objective,
      createdTime: ad.createdTime,
      startTime: ad.startTime,
      stopTime: ad.stopTime,
      /** Первый и последний день, когда объявление реально тратило. */
      firstSpendAt: dates[0] ?? null,
      lastSpendAt,
      /** Расход объявления за сегодня (Душанбе), сомони. */
      todayTjs,
      activeDays: activeDays.size,
      postUrl: ad.postUrl,
      previewUrl: ad.thumbnailUrl,
      /**
       * Первая строка публикации — то, чем строка без объекта называет себя сама.
       * Название кампании для этого не годится: Meta режет его до «Публикация:
       * "Продаётся квартира"», и такие строки в отчёте неотличимы друг от друга.
       */
      headline: firstLine(ad.caption),
      /** Реклама агентства: привязки к объекту не ждёт — так и помечена. */
      brand: ad.brand,
      /** Основной объект (первый по весу) — оставлен для экранов, ещё не знающих про несколько. */
      property: primary
        ? {
            id: primary.id,
            shortId: primary.shortId,
            title: primary.title,
            status: primary.status,
            coverUrl: primary.thumbUrl,
          }
        : null,
      /** Все объекты объявления с долей денег и обращений за период. */
      properties,
      /** Материалов в объявлении (разных, см. adMatching.ts). Больше числа объектов — неполное. */
      assetCount: ad.assetCount,
      /** Нужен взгляд человека: объекта нет или материалов больше, чем объектов (кроме ручной привязки). */
      needsReview: adNeedsReview(ad, properties.length),
      matchSource: ad.matchSource,
      period,
      lifetime,
      /** Клиенты CRM, показы, сделки и цена клиента по объявлению (волна 1); заполняется ниже. */
      leadStats: undefined as AdLeadStats | undefined,
      // Валюта кабинета у объявления одна; если дневные строки почему-то
      // разошлись, честнее не называть никакую, чем назвать первую попавшуюся.
      currency: new Set(ad.spend.map((s) => s.currency)).size > 1 ? null : ad.spend[0]?.currency ?? "USD",
    };
  });

  // Порядок: идут сейчас → живые без трат (включены, но не тратят / на проверке) →
  // остальные; внутри группы — по расходу за период, затем по последнему дню трат.
  rows.sort(
    (a, b) =>
      boardGroupOf(a.delivery) - boardGroupOf(b.delivery) ||
      b.period.spendTjs - a.period.spendTjs ||
      (b.lastSpendAt?.getTime() ?? 0) - (a.lastSpendAt?.getTime() ?? 0)
  );

  /**
   * РЕАЛЬНАЯ ЦЕНА КЛИЕНТА (волна 1, 03.10.2026): клиенты CRM, пришедшие с объявления
   * (Client.sourceAdId), их показы, сделки и комиссия — рядом с «обращениями» Meta.
   * Деньги и клиенты на объекты делятся одной функцией (adAllocation.ts). Сбой
   * расчёта не роняет доску: поля необязательные, экран без них рисует как раньше.
   */
  let leadsTruncated = false;
  let totalLeadStats: AdLeadStats | null = null;
  try {
    const externalIdOf = new Map(ads.map((a) => [a.id, a.externalId]));
    const attribution = await loadAdAttribution(
      rows.map((r) => ({
        adId: r.id,
        externalId: externalIdOf.get(r.id) ?? "",
        spendCents: toCents(r.period.spendTjs),
        items: allocations.get(r.id) ?? [],
      })),
      periodInstants(from, to),
      money
    );
    leadsTruncated = attribution.truncated;
    const sum = { leads: 0, showings: 0, deals: 0, commissionCents: 0 };
    for (const row of rows) {
      const found = attribution.byAd.get(row.id);
      if (!found) continue;
      sum.leads += found.total.leads;
      sum.showings += found.total.showings;
      sum.deals += found.total.deals;
      sum.commissionCents += found.total.commissionCents;
      row.leadStats = leadStatsOf(
        toCents(row.period.spendTjs),
        found.total,
        row.period.conversations
      );
      // Те же доли денег и обращений, что в чипах объектов, — клиенты по тем же весам.
      for (const p of row.properties) {
        const counts = found.byProperty.get(p.id);
        if (counts) p.leadStats = leadStatsOf(toCents(p.spendTjs), counts, p.conversations, { shares: true });
      }
    }
    totalLeadStats = leadStatsOf(
      rows.reduce((acc, r) => acc + toCents(r.period.spendTjs), 0),
      sum,
      rows.reduce((acc, r) => acc + r.period.conversations, 0)
    );
  } catch (err) {
    void logSystemError("ads", `Клиенты объявлений не посчитаны (доска рекламы): ${describeError(err)}`, {
      dedupKey: "ads-board-lead-attribution",
    });
  }

  const byDelivery = (d: AdDelivery) => rows.filter((r) => r.delivery === d).length;

  res.json({
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    label,
    // Когда сверялись с кабинетом и подключён ли он — то же, что у отчёта:
    // список объявлений открывается первым, и шапка раздела читает это с него.
    ...freshness,
    rows,
    /** true — объявлений больше, чем помещается в один ответ: итоги неполные. */
    truncated,
    /** true — клиентов в периоде больше предела выборки: цена клиента посчитана по неполному набору. */
    leadsTruncated,
    totals: {
      /** Клиенты CRM с рекламы за период и цена клиента по всем показанным объявлениям (волна 1). */
      leadStats: totalLeadStats,
      // Итоги — сумма ПОКАЗАННЫХ строк, копейка в копейку.
      periodTjs: fromCents(rows.reduce((acc, r) => acc + toCents(r.period.spendTjs), 0)),
      lifetimeTjs: fromCents(rows.reduce((acc, r) => acc + toCents(r.lifetime.spendTjs), 0)),
      /** Идёт — по факту трат, а не по статусу Meta (lib/ads/adDelivery.ts). */
      running: byDelivery("RUNNING"),
      /** Включено, но денег не тратит: кончился бюджет, аудитория, модерация. */
      stalled: byDelivery("STALLED"),
      /** Больше не идёт: выключено руками или вышел срок показа. */
      stopped: rows.length - byDelivery("RUNNING") - byDelivery("STALLED"),
      total: rows.length,
      linked: rows.filter((r) => r.property).length,
      foreign: foreignCount,
      conversations: rows.reduce((acc, r) => acc + r.period.conversations, 0),
      /**
       * Деньги на рекламу самого агентства и число таких объявлений. Считаются
       * отдельно, потому что отвечают на другой вопрос: не «сколько вложено в
       * эту квартиру», а «сколько ушло на то, чтобы о нас узнали».
       */
      brandTjs: fromCents(rows.filter((r) => r.brand).reduce((acc, r) => acc + toCents(r.period.spendTjs), 0)),
      brandCount: rows.filter((r) => r.brand).length,
      /** Осталось разобрать человеку — квартиры без привязки, без брендовых. */
      pending: rows.filter((r) => !r.property && !r.brand).length,
      /** Неполные объявления: объектов привязано меньше, чем материалов (кроме ручных). */
      needsReview: rows.filter((r) => r.needsReview).length,
    },
  });
});

/**
 * ДИНАМИКА РАСХОДА ПО ДНЯМ за выбранный период — график раздела. Те же объявления и
 * тот же курс, что у доски; дни без трат внутри периода отдаются нулями, чтобы
 * линия не рвалась.
 */
adsRouter.get("/trend", requireAdsRead, async (req, res) => {
  const parsed = periodSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверный период", details: parsed.error.flatten() });
  }
  const period = resolvePeriod(parsed.data);
  if (!period) return res.status(400).json({ error: "Неверный период: несуществующая календарная дата" });
  const { from, to } = period;

  // «Объявление × день × валюта» схлопнуто базой до «день × валюта»: строк на
  // порядок меньше. Предел — с запасом на шесть лет двух валют.
  const rows = await prisma.adSpendDaily.groupBy({
    by: ["date", "currency"],
    where: { date: { gte: from, lte: to }, ad: { excluded: false } },
    _sum: { spend: true, impressions: true, conversations: true },
    orderBy: { date: "asc" },
    take: 5000,
  });
  if (rows.length === 0) return res.json([] satisfies AdTrendPoint[]);

  const money = await loadMoneyContext();
  const byDay = new Map<string, { cents: number; conversations: number; impressions: number }>();
  for (const r of rows) {
    const key = r.date.toISOString().slice(0, 10);
    const point = byDay.get(key) ?? { cents: 0, conversations: 0, impressions: 0 };
    point.cents += centsToTjs(toCents(r._sum.spend ?? 0), r.currency, money);
    point.conversations += r._sum.conversations ?? 0;
    point.impressions += r._sum.impressions ?? 0;
    byDay.set(key, point);
  }

  // Ряд идёт с первого дня, когда были данные (пресет «всё время» начинается с
  // 2020 года, и тянуть шесть лет нулей незачем), и до конца периода.
  const out: AdTrendPoint[] = [];
  const cursor = new Date(rows[0].date.getTime());
  for (let guard = 0; cursor <= to && guard < 4000; guard++) {
    const key = cursor.toISOString().slice(0, 10);
    const point = byDay.get(key);
    out.push({
      date: key,
      spendTjs: fromCents(point?.cents ?? 0),
      conversations: point?.conversations ?? 0,
      impressions: point?.impressions ?? 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  res.json(out);
});

const leaderboardQuerySchema = periodSchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * РЕЙТИНГ ОБЪЕКТОВ ПО ЦЕНЕ ОБРАЩЕНИЯ (меньше = лучше). Строится из того же отчёта,
 * что и «по объектам», — то есть уже с долями объявлений на несколько объектов.
 * Объекты без обращений идут в конец по убыванию расхода: это «деньги без отдачи».
 */
adsRouter.get("/leaderboard", requireAdsRead, async (req, res) => {
  const parsed = leaderboardQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные параметры", details: parsed.error.flatten() });
  }
  const period = resolvePeriod(parsed.data);
  if (!period) return res.status(400).json({ error: "Неверный период: несуществующая календарная дата" });

  const report = await buildAdSpendReport({ from: period.from, to: period.to });
  const board: AdLeaderboardRow[] = report.rows
    .filter((r) => r.property && r.spendTjs > 0)
    .map((r) => ({
      propertyId: r.property!.id,
      shortId: r.property!.shortId,
      title: r.property!.title,
      spendTjs: r.spendTjs,
      conversations: r.conversations,
      costPerConversationTjs: r.conversations > 0 ? fromCents(Math.round(toCents(r.spendTjs) / r.conversations)) : null,
    }))
    .sort((a, b) => {
      if (a.costPerConversationTjs == null && b.costPerConversationTjs == null) return b.spendTjs - a.spendTjs;
      if (a.costPerConversationTjs == null) return 1;
      if (b.costPerConversationTjs == null) return -1;
      return a.costPerConversationTjs - b.costPerConversationTjs;
    })
    .slice(0, parsed.data.limit);
  res.json(board);
});

/**
 * КАКИЕ РОЛИКИ/КРЕАТИВЫ РАБОТАЮТ — рейтинг платных объявлений по цене клиента и цене
 * обращения (lib/ads/adCreativeRank.ts). Деньги — по праву requireAdsRead, как у всего
 * раздела: суммы расхода и цены не отдаются никому без «Финансов»/маркетинга.
 */
adsRouter.get("/creatives", requireAdsRead, async (req, res) => {
  const parsed = periodSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверный период", details: parsed.error.flatten() });
  }
  const period = resolvePeriod(parsed.data);
  if (!period) return res.status(400).json({ error: "Неверный период: несуществующая календарная дата" });
  res.json(await buildCreativeRanking(period));
});

/**
 * ТЕМП РАСХОДА И ПРОГНОЗ БЮДЖЕТА (lib/ads/adPacing.ts). Реквизиты кабинета берутся ТОЛЬКО из
 * кэша /ads/accounts (ниже): этот роут Meta не зовёт ни при каких условиях. Кэш пуст или
 * старше трёх часов — `accounts: null`, и экран так и пишет. Деньги — по праву requireAdsRead.
 */
adsRouter.get("/pacing", requireAdsRead, async (_req, res) => {
  const fresh = accountsCache && Date.now() - accountsCache.fetchedAt < PACING_ACCOUNTS_MAX_AGE_MS;
  res.json(await buildAdPacing({ accounts: fresh && accountsCache ? accountsCache.rows : null }));
});

/**
 * СВЕРКА РЕКЛАМЫ — что сторож нашёл неправильным прямо сейчас (lib/ads/adReconcile.ts):
 * объявления без объекта, неполные «гибкие», расхождение с итогом кабинета Meta.
 * Meta не ответила — это не ошибка роута: итог кабинета null, а в проблемах STALE_SYNC.
 */
adsRouter.get("/reconcile", requireAdsRead, async (req, res) => {
  const parsed = periodSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверный период", details: parsed.error.flatten() });
  }
  const period = resolvePeriod(parsed.data);
  if (!period) return res.status(400).json({ error: "Неверный период: несуществующая календарная дата" });
  res.json(await buildReconcileReport({ from: period.from, to: period.to }));
});

/** Реквизиты кабинета меняются раз в жизни — держим полчаса. */
let accountsCache: { rows: AdAccountDetails[]; fetchedAt: number } | null = null;

/**
 * КАБИНЕТЫ И ЧЕМ ПЛАТЯТ. Карта списания, валюта, долг и порог списания — то, что
 * директор иначе ищет в кабинете Meta через три меню.
 */
adsRouter.get("/accounts", requireAdsRead, async (_req, res) => {
  if (accountsCache && Date.now() - accountsCache.fetchedAt < 30 * 60 * 1000) {
    return res.json({ accounts: accountsCache.rows });
  }
  const credentials = await loadMetaAdsCredentials();
  if (!isMetaAdsConfigured(credentials)) return res.json({ accounts: [] });

  const rows = [];
  for (const id of credentials.adAccountIds) {
    const details = await fetchAdAccountDetails(credentials, id);
    if (details) rows.push(details);
  }
  accountsCache = { rows, fetchedAt: Date.now() };
  res.json({ accounts: rows });
});

/**
 * РЕКЛАМА ОДНОГО ОБЪЕКТА — для плашки в его карточке (просьба владельца
 * 21.08.2026). Отвечает на три вопроса: продвигается ли сейчас, сколько на него
 * потрачено всего и что это дало.
 */
/**
 * ДЕНЬГИ — ПО ПРАВУ, ПРИЗНАК — ВСЕМ (аудит №4, 27.08).
 *
 * Роут остаётся под requireAuth: плашка «продвигается ли объект» в карточке
 * нужна обычному агенту, и закрывать её правом «Финансы» значило бы сломать
 * рабочий экран. Но СУММЫ расхода (spendTjs) — те же деньги компании, что
 * закрыты в остальных семи роутах этого модуля, и агент читал их прямым
 * запросом. Теперь без права финансов/маркетинга в ответе остаются только
 * признак продвижения, число объявлений и ссылка на пост.
 */
adsRouter.get("/property/:id", async (req, res) => {
  const ads = await prisma.ad.findMany({
    // Объявления, платящие за объект, включая «гибкие» на несколько объектов и
    // старые строки без AdProperty (adsOfPropertiesWhere).
    where: { excluded: false, ...adsOfPropertiesWhere([req.params.id]) },
    select: {
      id: true,
      externalId: true,
      name: true,
      campaignName: true,
      status: true,
      stopTime: true,
      postUrl: true,
      startTime: true,
      spend: { select: { date: true, spend: true, currency: true, impressions: true, clicks: true, conversations: true } },
    },
    take: 500,
  });
  if (ads.length === 0) return res.json({ promoting: false, ads: 0 });

  const money = await loadMoneyContext();
  const all = ads.flatMap((a) => a.spend);
  const dates = all.map((s) => s.date).sort((a, b) => a.getTime() - b.getTime());
  const asOf = await deliveryAsOf();
  /** Последний день с тратами по одному объявлению. */
  const lastSpendOf = (spend: { date: Date; spend: unknown }[]) => {
    const days = spend
      .filter((s) => Number(s.spend) > 0)
      .map((s) => s.date)
      .sort((a, b) => a.getTime() - b.getTime());
    return days[days.length - 1] ?? null;
  };

  const base = {
    /**
     * «Сейчас в продвижении» — по факту трат, а не по статусу Meta: у неё
     * завершённое объявление навсегда остаётся ACTIVE, и зелёная плашка горела
     * на квартирах, которых не рекламировали с весны.
     */
    promoting: ads.some(
      (a) =>
        adDelivery({ status: a.status, stopTime: a.stopTime, lastSpendAt: lastSpendOf(a.spend), asOf }) === "RUNNING"
    ),
    ads: ads.length,
    postUrl: ads.find((a) => a.postUrl)?.postUrl ?? null,
  };
  // Право то же, что у остальных ручек раздела: finance.view или роль MARKETING.
  const canSeeMoney = req.agent!.role === "MARKETING" || req.agent!.permissions.has("finance.view");
  if (!canSeeMoney) return res.json(base);

  /**
   * ДОЛЯ ОБЪЕКТА, А НЕ ВСЁ ОБЪЯВЛЕНИЕ (03.10.2026): объявление про четыре квартиры
   * не должно записывать весь расход в карточку каждой из них. Деньги и счётчики
   * каждого объявления делятся по весам (lib/ads/adAllocation.ts), берётся доля
   * этого объекта.
   */
  const allocations = await loadAdAllocations(ads.map((a) => a.id));
  const shareOf = (adId: string, total: number): number => {
    const items = allocations.get(adId) ?? [];
    return allocateCents(total, items).find((s) => s.propertyId === req.params.id)?.cents ?? 0;
  };
  let spendCents = 0;
  let impressions = 0;
  let clicks = 0;
  let conversations = 0;
  /** Доля объекта в каждом объявлении: тем же делителем, что и итоги выше (adAllocation.ts). */
  const adsOfProperty: AdOfPropertyShare[] = [];
  /** Единицы для доли 0..1: делим миллион «единиц» тем же allocateCents, своего деления нет. */
  const SHARE_UNITS = 1_000_000;
  for (const ad of ads) {
    const adSpendShare = shareOf(ad.id, adSpendToTjsCents(ad.spend, money));
    spendCents += adSpendShare;
    const items = allocations.get(ad.id) ?? [];
    if (items.some((i) => i.propertyId === req.params.id)) {
      adsOfProperty.push({
        adId: ad.id,
        name: ad.name,
        share: shareOf(ad.id, SHARE_UNITS) / SHARE_UNITS,
        objectsInAd: items.length,
        spendTjs: fromCents(adSpendShare),
      });
    }
    impressions += shareOf(ad.id, ad.spend.reduce((acc, s) => acc + s.impressions, 0));
    clicks += shareOf(ad.id, ad.spend.reduce((acc, s) => acc + s.clicks, 0));
    conversations += shareOf(ad.id, ad.spend.reduce((acc, s) => acc + s.conversations, 0));
  }

  /**
   * КЛИЕНТЫ И ЦЕНА КЛИЕНТА ОБЪЕКТА (волна 1, 03.10.2026): клиенты CRM, пришедшие с
   * объявлений этого объекта за всё время, делятся между объектами объявления по тем
   * же весам, что и деньги выше (adLeadAttribution.ts). Сбой расчёта плашку не роняет.
   */
  let leadStats: AdLeadStats | undefined;
  try {
    const attribution = await loadAdAttribution(
      ads.map((ad) => ({
        adId: ad.id,
        externalId: ad.externalId,
        spendCents: adSpendToTjsCents(ad.spend, money),
        items: allocations.get(ad.id) ?? [],
      })),
      { start: null, end: null },
      money
    );
    const mine = attribution.byProperty.get(req.params.id);
    leadStats = leadStatsOf(
      spendCents,
      mine ?? { leads: 0, showings: 0, deals: 0, commissionCents: 0 },
      conversations,
      // Клиенты объекта из общих объявлений — доли (0.25 клиента), а не целые люди.
      { shares: true }
    );
  } catch (err) {
    void logSystemError("ads", `Клиенты объекта по рекламе не посчитаны: ${describeError(err)}`, {
      dedupKey: "ads-property-lead-attribution",
    });
  }

  res.json({
    ...base,
    spendTjs: fromCents(spendCents),
    impressions,
    clicks,
    conversations,
    firstSpendAt: dates[0] ?? null,
    lastSpendAt: lastSpendOf(all),
    leadStats,
    // Общие объявления вперёд (больше объектов — важнее), затем по деньгам; предел списка — 50.
    adsOfProperty: adsOfProperty
      .sort((a, b) => b.objectsInAd - a.objectsInAd || b.spendTjs - a.spendTjs)
      .slice(0, 50),
  });
});

/**
 * ИИ-разбор рекламы: куда уходят деньги, что окупается, что жжёт бюджет и что
 * делать. Кэш на сутки; force=1 — пересобрать сейчас (кнопка «Обновить разбор»).
 */
adsRouter.get("/insights", requireAdsRead, async (req, res) => {
  const parsed = monthSchema.safeParse(req.query.month);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверный месяц", details: parsed.error.flatten() });
  }
  const month = parsed.data ?? currentMonth();
  const result = await buildAdInsights(month, req.query.force === "1");
  // reason отличает «разбирать нечего» от «модель не ответила» — экран пишет
  // разное, и второе не должно выглядеть как отсутствие расходов.
  res.json(result ?? { text: null, reason: "empty" });
});

/**
 * ПОДКЛЮЧЕНИЕ КАБИНЕТА КНОПКОЙ — вместо переноса маркера руками.
 *
 * Адрес выдаётся только авторизованному сотруднику с правом вести финансы, вместе с
 * одноразовым `state`; сам обмен происходит в /callback, куда Facebook вернёт человека.
 */
adsRouter.post("/connect", requireAdsWrite, async (req, res) => {
  try {
    const url = await buildConnectUrl(req.agent!.id);
    logAudit(req, "CONNECT_START", "Ad", "meta-ads", {});
    res.json({ url });
  } catch (err) {
    const message = err instanceof MetaAdsConnectError ? err.message : "Не удалось начать подключение";
    res.status(400).json({ error: message });
  }
});

/**
 * ОТВЯЗАТЬ КАБИНЕТ — из самой CRM, без похода в Facebook.
 *
 * Стирает маркер и выключает синхронизацию; номера кабинетов и уже собранная
 * статистика остаются. Это сознательно: «отключить» для человека значит «пусть
 * перестанет ходить в кабинет», а не «сотри мне историю расходов за полгода».
 * Захочет вернуть — снова нажмёт «Подключить», данные продолжатся с того же места.
 */
adsRouter.post("/disconnect", requireAdsWrite, async (req, res) => {
  await prisma.settings.updateMany({
    where: { id: "singleton" },
    data: { metaAdsToken: null, metaAdsTokenRefreshedAt: null, metaAdsEnabled: false },
  });
  logAudit(req, "DISCONNECT", "Ad", "meta-ads", {});
  res.json({ ok: true });
});

/**
 * ВОЗВРАТ ИЗ FACEBOOK. Отдельный роутер, потому что монтируется ДО requireAuth:
 * сюда человека приводит сам Facebook обычным переходом по ссылке, а маркер доступа
 * CRM живёт в памяти вкладки и в таком переходе не участвует. Подлинность запроса
 * подтверждает одноразовый `state`, выданный при нажатии кнопки.
 */
export const adsCallbackRouter = Router();

adsCallbackRouter.get("/", async (req, res) => {
  const base = crmPublicBase() ?? "";
  const back = (params: Record<string, string>) =>
    `${base}/settings?tab=channels&${new URLSearchParams(params).toString()}`;

  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;

  // Человек нажал «Отмена» в окне Facebook — это не ошибка, просто передумал.
  if (!code || !state) {
    const denied = typeof req.query.error === "string" ? req.query.error : "cancelled";
    return res.redirect(back({ ads: "cancelled", reason: denied }));
  }

  try {
    await completeConnect(code, state);
    res.redirect(back({ ads: "connected" }));
  } catch (err) {
    const message = err instanceof MetaAdsConnectError ? err.message : "Не удалось подключить кабинет";
    res.redirect(back({ ads: "error", message }));
  }
});


/** Публикация и кандидаты для экрана привязки. Лента и объекты читаются по одному
 *  разу на страницу, а не на каждое объявление. */
async function enrichUnmatched(
  ads: {
    id: string;
    platform: string;
    name: string;
    campaignName: string | null;
    postUrl: string | null;
    postShortcode: string | null;
    mediaId: string | null;
    thumbnailUrl: string | null;
    caption: string | null;
    lastSyncedAt: Date;
    spend: { spend: unknown; currency: string; conversations: number; impressions: number }[];
  }[]
) {
  const [feed, properties] = await Promise.all([
    getAllOwnMedia().catch(() => null),
    prisma.property.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        shortId: true,
        title: true,
        address: true,
        price: true,
        currency: true,
        rooms: true,
        status: true,
        district: { select: { name: true } },
        photos: { select: { thumbUrl: true }, orderBy: { order: "asc" }, take: 1 },
      },
      orderBy: { createdAt: "desc" },
      take: 300,
    }),
  ]);

  const byCode = new Map<string, { caption?: string; permalink: string; thumbnailUrl?: string; mediaUrl?: string }>();
  const byMediaId = new Map<string, { caption?: string; permalink: string; thumbnailUrl?: string; mediaUrl?: string }>();
  for (const m of feed ?? []) {
    const code = m.permalink.match(/instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i)?.[1];
    const item = { caption: m.caption, permalink: m.permalink, thumbnailUrl: m.thumbnailUrl, mediaUrl: m.mediaUrl };
    if (code && !byCode.has(code)) byCode.set(code, item);
    if (m.id && !byMediaId.has(m.id)) byMediaId.set(m.id, item);
  }

  return ads.map((ad) => {
    const post = (ad.postShortcode ? byCode.get(ad.postShortcode) : null) ?? (ad.mediaId ? byMediaId.get(ad.mediaId) : null);
    // Текст берём из ленты, если публикация там нашлась, иначе — сохранённый при
    // сверке от самой Meta. Второе оказалось основным источником: в ленте не
    // нашлось ни одной рекламируемой публикации агентства (реклама идёт со
    // Страницы Facebook и с аккаунта, не подключённого к CRM).
    const caption = post?.caption ?? ad.caption ?? null;

    return {
      id: ad.id,
      platform: ad.platform,
      name: ad.name,
      campaignName: ad.campaignName,
      postUrl: ad.postUrl,
      lastSyncedAt: ad.lastSyncedAt,
      spendOriginal: fromCents(ad.spend.reduce((sum, s) => sum + toCents(s.spend), 0)),
      currency: ad.spend[0]?.currency ?? "USD",
      conversations: ad.spend.reduce((sum, s) => sum + s.conversations, 0),
      impressions: ad.spend.reduce((sum, s) => sum + s.impressions, 0),
      /** Превью: своё изображение из ленты предпочтительнее картинки Meta —
       *  оно крупнее и не протухает вместе со ссылкой рекламного крео. */
      previewUrl: post?.thumbnailUrl ?? post?.mediaUrl ?? ad.thumbnailUrl,
      caption,
      /** Публикация нашлась в нашей ленте — значит это точно наш пост. */
      isOurPost: !!post,
      candidates: caption ? suggestProperties(caption, properties) : [],
    };
  });
}

/**
 * Кандидаты-объекты по тексту публикации.
 *
 * Считаем совпадения по адресу, району, числу комнат и цене — тем словам, которые
 * агентство реально пишет в подписи. Это ПОДСКАЗКА, а не привязка: решение всегда
 * за человеком, поэтому ошибка подсказки стоит одного лишнего взгляда, а не
 * неверной цифры в отчёте.
 */
export function suggestProperties(
  caption: string,
  properties: {
    id: string;
    shortId: number;
    title: string;
    address: string | null;
    price: unknown;
    currency: string;
    rooms: number | null;
    status: string;
    district: { name: string } | null;
    photos: { thumbUrl: string }[];
  }[]
) {
  const text = caption.toLowerCase();

  const scored = properties.map((p) => {
    let score = 0;
    const address = (p.address ?? "").toLowerCase();
    // Улица из адреса: первое слово длиннее четырёх букв — «Рудаки», «Айни».
    const street = address.split(/[,\s]+/).find((w) => w.length > 4);
    if (street && text.includes(street)) score += 3;
    const district = p.district?.name.toLowerCase();
    if (district && text.includes(district)) score += 2;
    // Комнаты и цена — теми же проверками, что у привязки (adMatching.ts): число комнат и
    // цена ищутся как ОТДЕЛЬНЫЕ числа, а не как кусок склейки цифр или чужого числа.
    if (p.rooms && textHasRooms(text, p.rooms)) score += 2;
    const price = Math.round(Number(p.price));
    if (price > 0 && textHasPrice(text, price)) score += 3;
    // Номер объекта — только с «№»/«#» и границей справа: «131» внутри цены или телефона
    // номером не считается. `\b` по кириллице молчит, поэтому EW (ai/wordBoundary.ts).
    if (new RegExp(`[№#]\\s*${p.shortId}${EW}`, "u").test(text)) score += 4;
    return { p, score };
  });

  return scored
    .filter((s) => s.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((s) => ({
      id: s.p.id,
      shortId: s.p.shortId,
      title: s.p.title,
      address: s.p.address,
      status: s.p.status,
      coverUrl: s.p.photos[0]?.thumbUrl ?? null,
      score: s.score,
    }));
}
