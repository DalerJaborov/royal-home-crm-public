import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { loadPublishScheduleRules } from "./publishScheduleRules.js";
import { nextPublishSlot } from "./publishSchedule.js";
import { loadOccupiedPublishSlots } from "./publishSlots.js";
import { PUBLISH_SLOT_LOCK_ID } from "./videoHandoff.js";
import { enqueueBackgroundJob } from "../jobs/enqueue.js";
import {
  PHOTO_POST_CHANNELS,
  type PhotoPostChannel,
  type PhotoPostPublishResult,
  preparePhotoPostImages,
  photoPostCaption,
  publishInstagramCarousel,
  publishFacebookPhotoPost,
  publishTelegramPhotoPost,
} from "./photoPosts.js";
import { buildPriceDisplay, type CaptionAgent } from "./reelsCaptionTemplate.js";
import { loadMoneyContext, toTjs } from "./money.js";
import { loadCredentials, instagramTokenIdentity, GRAPH_VERSION } from "../messengers/meta.js";
import { readJson, graphErrorMessage, deleteInstagramMedia, PUBLISH_TIMEOUT_MS } from "./socialPublish.js";
import { sendMediaGroupFiles, deleteChannelMessage, isTelegramEnabled } from "../telegram/api.js";
import { decryptSecretSafe } from "../crypto.js";

/**
 * ПОВТОРНЫЕ ПОКАЗЫ ОБЪЕКТА (28.09.2026, agent-brief.md reposts-digests,
 * решение владельца 26.09.2026) — объект живёт месяцами, а показывается один
 * раз в день загрузки. Через `Settings.repostAfterDays` дней после последней
 * публикации AVAILABLE-объект получает новый круг публикации теми же фото
 * (lib/photoPosts.ts::preparePhotoPostImages), с новым текстом-«крючком», до
 * `Settings.repostMaxRounds` раз.
 *
 * ГРАНИЦА С PropertyPhotoPost/videoHandoff (правило владельца: не ломать
 * существующую логику): своя таблица (PropertySocialRepost), три канала
 * публикуются теми же функциями, что фото-посты (publishInstagramCarousel/
 * publishFacebookPhotoPost/publishTelegramPhotoPost из lib/photoPosts.ts) —
 * повторная реализация протокола Graph/Telegram здесь не заводится. Ни
 * Property.publishedChannels/publishedPostIds/instagramUrl, ни PropertyPhotoPost
 * этот модуль не трогает.
 */

export const SOCIAL_REPOST_CHANNELS = PHOTO_POST_CHANNELS;

// ---------------------------------------------------------------------------
// 1. Крючок и подпись
// ---------------------------------------------------------------------------

/** Информация о снижении цены с прошлого показа — уже отформатированные строки
 *  (buildPriceDisplay), чтобы repostHook оставалась чистой синхронной функцией. */
export interface RepostPriceDrop {
  fromDisplay: string;
  toDisplay: string;
}

/** По кругу, без снижения цены — индекс `(round - 1) % length`, round считается с 1. */
const ROUND_HOOKS = [
  "Всё ещё в продаже, успейте посмотреть",
  "Напоминаем: этот объект ждёт хозяина",
  "Показ на этой неделе, звоните",
];

/**
 * Первая строка подписи повтора. `priceDropped` — не просто флаг (владелец не
 * называл конкретный интерфейс, только смысл «крючок при снижении цены»): без
 * старой/новой цены строку «было X, стало Y» не собрать, поэтому решение по
 * умолчанию — принимать уже готовые отображаемые значения (см. detectPriceDrop
 * ниже), а не пересчитывать курс внутри чистой функции.
 */
export function repostHook(round: number, priceDropped: RepostPriceDrop | null): string {
  if (priceDropped) {
    return `🔻 Цена снижена: было ${priceDropped.fromDisplay}, стало ${priceDropped.toDisplay}`;
  }
  const idx = Math.max(0, round - 1) % ROUND_HOOKS.length;
  return ROUND_HOOKS[idx];
}

/**
 * Подпись = крючок + подпись фото-поста без ПЕРВОЙ строки (у каждого шаблона
 * DEFAULT_REELS_CAPTION_TEMPLATES первая строка — свой «крючок»-открывашка
 * («🔥 {{type}} в районе {{district}} — то, что вы искали!») — два открывашки
 * подряд читались бы нелепо). РЕШЕНИЕ ПО УМОЛЧАНИЮ (описано в задании как
 * «или целиком, если шаблон короткий»): подпись короче трёх строк (обычно —
 * ручной Property.reelsCaption в одну-две строки) оставляем целиком, срезать
 * из неё первую строку значило бы срезать всю суть.
 */
export async function repostCaption(
  property: Parameters<typeof photoPostCaption>[0],
  agent: CaptionAgent | null,
  hook: string
): Promise<string> {
  const base = await photoPostCaption(property, agent);
  const lines = base.split("\n");
  const body = lines.length > 2 ? lines.slice(1).join("\n") : base;
  return `${hook}\n\n${body}`;
}

// ---------------------------------------------------------------------------
// 2. Снижение цены и момент последнего показа
// ---------------------------------------------------------------------------

/**
 * Последний раз, когда объект реально показывался в соцсетях — максимум из
 * трёх источников (задание §2, «смотри что есть»): PropertyPhotoPost.publishedAt
 * и PropertySocialRepost.publishedAt существуют как поля буквально, а
 * отдельного Property.publishedAt в схеме НЕТ (только videoHandoffReceivedAt —
 * момент приёма СЫРОГО видео от агента, не публикации). Момент, когда ролик
 * РЕАЛЬНО вышел, в базе — запись AuditLog{action:"PROPERTY_EDITING_DONE"}, тот
 * же источник, которым уже пользуется GET /marketing/recently-published
 * (routes/marketing.ts) для показа «вышел в продажу». Ничего не публиковалось
 * ни разу — null, объект ещё не кандидат на повтор.
 */
export async function lastSocialShowAt(propertyId: string): Promise<Date | null> {
  const [photoMax, repostMax, editingDone] = await Promise.all([
    prisma.propertyPhotoPost.aggregate({ where: { propertyId, status: "PUBLISHED" }, _max: { publishedAt: true } }),
    prisma.propertySocialRepost.aggregate({ where: { propertyId, status: "PUBLISHED" }, _max: { publishedAt: true } }),
    prisma.auditLog.findFirst({
      where: { entityType: "Property", entityId: propertyId, action: "PROPERTY_EDITING_DONE" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  const dates = [photoMax._max.publishedAt, repostMax._max.publishedAt, editingDone?.createdAt].filter(
    (d): d is Date => d != null
  );
  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map((d) => d.getTime())));
}

/**
 * Цена упала СТРОГО после `since` — сравниваем в сомони (toTjs), потому что
 * объект мог сменить валюту между показами (та же оговорка, что у
 * lib/reelsCaptionTemplate.ts::buildPriceDisplay). Берётся САМОЕ РАННЕЕ
 * изменение после `since`: «было» — цена на момент прошлого показа, «стало» —
 * текущая, вся история между ними для крючка не нужна.
 */
async function detectPriceDrop(
  propertyId: string,
  since: Date | null,
  property: { price: number | string | { toString(): string }; currency: string }
): Promise<RepostPriceDrop | null> {
  if (!since) return null;
  const change = await prisma.priceChange.findFirst({
    where: { propertyId, createdAt: { gt: since } },
    orderBy: { createdAt: "asc" },
  });
  if (!change) return null;
  const money = await loadMoneyContext();
  const oldTjs = change.oldCurrency === "USD" ? toTjs(Number(change.oldPrice.toString()), "USD", money) : Number(change.oldPrice.toString());
  const newTjs = property.currency === "USD" ? toTjs(Number(property.price.toString()), "USD", money) : Number(property.price.toString());
  if (!(newTjs < oldTjs)) return null;
  return {
    fromDisplay: buildPriceDisplay(change.oldPrice, change.oldCurrency, money),
    toDisplay: buildPriceDisplay(property.price, property.currency, money),
  };
}

// ---------------------------------------------------------------------------
// 3. Публикация круга
// ---------------------------------------------------------------------------

export interface RepostSummary {
  ok: boolean;
  results: Partial<Record<PhotoPostChannel, PhotoPostPublishResult>>;
  reason?: string;
}

async function upsertRepostRecord(
  propertyId: string,
  round: number,
  channel: PhotoPostChannel,
  hook: string,
  existingId: string | undefined,
  data: {
    status: "PUBLISHED" | "FAILED";
    publishedAt?: Date;
    mediaId?: string | null;
    secondaryId?: string | null;
    permalink?: string | null;
    error?: string | null;
  }
): Promise<void> {
  if (existingId) {
    await prisma.propertySocialRepost.update({ where: { id: existingId }, data });
  } else {
    await prisma.propertySocialRepost.create({ data: { propertyId, round, channel, hook, ...data } });
  }
}

/**
 * ПУБЛИКАЦИЯ КРУГА ПОВТОРА. Гейт `Settings.repostsEnabled` (force обходит
 * только его — тот же приём, что у publishPropertyPhotoPost). Три канала —
 * TELEGRAM И FACEBOOK ВСЕГДА, INSTAGRAM ТОЖЕ (задание §2: карусель того же
 * объекта Instagram допускает публиковать снова; если Meta ответит «дубликат»
 * — ошибка в error, канал FAILED, остальные каналы это не останавливает,
 * ровно как у publishPropertyPhotoPost).
 */
export async function publishPropertyRepost(propertyId: string, round: number, options?: { force?: boolean }): Promise<RepostSummary> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { repostsEnabled: true, repostMaxRounds: true, telegramChannelId: true },
  });
  if (!options?.force && !settings?.repostsEnabled) {
    return { ok: false, results: {}, reason: "Повторные показы выключены в Настройках" };
  }
  if (settings && round > settings.repostMaxRounds) {
    return { ok: false, results: {}, reason: `Круг ${round} превышает лимит повторов (${settings.repostMaxRounds})` };
  }

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: {
      district: true,
      photos: { orderBy: { order: "asc" } },
      intakeAgent: { select: { fullName: true, phone: true } },
      assignedAgent: { select: { fullName: true, phone: true } },
      createdBy: { select: { fullName: true, phone: true } },
      socialReposts: { where: { round } },
    },
  });
  if (!property || property.deletedAt) {
    return { ok: false, results: {}, reason: "Объект не найден или удалён" };
  }
  if (property.status !== "AVAILABLE" || property.offSite) {
    return { ok: false, results: {}, reason: "Объект не в продаже (или закрытый) — повтор не нужен" };
  }

  const already = new Set<PhotoPostChannel>(property.socialReposts.filter((r) => r.status === "PUBLISHED").map((r) => r.channel as PhotoPostChannel));
  const toPublish = PHOTO_POST_CHANNELS.filter((c) => !already.has(c));
  if (toPublish.length === 0) {
    return { ok: true, results: {} };
  }

  const prepared = await preparePhotoPostImages(propertyId);
  if (!prepared || prepared.paths.length === 0) {
    return { ok: false, results: {}, reason: "У объекта нет ни одной подходящей фотографии" };
  }

  const lastShown = await lastSocialShowAt(propertyId);
  const priceDrop = await detectPriceDrop(propertyId, lastShown, property);
  const hook = repostHook(round, priceDrop);
  const captionAgent = property.intakeAgent ?? property.assignedAgent ?? property.createdBy ?? null;
  const caption = await repostCaption(property, captionAgent, hook);
  const creds = await loadCredentials();
  const results: RepostSummary["results"] = {};

  // Та же логика переиспользования записи, что у publishPropertyPhotoPost —
  // SCHEDULED/FAILED того же круга обновляются на месте, PUBLISHED сюда не
  // попадает (already выше), REMOVED — снятый круг, ему на смену новая строка.
  const reusableByChannel = new Map(
    [...property.socialReposts]
      .filter((r) => r.status === "SCHEDULED" || r.status === "FAILED")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => [r.channel, r.id] as const)
  );

  if (toPublish.includes("INSTAGRAM")) {
    let r: PhotoPostPublishResult;
    if (!creds.igToken) {
      r = { ok: false, error: "Instagram не подключён в Настройках" };
    } else if (prepared.urls.length === 0) {
      r = { ok: false, error: "Не настроен CRM_PUBLIC_URL — Meta неоткуда забрать фото" };
    } else {
      const identity = await instagramTokenIdentity(creds.igToken);
      r = identity.ok
        ? await publishInstagramCarousel(propertyId, identity.id, creds.igToken, prepared.urls, caption)
        : { ok: false, error: `Не удалось определить аккаунт Instagram: ${identity.error}` };
    }
    results.INSTAGRAM = r;
    await upsertRepostRecord(
      propertyId,
      round,
      "INSTAGRAM",
      hook,
      reusableByChannel.get("INSTAGRAM"),
      r.ok
        ? { status: "PUBLISHED", publishedAt: new Date(), mediaId: r.mediaId ?? null, permalink: r.permalink ?? null, error: null }
        : { status: "FAILED", error: r.error ?? "неизвестная ошибка" }
    );
    if (!r.ok && !r.pending) void logSystemError("meta", `Повтор в Instagram (объект ${propertyId}, круг ${round}) не удался: ${r.error}`, { dedupKey: "Повтор в Instagram не удался" });
  }

  if (toPublish.includes("FACEBOOK")) {
    let r: PhotoPostPublishResult;
    if (!creds.pageToken || !creds.pageId) {
      r = { ok: false, error: "Facebook не подключён в Настройках" };
    } else if (prepared.urls.length === 0) {
      r = { ok: false, error: "Не настроен CRM_PUBLIC_URL — Meta неоткуда забрать фото" };
    } else {
      r = await publishFacebookPhotoPost(creds.pageId, creds.pageToken, prepared.urls, caption);
    }
    results.FACEBOOK = r;
    await upsertRepostRecord(
      propertyId,
      round,
      "FACEBOOK",
      hook,
      reusableByChannel.get("FACEBOOK"),
      r.ok
        ? { status: "PUBLISHED", publishedAt: new Date(), mediaId: r.mediaId ?? null, permalink: r.permalink ?? null, error: null }
        : { status: "FAILED", error: r.error ?? "неизвестная ошибка" }
    );
    if (!r.ok) void logSystemError("meta", `Повтор в Facebook (объект ${propertyId}, круг ${round}) не удался: ${r.error}`, { dedupKey: "Повтор в Facebook не удался" });
  }

  if (toPublish.includes("TELEGRAM")) {
    const channelId = settings?.telegramChannelId?.trim();
    let r: PhotoPostPublishResult;
    if (!channelId || !isTelegramEnabled()) {
      r = { ok: false, error: "Канал Telegram не настроен" };
    } else {
      r = await publishTelegramPhotoPost(channelId, prepared.paths, caption);
    }
    results.TELEGRAM = r;
    await upsertRepostRecord(
      propertyId,
      round,
      "TELEGRAM",
      hook,
      reusableByChannel.get("TELEGRAM"),
      r.ok ? { status: "PUBLISHED", publishedAt: new Date(), secondaryId: r.secondaryId ?? null, error: null } : { status: "FAILED", error: r.error ?? "неизвестная ошибка" }
    );
    if (!r.ok) void logSystemError("telegram", `Повтор в Telegram (объект ${propertyId}, круг ${round}) не удался: ${r.error}`, { dedupKey: "Повтор в Telegram не удался" });
  }

  const ok = Object.values(results).some((r) => r?.ok);
  return { ok, results };
}

// ---------------------------------------------------------------------------
// 4. Снятие (объект ушёл из продажи)
// ---------------------------------------------------------------------------

/** Своя копия — тот же довод, что у instagramManageTokenForPhotoPosts в
 *  lib/photoPosts.ts: импорт оттуда завёл бы обратный цикл модулей. */
async function instagramManageTokenForReposts(): Promise<string | null> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaIgManageToken: true } });
  return decryptSecretSafe(settings?.metaIgManageToken ?? null);
}

/** Своя копия isPhotoPostTelegramMessageGone — та же причина. */
function isRepostTelegramMessageGone(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? "");
  return /message to delete not found/i.test(text);
}

export interface RepostRemovalResult {
  removed: number;
  failed: { round: number; channel: PhotoPostChannel; error: string }[];
  manual: { round: number; channel: PhotoPostChannel; reason: string }[];
}

/**
 * Снять ВСЕ опубликованные круги повтора объекта — вызывается рядом с
 * removePropertyPhotoPosts (crud.ts при продаже/снятии, videos.ts при кнопке
 * «Убрать из соцсетей»), тем же best-effort принципом: отказ одного канала не
 * мешает остальным.
 */
export async function removePropertySocialReposts(propertyId: string): Promise<RepostRemovalResult> {
  // Ждущие слоты следующего круга гасятся вместе с вышедшими (объект ушёл с продажи).
  await prisma.propertySocialRepost.updateMany({
    where: { propertyId, status: "SCHEDULED" },
    data: { status: "REMOVED", error: "объект ушёл с продажи до публикации" },
  });
  const posts = await prisma.propertySocialRepost.findMany({ where: { propertyId, status: "PUBLISHED" } });
  const removed: number[] = [];
  const failed: RepostRemovalResult["failed"] = [];
  const manual: RepostRemovalResult["manual"] = [];

  for (const post of posts) {
    const channel = post.channel as PhotoPostChannel;
    try {
      if (channel === "INSTAGRAM") {
        if (!post.mediaId) {
          manual.push({ round: post.round, channel, reason: "нет сохранённого id публикации — снимите в приложении" });
          await prisma.propertySocialRepost.update({ where: { id: post.id }, data: { status: "REMOVED", error: "снять руками — нет id" } });
          continue;
        }
        const token = await instagramManageTokenForReposts();
        if (!token) {
          manual.push({ round: post.round, channel, reason: "маркер удаления Instagram не настроен — снимите в приложении" });
          await prisma.propertySocialRepost.update({ where: { id: post.id }, data: { status: "REMOVED", error: "снять руками — нет маркера" } });
          continue;
        }
        const res = await deleteInstagramMedia(post.mediaId, token);
        if (res.ok) {
          removed.push(1);
          await prisma.propertySocialRepost.update({ where: { id: post.id }, data: { status: "REMOVED", error: null } });
        } else {
          failed.push({ round: post.round, channel, error: res.error ?? "неизвестная ошибка" });
        }
      } else if (channel === "FACEBOOK") {
        const creds = await loadCredentials();
        if (!post.mediaId || !creds.pageToken) {
          failed.push({ round: post.round, channel, error: !post.mediaId ? "в записи нет id поста Facebook" : "Facebook не подключён в Настройках" });
          continue;
        }
        const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${post.mediaId}?access_token=${encodeURIComponent(creds.pageToken)}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
        });
        const body = await readJson(res);
        if (res.ok || res.status === 404) {
          removed.push(1);
          await prisma.propertySocialRepost.update({ where: { id: post.id }, data: { status: "REMOVED", error: null } });
        } else {
          failed.push({ round: post.round, channel, error: graphErrorMessage(body, `HTTP ${res.status}`) });
        }
      } else if (channel === "TELEGRAM") {
        const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { telegramChannelId: true } });
        const channelId = settings?.telegramChannelId?.trim();
        if (!post.secondaryId || !channelId) {
          failed.push({ round: post.round, channel, error: !post.secondaryId ? "в записи нет id сообщений Telegram" : "канал Telegram не настроен" });
          continue;
        }
        const ids = post.secondaryId.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
        let ok = true;
        for (const id of ids) {
          try {
            await deleteChannelMessage(channelId, id);
          } catch (err) {
            if (!isRepostTelegramMessageGone(err)) {
              ok = false;
              failed.push({ round: post.round, channel, error: err instanceof Error ? err.message : String(err) });
              break;
            }
          }
        }
        if (ok) {
          removed.push(1);
          await prisma.propertySocialRepost.update({ where: { id: post.id }, data: { status: "REMOVED", error: null } });
        }
      }
    } catch (err) {
      failed.push({ round: post.round, channel, error: describeError(err) });
    }
  }

  return { removed: removed.length, failed, manual };
}

// ---------------------------------------------------------------------------
// 5. Расстановка кандидатов по времени (крон, раз в час)
// ---------------------------------------------------------------------------

export const SOCIAL_REPOST_PUBLISH_JOB_TYPE = "social-repost-publish";
export const SOCIAL_REPOST_PUBLISH_MAX_ATTEMPTS = 6;

export function socialRepostPublishDedupeKey(propertyId: string, round: number): string {
  return `social-repost-publish:${propertyId}:${round}`;
}

/** Через сколько объект, у которого круг повтора упал целиком, снова берётся в расстановку. */
const SOCIAL_REPOST_FAILED_RETRY_MS = 24 * 3_600_000;

/**
 * Закрыть строки SCHEDULED круга, который уже никто не опубликует (тот же класс,
 * что Ф5 аудита фона 02.10.2026 у фото-постов): публикация не запустилась вовсе
 * (объект сняли с продажи, пропали фото) или задание сдалось. Без этого объект
 * навсегда выпадал из кандидатов — их фильтр исключает SCHEDULED.
 */
export async function closeStuckScheduledReposts(propertyId: string, round: number, reason: string): Promise<number> {
  const res = await prisma.propertySocialRepost.updateMany({
    where: { propertyId, round, status: "SCHEDULED" },
    data: { status: "FAILED", error: reason.slice(0, 500) },
  });
  return res.count;
}

/**
 * Кандидаты: AVAILABLE, не закрытый (offSite), ≥1 фото, последний показ
 * (lastSocialShowAt) старше `repostAfterDays` дней, следующий круг не
 * превышает `repostMaxRounds`, нет уже SCHEDULED круга. Слот — тем же замком
 * и той же функцией, что у фото-постов и ролика (lib/publishSlots.ts::
 * loadOccupiedPublishSlots, PUBLISH_SLOT_LOCK_ID).
 */
export async function scheduleRepostsTick(): Promise<{ scheduled: number }> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { repostsEnabled: true, repostAfterDays: true, repostMaxRounds: true },
  });
  if (!settings?.repostsEnabled) return { scheduled: 0 };

  const cutoff = new Date(Date.now() - settings.repostAfterDays * 86_400_000);
  const candidates = await prisma.property.findMany({
    where: {
      deletedAt: null,
      status: "AVAILABLE",
      offSite: false,
      photos: { some: {} },
      socialReposts: { none: { status: "SCHEDULED" } },
      // Круг, упавший целиком, — не чаще раза в сутки: показ не состоялся,
      // lastSocialShowAt прежний, и без этого фильтра тот же круг заводился
      // заново каждый час — три новые строки и записи в журнал без предела.
      NOT: { socialReposts: { some: { status: "FAILED", createdAt: { gte: new Date(Date.now() - SOCIAL_REPOST_FAILED_RETRY_MS) } } } },
    },
    select: { id: true, price: true, currency: true },
    take: 200,
  });
  if (candidates.length === 0) return { scheduled: 0 };

  const scheduleRules = (await loadPublishScheduleRules()).rules;
  let scheduled = 0;
  for (const candidate of candidates) {
    const lastShown = await lastSocialShowAt(candidate.id);
    if (!lastShown || lastShown > cutoff) continue;

    const publishedRounds = await prisma.propertySocialRepost.aggregate({
      where: { propertyId: candidate.id, status: "PUBLISHED" },
      _max: { round: true },
    });
    const nextRound = (publishedRounds._max.round ?? 0) + 1;
    if (nextRound > settings.repostMaxRounds) continue;

    const priceDrop = await detectPriceDrop(candidate.id, lastShown, candidate);
    const hook = repostHook(nextRound, priceDrop);

    const now = new Date();
    const scheduledAt = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PUBLISH_SLOT_LOCK_ID}::bigint)`;
      const already = await tx.propertySocialRepost.findFirst({
        where: { propertyId: candidate.id, status: "SCHEDULED" },
        select: { id: true },
      });
      if (already) return null;
      const occupied = await loadOccupiedPublishSlots(tx, new Date(now.getTime() - scheduleRules.minGapMin * 60_000));
      const computed = nextPublishSlot(now, occupied, scheduleRules);
      await tx.propertySocialRepost.createMany({
        data: SOCIAL_REPOST_CHANNELS.map((channel) => ({
          propertyId: candidate.id,
          round: nextRound,
          hook,
          channel,
          status: "SCHEDULED",
          scheduledAt: computed.at,
        })),
      });
      return computed.at;
    });
    if (!scheduledAt) continue;
    const enqueued = await enqueueBackgroundJob({
      type: SOCIAL_REPOST_PUBLISH_JOB_TYPE,
      payload: { propertyId: candidate.id, round: nextRound },
      maxAttempts: SOCIAL_REPOST_PUBLISH_MAX_ATTEMPTS,
      dedupeKey: socialRepostPublishDedupeKey(candidate.id, nextRound),
      runAt: scheduledAt,
    });
    if (!enqueued.enqueued) {
      void logSystemError("meta", `Объект ${candidate.id}: слот повтора выдан, но задание не встало в очередь — досмотрит только следующий тик`, {
        dedupKey: "Слот повтора выдан, но задание не встало в очередь",
      });
    }
    scheduled++;
  }
  return { scheduled };
}
