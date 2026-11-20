import { z } from "zod";
import type { AttachmentSource } from "../messengers/attachments.js";
import { isMetaCdnUrl } from "../messengers/sharedPostCard.js";
import { customerPropertyUrl } from "./customerPropertyUrls.js";
import { customerPropertyUnresolvedReason } from "./customerPropertyUnresolvedReason.js";
import type { CustomerPropertyEvidence } from "@royal-home/shared";
import { customerDmForeignShareNoise } from "../ai/customerAgentAbuse.js";
import { customerSpamInterest } from "../ai/customerSpamMute.js";

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

/** Could this input be a publication forwarded from SOMEBODY ELSE'S account? Only an attachment that is a share, whose whole property
 * evidence is that share itself (an ad/story/reply/typed link/selector means the customer pointed at one of ours). Whether it IS foreign
 * is decided later from the lookup outcome (`customerShareLookupFoundNothing`): this is the necessary condition only. */
export function customerForeignShareCandidate(input: { kinds: readonly string[] | undefined;
  propertyEvidence: readonly { origin: string }[] }): boolean {
  return !!input.kinds?.length && input.kinds.every(kind => kind === "share") &&
    input.propertyEvidence.length > 0 && input.propertyEvidence.every(item => item.origin === "shared_media");
}

/**
 * ЧУЖОЙ ПОСТ ИЛИ РОЛИК БЕЗ СЛОВ — ИЗВЕСТЕН ДО СКАЧИВАНИЯ И МОДЕЛИ (владелец 21.11.2026: «спамерам не отвечать и не тратить
 * ИИ»; прод 1d15821e и 54fef009: чужой ролик скачивался, разбирался моделью и получал «Ин эълони мо нест…»). Все условия —
 * факты сервера, модель их не ставит:
 *  - вложение — только пересылка (`customerForeignShareCandidate`), своих слов нет или они шум (`customerDmForeignShareNoise`);
 *  - поиск в НАШЕМ каталоге для этого события закончился «такого нет» (не сбой чтения);
 *  - у каждого вложения ссылка CDN Meta: загрузчик всё равно не ищет такую публикацию в нашем аккаунте, «свой пост без
 *    объекта» отсюда не получится (lib/customerDmMediaContent.ts);
 *  - подпись пересланного поста не говорит о нас и о жилье (номер объекта, Royal Home, квартира, цена — уже не чужой шум).
 * Иначе — прежний путь (скачать, понять), а оператор на чужой пост без слов всё равно промолчит (ai/operator/decide.ts).
 */
export function customerForeignShareSettled(input: {
  candidate: boolean; media: readonly { url?: string | null }[];
  focus: { eventKey?: string | null; status: string; evidence?: readonly CustomerPropertyEvidence[]; lookupAttempts?: number } | null | undefined;
  eventKey: string; text: string; captions: readonly string[];
}): boolean {
  if (!input.candidate || !input.media.length || !customerDmForeignShareNoise(input.text)) return false;
  const focus = input.focus;
  if (!focus || focus.eventKey !== input.eventKey || focus.status !== "missing" ||
    customerPropertyUnresolvedReason(focus.evidence, "missing", focus.lookupAttempts) !== "not_found") return false;
  if (!input.media.every(item => !!item.url && isMetaCdnUrl(item.url))) return false;
  return !input.captions.some(caption => customerSpamInterest(caption));
}
