/**
 * СРОК АВТОПУБЛИКАЦИИ РОЛИКА БЕЗ ОТВЕТА ХОЗЯИНА (11.11.2026, lib/clipReview.ts).
 * Отдельный модуль без зависимостей от базы: его зовут и приём ролика
 * (lib/videoHandoff.ts), и clipReview.ts, который сам импортирует videoHandoff —
 * общий модуль не замыкает цикл.
 */
import { DUSHANBE_OFFSET_MS, dushanbeWallClock } from "./dushanbeTime.js";

export const CLIP_OWNER_HOURS_MIN = 1;
export const CLIP_OWNER_HOURS_MAX = 48;
/** Ночное окно без автопубликации, часы по Душанбе: [00:00, 07:00). */
export const CLIP_OWNER_NIGHT_END_HOUR = 7;

export function clampClipOwnerHours(raw: number | null | undefined): number {
  return Math.min(CLIP_OWNER_HOURS_MAX, Math.max(CLIP_OWNER_HOURS_MIN, Math.round(raw ?? 3)));
}

/** Ночь по Душанбе (00:00–07:00) — автопубликация не срабатывает. */
export function isClipOwnerNight(at: Date): boolean {
  return dushanbeWallClock(at).getUTCHours() < CLIP_OWNER_NIGHT_END_HOUR;
}

/**
 * Когда ролик опубликуется сам: запрос + N часов; попал в ночь — 07:00 того же
 * дня по Душанбе.
 */
export function clipOwnerDueFrom(requestedAt: Date, hours: number): Date {
  const due = new Date(requestedAt.getTime() + clampClipOwnerHours(hours) * 3_600_000);
  if (!isClipOwnerNight(due)) return due;
  const wall = dushanbeWallClock(due);
  return new Date(
    Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), CLIP_OWNER_NIGHT_END_HOUR, 0, 0) - DUSHANBE_OFFSET_MS
  );
}
