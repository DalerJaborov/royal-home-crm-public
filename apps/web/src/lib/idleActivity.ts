export const LEGACY_LAST_ACTIVITY_KEY = "royal-home-last-activity";
export const idleActivityKey = (actorId: string) => `${LEGACY_LAST_ACTIVITY_KEY}:${encodeURIComponent(actorId)}`;

export function clearIdleActivity(actorId?: string | null): void {
  try {
    localStorage.removeItem(LEGACY_LAST_ACTIVITY_KEY);
    if (actorId) localStorage.removeItem(idleActivityKey(actorId));
  } catch { /* Storage may be disabled; auth cleanup still proceeds. */ }
}

/** A legacy timestamp can belong to the persisted session being reopened. Explicit
 * login clears it; never extend an existing deadline merely because React mounts. */
export function readIdleActivity(actorId: string, now: number, fallback = now): number {
  try {
    const key = idleActivityKey(actorId);
    const raw = localStorage.getItem(key) ?? localStorage.getItem(LEGACY_LAST_ACTIVITY_KEY);
    const value = raw === null ? NaN : Number(raw);
    const last = Number.isFinite(value) && value > 0 && value <= now ? value : fallback;
    localStorage.setItem(key, String(last));
    localStorage.removeItem(LEGACY_LAST_ACTIVITY_KEY);
    return last;
  } catch { return fallback; }
}
