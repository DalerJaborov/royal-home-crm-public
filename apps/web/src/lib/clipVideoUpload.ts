import { uploadToPurpose } from "./chunkedUpload";

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
  onProgress?: (percent: number) => void
): Promise<{ clipVideoStatus: string }> {
  return uploadToPurpose<{ clipVideoStatus: string }>("clip-video", file, {
    completeUrl: (sessionId) => `/api/v1/properties/${propertyId}/clip-video/upload-sessions/${sessionId}/complete`,
    completeWaitMs: CLIP_COMPLETE_WAIT_MS,
    onProgress,
  });
}
