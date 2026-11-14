import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { videoHandoffDir } from "../upload.js";
import { hasPublishedPostId } from "./publishedRawVideoRetention.js";

/**
 * ПОСТОЯННАЯ ОТКРЫТАЯ ССЫЛКА НА ГОТОВЫЙ РОЛИК ОБЪЕКТА (23.10.2026).
 *
 * Готовый файл монтажёра лежит в закрытой папке `uploads/handoff` (статикой она
 * не раздаётся, см. PRIVATE_UPLOAD_DIRS в app.ts). Сайту (видео вторым слайдом) и
 * товарному фиду Meta с видео нужна прямая скачиваемая ссылка на mp4 — её отдаёт
 * роут `GET /api/v1/public/property-video/<shortId>.mp4` (routes/publicFeed.ts).
 * Здесь — только правило «можно ли открыть ролик» и сборка адреса, без HTTP и БД.
 *
 * ФАЙЛ ДОЛЖЕН БЫТЬ НА ДИСКЕ (14.11.2026, охота на тихие поломки, №5). После переезда
 * сервера 6 из 87 готовых роликов остались в базе путём к файлу, которого нет:
 * сайт и товарный фид Meta получали 404, а в журнале на каждый такой объект ложилось
 * по ~600 строк. Ссылка выдаётся, только если файл есть (`propertyVideoFileExists`):
 * одна дверь для фида Meta и синхронизации с сайтом.
 */

/** Поля объекта, от которых зависит публичность ролика. */
export interface PublicVideoFacts {
  shortId: number;
  status: string;
  deletedAt: Date | null;
  publishedOnSite: boolean;
  offSite: boolean;
  videoHandoffFinalPath: string | null;
  publishedChannels: string[];
  publishedPostIds: unknown;
}

const PUBLIC_VIDEO_STATUSES = ["AVAILABLE", "RESERVED", "SOLD"];

/**
 * Ролик открыт всем, только если объект живой и показывается на сайте, у него есть
 * готовый файл и ролик РЕАЛЬНО вышел хотя бы в одном канале (то же правило, что и
 * у хранения исходников — hasPublishedPostId). Недомонтированный или ещё не
 * опубликованный файл наружу не отдаётся.
 */
export function isPropertyVideoPublic(p: PublicVideoFacts): boolean {
  if (p.deletedAt || !p.publishedOnSite || p.offSite) return false;
  if (!PUBLIC_VIDEO_STATUSES.includes(p.status)) return false;
  if (!p.videoHandoffFinalPath) return false;
  return hasPublishedPostId(p.publishedChannels, p.publishedPostIds);
}

/** Лежит ли готовый ролик в закрытой папке handoff: путь из базы берётся только по имени файла. */
export function propertyVideoFileExists(finalPath: string | null | undefined): boolean {
  if (!finalPath) return false;
  try {
    return fs.existsSync(path.join(videoHandoffDir, path.basename(finalPath)));
  } catch {
    return false;
  }
}

/** Короткий отпечаток имени файла: перемонтаж даёт новый файл → новая ссылка → сброс кэша. */
export function propertyVideoVersion(finalPath: string): string {
  return createHash("sha1").update(path.basename(finalPath)).digest("hex").slice(0, 10);
}

/** Публичная ссылка на mp4 либо undefined (нет адреса CRM, ролик не публичен или файла нет на диске). */
export function propertyPublicVideoUrl(p: PublicVideoFacts, crmBase: string | undefined): string | undefined {
  if (!crmBase || !isPropertyVideoPublic(p) || !propertyVideoFileExists(p.videoHandoffFinalPath)) return undefined;
  return `${crmBase}/api/v1/public/property-video/${p.shortId}.mp4?v=${propertyVideoVersion(p.videoHandoffFinalPath!)}`;
}
