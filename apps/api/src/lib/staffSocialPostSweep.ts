import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "../db.js";
import { videoHandoffDir } from "../upload.js";
import { deleteSocialVideo } from "./socialVideoPosts.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";

/**
 * УБОРКА ПОСТОВ БЕЗ ОБЪЕКТА ОТ ШАБНАМ (21.11.2026, ревью PR #349). Раз в 15 минут, cron.ts.
 * Молча, без сообщений людям: брошенное превью просто перестаёт быть живым (кнопка ответит «устарела»).
 *
 *  - превью, правка подписи и выбор сетей старше суток (expiresAt) → CANCELLED, черновик и его файлы удаляются;
 *  - PREPARING дольше часа: превью ещё не было — строка и черновик удаляются (повтор возможен);
 *    превью уже было (зависла новая подпись) — возвращается PREVIEW с прежней подписью;
 *  - ролик «к какому объекту» в WORKING дольше двух часов (процесс упал посреди работы) — снова ждёт кнопку;
 *  - временные файлы `staff-social-*`, `staff-clip-*` и папки `clip-speech-*` старше двух часов — удаляются.
 *
 * Все переходы условные: строку, которую человек в эту секунду публикует, уборка не трогает.
 */
export const STAFF_SOCIAL_PREPARING_STUCK_MS = 3_600_000;
export const STAFF_CLIP_WORKING_STUCK_MS = 2 * 3_600_000;
const TEMP_FILE_MAX_AGE_MS = 2 * 3_600_000;
const BATCH = 100;
const ALIVE = ["PREVIEW", "EDIT_CAPTION", "PICKING"];

export interface StaffSocialSweepResult { cancelled: number; dropped: number; restored: number; released: number; files: number }

/**
 * Удаляет только ЧЕРНОВИК. Черновик виден и в «Роликах» CRM: если его оттуда уже опубликовали или
 * поставили в расписание, запись и файлы остаются — уборка не трогает чужую публикацию.
 */
export async function dropDraftIfStillDraft(socialVideoPostId: string | null): Promise<void> {
  if (!socialVideoPostId) return;
  const row = await prisma.socialVideoPost.findUnique({ where: { id: socialVideoPostId }, select: { status: true, deletedAt: true } });
  if (!row || row.deletedAt || row.status !== "DRAFT") return;
  try {
    await deleteSocialVideo(socialVideoPostId);
  } catch (err) {
    // Уже удалён (404) — норма. Остальное — в журнал: файлы останутся на диске.
    const status = (err as { status?: number })?.status;
    if (status !== 404) void logSystemError("api", `Уборка постов Шабнам: черновик ${socialVideoPostId} не удалён — ${describeError(err)}`, { dedupKey: "staff-social-sweep-draft" });
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

export async function sweepStaffSocialPosts(now: Date = new Date(), dirs: { handoff?: string; tmp?: string } = {}): Promise<StaffSocialSweepResult> {
  const result: StaffSocialSweepResult = { cancelled: 0, dropped: 0, restored: 0, released: 0, files: 0 };

  const expired = await prisma.staffSocialPost.findMany({
    where: { status: { in: ALIVE }, expiresAt: { lt: now } },
    select: { id: true, socialVideoPostId: true },
    take: BATCH,
  });
  for (const post of expired) {
    const moved = await prisma.staffSocialPost.updateMany({ where: { id: post.id, status: { in: ALIVE } }, data: { status: "CANCELLED" } });
    if (!moved.count) continue;
    result.cancelled++;
    await dropDraftIfStillDraft(post.socialVideoPostId);
  }

  const stuck = await prisma.staffSocialPost.findMany({
    where: { status: "PREPARING", updatedAt: { lt: new Date(now.getTime() - STAFF_SOCIAL_PREPARING_STUCK_MS) } },
    select: { id: true, socialVideoPostId: true, previewMessageId: true },
    take: BATCH,
  });
  for (const post of stuck) {
    if (post.previewMessageId && post.socialVideoPostId) {
      const moved = await prisma.staffSocialPost.updateMany({ where: { id: post.id, status: "PREPARING" }, data: { status: "PREVIEW" } });
      result.restored += moved.count;
      continue;
    }
    const gone = await prisma.staffSocialPost.deleteMany({ where: { id: post.id, status: "PREPARING" } });
    if (!gone.count) continue;
    result.dropped++;
    await dropDraftIfStillDraft(post.socialVideoPostId);
  }

  const workingBefore = new Date(now.getTime() - STAFF_CLIP_WORKING_STUCK_MS);
  const [asking, chosen] = await Promise.all([
    prisma.staffClipIntake.updateMany({ where: { status: "WORKING", updatedAt: { lt: workingBefore }, propertyId: null }, data: { status: "ASKING" } }),
    prisma.staffClipIntake.updateMany({ where: { status: "WORKING", updatedAt: { lt: workingBefore }, propertyId: { not: null } }, data: { status: "CHOSEN" } }),
  ]);
  result.released = asking.count + chosen.count;

  result.files += await removeOldTemp(dirs.handoff ?? videoHandoffDir, ["staff-social-", "staff-clip-"], now.getTime());
  result.files += await removeOldTemp(dirs.tmp ?? os.tmpdir(), ["clip-speech-"], now.getTime());
  return result;
}
