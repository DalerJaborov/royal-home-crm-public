import { enqueueBackgroundJob } from "../jobs/enqueue.js";

/**
 * Постановка разбора начала ролика (jobs/videoOpening.ts). Отдельный лёгкий
 * модуль, чтобы HTTP-процесс ставил задание, не загружая сам обработчик
 * (ffmpeg, ИИ) — тот же разрыв, что описан в jobs/registry.ts.
 */
export const VIDEO_OPENING_JOB_TYPE = "video-opening";

export function scheduleVideoOpening(propertyId: string, videoPath: string): Promise<unknown> {
  return enqueueBackgroundJob({
    type: VIDEO_OPENING_JOB_TYPE,
    payload: { propertyId, videoPath },
    // Ключ на объект, а не на файл: новый ролик объекта перезаводит то же
    // задание с новым путём, а не копит очередь из старых файлов.
    dedupeKey: `video-opening:${propertyId}`,
    maxAttempts: 2,
  });
}
