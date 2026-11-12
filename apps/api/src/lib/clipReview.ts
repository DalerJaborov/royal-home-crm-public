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
 *
 * ПОДТВЕРЖДАЕТ ХОЗЯИН ОБЪЕКТА (11.11.2026, Settings.clipOwnerApproveEnabled;
 * владелец: «все ролики что от монтажера обратно идут после монтажа пусть идут к
 * своим хозяином с кнопками подтвердить и они сразу добавятся», страховка — «не
 * руководству а автоматически поститься но не ночью с 12 по 7 утра»). Ролик так
 * же ждёт решения (PENDING), но кнопки получает ещё и хозяин объекта
 * (propertyOwnerAgentId). Молчит clipOwnerAutoPublishHours (3 ч) — ролик
 * одобряется сам (runClipOwnerAutoPublishTick, byId = null, source "auto"), а срок,
 * попавший на 00:00–07:00 по Душанбе, переносится на 07:00. У хозяина нет
 * Telegram или он неактивен — тот же таймер: решение не встаёт на одном человеке.
 * Руководство (clipReviewTelegram, право модерации) может решить в любой момент.
 */
import type { VideoRemakeReason } from "@royal-home/shared";
import { VIDEO_REMAKE_REASON_LABELS, parsePermissionOverrides, resolvePermissions, type Role } from "@royal-home/shared";
import { prisma } from "../db.js";
import { logAgentAudit, logSystemAudit } from "./audit.js";
import { schedulePublishAfterAccept } from "./videoHandoff.js";
import { sendBackToMontajer, type SendBackResult } from "./publishedVideoFix.js";
import { requestPultSnapshot } from "./pultCacheHook.js";
import { publishPropertyUpdated } from "./livePublish.js";
import { dushanbeDateTimeString } from "./dushanbeTime.js";
import { clampClipOwnerHours, clipOwnerDueFrom, isClipOwnerNight } from "./clipOwnerDue.js";

export { CLIP_OWNER_HOURS_MAX, CLIP_OWNER_HOURS_MIN, CLIP_OWNER_NIGHT_END_HOUR, isClipOwnerNight } from "./clipOwnerDue.js";
import { createNotifications, shouldAlert } from "./notifications.js";
import { isWithinAlarmHours } from "./workingHours.js";
import { montageNotificationRecipients } from "./montageObservers.js";
import { sendPushToAgents } from "../push.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";

/** "auto" — хозяин не ответил вовремя, ролик одобрила сама CRM (runClipOwnerAutoPublishTick). */
export type ClipReviewSource = "crm" | "telegram" | "auto";

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

// ─────────────────────────── хозяин объекта ───────────────────────────

export interface ClipOwnerSettings {
  enabled: boolean;
  hours: number;
}

export async function getClipOwnerSettings(): Promise<ClipOwnerSettings> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { clipOwnerApproveEnabled: true, clipOwnerAutoPublishHours: true },
  });
  return { enabled: s?.clipOwnerApproveEnabled ?? false, hours: clampClipOwnerHours(s?.clipOwnerAutoPublishHours) };
}

/** Срок автопубликации (та же формула, что пишет приём ролика в Property.clipOwnerDueAt). */
export const clipOwnerAutoPublishAt = clipOwnerDueFrom;

/** Хозяин объекта, которому идёт ролик: активный агент с привязанным Telegram, иначе null. */
export async function clipOwnerRecipient(propertyId: string): Promise<ClipReviewer | null> {
  const p = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { intakeAgentId: true, assignedAgentId: true, createdById: true },
  });
  const ownerId = p ? propertyOwnerAgentId(p) : null;
  if (!ownerId) return null;
  const [a, settings] = await Promise.all([
    prisma.agent.findUnique({
      where: { id: ownerId },
      select: { id: true, fullName: true, isActive: true, frozenAt: true, telegramChatId: true },
    }),
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } }),
  ]);
  // Замороженный не решает; монтажёр свой же ролик не подтверждает (ревью 11.11.2026).
  if (!a || !a.isActive || a.frozenAt || !a.telegramChatId || a.id === settings?.videoMontajerAgentId) return null;
  return { id: a.id, fullName: a.fullName, chatId: a.telegramChatId };
}

/**
 * Кто может решить по ролику ЭТОГО объекта из Telegram: руководство/модератор
 * (clipReviewerByChat) или — при включённом подтверждении хозяином — сам хозяин.
 * Право проверяется заново на каждое нажатие: объект могли передать другому.
 */
export async function clipDeciderByChat(
  chatId: string,
  propertyId: string
): Promise<(ClipReviewer & { asOwner: boolean }) | null> {
  const reviewer = await clipReviewerByChat(chatId);
  if (reviewer) return { ...reviewer, asOwner: false };
  // Хозяин решает, пока рубильник включён ИЛИ у ролика стоит срок автопубликации:
  // выключили рубильник, а срок в силе — без кнопок хозяин не успел бы вернуть ролик.
  const [{ enabled }, due] = await Promise.all([
    getClipOwnerSettings(),
    prisma.property.findUnique({ where: { id: propertyId }, select: { clipOwnerDueAt: true } }),
  ]);
  if (!enabled && !due?.clipOwnerDueAt) return null;
  const owner = await clipOwnerRecipient(propertyId);
  if (!owner || owner.chatId !== chatId) return null;
  return { ...owner, asOwner: true };
}

// ─────────────────────────── очередь «ждёт проверки» ───────────────────────────

/**
 * Признак «ролик ждёт проверки» — тот же, по которому approveClip берёт ролик в
 * работу и по которому карточка рисует плашку (propertyListItem.ts). Единственное
 * место условия: список пульта и решение не разойдутся.
 */
export const CLIP_REVIEW_PENDING_WHERE = {
  deletedAt: null,
  videoHandoffStatus: "RECEIVED",
  clipReviewStatus: "PENDING",
} as const;

export const CLIP_REVIEW_PENDING_LIMIT = 20;

export interface PendingClipItem {
  id: string;
  shortId: number;
  title: string;
  /** Публичный путь /uploads/handoff/…; подпись ставит signMediaUrlsInResponses. */
  videoUrl: string | null;
  coverUrl: string | null;
  requestedAt: string | null;
  montajer: { id: string; fullName: string } | null;
}

/** Ролики, ждущие решения, давние первыми; `total` — сколько всего (может быть больше предела). */
export async function listPendingClips(limit = CLIP_REVIEW_PENDING_LIMIT): Promise<{ items: PendingClipItem[]; total: number }> {
  const [rows, total, settings] = await Promise.all([
    prisma.property.findMany({
      where: CLIP_REVIEW_PENDING_WHERE,
      orderBy: [{ clipReviewRequestedAt: { sort: "asc", nulls: "last" } }, { videoHandoffReceivedAt: "asc" }],
      take: limit,
      select: {
        id: true,
        shortId: true,
        title: true,
        videoHandoffFinalPath: true,
        clipReviewRequestedAt: true,
        videoHandoffReceivedAt: true,
        photos: { orderBy: { order: "asc" }, take: 1, select: { thumbUrl: true } },
      },
    }),
    prisma.property.count({ where: CLIP_REVIEW_PENDING_WHERE }),
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } }),
  ]);
  const montajer = settings?.videoMontajerAgentId
    ? await prisma.agent.findUnique({ where: { id: settings.videoMontajerAgentId }, select: { id: true, fullName: true } })
    : null;
  return {
    total,
    items: rows.map((p) => ({
      id: p.id,
      shortId: p.shortId,
      title: p.title,
      videoUrl: p.videoHandoffFinalPath,
      coverUrl: p.photos[0]?.thumbUrl ?? null,
      requestedAt: (p.clipReviewRequestedAt ?? p.videoHandoffReceivedAt)?.toISOString() ?? null,
      montajer,
    })),
  };
}

// ─────────────────────────── решение ───────────────────────────

export type ClipDecisionEvent = {
  propertyId: string;
  outcome: "approved" | "rejected";
  /** null — одобрила сама CRM (хозяин не ответил вовремя). */
  byId: string | null;
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
  if (p.clipReviewStatus === "APPROVED" && !p.clipReviewDecidedById) {
    const at = p.clipReviewDecidedAt ? ` в ${dushanbeDateTimeString(p.clipReviewDecidedAt)}` : "";
    return `Уже решено: ролик ушёл в публикацию автоматически${at}.`;
  }
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
export async function approveClip(
  propertyId: string,
  byId: string | null,
  source: ClipReviewSource,
  /** Момент решения для журнала «сколько ждали» — тик автопубликации передаёт свой. */
  decidedAt?: Date
): Promise<ApproveClipResult> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      id: true,
      shortId: true,
      deletedAt: true,
      assignedAgentId: true,
      intakeAgentId: true,
      createdById: true,
      status: true,
      clipReviewRequestedAt: true,
    },
  });
  if (!property || property.deletedAt) return { ok: false, status: 404, error: "Объект не найден или удалён." };
  const now = new Date();
  const claimed = await prisma.property.updateMany({
    // Автопубликация перепроверяет срок в самой записи (ревью 12.11.2026): хозяин мог
    // нажать «Вернуть» между выборкой тика и этой строкой — срок уже отодвинут.
    where: { id: propertyId, ...CLIP_REVIEW_PENDING_WHERE, ...(source === "auto" ? { clipOwnerDueAt: { lte: decidedAt ?? new Date() } } : {}) },
    data: { clipReviewStatus: "APPROVED", clipReviewDecidedAt: now, clipReviewDecidedById: byId, clipReviewComment: null, clipOwnerDueAt: null },
  });
  if (claimed.count === 0) return { ok: false, status: 409, error: await clipAlreadyDecidedText(propertyId) };

  const scheduled = await schedulePublishAfterAccept(propertyId);
  // Журнал (11.11.2026): кто решил — хозяин, руководство или сама CRM, — и
  // сколько ролик ждал решения.
  const meta = {
    shortId: property.shortId,
    source,
    decidedAs: !byId ? "auto" : byId === propertyOwnerAgentId(property) ? "owner" : "reviewer",
    waitedMinutes: property.clipReviewRequestedAt
      ? Math.round(((decidedAt ?? now).getTime() - property.clipReviewRequestedAt.getTime()) / 60_000)
      : null,
    scheduledPublishAt: scheduled.scheduledPublishAt?.toISOString() ?? null,
    notPublishingReason: scheduled.notPublishingReason ?? null,
  };
  if (byId) logAgentAudit(byId, "PROPERTY_CLIP_APPROVED", "Property", propertyId, meta);
  else logSystemAudit("PROPERTY_CLIP_AUTO_APPROVED", "Property", propertyId, meta);
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
  decidedAs?: "owner" | "reviewer";
}): void {
  const label = VIDEO_REMAKE_REASON_LABELS[input.reason];
  logAgentAudit(input.byId, "PROPERTY_CLIP_REJECTED", "Property", input.propertyId, {
    shortId: input.shortId,
    source: input.source,
    reason: input.reason,
    comment: input.comment,
    ...(input.decidedAs ? { decidedAs: input.decidedAs } : {}),
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
  input: {
    reason: VideoRemakeReason;
    comment: string | null;
    byId: string;
    source: ClipReviewSource;
    decidedAs?: "owner" | "reviewer";
  }
): Promise<SendBackResult> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { shortId: true, deletedAt: true, clipReviewStatus: true },
  });
  if (!property || property.deletedAt) return { ok: false, error: "Объект не найден или удалён." };
  if (property.clipReviewStatus !== "PENDING") return { ok: false, error: await clipAlreadyDecidedText(propertyId) };
  const result = await sendBackToMontajer(propertyId, input.byId, input.reason, input.comment);
  if (result.ok && result.clipReviewWasPending) {
    afterClipRejected({
      propertyId,
      shortId: property.shortId,
      byId: input.byId,
      source: input.source,
      reason: input.reason,
      comment: input.comment,
      decidedAs: input.decidedAs,
    });
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
  // Хозяин подтверждает сам, а молчание закрывает автопубликация — напоминать
  // руководству нечего («не руководству а автоматически поститься»).
  // Ролик, который ждал решения ещё до включения (срока у него нет), напоминанием
  // не теряется (ревью 12.11.2026): молчит только тот, чей срок закроет автопубликация.
  const ownerOn = (await getClipOwnerSettings()).enabled;
  const stale = await prisma.property.findMany({
    where: {
      ...(ownerOn ? { clipOwnerDueAt: null } : {}),
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

// ─────────────────────────── автопубликация без ответа хозяина ───────────────────────────

/**
 * АВТОПУБЛИКАЦИЯ (11.11.2026). Ролик ждёт решения дольше clipOwnerAutoPublishHours —
 * одобряется тем же approveClip (byId = null, source "auto"), как будто нажали
 * «Подтвердить». Ночью (00:00–07:00 по Душанбе) ничего не делает: срок, попавший в
 * ночь, наступает в 07:00 (clipOwnerAutoPublishAt). Повторный тик и гонка с
 * нажатием безопасны — переход PENDING → APPROVED в approveClip атомарный.
 */
export async function runClipOwnerAutoPublishTick(now: Date = new Date()): Promise<{ published: number }> {
  if (isClipOwnerNight(now)) return { published: 0 };
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { clipOwnerApproveEnabled: true, clipReviewEnabled: true },
  });
  // Рубильник выключили, пока ролики ждали: решают модераторы, если проверка
  // ими включена; если выключена и она — решать некому, срок у объекта в силе
  // (ревью 11.11.2026: иначе ролик повис бы навсегда).
  if (!s?.clipOwnerApproveEnabled && s?.clipReviewEnabled) return { published: 0 };
  const candidates = await prisma.property.findMany({
    where: { ...CLIP_REVIEW_PENDING_WHERE, clipOwnerDueAt: { lte: now } },
    select: { id: true, shortId: true },
    orderBy: { clipOwnerDueAt: "asc" },
    take: 50,
  });
  if (candidates.length === 0) return { published: 0 };
  // Хозяин (или модератор) прямо сейчас пишет причину возврата — не перебивать
  // его автопубликацией: диалог живёт 15 минут, после него срок снова в силе.
  const dialogs = await prisma.telegramDialogState.findMany({
    where: { kind: CLIP_REJECT_DIALOG_KIND, expiresAt: { gt: now } },
    select: { payload: true },
  });
  const rejecting = new Set(dialogs.map((d) => Number((d.payload as { shortId?: unknown } | null)?.shortId)));
  let published = 0;
  for (const p of candidates) {
    if (rejecting.has(p.shortId)) continue;
    const result = await approveClip(p.id, null, "auto", now);
    if (result.ok) published++;
  }
  return { published };
}

/** Сколько даём на выбор причины и комментарий при «Вернуть монтажёру». */
export const CLIP_REJECT_GRACE_MS = 15 * 60_000;

/**
 * Нажали «Вернуть монтажёру» — срок автопубликации не раньше чем через 15 минут
 * (ревью 11.11.2026: хозяин выбирает причину в 2:59, тик в 3:00 опубликовал бы
 * ролик, который он возвращает). Только отодвигает, никогда не приближает.
 */
export async function holdClipOwnerDueForReject(propertyId: string, now: Date = new Date()): Promise<void> {
  const hold = new Date(now.getTime() + CLIP_REJECT_GRACE_MS);
  await prisma.property.updateMany({
    where: { id: propertyId, ...CLIP_REVIEW_PENDING_WHERE, clipOwnerDueAt: { not: null, lt: hold } },
    data: { clipOwnerDueAt: hold },
  });
}

/** Вид состояния диалога «жду комментарий к возврату» (telegram/clipReviewBot.ts). */
export const CLIP_REJECT_DIALOG_KIND = "clip_reject_comment";
