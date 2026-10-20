import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { DUSHANBE_OFFSET_MS } from "./dushanbeTime.js";

/**
 * СТАТИСТИКА САЙТА ROYALHOME.TJ В CRM (24.09.2026, Dan: «забыли добавить к
 * тепловой карте статистику с нашего собственного сайта»).
 *
 * Сайт — отдельное приложение со своей базой (репозиторий royal-home-website).
 * Сам он хранит только открытия страниц и, с правки сайта #30, нажатия на
 * странице объекта (WhatsApp, «поделиться», «в избранное»). Всё остальное —
 * источники, устройства, карта кликов — живёт только в Яндекс Метрике, и сюда
 * не приходит.
 *
 * Раз в час CRM забирает `GET {SITE_SYNC_URL}/stats?since&until` тем же ключом,
 * что и отправка объектов на сайт (lib/siteSync.ts), и перезаписывает:
 *  - `SiteVisitHour` — посещаемость по часам (срез «Посетители сайта» на карте);
 *  - `SitePropertyDay` — объект по дням (вкладка «Статистика» в карточке).
 * Сайт отдаёт ИТОГ за час или день, а не прибавку, поэтому повторный сбор того
 * же часа безопасен: число перезаписывается, а не удваивается.
 */

/** Читаются при вызове, а не при загрузке модуля: тест подставляет свои. */
const siteUrl = () => process.env.SITE_SYNC_URL;
const siteKey = () => process.env.SITE_SYNC_API_KEY;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Обычный сбор — двое суток назад: час, который сайт досчитывал в момент
 *  прошлого сбора, и день, который ещё не закончился, перезаписываются. */
export const SITE_STATS_REGULAR_HOURS = 48;
/** Первый сбор (таблица пуста) — месяц: сайт отдаёт не больше 32 дней за раз. */
export const SITE_STATS_BACKFILL_DAYS = 30;

const TIMEOUT_MS = 15_000;

/** Ответ сайта — внешний ввод, проверяется схемой до использования. */
const count = z.number().int().nonnegative();
export const siteStatsResponseSchema = z.object({
  hours: z.array(z.object({ hourStart: z.string().datetime({ offset: true }), views: count, visitors: count })).max(2000),
  listings: z
    .array(
      z.object({
        listingId: z.number().int().positive(),
        externalId: z.string().max(100).nullable(),
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        views: count,
        visitors: count,
        phone: count,
        whatsapp: count,
        telegram: count,
        share: count,
        favorite: count,
      })
    )
    .max(50_000),
});
export type SiteStatsResponse = z.infer<typeof siteStatsResponseSchema>;

/** «2026-09-24» по Душанбе → полночь этого дня по Душанбе, выраженная в UTC. */
export function dushanbeDayKeyToDate(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - DUSHANBE_OFFSET_MS);
}

export function siteStatsConfigured(): boolean {
  return Boolean(siteUrl() && siteKey());
}

export type SiteStatsResult =
  | { ok: true; hours: number; days: number; unmatched: number }
  | { ok: false; error: string; notConfigured?: true; siteNotDeployed?: true };

/** Окно сбора: месяц, если ещё ничего не собрано, иначе двое суток. */
export async function siteStatsWindow(now: Date = new Date()): Promise<{ since: Date; until: Date }> {
  const until = new Date(Math.ceil(now.getTime() / HOUR_MS) * HOUR_MS);
  const any = await prisma.siteVisitHour.findFirst({ select: { hourStart: true } });
  const back = any ? SITE_STATS_REGULAR_HOURS * HOUR_MS : SITE_STATS_BACKFILL_DAYS * DAY_MS;
  return { since: new Date(until.getTime() - back), until };
}

/** Сайт отвечает 404 — там ещё нет правки #30. Не поломка CRM, а ожидание выката
 *  сайта: крон напоминает раз в сутки, а не каждый час (25.09.2026). */
class SiteStatsNotDeployedError extends Error {}

async function fetchSiteStats(since: Date, until: Date): Promise<SiteStatsResponse> {
  const url = `${siteUrl()}/stats?since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(until.toISOString())}`;
  const res = await fetch(url, {
    headers: { "X-Api-Key": siteKey() ?? "" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) {
    // Сайт ещё без правки #30 (royal-home-website): выдачи статистики там нет.
    throw new SiteStatsNotDeployedError("на сайте ещё не выкачена выдача статистики (правка сайта #30)");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ? `сайт ответил ${res.status}: ${body.error}` : `сайт ответил ${res.status}`);
  }
  const parsed = siteStatsResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error(`сайт прислал статистику не того вида: ${parsed.error.issues[0]?.message ?? "?"}`);
  return parsed.data;
}

/**
 * Разложить ответ сайта по таблицам. Отдельно от сети — ради теста.
 * Объект сайта сопоставляется с CRM так же, как при отправке объектов:
 * `externalId` — это id объекта CRM (объект создан в CRM), иначе CRM знает
 * номер объекта сайта в `siteListingId` (объект создан на сайте).
 */
export async function storeSiteStats(data: SiteStatsResponse): Promise<{ hours: number; days: number; unmatched: number }> {
  const externalIds = [...new Set(data.listings.map((l) => l.externalId).filter((x): x is string => !!x))];
  const listingIds = [...new Set(data.listings.map((l) => l.listingId))];
  const [byExternal, bySiteId] = await Promise.all([
    externalIds.length
      ? prisma.property.findMany({ where: { id: { in: externalIds } }, select: { id: true } })
      : Promise.resolve([]),
    listingIds.length
      ? prisma.property.findMany({ where: { siteListingId: { in: listingIds } }, select: { id: true, siteListingId: true } })
      : Promise.resolve([]),
  ]);
  const known = new Set(byExternal.map((p) => p.id));
  const siteToCrm = new Map(bySiteId.map((p) => [p.siteListingId as number, p.id]));

  // Один объект CRM может прийти двумя строками одного дня (старая страница по
  // номеру сайта и новая по externalId) — складываем, иначе вторая затрёт первую.
  type Row = { views: number; visitors: number; phone: number; whatsapp: number; telegram: number; share: number; favorite: number };
  const rows = new Map<string, { propertyId: string; day: Date } & Row>();
  let unmatched = 0;
  for (const l of data.listings) {
    const propertyId = l.externalId && known.has(l.externalId) ? l.externalId : siteToCrm.get(l.listingId);
    if (!propertyId) {
      unmatched++;
      continue;
    }
    const key = `${propertyId}|${l.day}`;
    const prev = rows.get(key);
    if (prev) {
      prev.views += l.views;
      prev.visitors += l.visitors;
      prev.phone += l.phone;
      prev.whatsapp += l.whatsapp;
      prev.telegram += l.telegram;
      prev.share += l.share;
      prev.favorite += l.favorite;
    } else {
      rows.set(key, { ...l, propertyId, day: dushanbeDayKeyToDate(l.day) });
    }
  }

  const ops: Prisma.PrismaPromise<number>[] = [];
  if (data.hours.length) {
    const values = data.hours.map((h) => Prisma.sql`(${new Date(h.hourStart)}, ${h.views}, ${h.visitors}, NOW())`);
    ops.push(prisma.$executeRaw`
      INSERT INTO "SiteVisitHour" ("hourStart", "views", "visitors", "fetchedAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("hourStart") DO UPDATE SET
        "views" = EXCLUDED."views", "visitors" = EXCLUDED."visitors", "fetchedAt" = NOW()
    `);
  }
  const dayRows = [...rows.values()];
  // Кусками: у Postgres предел параметров на запрос, а месяц объектов — тысячи строк.
  for (let i = 0; i < dayRows.length; i += 1000) {
    const values = dayRows
      .slice(i, i + 1000)
      .map(
        (r) =>
          Prisma.sql`(${r.propertyId}, ${r.day}, ${r.views}, ${r.visitors}, ${r.phone}, ${r.whatsapp}, ${r.telegram}, ${r.share}, ${r.favorite}, NOW())`
      );
    ops.push(prisma.$executeRaw`
      INSERT INTO "SitePropertyDay" ("propertyId", "day", "views", "visitors", "phoneClicks", "whatsappClicks", "telegramClicks", "shareClicks", "favoriteClicks", "fetchedAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("propertyId", "day") DO UPDATE SET
        "views" = EXCLUDED."views", "visitors" = EXCLUDED."visitors",
        "phoneClicks" = EXCLUDED."phoneClicks", "whatsappClicks" = EXCLUDED."whatsappClicks",
        "telegramClicks" = EXCLUDED."telegramClicks", "shareClicks" = EXCLUDED."shareClicks",
        "favoriteClicks" = EXCLUDED."favoriteClicks", "fetchedAt" = NOW()
    `);
  }
  // Одной транзакцией: половина часов без половины дней — хуже, чем ничего.
  if (ops.length) await prisma.$transaction(ops);
  return { hours: data.hours.length, days: dayRows.length, unmatched };
}

/** Сбор раз в час (крон `site-stats`). Не бросает — отказ возвращает текстом. */
export async function collectSiteStats(now: Date = new Date()): Promise<SiteStatsResult> {
  if (!siteStatsConfigured()) {
    return { ok: false, error: "Связь с сайтом не настроена (SITE_SYNC_URL/SITE_SYNC_API_KEY)", notConfigured: true };
  }
  try {
    const { since, until } = await siteStatsWindow(now);
    const data = await fetchSiteStats(since, until);
    return { ok: true, ...(await storeSiteStats(data)) };
  } catch (err) {
    if (err instanceof SiteStatsNotDeployedError) return { ok: false, error: err.message, siteNotDeployed: true };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
