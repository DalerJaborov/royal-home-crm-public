export interface RecentSearch { label: string; url: string; ts: number }
const LEGACY_KEY = "royalhome:recentSearches";
export const recentSearchKey = (actorId: string) => `${LEGACY_KEY}:${encodeURIComponent(actorId)}`;

export function clearRecentSearches(actorId?: string | null): void {
  try {
    localStorage.removeItem(LEGACY_KEY);
    if (actorId) localStorage.removeItem(recentSearchKey(actorId));
  } catch { /* Optional local history must not prevent sign-out. */ }
}

export function loadRecentSearches(actorId: string | null): RecentSearch[] {
  try {
    // Never migrate labels whose owner cannot be established.
    localStorage.removeItem(LEGACY_KEY);
    if (!actorId) return [];
    const entries: unknown = JSON.parse(localStorage.getItem(recentSearchKey(actorId)) ?? "[]");
    return Array.isArray(entries) ? entries.filter((entry): entry is RecentSearch =>
      typeof entry?.label === "string" && typeof entry?.url === "string" &&
      entry.url.startsWith("/") && !entry.url.startsWith("//") && Number.isFinite(entry?.ts)
    ).slice(0, 8) : [];
  } catch { return []; }
}

export function saveRecentSearch(actorId: string | null, entry: RecentSearch): void {
  if (!actorId) return;
  try {
    const entries = [entry, ...loadRecentSearches(actorId).filter(item => item.url !== entry.url)].slice(0, 8);
    localStorage.setItem(recentSearchKey(actorId), JSON.stringify(entries));
  } catch { /* Search remains available when storage is full or disabled. */ }
}
