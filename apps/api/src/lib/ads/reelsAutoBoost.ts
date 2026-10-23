import {
  REELS_AUTOBOOST_CTA_TYPES,
  REELS_AUTOBOOST_DEFAULTS,
  type ReelsAutoBoostCtaType,
  type ReelsAutoBoostSettings,
  type ReelsAutoBoostStatus,
} from "@royal-home/shared";
import { prisma } from "../../db.js";
import { describeError } from "../describeError.js";
import { logSystemAudit } from "../audit.js";
import { logSystemError } from "../systemError.js";
import { RAW_VIDEO_PUBLISHED_AT } from "../publishedRawVideoRetention.js";
import { loadMetaAdsCredentials, MetaAdsTokenError, MetaRateLimitError, type MetaAdsCredentials } from "./metaAdsApi.js";
import {
  decideReelsAutoBoost,
  type ReelFact,
  type ReelRecord,
  type ReelsAutoBoostAction,
} from "./reelsAutoBoostDecide.js";
import {
  createBoostAd,
  createBoostCreative,
  fetchAccountCurrency,
  fetchAdSetAdStats,
  fetchAdSetInfo,
  fetchBoostEligibility,
  fetchConnectedInstagramUserId,
  findAdByMediaId,
  setAdStatus,
} from "./reelsAutoBoostMeta.js";

/**
 * АВТОПРОДВИЖЕНИЕ РОЛИКОВ — исполнитель (крон раз в 30 минут, cron.ts).
 *
 * Решения принимает чистая функция decideReelsAutoBoost; здесь — собрать факты,
 * применить решения и записать результат в журнал ReelAutoBoostAd.
 *
 *  - выключено (reelsAutoBoostEnabled=false) — не делает НИЧЕГО, даже не читает факты;
 *  - пробный режим (dryRun, по умолчанию) — считает решения, пишет их в журнал
 *    (строки PLANNED/PAUSED + сводка в историю действий), в Meta не ходит вообще;
 *  - боевой режим — читает расход для стоп-лосса, создаёт креатив и объявление
 *    (ACTIVE) в группе объявлений постоянной кампании и ставит лишнее на паузу.
 *
 * Отказ Meta по одному ролику не валит остальные (строка FAILED, повтор через 6 часов,
 * до трёх попыток). Истёкший маркер и лимит запросов обрывают проход целиком: следующие
 * вызовы получат тот же отказ.
 */

const TICK_ACTIONS_IN_AUDIT = 30;
const FACT_LOOKBACK_EXTRA_DAYS = 1;
const FACT_QUERY_LIMIT = 300;
const DAY_MS = 86_400_000;
const REASON_MAX = 480;

export async function loadReelsAutoBoostSettings(): Promise<ReelsAutoBoostSettings> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      reelsAutoBoostEnabled: true,
      reelsAutoBoostDryRun: true,
      reelsAutoBoostAdSetId: true,
      reelsAutoBoostMaxActive: true,
      reelsAutoBoostMaxAgeDays: true,
      reelsAutoBoostStopLossSpendUsd: true,
      reelsAutoBoostCtaType: true,
    },
  });
  const cta = (REELS_AUTOBOOST_CTA_TYPES as readonly string[]).includes(s?.reelsAutoBoostCtaType ?? "")
    ? (s!.reelsAutoBoostCtaType as ReelsAutoBoostCtaType)
    : REELS_AUTOBOOST_DEFAULTS.ctaType;
  return {
    enabled: s?.reelsAutoBoostEnabled ?? REELS_AUTOBOOST_DEFAULTS.enabled,
    dryRun: s?.reelsAutoBoostDryRun ?? REELS_AUTOBOOST_DEFAULTS.dryRun,
    adSetId: s?.reelsAutoBoostAdSetId?.trim() || null,
    maxActive: s?.reelsAutoBoostMaxActive ?? REELS_AUTOBOOST_DEFAULTS.maxActive,
    maxAgeDays: s?.reelsAutoBoostMaxAgeDays ?? REELS_AUTOBOOST_DEFAULTS.maxAgeDays,
    stopLossSpendUsd: s ? Number(s.reelsAutoBoostStopLossSpendUsd) : REELS_AUTOBOOST_DEFAULTS.stopLossSpendUsd,
    ctaType: cta,
  };
}

/** Публикация Reels в Instagram из карточки объекта → факт для решения (null — ролика в Instagram нет). */
export function reelFactOf(p: {
  id: string;
  status: string;
  deletedAt: Date | null;
  offSite: boolean;
  publishedOnSite: boolean;
  publishedChannels: string[];
  publishedPostIds: unknown;
}): ReelFact | null {
  const ids = p.publishedPostIds;
  if (!ids || typeof ids !== "object" || Array.isArray(ids)) return null;
  const map = ids as Record<string, unknown>;
  const mediaId = map.INSTAGRAM;
  if (!p.publishedChannels.includes("INSTAGRAM") || typeof mediaId !== "string" || !mediaId) return null;
  const rawAt = map[RAW_VIDEO_PUBLISHED_AT];
  const at = typeof rawAt === "string" ? new Date(rawAt) : null;
  return {
    propertyId: p.id,
    mediaId,
    publishedAt: at && Number.isFinite(at.getTime()) ? at : null,
    status: p.status,
    deleted: p.deletedAt !== null,
    offSite: p.offSite,
    publishedOnSite: p.publishedOnSite,
  };
}

const FACT_SELECT = {
  id: true,
  shortId: true,
  title: true,
  status: true,
  deletedAt: true,
  offSite: true,
  publishedOnSite: true,
  publishedChannels: true,
  publishedPostIds: true,
} as const;

export interface ReelsAutoBoostTickResult {
  ran: boolean;
  dryRun: boolean;
  /** Почему не работало (выключено, нет настроек, отказ Meta). */
  note: string | null;
  created: number;
  paused: number;
  kept: number;
  failed: number;
}

const idle = (dryRun: boolean, note: string | null): ReelsAutoBoostTickResult => ({
  ran: false,
  dryRun,
  note,
  created: 0,
  paused: 0,
  kept: 0,
  failed: 0,
});

function trimReason(text: string): string {
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
}

/** Контекст боевого прохода: всё, что нужно знать о Meta, читается один раз за проход. */
interface LiveContext {
  creds: MetaAdsCredentials;
  adSetId: string;
  accountId: string;
  pageId: string;
  instagramUserId: string;
}

async function openLiveContext(settings: ReelsAutoBoostSettings): Promise<LiveContext | string> {
  if (!settings.adSetId) return "не указан номер группы объявлений постоянной кампании";
  const creds = await loadMetaAdsCredentials();
  if (!creds.token) return "не подключён маркер рекламы Meta (нужно право ads_management)";
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaPageId: true } });
  const pageId = s?.metaPageId?.trim() || process.env.META_PAGE_ID || "";
  if (!pageId) return "не указан номер Страницы Facebook (Настройки → Каналы)";
  const adSet = await fetchAdSetInfo(creds, settings.adSetId);
  const currency = await fetchAccountCurrency(creds, adSet.accountId);
  if (currency !== "USD") {
    return `кабинет ${adSet.accountId} в валюте ${currency ?? "неизвестной"}, а порог стоп-лосса задан в долларах — боевой режим не включаю`;
  }
  const instagramUserId = await fetchConnectedInstagramUserId(creds, adSet.accountId);
  if (!instagramUserId) return `к кабинету ${adSet.accountId} не подключён аккаунт Instagram`;
  return { creds, adSetId: settings.adSetId, accountId: adSet.accountId, pageId, instagramUserId };
}

type DbRecord = Awaited<ReturnType<typeof prisma.reelAutoBoostAd.findMany>>[number];

function toReelRecord(r: DbRecord): ReelRecord {
  return {
    propertyId: r.propertyId,
    mediaId: r.instagramMediaId,
    status: r.status as ReelsAutoBoostStatus,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    attempts: r.attempts,
    spendUsd: r.spendUsd === null ? null : Number(r.spendUsd),
    conversations: r.conversations,
  };
}

let tickRunning = false;

/**
 * Один проход с защитой от наложения (крон раз в 30 минут и кнопка «Проверить сейчас»
 * делят один флаг). null — предыдущий проход ещё идёт, этот пропущен.
 */
export async function runReelsAutoBoostGuarded(): Promise<ReelsAutoBoostTickResult | null> {
  if (tickRunning) return null;
  tickRunning = true;
  try {
    return await runReelsAutoBoostTick();
  } finally {
    tickRunning = false;
  }
}

export async function runReelsAutoBoostTick(now = new Date()): Promise<ReelsAutoBoostTickResult> {
  const settings = await loadReelsAutoBoostSettings();
  if (!settings.enabled) return idle(settings.dryRun, "выключено");
  const { dryRun } = settings;

  // Боевой режим: подготовить Meta ДО решений — расход для стоп-лосса нужен им на входе.
  let live: LiveContext | null = null;
  if (!dryRun) {
    try {
      const opened = await openLiveContext(settings);
      if (typeof opened === "string") {
        await logSystemError("ads", `Автопродвижение роликов: ${opened}`, {
          dedupKey: "reels-autoboost-setup",
          dedupWindowMs: DAY_MS,
        });
        return idle(dryRun, opened);
      }
      live = opened;
    } catch (err) {
      await logSystemError("ads", `Автопродвижение роликов: Meta недоступна — ${describeError(err)}`, {
        dedupKey: "reels-autoboost-setup",
        dedupWindowMs: DAY_MS,
      });
      return idle(dryRun, "Meta недоступна");
    }
  }

  const dbRecords = await prisma.reelAutoBoostAd.findMany();
  const byMedia = new Map(dbRecords.map((r) => [r.instagramMediaId, r]));

  // Расход и переписки активных объявлений — для стоп-лосса.
  if (live) {
    const active = dbRecords.filter((r) => r.status === "ACTIVE" && r.metaAdId);
    if (active.length > 0) {
      try {
        const stats = await fetchAdSetAdStats(live.creds, live.adSetId);
        for (const r of active) {
          const st = stats.get(r.metaAdId!) ?? { spend: 0, conversations: 0 };
          const updated = await prisma.reelAutoBoostAd.update({
            where: { id: r.id },
            data: { spendUsd: st.spend, conversations: st.conversations, lastCheckedAt: now },
          });
          byMedia.set(r.instagramMediaId, updated);
        }
      } catch (err) {
        // Без свежих цифр стоп-лосс не сработает — это не повод останавливать остальное.
        await logSystemError("ads", `Автопродвижение роликов: расход не прочитан — ${describeError(err)}`, {
          dedupKey: "reels-autoboost-stats",
          dedupWindowMs: DAY_MS,
        });
      }
    }
  }

  // Факты: молодые опубликованные объекты + объекты, по которым уже есть живые записи.
  const since = new Date(now.getTime() - (settings.maxAgeDays + FACT_LOOKBACK_EXTRA_DAYS) * DAY_MS);
  const trackedIds = dbRecords
    .filter((r) => r.status === "ACTIVE" || r.status === "PLANNED" || r.status === "FAILED")
    .map((r) => r.propertyId);
  const [young, tracked] = await Promise.all([
    prisma.property.findMany({
      where: {
        deletedAt: null,
        status: "AVAILABLE",
        offSite: false,
        publishedOnSite: true,
        publishedChannels: { has: "INSTAGRAM" },
        updatedAt: { gte: since },
      },
      select: FACT_SELECT,
      orderBy: { updatedAt: "desc" },
      take: FACT_QUERY_LIMIT,
    }),
    trackedIds.length > 0
      ? prisma.property.findMany({ where: { id: { in: trackedIds } }, select: FACT_SELECT })
      : Promise.resolve([]),
  ]);
  const props = new Map([...young, ...tracked].map((p) => [p.id, p]));
  const facts: ReelFact[] = [];
  for (const p of props.values()) {
    const f = reelFactOf(p);
    if (f) facts.push(f);
  }

  const actions = decideReelsAutoBoost(
    { facts, records: [...byMedia.values()].map(toReelRecord) },
    now,
    { dryRun, maxActive: settings.maxActive, maxAgeDays: settings.maxAgeDays, stopLossSpendUsd: settings.stopLossSpendUsd }
  );

  const result: ReelsAutoBoostTickResult = { ran: true, dryRun, note: null, created: 0, paused: 0, kept: 0, failed: 0 };
  const log: Array<{ kind: string; propertyId: string; mediaId: string; reason: string; ok: boolean }> = [];
  const keptMedia: string[] = [];
  let aborted = false;

  for (const action of actions) {
    if (action.kind === "keep") {
      result.kept++;
      keptMedia.push(action.mediaId);
      continue;
    }
    if (aborted) break;
    try {
      if (action.kind === "create") {
        const outcome = dryRun
          ? await planCreate(action, now)
          : await liveCreate(action, live!, settings, byMedia.get(action.mediaId) ?? null, props.get(action.propertyId)?.shortId ?? null, now);
        if (outcome === "created") result.created++;
        else if (outcome === "failed") result.failed++;
        log.push({ ...action, ok: outcome !== "failed" });
      } else {
        await applyPause(action, live, byMedia.get(action.mediaId) ?? null, now);
        result.paused++;
        log.push({ ...action, ok: true });
      }
    } catch (err) {
      result.failed++;
      log.push({ ...action, ok: false });
      await logSystemError("ads", `Автопродвижение роликов: ${action.kind} ${action.mediaId} — ${describeError(err)}`, {
        dedupKey: `reels-autoboost-${action.kind}`,
        dedupWindowMs: 6 * 60 * 60 * 1000,
      });
      if (err instanceof MetaAdsTokenError || err instanceof MetaRateLimitError) aborted = true;
    }
  }

  if (keptMedia.length > 0) {
    await prisma.reelAutoBoostAd
      .updateMany({ where: { instagramMediaId: { in: keptMedia } }, data: { lastCheckedAt: now } })
      .catch(() => null);
  }

  if (log.length > 0) {
    logSystemAudit("REELS_AUTOBOOST_TICK", "Settings", "singleton", {
      dryRun,
      created: result.created,
      paused: result.paused,
      kept: result.kept,
      failed: result.failed,
      decisions: log.slice(0, TICK_ACTIONS_IN_AUDIT),
    });
  }
  return result;
}

/** Пробный режим: записать «создал бы». В Meta не ходит. */
async function planCreate(action: ReelsAutoBoostAction, now: Date): Promise<"created"> {
  await prisma.reelAutoBoostAd.upsert({
    where: { instagramMediaId: action.mediaId },
    create: {
      propertyId: action.propertyId,
      instagramMediaId: action.mediaId,
      status: "PLANNED",
      reason: trimReason(`[пробный режим] создал бы объявление: ${action.reason}`),
      lastCheckedAt: now,
    },
    update: { status: "PLANNED", reason: trimReason(`[пробный режим] создал бы объявление: ${action.reason}`), lastCheckedAt: now },
  });
  return "created";
}

/** Боевой режим: проверить пригодность, создать креатив и объявление. */
async function liveCreate(
  action: ReelsAutoBoostAction,
  ctx: LiveContext,
  settings: ReelsAutoBoostSettings,
  existing: DbRecord | null,
  shortId: number | null,
  now: Date
): Promise<"created" | "failed" | "skipped"> {
  // Строка появляется ДО обращения к Meta, а попытка считается сразу: обрыв посреди вызова
  // не должен дать ни бесконечных повторов, ни второго объявления (см. findAdByMediaId).
  const row = await prisma.reelAutoBoostAd.upsert({
    where: { instagramMediaId: action.mediaId },
    create: { propertyId: action.propertyId, instagramMediaId: action.mediaId, status: "PLANNED", reason: trimReason(action.reason), attempts: 1 },
    update: { attempts: { increment: 1 }, reason: trimReason(action.reason) },
  });
  const failWith = async (why: string) => {
    await prisma.reelAutoBoostAd.update({
      where: { id: row.id },
      data: { status: "FAILED", reason: trimReason(`Meta отказала: ${why}`), lastCheckedAt: now },
    });
    await logSystemError("ads", `Автопродвижение роликов: объявление для ${action.mediaId} не создано — ${why}`, {
      dedupKey: "reels-autoboost-create",
      dedupWindowMs: 6 * 60 * 60 * 1000,
    });
    return "failed" as const;
  };

  const eligibility = await fetchBoostEligibility(ctx.creds, action.mediaId);
  if (eligibility.eligible === false) {
    await prisma.reelAutoBoostAd.update({
      where: { id: row.id },
      data: {
        status: "SKIPPED",
        reason: trimReason(`Meta не разрешает продвигать эту публикацию${eligibility.reason ? `: ${eligibility.reason}` : ""}`),
        lastCheckedAt: now,
      },
    });
    return "skipped";
  }

  try {
    let adId: string | null = null;
    if (row.attempts > 1) adId = await findAdByMediaId(ctx.creds, ctx.adSetId, action.mediaId);
    let creativeId = existing?.metaCreativeId ?? row.metaCreativeId;
    if (!adId) {
      if (!creativeId) {
        creativeId = await createBoostCreative(ctx.creds, {
          accountId: ctx.accountId,
          pageId: ctx.pageId,
          instagramUserId: ctx.instagramUserId,
          mediaId: action.mediaId,
          cta: settings.ctaType,
          name: `Reels ${shortId ?? action.propertyId} ${action.mediaId}`,
        });
        await prisma.reelAutoBoostAd.update({ where: { id: row.id }, data: { metaCreativeId: creativeId } });
      }
      adId = await createBoostAd(ctx.creds, {
        accountId: ctx.accountId,
        adSetId: ctx.adSetId,
        creativeId,
        name: `Reels ${shortId ?? action.propertyId} ${action.mediaId}`,
        status: "ACTIVE",
      });
    }
    await prisma.reelAutoBoostAd.update({
      where: { id: row.id },
      data: { status: "ACTIVE", metaAdId: adId, metaCreativeId: creativeId, reason: trimReason(`продвигается: ${action.reason}`), lastCheckedAt: now },
    });
    return "created";
  } catch (err) {
    if (err instanceof MetaAdsTokenError || err instanceof MetaRateLimitError) {
      await prisma.reelAutoBoostAd.update({ where: { id: row.id }, data: { attempts: { decrement: 1 } } }).catch(() => null);
      throw err;
    }
    return failWith(describeError(err));
  }
}

/** Пауза: в Meta (если объявление было) и в журнале. Пробный режим не трогает живые объявления. */
async function applyPause(action: ReelsAutoBoostAction, live: LiveContext | null, rec: DbRecord | null, now: Date): Promise<void> {
  if (!rec) return;
  if (!live) {
    // Пробный режим. Планируемое снимаем; настоящее (ACTIVE от боевого прошлого) не трогаем —
    // только отмечаем, что поставили бы на паузу.
    if (rec.status === "PLANNED") {
      await prisma.reelAutoBoostAd.update({
        where: { id: rec.id },
        data: { status: "PAUSED", reason: trimReason(`[пробный режим] ${action.reason}`), lastCheckedAt: now },
      });
    } else {
      await prisma.reelAutoBoostAd.update({
        where: { id: rec.id },
        data: { reason: trimReason(`[пробный режим] поставил бы на паузу: ${action.reason}`), lastCheckedAt: now },
      });
    }
    return;
  }
  if (rec.metaAdId) await setAdStatus(live.creds, rec.metaAdId, "PAUSED");
  await prisma.reelAutoBoostAd.update({
    where: { id: rec.id },
    data: { status: "PAUSED", reason: trimReason(`пауза: ${action.reason}`), lastCheckedAt: now },
  });
}
