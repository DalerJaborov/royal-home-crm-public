import { z } from "zod";
import type { AttachmentSource } from "../messengers/attachments.js";
import { isMetaCdnUrl } from "../messengers/sharedPostCard.js";
import { customerPropertyUrl } from "./customerPropertyUrls.js";

const FIELDS = "id,permalink,media_type,media_url,children{id,media_type,media_url}";
const assetSchema = z.object({ id: z.string().regex(/^\d{1,80}$/), media_type: z.string().max(40).optional(),
  media_url: z.string().max(4096).optional() }).passthrough();
const publicationSchema = assetSchema.extend({ permalink: z.string().max(4096).optional(),
  children: z.object({ data: z.array(assetSchema).max(100) }).passthrough().optional() }).passthrough();
const pageSchema = z.object({ data: z.array(z.unknown()).max(100), paging: z.object({
  next: z.string().max(8192).optional(), cursors: z.object({ after: z.string().min(1).max(1024) }).passthrough().optional(),
}).passthrough().optional() }).passthrough();
const publicCode = (url: string | undefined) => { const parsed = url ? customerPropertyUrl(url) : null;
  return parsed?.kind === "instagram" ? parsed.shortcode : null; };
function assets(value: z.infer<typeof publicationSchema>): AttachmentSource[] {
  // A thumbnail is not a video. Only actual media bytes may become perception.
  const items = value.media_type === "CAROUSEL_ALBUM" ? value.children?.data ?? [] : [value];
  return items.flatMap(item => {
    if (!["IMAGE", "VIDEO"].includes(item.media_type ?? "") || !item.media_url || !isMetaCdnUrl(item.media_url)) return [];
    const url = new URL(item.media_url);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return [];
    return [{ url: url.toString(), declaredKind: item.media_type === "VIDEO" ? "video" : "image" }];
  }).slice(0, 3);
}

/** Same own-feed/permalink lookup used by legacy ownMedia, with the ORIGINAL
 * account only and explicit bounds. reel_video_id is often a legacy Instagram
 * ID, not the Graph media ID. No global/default token, HTML scraper, arbitrary
 * provider paging URL, cross-account cache or inferred "foreign" classification.
 * An inaccessible post remains inaccessible, never proof that pixels were seen. */
export async function resolveCustomerSharedPublication(target: { url?: string; publicationId?: string },
  read: (path: string) => Promise<unknown>, check: () => Promise<void>): Promise<AttachmentSource[]> {
  const code = publicCode(target.url);
  const numericId = target.publicationId && /^\d{1,80}$/.test(target.publicationId) ? target.publicationId : null;
  if (target.url && !code || !code && !numericId) return [];
  const get = async (path: string) => { await check(); const result = await read(path); await check(); return result; };
  if (numericId) {
    const raw = await get(`/${numericId}?fields=${FIELDS}`);
    if (raw && typeof raw === "object" && "unavailable" in raw) return [];
    const direct = publicationSchema.safeParse(raw);
    if (direct.success && direct.data.id === numericId && (!code || publicCode(direct.data.permalink) === code)) {
      const found = assets(direct.data); if (found.length) return found;
    }
  }
  if (!code) return [];
  let after: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < 3; page++) {
    const parsed = pageSchema.safeParse(await get(`/me/media?fields=${FIELDS}&limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`));
    if (!parsed.success) return [];
    const matches = parsed.data.data.flatMap(raw => { const item = publicationSchema.safeParse(raw);
      return item.success && publicCode(item.data.permalink) === code ? [item.data] : []; });
    if (matches.length > 1) return []; // Conflicting records are not a unique asset.
    if (matches.length === 1) return assets(matches[0]);
    const cursor = parsed.data.paging?.cursors?.after;
    if (!parsed.data.paging?.next || !cursor || seenCursors.has(cursor)) break;
    seenCursors.add(cursor); after = cursor;
  }
  return [];
}
