import { prisma } from "../db.js";
import {
  abortLocalUploadSession,
  listLocalUploadParts,
  listLocalUploadSessionDirs,
  readLocalUploadSessionState,
} from "./localVideoStorage.js";
import type { ChunkedUploadMeta } from "./chunkedUploadSessions.js";
import { logSystemError } from "./systemError.js";
import { sendPushToAgent } from "../push.js";

/**
 * Подстраховка на случай брошенной многочастевой загрузки видео.
 *
 * Сессия (VideoUploadSession) заводится, когда агент начинает грузить ролик, и
 * должна исчезать, когда он собран или отменён. Но телефон могут потерять,
 * приложение — удалить, объект — забросить на середине загрузки: тогда сессия
 * остаётся в базе, а её незакрытые части лежат на диске сервера, хотя файла
 * целиком никогда не будет.
 *
 * 48 часов, а не сутки: агент может грузить видео весь рабочий день с перерывами
 * (очередь досылает недостающие части при каждом появлении сети), и подстраховка
 * не должна срезать сессию, которая ещё жива.
 *
 * СЕССИИ БЕЗ ЕДИНОГО КУСКА — СВОЙ, МЕНЬШИЙ ПОРОГ (23.09.2026, разбор жалобы
 * «видео не грузится»: 6 сессий с 21.09, `parts = []`, ни один кусок не пришёл
 * ни разу). У такой сессии сервер выдал план, а клиент не отправил ни одной
 * части — известная особенность WebKit: Blob, восстановленный из IndexedDB
 * после перезапуска вкладки, может быть нечитаем (`NotReadableError`), и XHR
 * даёт `status 0` на каждой попытке. Общий порог в 48 часов ждал бы ещё сутки
 * с лишним, хотя дальнейшее ожидание ничего не изменит: части не начнут идти
 * сами по себе, если не пришло ни одной за долгий срок. 24 часа — с запасом
 * больше, чем нужно настоящему перерыву в работе (агент мог просто уйти домой
 * на ночь и вернуться утром), но короче прежних полутора суток простоя строки
 * в базе.
 */
const STALE_SESSION_HOURS = 48;
const EMPTY_SESSION_HOURS = 24;
const MAX_SESSIONS_PER_RUN = 50;

export interface VideoUploadCleanupResult {
  sessions: number;
  failed: number;
}

export async function cleanupStaleVideoUploadSessions(): Promise<VideoUploadCleanupResult> {
  const result: VideoUploadCleanupResult = { sessions: 0, failed: 0 };
  const cutoff = new Date(Date.now() - STALE_SESSION_HOURS * 60 * 60 * 1000);
  const emptyCutoff = new Date(Date.now() - EMPTY_SESSION_HOURS * 60 * 60 * 1000);

  // Кандидаты по обоим порогам разом (младший шире старшего), а не отдельным
  // Json-запросом по `parts` — Prisma фильтрует JSON-поля по равенству
  // ненадёжно между версиями, а нагрузка тут копеечная (раз в сутки, до
  // MAX_SESSIONS_PER_RUN*2 строк с одним только `select`).
  const candidates = await prisma.videoUploadSession.findMany({
    where: { updatedAt: { lte: emptyCutoff } },
    select: {
      id: true,
      updatedAt: true,
      parts: true,
      createdById: true,
      filename: true,
      property: { select: { id: true, shortId: true } },
    },
    take: MAX_SESSIONS_PER_RUN * 2,
  });
  const stale = candidates
    .filter((s) => s.updatedAt <= cutoff || (Array.isArray(s.parts) && s.parts.length === 0))
    .slice(0, MAX_SESSIONS_PER_RUN);

  for (const session of stale) {
    result.sessions++;
    // Сначала папка сессии на диске, и только потом запись о ней — тот же
    // порядок, что и у уборки видео объектов: обратный терял бы возможность
    // повторить отмену.
    if (await abortLocalUploadSession(session.id)) {
      await prisma.videoUploadSession.delete({ where: { id: session.id } });
      // Автору — пуш (07.10.2026): загрузка пропала молча, а он считал, что ролик
      // у объекта уже есть. Тег по сессии — повтор прохода не дублирует.
      await sendPushToAgent(session.createdById, {
        title: "⚠️ Загрузка видео отменена",
        body: `ОБ-${String(session.property.shortId).padStart(6, "0")}: загрузка «${session.filename}» не была завершена — загрузите ролик заново`,
        url: `/properties/${session.property.shortId}`,
        tag: `video-upload-cancelled-${session.id}`,
      }).catch((err) => console.error("[uploadCleanup] пуш автору:", err instanceof Error ? err.message : err));
    } else {
      result.failed++;
    }
  }

  if (result.failed > 0) {
    void logSystemError(
      "storage",
      `Уборка брошенных загрузок видео: ${result.failed} сессий не удалось отменить на диске (см. лог выше по каждой)`
    );
  }

  return result;
}

/**
 * СИРОТЫ НА ДИСКЕ (25.11.2026). Уборка выше ходит только по строкам VideoUploadSession, а
 * папка частей бывает без строки: сервер упал между созданием папки и записью в базу,
 * строку удалили, а папку — нет, план (meta.json) общего ядра обрезан сбоем. Такая папка
 * держала до 2 ГБ без единой ссылки на себя (комментарий «подберёт уборка» в
 * routes/properties/videos.ts был неправдой).
 *
 * Правило: папка без meta.json (не общее ядро — у того своя уборка) и без строки ни в
 * VideoUploadSession, ни в PropertyDraftMedia, не менявшаяся ORPHAN_DIR_HOURS, — удаляется.
 * Папка, где остался только итог сборки (state.json без частей), живёт сутки и удаляется
 * независимо от строки — итог уже никому не нужен.
 */
const ORPHAN_DIR_HOURS = 48;
const FINISHED_DIR_HOURS = 24;

export async function cleanupOrphanUploadDirs(now = Date.now()): Promise<number> {
  const dirs = await listLocalUploadSessionDirs();
  const candidates = dirs.filter((d) => !d.hasMeta && now - d.mtimeMs > FINISHED_DIR_HOURS * 60 * 60 * 1000);
  if (candidates.length === 0) return 0;
  const ids = candidates.map((d) => d.id);
  const [sessions, media] = await Promise.all([
    prisma.videoUploadSession.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    prisma.propertyDraftMedia.findMany({ where: { id: { in: ids } }, select: { id: true } }),
  ]);
  const referenced = new Set([...sessions.map((s) => s.id), ...media.map((m) => m.id)]);
  let removed = 0;
  for (const d of candidates) {
    const onlyResult = (await listLocalUploadParts(d.id)).length === 0 && (await readLocalUploadSessionState(d.id)) !== null;
    const orphan = !referenced.has(d.id) && now - d.mtimeMs > ORPHAN_DIR_HOURS * 60 * 60 * 1000;
    if ((onlyResult || orphan) && (await abortLocalUploadSession(d.id))) removed++;
  }
  return removed;
}

/**
 * Брошенные загрузки общего ядра (ролик карточки, файл в переписку, свободный ролик): та же
 * уборка, что раньше (lib/chunkedUploadSessions.ts::sweepStaleChunkedUploads), но автор
 * теперь получает пуш, как у видео объекта: загрузка пропала не молча.
 */
/** Мелкие файлы (фото в переписку) не беспокоят: человек и не заметит, что загрузка ушла. */
export const ABANDONED_UPLOAD_PUSH_MIN_BYTES = 50 * 1024 * 1024;

export async function notifyAbandonedChunkedUpload(s: { id: string; meta: ChunkedUploadMeta }): Promise<void> {
  if (!(s.meta.sizeBytes >= ABANDONED_UPLOAD_PUSH_MIN_BYTES)) return;
  await sendPushToAgent(s.meta.agentId, {
    title: "⚠️ Загрузка отменена",
    body: `Загрузка «${s.meta.filename}» не была завершена за сутки — выберите файл заново`,
    tag: `chunked-upload-cancelled-${s.id}`,
  }).catch((err) => console.error("[uploadCleanup] пуш автору:", err instanceof Error ? err.message : err));
}
