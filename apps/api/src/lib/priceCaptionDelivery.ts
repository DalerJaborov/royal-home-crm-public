import { z } from "zod";
import { prisma, type TxClient } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import type { Prisma } from "../generated/prisma/client.js";
import { loadCredentials } from "../messengers/meta.js";
import { editMessageCaption, isTelegramEnabled, TelegramApiError } from "../telegram/api.js";
import { metadataHash, planPublicationMetadata } from "./publicationMetadataPolicy.js";
import { buildPriceDisplay } from "./reelsCaptionTemplate.js";
import { loadMoneyContext } from "./money.js";
import { updateFacebookVideoDescription, updateYouTubeDescription } from "./socialPublish.js";
import { logSystemError } from "./systemError.js";

const MODE = "PRICE_CHANGE";
const OPERATION = "CAPTION";
const MANUAL_MODE = "CAPTION_REFRESH";
const UNKNOWN_AFTER_MS = 10 * 60_000;
const MAX_ATTEMPTS = 4;
const RETRY_MS = [60_000, 5 * 60_000, 20 * 60_000];

const targetSchema = z.object({ postId: z.string().min(1), chatId: z.string().optional() });
const payloadSchema = z.object({ caption: z.string(), target: targetSchema });
const attemptSchema = z.object({ attempts: z.number().int().positive(), retryAtMs: z.number().optional() });
type Target = z.infer<typeof targetSchema>;
type Payload = z.infer<typeof payloadSchema>;
type Delivery = { status: "APPLIED" | "REJECTED" | "RETRYABLE" | "UNKNOWN"; code: string };

type Publication = { publishedChannels: string[]; publishedPostIds: unknown };
type VersionedPublication = Publication & { id: string; version: number };

function captionPlans(property: Publication, caption: string, telegramChatId: string | null) {
  return planPublicationMetadata({
    caption, coverKey: null, coverDigest: null,
    channels: property.publishedChannels, postIds: property.publishedPostIds, telegramChatId,
  }).filter(({ operation }) => operation === OPERATION);
}

function revisionKey(target: Target | undefined, version: number): string {
  return `${metadataHash(target ? [target.chatId ?? null, target.postId] : [])}:${String(version).padStart(12, "0")}`;
}

/** Called after writing the property row, inside the same transaction. */
export async function stagePriceCaptionTargets(
  tx: TxClient,
  property: VersionedPublication,
  caption: string | null,
): Promise<{ queued: string[]; manual: string[] }> {
  // A newer price replaces all outstanding, unsent attempts. An active or
  // uncertain write remains fenced until its outcome is known.
  await tx.publicationMetadataSync.updateMany({
    where: {
      propertyId: property.id,
      executionMode: MODE,
      operation: OPERATION,
      status: { in: ["PENDING", "RETRY"] },
      NOT: { revisionHash: { endsWith: ":" + String(property.version).padStart(12, "0") } },
    },
    data: { status: "SUPERSEDED", reason: "Более новая цена в CRM" },
  });
  return appendCaptionTargets(tx, property, caption);
}

async function appendCaptionTargets(tx: TxClient, property: VersionedPublication, caption: string | null) {
  const settings = await tx.settings.findUnique({ where: { id: "singleton" }, select: { telegramChannelId: true } });
  const plans = captionPlans(property, caption ?? "", settings?.telegramChannelId?.trim() || null);
  const queued: string[] = [];
  const manual: string[] = [];
  const rows: Prisma.PublicationMetadataSyncCreateManyInput[] = [];
  for (const { channel, status, reason, payload } of plans) {
    const send = status === "PREVIEW";
    (send ? queued : manual).push(channel);
    const targets = payload.targets.length ? payload.targets : [undefined];
    for (const target of targets) {
      rows.push({
        propertyId: property.id,
        revisionHash: revisionKey(target, property.version),
        channel,
        operation: OPERATION,
        executionMode: MODE,
        status: send ? "PENDING" : "MANUAL_REQUIRED",
        reason: send ? "Подпись ожидает отправки" : reason,
        payload: target ? { caption: caption ?? "", target } : undefined,
      });
    }
  }
  if (rows.length) await tx.publicationMetadataSync.createMany({ data: rows, skipDuplicates: true });
  return { queued, manual };
}

/** A post may be acknowledged after a price change already staged the known targets. */
export async function stageLatePublishedPriceCaption(
  tx: TxClient,
  propertyId: string,
  channels: string[],
  publishedPrice: { price: number; currency: string },
) {
  const property = await tx.property.findUniqueOrThrow({ where: { id: propertyId } });
  if (property.deletedAt || (Number(property.price) === publishedPrice.price && property.currency === publishedPrice.currency)) return;
  const money = await loadMoneyContext(tx);
  const expected = buildPriceDisplay(property.price, property.currency, money);
  const caption = property.reelsCaption?.includes(expected) ? property.reelsCaption : null;
  await appendCaptionTargets(tx, { ...property, publishedChannels: property.publishedChannels.filter((channel) => channels.includes(channel)) }, caption);
}

function providerResult(result: Awaited<ReturnType<typeof updateFacebookVideoDescription>>): Delivery {
  if (result.ok) return { status: "APPLIED", code: "PROVIDER_ACKNOWLEDGED" };
  return { status: result.delivery ?? "UNKNOWN", code: "PROVIDER_WRITE_UNCONFIRMED" };
}

async function sendCaption(channel: string, { caption, target }: Payload): Promise<Delivery> {
  if (channel === "FACEBOOK") {
    const creds = await loadCredentials().catch(() => null);
    if (!creds) return { status: "RETRYABLE", code: "CREDENTIALS_READ_FAILED" };
    if (!creds.pageToken) return { status: "REJECTED", code: "CREDENTIALS_MISSING" };
    return providerResult(await updateFacebookVideoDescription(target.postId, creds.pageToken, caption, true));
  }
  if (channel === "YOUTUBE") {
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { youtubeClientId: true, youtubeClientSecret: true, youtubeRefreshToken: true },
    }).catch(() => undefined);
    if (settings === undefined) return { status: "RETRYABLE", code: "CREDENTIALS_READ_FAILED" };
    const creds = {
      clientId: settings?.youtubeClientId ?? undefined,
      clientSecret: decryptSecretSafe(settings?.youtubeClientSecret ?? null) ?? undefined,
      refreshToken: decryptSecretSafe(settings?.youtubeRefreshToken ?? null) ?? undefined,
    };
    if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) return { status: "REJECTED", code: "CREDENTIALS_MISSING" };
    return providerResult(await updateYouTubeDescription(creds, target.postId, caption, caption, true));
  }
  if (channel === "TELEGRAM") {
    if (!isTelegramEnabled() || !target.chatId || !/^\d+$/.test(target.postId) || !Number.isSafeInteger(Number(target.postId))) {
      return { status: "REJECTED", code: "TARGET_UNAVAILABLE" };
    }
    if (caption.length > 1024) return { status: "REJECTED", code: "CAPTION_TOO_LONG" };
    try {
      await editMessageCaption(target.chatId, Number(target.postId), caption, undefined, true);
      return { status: "APPLIED", code: "PROVIDER_ACKNOWLEDGED" };
    } catch (error) {
      if (!(error instanceof TelegramApiError) || error.errorCode == null) throw error;
      const status = error.errorCode;
      const retryable = status === 408 || status === 429 || status >= 500;
      return { status: retryable ? "RETRYABLE" : "REJECTED", code: `TELEGRAM_${status}` };
    }
  }
  return { status: "REJECTED", code: "UNSUPPORTED_CHANNEL" };
}

async function claimCaption(id: string, propertyId: string, now: Date) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${propertyId} FOR UPDATE`;
    const row = await tx.publicationMetadataSync.findUnique({ where: { id } });
    if (!row || !["PENDING", "RETRY"].includes(row.status)) return null;
    const parsed = payloadSchema.safeParse(row.payload);
    const previousAttempt = attemptSchema.safeParse(row.result);
    if (previousAttempt.success && (previousAttempt.data.retryAtMs ?? 0) > now.getTime()) return null;
    const property = await tx.property.findUnique({ where: { id: propertyId } });
    const settings = await tx.settings.findUnique({ where: { id: "singleton" }, select: { telegramChannelId: true } });
    const stillPublished = parsed.success && property && !property.deletedAt &&
      captionPlans(property, parsed.data.caption, settings?.telegramChannelId?.trim() || null).some((plan) =>
        plan.channel === row.channel && plan.payload.targets.some((target) =>
          target.chatId === parsed.data.target.chatId && target.postId === parsed.data.target.postId));
    if (!parsed.success || !stillPublished) {
      await tx.publicationMetadataSync.update({
        where: { id },
        data: { status: parsed.success ? "SUPERSEDED" : "FAILED", finishedAt: now, reason: parsed.success ? "Публикация больше недоступна" : "Неверные данные подписи" },
      });
      return null;
    }
    const targetKey = row.revisionHash.split(":")[0];
    const newer = await tx.publicationMetadataSync.findFirst({
      where: {
        propertyId, channel: row.channel, operation: OPERATION, executionMode: MODE,
        revisionHash: { startsWith: targetKey + ":", gt: row.revisionHash },
      },
      select: { id: true },
    });
    if (newer) {
      await tx.publicationMetadataSync.update({
        where: { id },
        data: { status: "SUPERSEDED", finishedAt: now, reason: "Более новая цена в CRM" },
      });
      return null;
    }
    const blocked = await tx.publicationMetadataSync.findFirst({
      where: {
        propertyId, operation: OPERATION, status: { in: ["EXECUTING", "UNKNOWN"] },
        OR: [
          { executionMode: MANUAL_MODE },
          { channel: row.channel, executionMode: "LIVE" },
          { channel: row.channel, executionMode: MODE, revisionHash: { startsWith: targetKey + ":" } },
        ],
      },
      select: { id: true },
    });
    if (blocked) return null;
    const attempts = (previousAttempt.success ? previousAttempt.data.attempts : 0) + 1;
    await tx.publicationMetadataSync.update({
      where: { id },
      data: { status: "EXECUTING", startedAt: now, finishedAt: null, reason: "Подпись отправляется", result: { attempts } },
    });
    return { channel: row.channel, payload: parsed.data, attempts };
  });
}

async function processCaption(id: string, propertyId: string, now: Date): Promise<void> {
  const claim = await claimCaption(id, propertyId, now);
  if (!claim) return;
  const outcome = await sendCaption(claim.channel, claim.payload).catch((): Delivery => ({
    status: "UNKNOWN", code: "PROVIDER_OUTCOME_UNCONFIRMED",
  }));
  const finishedAt = new Date(Math.max(Date.now(), now.getTime()));
  const retry = outcome.status === "RETRYABLE" && claim.attempts < MAX_ATTEMPTS;
  const status = retry ? "RETRY" : outcome.status === "APPLIED" || outcome.status === "UNKNOWN" ? outcome.status : "FAILED";
  const reason = {
    APPLIED: "Площадка подтвердила обновление",
    RETRY: "Площадка вернула временный отказ. Подпись будет отправлена повторно",
    FAILED: "Обновить подпись не удалось. Требуется проверка сотрудником",
    UNKNOWN: "Ответ об обновлении не получен. Проверьте площадку перед новой отправкой",
  }[status];
  const result = {
    attempts: claim.attempts,
    code: outcome.code,
    ...(retry ? { retryAtMs: finishedAt.getTime() + RETRY_MS[claim.attempts - 1] } : {}),
  };
  const saved = await prisma.publicationMetadataSync.updateMany({
    where: { id, status: { in: ["EXECUTING", "UNKNOWN"] }, startedAt: now },
    data: { status, reason, result, finishedAt },
  });
  if (saved.count && (status === "FAILED" || status === "UNKNOWN")) {
    await logSystemError("meta", `Объект ${propertyId}: ${claim.channel}, ${reason}. Запись ${id}.`);
  }
}

/** The database keeps each attempt and its next due time through worker restarts. */
export async function runPriceCaptionDeliveryTick(now = new Date()): Promise<void> {
  const abandoned = await prisma.publicationMetadataSync.updateManyAndReturn({
    where: { executionMode: { in: [MODE, MANUAL_MODE] }, operation: OPERATION, status: "EXECUTING", startedAt: { lte: new Date(now.getTime() - UNKNOWN_AFTER_MS) } },
    data: { status: "UNKNOWN", finishedAt: now, reason: "Воркер прервался до записи результата. Проверьте площадку" },
    select: { id: true, propertyId: true, channel: true },
  });
  for (const row of abandoned) {
    await logSystemError("meta", `Объект ${row.propertyId}: ${row.channel}, ответ об обновлении подписи не записан. Запись ${row.id}.`);
  }
  const due = await prisma.$queryRaw<Array<{ id: string; propertyId: string }>>`
    SELECT target.id, target."propertyId"
    FROM "PublicationMetadataSync" AS target
    WHERE target."executionMode" = ${MODE} AND target.operation = ${OPERATION}
      AND target.status IN ('PENDING', 'RETRY')
      AND COALESCE((target.result ->> 'retryAtMs')::bigint, 0) <= ${now.getTime()}
      AND NOT EXISTS (
        SELECT 1 FROM "PublicationMetadataSync" AS prior
        WHERE prior."propertyId" = target."propertyId"
          AND prior.operation = target.operation AND prior.status IN ('EXECUTING', 'UNKNOWN')
          AND (
            prior."executionMode" = ${MANUAL_MODE}
            OR (prior.channel = target.channel AND (
              prior."executionMode" = 'LIVE'
              OR (prior."executionMode" = ${MODE} AND split_part(prior."revisionHash", ':', 1) = split_part(target."revisionHash", ':', 1))
            ))
          )
      )
    ORDER BY target."createdAt", target.id
    LIMIT 12
  `;
  const outcomes = await Promise.allSettled(due.map(({ id, propertyId }) => processCaption(id, propertyId, now)));
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

/** A director needs to know which exact post to inspect before resolving an unknown result. */
export async function listPriceCaptionDelivery(propertyId: string) {
  const scope = { propertyId, operation: OPERATION, executionMode: { in: [MODE, MANUAL_MODE] } };
  const select = {
    id: true, channel: true, operation: true, executionMode: true,
    status: true, reason: true, startedAt: true, payload: true,
  } as const;
  const [unconfirmed, recent] = await Promise.all([
    prisma.publicationMetadataSync.findMany({
      where: { ...scope, status: "UNKNOWN" },
      select, orderBy: { createdAt: "desc" }, take: 30,
    }),
    prisma.publicationMetadataSync.findMany({
      where: { ...scope, status: { notIn: ["UNKNOWN", "SUPERSEDED"] } },
      select, orderBy: { createdAt: "desc" }, take: 15,
    }),
  ]);
  return [...unconfirmed, ...recent].map(({ payload, ...row }) => {
    const parsed = payloadSchema.safeParse(payload);
    return { ...row, postUrl: parsed.success ? captionPostUrl(row.channel, parsed.data.target) : null };
  });
}

function captionPostUrl(channel: string, target: Target): string | null {
  const postId = encodeURIComponent(target.postId);
  if (channel === "FACEBOOK") return `https://www.facebook.com/watch/?v=${postId}`;
  if (channel === "YOUTUBE") return `https://www.youtube.com/watch?v=${postId}`;
  if (channel === "TELEGRAM" && /^\d+$/.test(target.postId)) {
    const chat = target.chatId ?? "";
    if (/^-100\d+$/.test(chat)) return `https://t.me/c/${chat.slice(4)}/${postId}`;
    if (/^@[A-Za-z0-9_]+$/.test(chat)) return `https://t.me/${chat.slice(1)}/${postId}`;
  }
  return null;
}
