import { prisma } from "../db.js";
import { abortLocalUploadSession } from "./localVideoStorage.js";
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
    // Сначала папка сессии на диске, и только потом запись о ней — тот же
    // порядок, что и у уборки видео объектов: обратный терял бы возможность
    // повторить отмену.
    const cancelled = await prisma.$transaction(async (tx) => {
      // The scan is only a candidate list. A PUT accepted while we were waiting
      // has refreshed updatedAt. Lock/reload before removing any bytes; normal
      // PUT metadata updates take this same PostgreSQL row lock implicitly.
      await tx.$queryRaw`SELECT id FROM "VideoUploadSession" WHERE id = ${session.id} FOR UPDATE`;
      const current = await tx.videoUploadSession.findUnique({ where: { id: session.id } });
      if (!current || current.updatedAt > emptyCutoff ||
        (current.updatedAt > cutoff && !(Array.isArray(current.parts) && current.parts.length === 0))) return false;
      // Retain the row on a filesystem failure, so a later sweep can retry.
      if (!await abortLocalUploadSession(current.id)) { result.failed++; return false; }
      await tx.videoUploadSession.delete({ where: { id: current.id } });
      return true;
    }, { timeout: 120_000 });
    if (cancelled) {
      result.sessions++;
      // Автору — пуш (07.10.2026): загрузка пропала молча, а он считал, что ролик
      // у объекта уже есть. Тег по сессии — повтор прохода не дублирует.
      await sendPushToAgent(session.createdById, {
        title: "⚠️ Загрузка видео отменена",
        body: `ОБ-${String(session.property.shortId).padStart(6, "0")}: загрузка «${session.filename}» не была завершена — загрузите ролик заново`,
        url: `/properties/${session.property.shortId}`,
        tag: `video-upload-cancelled-${session.id}`,
      }).catch((err) => console.error("[uploadCleanup] пуш автору:", err instanceof Error ? err.message : err));
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
