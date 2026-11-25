import { uploadToPurpose, type ChunkedSessionHolder } from "./chunkedUpload";
import type { UploadLive } from "./upload/progressText";

/**
 * КОРОТКИЙ РОЛИК КАРТОЧКИ ОБЪЕКТА — ЧАСТЯМИ (17.11.2026). Одним запросом обход квартиры с
 * телефона (1080p, минута — больше 100 МБ) отбивал прокси перед сервером: 413 ещё до API.
 * Общие сессии (назначение `clip-video`, до 300 МБ), сборка — маршрут карточки объекта,
 * который проверяет права, длительность и ставит сжатие (routes/properties/videos.ts).
 * Зовут: очередь загрузок мастера (lib/uploadQueue.ts) и карточка (PropertyClipVideoCard).
 */
export const CLIP_COMPLETE_WAIT_MS = 120_000;

export function uploadClipVideo(
  propertyId: string,
  file: File,
  onProgress?: (percent: number) => void,
  /** Сессия прошлой попытки (очередь повторяет задание) — докачать в неё, а не грузить заново. */
  session?: ChunkedSessionHolder,
  /** Подробное состояние для строки прогресса и отмена человеком (25.11.2026). */
  extra: { onLive?: (live: UploadLive) => void; signal?: AbortSignal } = {}
): Promise<{ clipVideoStatus: string }> {
  return uploadToPurpose<{ clipVideoStatus: string }>("clip-video", file, {
    completeUrl: (sessionId) => `/api/v1/properties/${propertyId}/clip-video/upload-sessions/${sessionId}/complete`,
    completeWaitMs: CLIP_COMPLETE_WAIT_MS,
    onProgress,
    session,
    onLive: extra.onLive,
    signal: extra.signal,
    report: { kind: "clip", label: "короткий ролик объекта" },
  });
}
