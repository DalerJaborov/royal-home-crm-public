import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatPropertyCode } from "@royal-home/shared";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { videoHandoffDir } from "../upload.js";
import { deleteSocialVideoDraftIfUntouched } from "./socialVideoPosts.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { sendMessage } from "../telegram/api.js";

/**
 * УБОРКА ПОСТОВ БЕЗ ОБЪЕКТА ОТ ШАБНАМ И РОЛИКОВ «К КАКОМУ ОБЪЕКТУ» (21.11.2026, два круга ревью PR #349).
 * Раз в 15 минут, cron.ts (`staff-social-post-sweep`).
 *
 * Долгая часть нажатия идёт в очереди чата в памяти процесса: перезапуск или падение сервера её теряет,
 * а статус в базе остаётся «в работе». Уборка возвращает такое в рабочее состояние и пишет сотруднику
 * ОДНУ строку, что делать (это ответ на его же нажатие, которое сорвал перезапуск):
 *  - PUBLISHING дольше 10 минут, черновик всё ещё DRAFT — публикация не началась: снова PREVIEW, «нажмите ещё раз»;
 *    черновик уже не DRAFT — публикация пошла: PUBLISHED, молча;
 *  - PREPARING дольше 20 минут: превью уже было (новая подпись не дописалась) — снова PREVIEW с прежней подписью;
 *    превью не было — строка и черновик убираются; альбом — «пришлите фото ещё раз» (ролик — строкой ниже);
 *  - ролик в WORKING дольше 20 минут: приём уже прошёл (объект получил ролик после начала приёма) — READY, «принят»;
 *    иначе снова ждёт кнопку (ASKING / CHOSEN), «нажмите кнопку ещё раз»;
 *  - превью без решения дольше суток — EXPIRED, черновик удаляется, только если его не трогали в «Роликах» CRM
 *    (deleteSocialVideoDraftIfUntouched); сообщения нет, кнопка потом ответит, что пост убран;
 *  - временные файлы `staff-social-*`, `staff-clip-*` и папки `clip-speech-*` старше двух часов.
 * Все переходы условные: то, что человек в эту секунду делает, уборка не перебивает.
 */
export const STAFF_SOCIAL_PUBLISHING_STUCK_MS = 10 * 60_000;
export const STAFF_SOCIAL_PREPARING_STUCK_MS = 20 * 60_000;
export const STAFF_CLIP_WORKING_STUCK_MS = 20 * 60_000;
const TEMP_FILE_MAX_AGE_MS = 2 * 3_600_000;
const BATCH = 100;
const ALIVE = ["PREVIEW", "EDIT_CAPTION", "PICKING"];

/** Что идёт в WORKING у ролика: `token` — чьё это нажатие (опоздавшая работа из очереди сверяет его). */
export interface ClipWorkMarker { kind: "RECEIVING" | "MONTAGE_SENDING" | "FREE_POST"; token: string; startedAt: string }
export function clipWorkMarker(value: Prisma.JsonValue | null | undefined): ClipWorkMarker | null {
  const v = value as Partial<ClipWorkMarker> | null;
  return v && typeof v === "object" && typeof v.token === "string" && typeof v.startedAt === "string"
    && (v.kind === "RECEIVING" || v.kind === "MONTAGE_SENDING" || v.kind === "FREE_POST") ? (v as ClipWorkMarker) : null;
}

const TEXT = {
  publishNotStarted: { ru: "Публикация не началась (сервер перезапускался). Нажмите «Опубликовать» ещё раз.", tg: "Нашр сар нашуд (сервер аз нав оғоз шуд). «Нашр кардан»-ро боз пахш кунед." },
  captionNotWritten: { ru: "Новая подпись не дописалась, осталась прежняя. Можно нажать «Опубликовать» на последнем превью.", tg: "Матни нав навишта нашуд, пештара монд. «Нашр кардан»-ро дар пешнамоиши охирин пахш кардан мумкин аст." },
  albumNotPrepared: { ru: "Пост из фото не подготовился (сервер перезапускался). Пришлите фото ещё раз.", tg: "Пост аз аксҳо омода нашуд (сервер аз нав оғоз шуд). Аксҳоро боз фиристед." },
} as const;
const lang = (request: string | null): "ru" | "tg" => (request && /[ӣӯқғҳҷ]/iu.test(request) ? "tg" : "ru");

/** Одна строка сотруднику в его личку — только если чат всё ещё его и учётка жива. */
async function tell(chatId: string, agentId: string, text: string): Promise<void> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { isActive: true, telegramChatId: true } });
  if (!agent?.isActive || agent.telegramChatId !== chatId) return;
  await sendMessage(chatId, text).catch((err: unknown) => {
    void logSystemError("telegram", `Уборка постов Шабнам: сообщение сотруднику не ушло — ${describeError(err)}`, { dedupKey: "staff-social-sweep-tell" });
  });
}

async function dropDraft(socialVideoPostId: string | null, seenAt: Date | null): Promise<void> {
  if (!socialVideoPostId || !seenAt) return;
  try {
    await deleteSocialVideoDraftIfUntouched(socialVideoPostId, seenAt);
  } catch (err) {
    void logSystemError("api", `Уборка постов Шабнам: черновик ${socialVideoPostId} не удалён — ${describeError(err)}`, { dedupKey: "staff-social-sweep-draft" });
  }
}

async function removeOldTemp(dir: string, prefixes: readonly string[], now: number): Promise<number> {
  let removed = 0;
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!prefixes.some((p) => entry.name.startsWith(p))) continue;
    const full = path.join(dir, entry.name);
    const stat = await fs.promises.stat(full).catch(() => null);
    if (!stat || now - stat.mtimeMs < TEMP_FILE_MAX_AGE_MS) continue;
    await fs.promises.rm(full, { recursive: true, force: true }).catch(() => {});
    removed++;
  }
  return removed;
}

export interface StaffSocialSweepResult { expired: number; dropped: number; restored: number; released: number; files: number }

export async function sweepStaffSocialPosts(now: Date = new Date(), dirs: { handoff?: string; tmp?: string } = {}): Promise<StaffSocialSweepResult> {
  const result: StaffSocialSweepResult = { expired: 0, dropped: 0, restored: 0, released: 0, files: 0 };
  const before = (ms: number) => new Date(now.getTime() - ms);

  // 1. Публикация, сорванная перезапуском.
  const publishing = await prisma.staffSocialPost.findMany({
    where: { status: "PUBLISHING", updatedAt: { lt: before(STAFF_SOCIAL_PUBLISHING_STUCK_MS) } },
    select: { id: true, chatId: true, agentId: true, request: true, socialVideoPostId: true }, take: BATCH,
  });
  for (const post of publishing) {
    const draft = post.socialVideoPostId ? await prisma.socialVideoPost.findUnique({ where: { id: post.socialVideoPostId }, select: { status: true, deletedAt: true } }) : null;
    const notStarted = draft !== null && !draft.deletedAt && draft.status === "DRAFT";
    const moved = await prisma.staffSocialPost.updateMany({
      where: { id: post.id, status: "PUBLISHING" },
      data: notStarted ? { status: "PREVIEW" } : { status: "PUBLISHED", publishedAt: now },
    });
    if (!moved.count) continue;
    result.restored++;
    if (notStarted) await tell(post.chatId, post.agentId, TEXT.publishNotStarted[lang(post.request)]);
  }

  // 2. Подготовка, сорванная перезапуском.
  const preparing = await prisma.staffSocialPost.findMany({
    where: { status: "PREPARING", updatedAt: { lt: before(STAFF_SOCIAL_PREPARING_STUCK_MS) } },
    select: { id: true, chatId: true, agentId: true, request: true, kind: true, staffClipIntakeId: true, socialVideoPostId: true, previewMessageId: true, draftSeenAt: true },
    take: BATCH,
  });
  for (const post of preparing) {
    if (post.previewMessageId && post.socialVideoPostId) {
      const moved = await prisma.staffSocialPost.updateMany({ where: { id: post.id, status: "PREPARING" }, data: { status: "PREVIEW" } });
      if (!moved.count) continue;
      result.restored++;
      await tell(post.chatId, post.agentId, TEXT.captionNotWritten[lang(post.request)]);
      continue;
    }
    const gone = await prisma.staffSocialPost.deleteMany({ where: { id: post.id, status: "PREPARING" } });
    if (!gone.count) continue;
    result.dropped++;
    // Превью не было — черновик никто, кроме нас, не видел в Telegram; в CRM его могли тронуть — тогда остаётся.
    await dropDraft(post.socialVideoPostId, post.draftSeenAt);
    // Ролик: о нём скажет строка про сам ролик ниже (он тоже в WORKING). Альбом — здесь.
    if (!post.staffClipIntakeId) await tell(post.chatId, post.agentId, TEXT.albumNotPrepared[lang(post.request)]);
  }

  // 3. Ролик «к какому объекту», сорванный перезапуском.
  const working = await prisma.staffClipIntake.findMany({
    where: { status: "WORKING", updatedAt: { lt: before(STAFF_CLIP_WORKING_STUCK_MS) } },
    select: { id: true, chatId: true, agentId: true, propertyId: true, result: true, updatedAt: true }, take: BATCH,
  });
  for (const intake of working) {
    const marker = clipWorkMarker(intake.result);
    // Приём ролика мог закончиться до падения (объект получил ролик после начала приёма): второй раз не принимаем.
    if (marker?.kind === "RECEIVING" && intake.propertyId) {
      const p = await prisma.property.findUnique({ where: { id: intake.propertyId }, select: { shortId: true, videoHandoffReceivedAt: true } });
      if (p?.videoHandoffReceivedAt && p.videoHandoffReceivedAt >= new Date(marker.startedAt)) {
        const moved = await prisma.staffClipIntake.updateMany({
          where: { id: intake.id, status: "WORKING", updatedAt: intake.updatedAt },
          data: { status: "READY", decidedAt: null, result: { kind: "READY", hadFinal: true, remakeRequestId: null, recovered: true } },
        });
        if (moved.count) {
          result.released++;
          await tell(intake.chatId, intake.agentId, `Ролик для ${formatPropertyCode(p.shortId)} принят. Нажимать ещё раз не нужно.`);
        }
        continue;
      }
    }
    const moved = await prisma.staffClipIntake.updateMany({
      where: { id: intake.id, status: "WORKING", updatedAt: intake.updatedAt },
      data: { status: intake.propertyId ? "CHOSEN" : "ASKING" },
    });
    if (!moved.count) continue;
    result.released++;
    await tell(intake.chatId, intake.agentId, "Ролик не обработался (сервер перезапускался). Нажмите кнопку под ним ещё раз.");
  }

  // 4. Брошенные превью — сутки без решения.
  const expired = await prisma.staffSocialPost.findMany({
    where: { status: { in: ALIVE }, expiresAt: { lt: now } },
    select: { id: true, socialVideoPostId: true, draftSeenAt: true }, take: BATCH,
  });
  for (const post of expired) {
    const moved = await prisma.staffSocialPost.updateMany({ where: { id: post.id, status: { in: ALIVE } }, data: { status: "EXPIRED" } });
    if (!moved.count) continue;
    result.expired++;
    await dropDraft(post.socialVideoPostId, post.draftSeenAt);
  }

  result.files += await removeOldTemp(dirs.handoff ?? videoHandoffDir, ["staff-social-", "staff-clip-"], now.getTime());
  result.files += await removeOldTemp(dirs.tmp ?? os.tmpdir(), ["clip-speech-"], now.getTime());
  return result;
}
