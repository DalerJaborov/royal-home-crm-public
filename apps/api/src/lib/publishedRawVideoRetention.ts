export const RAW_VIDEO_PUBLISHED_AT = "RAW_VIDEO_PUBLISHED_AT";
export const RAW_VIDEO_PUBLISHED_PATH = "RAW_VIDEO_PUBLISHED_PATH";
export const PROPERTY_VIDEO_RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;

/** Called only with successful video publication results. Duplicate callbacks do not reset the clock. */
export function rawVideoPublicationMarks(
  current: Record<string, unknown>,
  succeeded: Array<{ channel: string; postId?: string }>,
  finalPath: string | null,
  now = new Date()
): Record<string, string> {
  if (!finalPath || !succeeded.some(r => r.postId && current[r.channel] !== r.postId)) return {};
  return { [RAW_VIDEO_PUBLISHED_AT]: now.toISOString(), [RAW_VIDEO_PUBLISHED_PATH]: finalPath };
}

export interface PublishedSourceFacts {
  status: string;
  deletedAt: Date | null;
  videoHandoffStatus: string;
  clipReviewStatus: string;
  videoHandoffFinalPath: string | null;
  publishedChannels: string[];
  publishedPostIds: unknown;
}

/** No fallback to approval, scheduled publication, stage age, or file mtime. */
export function publishedSourceCutoff(p: PublishedSourceFacts, now = new Date()): Date | null {
  if (p.deletedAt || !["AVAILABLE", "RESERVED", "SOLD", "WITHDRAWN"].includes(p.status)) return null;
  if (!["NONE", "RECEIVED"].includes(p.videoHandoffStatus) || !["NONE", "APPROVED"].includes(p.clipReviewStatus)) return null;
  const marks = p.publishedPostIds;
  if (!marks || typeof marks !== "object" || Array.isArray(marks)) return null;
  const ids = marks as Record<string, unknown>;
  if (!p.publishedChannels.some(c => typeof ids[c] === "string" && ids[c])) return null;
  if (Object.entries(ids).some(([key, value]) => key.endsWith("_PENDING") && value)) return null;
  if (!p.videoHandoffFinalPath || ids[RAW_VIDEO_PUBLISHED_PATH] !== p.videoHandoffFinalPath) return null;
  const at = ids[RAW_VIDEO_PUBLISHED_AT];
  if (typeof at !== "string") return null;
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp) || timestamp > now.getTime() - PROPERTY_VIDEO_RETENTION_DAYS * DAY_MS) return null;
  return new Date(timestamp);
}
