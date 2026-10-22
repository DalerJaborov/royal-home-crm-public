/**
 * ПРОВЕРКА ГОТОВОГО РОЛИКА МОДЕРАТОРОМ (25.09.2026, владелец: «ролики от
 * монтажёра пусть проходят модерацию в Telegram Нурмухаммада, но отправка не
 * файлом, а просто видео, чтобы удобно было; на наш сервер и в соцсети уходит
 * файлом»).
 *
 * Поток при Settings.clipReviewEnabled:
 *  1. приём ролика (lib/videoHandoff.ts::finishReceivingVideo) пишет RECEIVED и
 *     clipReviewStatus=PENDING, место монтажёра освобождает, слот НЕ считает;
 *  2. модераторам в Telegram уходит видео с кнопками (telegram/clipReviewBot.ts),
 *     в карточке объекта — плеер и те же кнопки (PropertyVideoFixCard.tsx);
 *  3. «Одобрить» (approveClip) — APPROVED и ровно тот хвост приёма, что без
 *     проверки: schedulePublishAfterAccept (слот + задание публикации);
 *  4. «Вернуть монтажёру» (rejectClip) — существующий sendBackToMontajer: он сам
 *     ставит REJECTED той же транзакцией, объект в начало очереди, причину —
 *     монтажёру. Обычное окно «Вернуть монтажёру» в карточке закрывает
 *     проверку тем же путём (routes/properties/videos.ts).
 *
 * Решение атомарно: переход PENDING → APPROVED одной записью с условием,
 * проигравшему (второй модератор, второе нажатие) — «Уже решено …».
 * Файл в сети и на сервер уходит как есть — Telegram-видео только для просмотра.
 */
import type { VideoRemakeReason } from "@royal-home/shared";
import { VIDEO_REMAKE_REASON_LABELS, parsePermissionOverrides, resolvePermissions, type Role } from "@royal-home/shared";
import { prisma } from "../db.js";
import { logAgentAudit } from "./audit.js";
import { schedulePublishAfterAccept } from "./videoHandoff.js";
import { sendBackToMontajer, type SendBackResult } from "./publishedVideoFix.js";
import { requestPultSnapshot } from "./pultCacheHook.js";
import { publishPropertyUpdated } from "./livePublish.js";
import { dushanbeDateTimeString } from "./dushanbeTime.js";
import { createNotifications, shouldAlert } from "./notifications.js";
import { isWithinAlarmHours } from "./workingHours.js";
import { montageNotificationRecipients } from "./montageObservers.js";
import { sendPushToAgents } from "../push.js";

export type ClipReviewSource = "crm" | "telegram";

export interface ClipReviewer {
  id: string;
  fullName: string;
  chatId: string;
}

/** Кто может решать по ролику: руководство или право модерации объектов. */
export function canReviewClip(a: { role: string; permissions: unknown }): boolean {
  if (a.role === "ADMIN" || a.role === "DIRECTOR") return true;
  return resolvePermissions(a.role as Role, parsePermissionOverrides(a.permissions as never)).has("properties.moderate");
}

/** Кому слать ролик в Telegram: активные, с флагом, с чатом и с правом. */
export async function listClipReviewers(): Promise<ClipReviewer[]> {
  const agents = await prisma.agent.findMany({
    where: { isActive: true, clipReviewTelegram: true, telegramChatId: { not: null } },
    select: { id: true, fullName: true, role: true, permissions: true, telegramChatId: true },
  });
  return agents.filter(canReviewClip).map((a) => ({ id: a.id, fullName: a.fullName, chatId: a.telegramChatId! }));
}

/** Чат → модератор ролика. Флаг НЕ требуется (выключил рассылку — старые кнопки
 *  всё равно его), право проверяется заново на каждое нажатие. */
export async function clipReviewerByChat(chatId: string): Promise<ClipReviewer | null> {
  const a = await prisma.agent.findUnique({
    where: { telegramChatId: chatId },
    select: { id: true, fullName: true, role: true, permissions: true, isActive: true },
  });
  if (!a || !a.isActive || !canReviewClip(a)) return null;
  return { id: a.id, fullName: a.fullName, chatId };
}

// ─────────────────────────── решение ───────────────────────────

export type ClipDecisionEvent = {
  propertyId: string;
  outcome: "approved" | "rejected";
  byId: string;
  source: ClipReviewSource;
  at: Date;
  reason?: string;
};
const decisionListeners: Array<(e: ClipDecisionEvent) => Promise<void>> = [];
/** Telegram подписывается, чтобы погасить кнопки у всех копий (telegram/clipReviewBot.ts). */
export function onClipDecision(fn: (e: ClipDecisionEvent) => Promise<void>): void {
  decisionListeners.push(fn);
}
function emitClipDecision(e: ClipDecisionEvent): void {
  for (const fn of decisionListeners) void fn(e).catch((err) => console.error("[clip-review] слушатель решения:", err));
}

export type ClipDecisionFailure = { ok: false; status: 404 | 409; error: string };

/** «Уже решено: одобрил Нурмухаммад 2026-09-25 11:40» — ответ проигравшему. */
export async function clipAlreadyDecidedText(propertyId: string): Promise<string> {
  const p = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { clipReviewStatus: true, clipReviewDecidedAt: true, clipReviewDecidedById: true },
  });
  if (!p || p.clipReviewStatus === "NONE" || p.clipReviewStatus === "PENDING") return "Ролик сейчас не ждёт проверки.";
  const who = p.clipReviewDecidedById
    ? await prisma.agent.findUnique({ where: { id: p.clipReviewDecidedById }, select: { fullName: true } })
    : null;
  const what = p.clipReviewStatus === "APPROVED" ? "одобрил" : "вернул монтажёру";
  const when = p.clipReviewDecidedAt ? ` в ${dushanbeDateTimeString(p.clipReviewDecidedAt)}` : "";
  return `Уже решено: ${what} ${who?.fullName ?? "другой модератор"}${when}.`;
}

export type ApproveClipResult =
  | { ok: true; scheduledPublishAt: Date | null; notPublishingReason?: string }
  | ClipDecisionFailure;

/**
 * «Одобрить» — ролик уходит в расписание публикаций тем же хвостом, что и
 * приём без проверки (schedulePublishAfterAccept), без второй копии.
 */
export async function approveClip(propertyId: string, byId: string, source: ClipReviewSource): Promise<ApproveClipResult> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { id: true, shortId: true, deletedAt: true, assignedAgentId: true, status: true },
  });
  if (!property || property.deletedAt) return { ok: false, status: 404, error: "Объект не найден или удалён." };
  const now = new Date();
  const claimed = await prisma.property.updateMany({
    where: { id: propertyId, deletedAt: null, videoHandoffStatus: "RECEIVED", clipReviewStatus: "PENDING" },
    data: { clipReviewStatus: "APPROVED", clipReviewDecidedAt: now, clipReviewDecidedById: byId, clipReviewComment: null },
  });
  if (claimed.count === 0) return { ok: false, status: 409, error: await clipAlreadyDecidedText(propertyId) };

  const scheduled = await schedulePublishAfterAccept(propertyId);
  logAgentAudit(byId, "PROPERTY_CLIP_APPROVED", "Property", propertyId, {
    shortId: property.shortId,
    source,
    scheduledPublishAt: scheduled.scheduledPublishAt?.toISOString() ?? null,
    notPublishingReason: scheduled.notPublishingReason ?? null,
  });
  emitClipDecision({ propertyId, outcome: "approved", byId, source, at: now });
  requestPultSnapshot(); // пульт: проверка ролика закрыта
  publishPropertyUpdated({ propertyId, agentId: property.assignedAgentId, stage: property.status, actorId: byId });
  return { ok: true, scheduledPublishAt: scheduled.scheduledPublishAt, notPublishingReason: scheduled.notPublishingReason };
}

/**
 * Проверка закрыта возвратом монтажёру (решение уже записано в
 * sendBackToMontajer той же транзакцией) — журнал и кнопки у модераторов.
 * Зовут rejectClip ниже и обычный роут «Вернуть монтажёру».
 */
export function afterClipRejected(input: {
  propertyId: string;
  shortId: number;
  byId: string;
  source: ClipReviewSource;
  reason: VideoRemakeReason;
  comment: string | null;
}): void {
  const label = VIDEO_REMAKE_REASON_LABELS[input.reason];
  logAgentAudit(input.byId, "PROPERTY_CLIP_REJECTED", "Property", input.propertyId, {
    shortId: input.shortId,
    source: input.source,
    reason: input.reason,
    comment: input.comment,
  });
  emitClipDecision({
    propertyId: input.propertyId,
    outcome: "rejected",
    byId: input.byId,
    source: input.source,
    at: new Date(),
    reason: input.comment ? `${label}: ${input.comment}` : label,
  });
}

/** «Вернуть монтажёру» с проверки — весь возврат делает sendBackToMontajer. */
export async function rejectClip(
  propertyId: string,
  input: { reason: VideoRemakeReason; comment: string | null; byId: string; source: ClipReviewSource }
): Promise<SendBackResult> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { shortId: true, deletedAt: true, clipReviewStatus: true },
  });
  if (!property || property.deletedAt) return { ok: false, error: "Объект не найден или удалён." };
  if (property.clipReviewStatus !== "PENDING") return { ok: false, error: await clipAlreadyDecidedText(propertyId) };
  const result = await sendBackToMontajer(propertyId, input.byId, input.reason, input.comment);
  if (result.ok && result.clipReviewWasPending) {
    afterClipRejected({ propertyId, shortId: property.shortId, byId: input.byId, source: input.source, reason: input.reason, comment: input.comment });
  } else if (!result.ok) {
    // Второй модератор успел вернуть раньше — объект уже в очереди монтажёра.
    const fresh = await prisma.property.findUnique({ where: { id: propertyId }, select: { clipReviewStatus: true } });
    if (fresh && fresh.clipReviewStatus !== "PENDING") return { ok: false, error: await clipAlreadyDecidedText(propertyId) };
  }
  requestPultSnapshot(); // пульт: ролик отправлен на доработку
  return result;
}

// ─────────────────────────── сторож ───────────────────────────

/** Ролик ждёт решения дольше этого — напоминание модераторам. */
export const CLIP_REVIEW_STALE_MS = 3 * 60 * 60 * 1000;
/** Не чаще раза в 6 часов на объект. */
export const CLIP_REVIEW_REMIND_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * НАПОМИНАНИЕ «РОЛИК ЖДЁТ ПРОВЕРКИ» — по образцу alertMontageStuck
 * (videoHandoffStaleAlarm.ts): только в часы алармов, не чаще раза в 6 часов на
 * объект (тег clip-review-stale-<id>), уведомление + пуш модераторам и строка в
 * Telegram тем, кто получает ролики на проверку. Готовый ролик, который никто не
 * одобрил, не выйдет никогда — это ровно то «молча стоит», ради чего сторож.
 * `remind` — отправка в Telegram (telegram/clipReviewBot.ts), подставляется
 * вызывающим, чтобы сервис не тянул бота.
 */
export async function runClipReviewStaleTick(
  remind: (propertyId: string, shortId: number, hours: number) => Promise<void>,
  now: Date = new Date()
): Promise<{ reminded: number }> {
  if (!(await isWithinAlarmHours(now))) return { reminded: 0 };
  const stale = await prisma.property.findMany({
    where: {
      deletedAt: null,
      videoHandoffStatus: "RECEIVED",
      clipReviewStatus: "PENDING",
      clipReviewRequestedAt: { lt: new Date(now.getTime() - CLIP_REVIEW_STALE_MS) },
    },
    select: { id: true, shortId: true, clipReviewRequestedAt: true },
    orderBy: { clipReviewRequestedAt: "asc" },
    take: 100,
  });
  if (stale.length === 0) return { reminded: 0 };
  const [reviewers, moderators] = await Promise.all([listClipReviewers(), montageNotificationRecipients()]);
  const recipients = Array.from(new Set([...reviewers.map((r) => r.id), ...moderators]));
  if (recipients.length === 0) return { reminded: 0 };

  let reminded = 0;
  for (const p of stale) {
    const tag = `clip-review-stale-${p.id}`;
    if (!(await shouldAlert(tag, CLIP_REVIEW_REMIND_INTERVAL_MS, now))) continue;
    const hours = Math.floor((now.getTime() - p.clipReviewRequestedAt!.getTime()) / 3_600_000);
    const payload = {
      kind: "oversight" as const,
      title: `🎬 Ролик ждёт проверки: объект №${p.shortId}`,
      body: `Готовый ролик от монтажёра ждёт решения уже ${hours} ч. Без «Одобрить» он в сети не выйдет.`,
      url: `/properties/${p.shortId}`,
      tag,
      level: "APPROVAL" as const,
    };
    try {
      await createNotifications(recipients, payload);
    } catch (err) {
      console.error("[clip-review] напоминание:", err);
      continue;
    }
    void sendPushToAgents(recipients, payload).catch((err) => console.error("[clip-review] пуш напоминания:", err));
    await remind(p.id, p.shortId, hours).catch((err) => console.error("[clip-review] напоминание в Telegram:", err));
    reminded++;
  }
  return { reminded };
}
