import { useSyncExternalStore } from "react";
import {
  getDraftMediaSnapshot,
  getDraftPhotoLocationSnapshot,
  subscribeDraftMedia,
  subscribeDraftPhotoLocation,
  type DraftMediaItem,
} from "../lib/draftUploads";
import type { ExifGpsPoint } from "../lib/exifGps";

/**
 * Подписка на ход загрузки файлов черновика (lib/draftUploads.ts) — тем же
 * способом, что и на общую очередь загрузки: useSyncExternalStore со снимком по
 * ссылке. Модуль отдаёт новый массив на каждое изменение, поэтому третий
 * аргумент (снимок для сервера) — та же функция: рендера на сервере у CRM нет.
 */
export function useDraftMedia(): DraftMediaItem[] {
  return useSyncExternalStore(subscribeDraftMedia, getDraftMediaSnapshot, getDraftMediaSnapshot);
}

/** Точка, найденная в EXIF первого добавленного снимка — `null`, пока не найдена. */
export function useDraftPhotoLocation(): ExifGpsPoint | null {
  return useSyncExternalStore(subscribeDraftPhotoLocation, getDraftPhotoLocationSnapshot, getDraftPhotoLocationSnapshot);
}

export interface DraftMediaSummary {
  photos: DraftMediaItem[];
  videos: DraftMediaItem[];
  /** Сколько файлов ещё едет или ждёт очереди. */
  pending: number;
  /** Сколько не ушло и ждёт кнопки «Повторить» (упавшие и потерянные вместе). */
  failed: number;
  /** Из них потеряно: самого файла у вкладки нет, нужно выбрать заново. */
  lost: number;
  /** Сколько файлов уже на сервере. */
  ready: number;
  /** Отдано байт по всем файлам. */
  loadedBytes: number;
  /** Общий процент по всем файлам — для строки на шаге проверки. */
  percent: number;
  totalBytes: number;
}

export function summarizeDraftMedia(items: DraftMediaItem[]): DraftMediaSummary {
  const photos = items.filter((i) => i.kind === "photo");
  const videos = items.filter((i) => i.kind === "video");
  const pending = items.filter((i) => i.status === "queued" || i.status === "uploading").length;
  const failed = items.filter((i) => i.status === "failed" || i.status === "lost").length;
  const lost = items.filter((i) => i.status === "lost").length;
  const ready = items.filter((i) => i.status === "ready").length;
  const totalBytes = items.reduce((sum, i) => sum + i.sizeBytes, 0);
  const loaded = items.reduce((sum, i) => sum + Math.min(i.loaded, i.sizeBytes), 0);
  return {
    photos,
    videos,
    pending,
    failed,
    lost,
    ready,
    loadedBytes: loaded,
    percent: totalBytes > 0 ? Math.min(100, Math.round((loaded / totalBytes) * 100)) : 0,
    totalBytes,
  };
}
