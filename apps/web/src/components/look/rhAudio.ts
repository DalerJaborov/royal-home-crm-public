/**
 * Чистые части плеера `RhAudioPlayer` (20.11.2026, класс К01): время и длительность.
 * Отдельно от компонента, чтобы проверять без браузера.
 */

/** Секунды → «0:12», «12:05», «1:02:03». Бесконечность, NaN и минус — «0:00». */
export function audioClock(sec: number | null | undefined): string {
  const total = typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Длительность годится для показа: конечная и больше нуля (у webm Chrome отдаёт Infinity, у части файлов — NaN). */
export function usableDuration(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export const AUDIO_SPEEDS = [1, 1.5, 2] as const;
export type AudioSpeed = (typeof AUDIO_SPEEDS)[number];

/** Следующая скорость по кругу: 1× → 1,5× → 2× → 1×. */
export function nextAudioSpeed(current: number): AudioSpeed {
  const i = AUDIO_SPEEDS.findIndex((v) => v === current);
  return AUDIO_SPEEDS[(i + 1) % AUDIO_SPEEDS.length] ?? 1;
}

export function audioSpeedLabel(speed: number): string {
  return `${String(speed).replace(".", ",")}×`;
}
