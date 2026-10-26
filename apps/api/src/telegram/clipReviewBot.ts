/**
 * ГОТОВЫЙ РОЛИК НА ПРОВЕРКУ В TELEGRAM (25.09.2026, lib/clipReview.ts).
 *
 * Модератору (Agent.clipReviewTelegram + привязанный чат + право) уходит
 * ВИДЕО, а не документ (владелец: «не файлом, а просто видео, чтобы удобно
 * было») — sendVideo с supports_streaming, смотреть прямо в чате, — с подписью
 * (номер, факты карточки, монтажёр, длительность/размер/звук) и кнопками
 * `cr:a` «Одобрить», `cr:r` «Вернуть монтажёру» и ссылкой «Открыть в CRM».
 *
 * Отправленные сообщения лежат в TelegramModerationMessage (kind CLIP — видео,
 * CLIP_TEXT — запасное текстовое, если видео не ушло): решение где угодно
 * (Telegram, карточка, обычное «Вернуть монтажёру») гасит кнопки у всех копий
 * тем же resolveMessages, что и модерация объектов. Повтор нажатия —
 * claimCallback; второе нажатие после решения — «Уже решено …».
 *
 * Монтажёру отсюда не пишется ничего: возврат идёт через sendBackToMontajer,
 * квитанция — через telegram/montajerReceive.ts.
 */
import { stat } from "node:fs/promises";
import {
  VIDEO_REMAKE_REASONS,
  VIDEO_REMAKE_REASON_LABELS,
  VIDEO_REMAKE_REASONS_REQUIRING_COMMENT,
  type VideoRemakeReason,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import {
  answerCallbackQuery,
  isTelegramEnabled,
  sendMessageWithButtons,
  sendVideoFromDisk,
  TELEGRAM_BOT_SEND_LIMIT_BYTES,
  type TelegramCallbackQuery,
  type TelegramInlineButton,
} from "./api.js";
import {
  approveClip,
  clipAlreadyDecidedText,
  clipReviewerByChat,
  listClipReviewers,
  onClipDecision,
  rejectClip,
  runClipReviewStaleTick,
  type ClipDecisionEvent,
  type ClipReviewer,
} from "../lib/clipReview.js";
import {
  claimCallback,
  crmPropertyUrl,
  DIALOG_TTL_MS,
  humanFileSize,
  recordMessage,
  reply,
  resolveMessages,
  SEND_PAUSE_MS,
} from "../lib/telegramModeration.js";
import { onClipReviewRequested, propertyFactsForMontajer, videoHandoffFinalDiskPath } from "../lib/videoHandoff.js";
import { prepareClipForTelegram, type ClipForTelegram } from "../lib/clipReviewPreview.js";
import { probeMediaInfo } from "../lib/ffmpeg.js";
import { formatDurationShort } from "../lib/rawVideoFacts.js";
import { logSystemError } from "../lib/systemError.js";
import { dushanbeDateTimeString } from "../lib/dushanbeTime.js";

const CLIP_KINDS = ["CLIP", "CLIP_TEXT"];
/** Вид состояния диалога «жду комментарий к возврату» (TelegramDialogState). */
const REJECT_DIALOG_KIND = "clip_reject_comment";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────── подпись и кнопки ───────────────────────────

export interface ClipCaptionInput {
  shortId: number;
  /** Факты карточки для монтажёра (propertyFactsForMontajer): агент, район, цена… */
  facts: string;
  montajerName: string | null;
  durationSec: number | null;
  sizeBytes: number | null;
  hasAudio: boolean | null;
}

/** Подпись под видео. Первая строка фактов («Объект №N») не дублируется. */
export function clipReviewCaption(input: ClipCaptionInput): string {
  const facts = input.facts
    .split("\n")
    .filter((l) => l.trim() && !/^Объект №\d+$/.test(l.trim()))
    .join("\n");
  const media = [
    input.durationSec != null && input.durationSec > 0 ? formatDurationShort(input.durationSec) : null,
    input.sizeBytes != null ? humanFileSize(input.sizeBytes) : null,
    input.hasAudio == null ? null : input.hasAudio ? "звук есть" : "⚠ без звука",
  ].filter(Boolean);
  return [
    `🎬 Ролик на проверку · Объект №${input.shortId}`,
    facts || null,
    `Монтажёр: ${input.montajerName ?? "—"}`,
    media.length ? `Ролик: ${media.join(", ")}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

export function clipReviewButtons(shortId: number): TelegramInlineButton[][] {
  return [
    [
      { text: "✅ Одобрить", callback_data: `cr:a:${shortId}` },
      { text: "↩️ Вернуть монтажёру", callback_data: `cr:r:${shortId}` },
    ],
    [{ text: "🔗 Открыть в CRM", url: crmPropertyUrl(shortId) }],
  ];
}

// ─────────────────────────── рассылка ───────────────────────────

function reportSendFailure(r: ClipReviewer, shortId: number, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  void logSystemError("telegram", `Проверка ролика: объект №${shortId} для ${r.fullName} не ушёл: ${message}`);
}

/** Одному модератору: видео с кнопками, а не вышло — текст с кнопками и ссылкой. */
async function sendClipTo(
  r: ClipReviewer,
  p: { id: string; shortId: number; version: number },
  caption: string,
  clip: ClipForTelegram | null
): Promise<void> {
  const buttons = clipReviewButtons(p.shortId);
  try {
    const tooBig = clip != null && clip.sizeBytes > TELEGRAM_BOT_SEND_LIMIT_BYTES;
    if (!clip || tooBig) throw new Error(tooBig ? "файл больше предела Telegram" : "файл ролика не найден");
    const sent = await sendVideoFromDisk(r.chatId, clip.videoPath, caption, undefined, buttons, clip);
    await recordMessage({ kind: "CLIP", propertyId: p.id, mod: r, messageId: sent.message_id, text: caption, version: p.version });
    return;
  } catch (err) {
    reportSendFailure(r, p.shortId, err);
  }
  const text = `${caption}\n\n🎬 Видео не удалось прислать сюда — смотреть в CRM: ${crmPropertyUrl(p.shortId)}`;
  try {
    const sent = await sendMessageWithButtons(r.chatId, text, buttons);
    await recordMessage({ kind: "CLIP_TEXT", propertyId: p.id, mod: r, messageId: sent.message_id, text, version: p.version });
  } catch (err) {
    reportSendFailure(r, p.shortId, err);
  }
}

/** Ролик принят и ждёт проверки — всем модераторам роликов. Никогда не бросает. */
export async function notifyClipReview(propertyId: string): Promise<void> {
  try {
    if (!isTelegramEnabled()) return;
    const reviewers = await listClipReviewers();
    if (reviewers.length === 0) return;
    const p = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true, shortId: true, version: true, deletedAt: true, clipReviewStatus: true, videoHandoffFinalPath: true },
    });
    if (!p || p.deletedAt || p.clipReviewStatus !== "PENDING") return;
    // Монтажёр переслал исправленный ролик (reopenForResend) — кнопки под прежним
    // видео решали бы уже за новый файл, которого модератор не видел.
    await resolveMessages({ propertyId: p.id, kind: { in: CLIP_KINDS } }, "⚠️ Монтажёр прислал новый ролик — он ниже.");
    const diskPath = p.videoHandoffFinalPath ? videoHandoffFinalDiskPath(p.videoHandoffFinalPath) : null;
    const [facts, settings, fileStat, media] = await Promise.all([
      propertyFactsForMontajer(p.id),
      prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } }),
      diskPath ? stat(diskPath).catch(() => null) : null,
      diskPath ? probeMediaInfo(diskPath).catch(() => null) : null,
    ]);
    const montajer = settings?.videoMontajerAgentId
      ? await prisma.agent.findUnique({ where: { id: settings.videoMontajerAgentId }, select: { fullName: true } })
      : null;
    const caption = clipReviewCaption({
      shortId: p.shortId,
      facts,
      montajerName: montajer?.fullName ?? null,
      durationSec: media?.durationSec ?? null,
      sizeBytes: fileStat?.size ?? null,
      hasAudio: media ? media.hasAudio : null,
    });
    // Один раз на всех модераторов: оригинал с размерами и обложкой, а
    // перевёрнутый/HEVC/огромный — копией для просмотра (lib/clipReviewPreview.ts).
    const clip = fileStat && diskPath ? await prepareClipForTelegram(diskPath, media, fileStat.size, TELEGRAM_BOT_SEND_LIMIT_BYTES) : null;
    try {
      for (const [i, r] of reviewers.entries()) {
        if (i > 0) await sleep(SEND_PAUSE_MS);
        await sendClipTo(r, p, caption, clip);
      }
    } finally {
      await clip?.cleanup();
    }
  } catch (err) {
    void logSystemError("telegram", `Проверка ролика: рассылка объекта ${propertyId} упала: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * ДОСЫЛКА ПРОВЕРКИ, КОТОРАЯ НЕ ДОШЛА (29.09.2026, №139: Telegram ответил `fetch failed`,
 * рассылка проглотила отказ, ролик 10 часов висел «на проверке» без единого сообщения
 * модератору). Ролик ждёт решения, а живого сообщения с кнопками ни у кого нет —
 * шлём заново. Каждые 5 минут, не дольше трёх суток, не больше 20 объектов за тик.
 */
export async function runClipReviewResendTick(now: Date = new Date()): Promise<{ resent: number }> {
  if (!isTelegramEnabled()) return { resent: 0 };
  const pending = await prisma.property.findMany({
    where: {
      deletedAt: null,
      videoHandoffStatus: "RECEIVED",
      clipReviewStatus: "PENDING",
      clipReviewRequestedAt: { lt: new Date(now.getTime() - 3 * 60_000), gt: new Date(now.getTime() - 3 * 86_400_000) },
    },
    select: { id: true },
    orderBy: { clipReviewRequestedAt: "asc" },
    take: 20,
  });
  let resent = 0;
  for (const p of pending) {
    const live = await prisma.telegramModerationMessage.count({
      where: { propertyId: p.id, kind: { in: CLIP_KINDS }, resolvedAt: null },
    });
    if (live > 0) continue;
    await notifyClipReview(p.id);
    resent++;
  }
  return { resent };
}

/**
 * Напоминание сторожа — с теми же кнопками решения, что под видео (26.10.2026,
 * владелец: «чтобы решалось прямо из бота без перехода в CRM» — видео к тому
 * времени ушло далеко вверх). Сообщение записано как CLIP_TEXT: решение гасит
 * его кнопки вместе с видео, а новый ролик от монтажёра делает их устаревшими
 * (notifyClipReview → resolveMessages) — старое напоминание не одобрит невиданный файл.
 */
async function remindClipReview(propertyId: string, shortId: number, hours: number): Promise<void> {
  if (!isTelegramEnabled()) return;
  const p = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, version: true } });
  if (!p) return;
  const text = `⏰ Ролик по объекту №${shortId} ждёт проверки уже ${hours} ч. Видео — выше, решить можно здесь.`;
  for (const r of await listClipReviewers()) {
    try {
      const sent = await sendMessageWithButtons(r.chatId, text, clipReviewButtons(shortId));
      await recordMessage({ kind: "CLIP_TEXT", propertyId: p.id, mod: r, messageId: sent.message_id, text, version: p.version });
    } catch (err) {
      reportSendFailure(r, shortId, err);
    }
  }
}

/** Тик сторожа «ролик ждёт проверки дольше 3 часов» (cron.ts). */
export function runClipReviewStaleAlarmTick(now: Date = new Date()): Promise<{ reminded: number }> {
  return runClipReviewStaleTick(remindClipReview, now);
}

// ─────────────────────────── решение гасит кнопки у всех ───────────────────────────

export function clipDecisionLine(e: { outcome: "approved" | "rejected"; name: string; at: Date; reason?: string }): string {
  const time = dushanbeDateTimeString(e.at).split(" ")[1] ?? "";
  return e.outcome === "approved"
    ? `✅ Одобрил ${e.name} ${time}`
    : `↩️ Вернул ${e.name} ${time}${e.reason ? `: ${e.reason}` : ""}`;
}

async function onDecision(e: ClipDecisionEvent): Promise<void> {
  const agent = await prisma.agent.findUnique({ where: { id: e.byId }, select: { fullName: true } });
  const where: Prisma.TelegramModerationMessageWhereInput = { propertyId: e.propertyId, kind: { in: CLIP_KINDS } };
  await resolveMessages(where, clipDecisionLine({ outcome: e.outcome, name: agent?.fullName ?? "—", at: e.at, reason: e.reason }));
}

// ─────────────────────────── диалог «комментарий к возврату» ───────────────────────────

type RejectDialog = { shortId: number; reason: number };

async function setRejectDialog(chatId: string, agentId: string, state: RejectDialog): Promise<void> {
  const data = { agentId, kind: REJECT_DIALOG_KIND, payload: state as unknown as Prisma.InputJsonValue, expiresAt: new Date(Date.now() + DIALOG_TTL_MS) };
  await prisma.telegramDialogState.upsert({ where: { chatId }, create: { chatId, ...data }, update: data });
}

/** Состояние только своего вида: чужое (модерация, монтажёр) не читаем и не стираем. */
async function getRejectDialog(chatId: string, agentId: string): Promise<RejectDialog | null> {
  const row = await prisma.telegramDialogState.findUnique({ where: { chatId } });
  if (!row || row.kind !== REJECT_DIALOG_KIND) return null;
  if (row.expiresAt <= new Date() || row.agentId !== agentId) {
    await prisma.telegramDialogState.deleteMany({ where: { chatId, kind: REJECT_DIALOG_KIND } });
    return null;
  }
  return row.payload as unknown as RejectDialog;
}

async function clearRejectDialog(chatId: string): Promise<void> {
  await prisma.telegramDialogState.deleteMany({ where: { chatId, kind: REJECT_DIALOG_KIND } });
}

async function finishReject(r: ClipReviewer, propertyId: string, reasonIdx: number, comment: string | null): Promise<void> {
  const reason = VIDEO_REMAKE_REASONS[reasonIdx] as VideoRemakeReason;
  const result = await rejectClip(propertyId, { reason, comment, byId: r.id, source: "telegram" });
  if (!result.ok) await reply(r.chatId, result.error);
}

// ─────────────────────────── нажатия ───────────────────────────

/** Разбор `cr:*`. true — нажатие про проверку ролика и обработано здесь. */
export async function handleClipReviewCallback(query: TelegramCallbackQuery): Promise<boolean> {
  const data = query.data ?? "";
  if (!data.startsWith("cr:")) return false;
  await answerCallbackQuery(query.id).catch(() => {});
  const chatId = query.message?.chat.id != null ? String(query.message.chat.id) : null;
  if (!chatId) return true;
  if (!(await claimCallback(query.id))) return true;

  const r = await clipReviewerByChat(chatId);
  if (!r) {
    await reply(chatId, "Нет права проверять ролики. Если это ошибка — попросите руководителя выдать его в CRM.");
    return true;
  }
  const [, action, arg1, arg2] = data.split(":");
  if (action === "x") {
    await clearRejectDialog(chatId);
    await reply(chatId, "Отменено.");
    return true;
  }
  const shortId = Number(arg1);
  if (!Number.isInteger(shortId) || shortId <= 0) return true;
  const p = await prisma.property.findFirst({ where: { shortId }, select: { id: true, deletedAt: true, clipReviewStatus: true } });
  if (!p || p.deletedAt) {
    await reply(chatId, "🗑 Объект удалён");
    return true;
  }

  // КНОПКА СТАРОГО ВИДЕО НЕ РЕШАЕТ ЗА НОВЫЙ РОЛИК (аудит 04.10.2026, PUB11). callback_data
  // несёт только номер объекта, и пока ролик на проверке, «Одобрить» под ПРЕЖНИМ видео
  // одобрило бы присланный позже, которого модератор не видел. notifyClipReview помечает
  // старые сообщения решёнными в базе ДО правки их кнопок, так что отказ правки (таймаут,
  // 429) эту проверку не обходит. После настоящего решения (не PENDING) оставляем прежний
  // ответ «Уже решено …» — его даёт approveClip / ветки ниже. Сообщения без записи
  // (ответы бота с причинами возврата) не ограничиваем.
  if (p.clipReviewStatus === "PENDING" && ["a", "r", "rr", "rx"].includes(action) && query.message?.message_id != null) {
    const pressed = await prisma.telegramModerationMessage.findFirst({
      where: { chatId, messageId: query.message.message_id, kind: { in: CLIP_KINDS } },
      select: { resolvedAt: true },
    });
    if (pressed?.resolvedAt) {
      await reply(chatId, "Кнопка устарела: ролик по этому объекту обновили, актуальный ниже. Решение — под новым видео.");
      return true;
    }
  }

  switch (action) {
    case "a": {
      const result = await approveClip(p.id, r.id, "telegram");
      if (!result.ok) await reply(chatId, result.error);
      else if (result.notPublishingReason) await reply(chatId, `Одобрено, но в сети ролик сам не уйдёт: ${result.notPublishingReason}`);
      return true;
    }
    case "r": {
      if (p.clipReviewStatus !== "PENDING") {
        await reply(chatId, await clipAlreadyDecidedText(p.id));
        return true;
      }
      await reply(
        chatId,
        `Почему возвращаем ролик №${shortId} монтажёру?`,
        VIDEO_REMAKE_REASONS.map((code, i) => [{ text: VIDEO_REMAKE_REASON_LABELS[code], callback_data: `cr:rr:${shortId}:${i}` }])
      );
      return true;
    }
    case "rr": {
      const idx = Number(arg2);
      const code = VIDEO_REMAKE_REASONS[idx];
      if (!code) return true;
      if (p.clipReviewStatus !== "PENDING") {
        await reply(chatId, await clipAlreadyDecidedText(p.id));
        return true;
      }
      await setRejectDialog(chatId, r.id, { shortId, reason: idx });
      const required = VIDEO_REMAKE_REASONS_REQUIRING_COMMENT.includes(code);
      await reply(
        chatId,
        required
          ? `Причина: «${VIDEO_REMAKE_REASON_LABELS[code]}». Напишите монтажёру, что именно исправить, одним сообщением (15 минут).`
          : `Причина: «${VIDEO_REMAKE_REASON_LABELS[code]}». Напишите комментарий монтажёру одним сообщением (15 минут) или отправьте без него.`,
        [
          ...(required ? [] : [[{ text: "Отправить без комментария", callback_data: `cr:rx:${shortId}` }]]),
          [{ text: "Отмена", callback_data: "cr:x" }],
        ]
      );
      return true;
    }
    case "rx": {
      const state = await getRejectDialog(chatId, r.id);
      if (!state || state.shortId !== shortId) {
        await reply(chatId, "Время на ответ вышло — нажмите «Вернуть монтажёру» ещё раз.");
        return true;
      }
      await clearRejectDialog(chatId);
      await finishReject(r, p.id, state.reason, null);
      return true;
    }
    case "o": {
      await reply(chatId, `Объект №${shortId} в CRM: ${crmPropertyUrl(shortId)}`);
      return true;
    }
    default:
      return true;
  }
}

/** Текст модератора — ответ на «жду комментарий к возврату». true — разобран. */
export async function handleClipReviewText(chatId: string, text: string): Promise<boolean> {
  const row = await prisma.telegramDialogState.findUnique({ where: { chatId }, select: { kind: true } });
  if (row?.kind !== REJECT_DIALOG_KIND) return false;
  const r = await clipReviewerByChat(chatId);
  if (!r) return false;
  const state = await getRejectDialog(chatId, r.id);
  if (!state) {
    await reply(chatId, "Время на ответ вышло — нажмите «Вернуть монтажёру» ещё раз.");
    return true;
  }
  await clearRejectDialog(chatId);
  const p = await prisma.property.findFirst({ where: { shortId: state.shortId }, select: { id: true, deletedAt: true } });
  if (!p || p.deletedAt) {
    await reply(chatId, "🗑 Объект удалён");
    return true;
  }
  await finishReject(r, p.id, state.reason, text.trim().slice(0, 2000) || null);
  return true;
}

// Подписки — при первой загрузке модуля (telegram/bot.ts импортирует его).
onClipReviewRequested(notifyClipReview);
onClipDecision(onDecision);
