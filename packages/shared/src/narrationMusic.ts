import { z } from "zod";

/**
 * СВОЯ МУЗЫКА ДЛЯ ПЕРЕМОНТАЖА (18.11.2026): библиотека треков в Настройки → Озвучка. Договор сервера и
 * экрана в одном месте: пределы загрузки, входы маршрутов, вид списка. Сама логика — apps/api/src/lib/narrationMusic.ts.
 */
export const NARRATION_MUSIC_FORMATS = ["mp3", "m4a"] as const;
export type NarrationMusicFormat = (typeof NARRATION_MUSIC_FORMATS)[number];

/** 15 МБ — несколько минут mp3 высокого качества; 5 с — 10 мин по длине; 50 треков — с запасом. */
export const NARRATION_MUSIC_LIMITS = { maxBytes: 15 * 1024 * 1024, minSec: 5, maxSec: 600, maxTracks: 50 } as const;

/** Поля формы загрузки (сам файл — поле «file»). Название пустое — берётся имя файла. */
export const narrationMusicUploadSchema = z.object({ title: z.string().trim().max(80).optional() }).strict();
export const narrationMusicIdSchema = z.string().uuid();

export type NarrationMusicTrackView = { id: string; title: string; durationSec: number; sizeBytes: number; format: NarrationMusicFormat; createdAt: string };
export type NarrationMusicLibraryView = { tracks: NarrationMusicTrackView[]; canConfigure: boolean; limits: typeof NARRATION_MUSIC_LIMITS };

/** Название по имени файла: без расширения, подчёркивания — пробелами, не длиннее 80. */
export function narrationMusicTitleFromFile(filename: string): string {
  const base = filename.replace(/\.[A-Za-z0-9]{2,4}$/u, "").replace(/[_]+/gu, " ").trim();
  return (base || "Трек").slice(0, 80);
}

/** «1:05» для экрана. */
export function formatMusicDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
