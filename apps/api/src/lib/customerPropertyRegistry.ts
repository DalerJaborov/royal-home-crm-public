import { z } from "zod";
import type { ChatMessage } from "../ai/client.js";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { CRM_PUBLISHED_POST_KEYS, crmMediaKeys } from "./ads/crmMediaRegistryKeys.js";
import { customerPropertyScopeKey } from "./customerPropertyScope.js";
import { customerPropertyUrl } from "./customerPropertyUrls.js";
import { resolvePropertyFromPageUrl } from "./resolvePropertyFromPageUrl.js";
import type { CustomerPropertyRegistry } from "./customerPropertyResolver.js";

/** Same CRM_MEDIA full/tail convention. DISTINCT+LIMIT9 preserves ambiguity. */
async function mediaCandidates(reference: string): Promise<string[]> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(reference)) return [];
  const keys = crmMediaKeys(reference);
  const query = async (tail: boolean) => {
    const key = tail ? keys[keys.length - 1] : reference;
    const rows = await prisma.$queryRaw<{ propertyId: string }[]>(Prisma.sql`
      SELECT DISTINCT matches."propertyId" FROM (
        SELECT p."id" AS "propertyId" FROM "Property" p
        CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(p."publishedPostIds") = 'object'
          THEN p."publishedPostIds" ELSE '{}'::jsonb END) entry
        WHERE entry.key IN (${Prisma.join(CRM_PUBLISHED_POST_KEYS)}) AND jsonb_typeof(entry.value) = 'string'
          AND (CASE WHEN ${tail} THEN regexp_replace(entry.value #>> '{}', '^.*_', '')
            ELSE entry.value #>> '{}' END) = ${key}
        UNION ALL
        SELECT "propertyId" FROM "PropertyPhotoPost" WHERE "status" = 'PUBLISHED'
          AND ((CASE WHEN ${tail} THEN regexp_replace("mediaId", '^.*_', '') ELSE "mediaId" END) = ${key}
            OR (CASE WHEN ${tail} THEN regexp_replace("secondaryId", '^.*_', '') ELSE "secondaryId" END) = ${key})
        UNION ALL
        SELECT "propertyId" FROM "PropertyStoryPost"
          WHERE (CASE WHEN ${tail} THEN regexp_replace("mediaId", '^.*_', '') ELSE "mediaId" END) = ${key}
        UNION ALL
        SELECT "propertyId" FROM "PropertySocialRepost" WHERE "status" = 'PUBLISHED'
          AND ((CASE WHEN ${tail} THEN regexp_replace("mediaId", '^.*_', '') ELSE "mediaId" END) = ${key}
            OR (CASE WHEN ${tail} THEN regexp_replace("secondaryId", '^.*_', '') ELSE "secondaryId" END) = ${key})
        UNION ALL
        SELECT unnest("propertyIds") FROM "SocialDigestPost" WHERE "status" = 'PUBLISHED'
          AND ((CASE WHEN ${tail} THEN regexp_replace("mediaId", '^.*_', '') ELSE "mediaId" END) = ${key}
            OR (CASE WHEN ${tail} THEN regexp_replace("secondaryId", '^.*_', '') ELSE "secondaryId" END) = ${key})
      ) matches LIMIT 9`);
    return rows.map((row) => row.propertyId);
  };
  const exact = await query(false);
  // A bare tail can name both a composite ID and an exact bare ID. Only a
  // qualified ID may prefer an exact match over unrelated tail collisions.
  if (reference.includes("_") && exact.length) return exact;
  return [...new Set([...exact, ...await query(true)])].slice(0, 9);
}

export const customerPropertyRegistry: CustomerPropertyRegistry = {
  async ad(id) {
    const ad = await prisma.ad.findUnique({
      where: { platform_externalId: { platform: "META", externalId: id } },
      select: { propertyId: true, properties: { select: { propertyId: true }, take: 9 } },
    });
    return ad ? { ids: [...new Set([ad.propertyId, ...ad.properties.map((item) => item.propertyId)].filter((item): item is string => !!item))] } : null;
  },
  media: mediaCandidates,
  async url(url) {
    if (url.kind === "site") {
      // The pure origin/format gate above precedes this existing read-only helper.
      const id = await resolvePropertyFromPageUrl(url.url);
      return id ? [id] : [];
    }
    if (url.kind === "media") return mediaCandidates(url.mediaId);
    const rows = await prisma.property.findMany({
      where: { OR: ["p", "reel", "reels"].map((kind) => ({ instagramUrl: { contains: `/${kind}/${url.shortcode}` } })) },
      select: { id: true, instagramUrl: true }, take: 9,
    });
    // A capped partial prefix scan cannot prove that the sole exact match is unique.
    if (rows.length === 9) return rows.map((row) => row.id);
    return rows.filter((row) => {
      const parsed = row.instagramUrl ? customerPropertyUrl(row.instagramUrl) : null;
      return parsed?.kind === "instagram" && parsed.shortcode === url.shortcode;
    }).map((row) => row.id);
  },
  async selector(reference) {
    const uuid = /^uuid:(.+)$/.exec(reference)?.[1];
    if (uuid && z.string().uuid().safeParse(uuid).success) {
      const row = await prisma.property.findUnique({ where: { id: uuid }, select: { id: true } });
      return row ? [row.id] : [];
    }
    const short = /^short:([1-9]\d{0,8})$/.exec(reference)?.[1];
    if (!short) return [];
    const row = await prisma.property.findUnique({ where: { shortId: Number(short) }, select: { id: true } });
    return row ? [row.id] : [];
  },
  async reply(mid, scope) {
    const row = await prisma.botConversation.findUnique({
      where: { id: scope.conversationId }, select: { messages: true, accountId: true, channel: true, subscriberId: true, endpointScopeId: true },
    });
    if (!row || row.accountId !== scope.accountId || row.channel !== scope.channel ||
        (scope.accountId === null && scope.channel !== "WEBSITE" && !scope.endpointScopeId) ||
        (scope.endpointScopeId && row.endpointScopeId !== scope.endpointScopeId) ||
        customerPropertyScopeKey(row.channel, row.subscriberId, row.accountId, scope.endpointScopeId) !== scope.scopeKey) return [];
    const messages = Array.isArray(row.messages) ? row.messages as unknown as ChatMessage[] : [];
    const ids: string[] = [];
    for (const message of messages) {
      if (message.role !== "assistant" || message.by?.kind !== "bot") continue;
      if (message.customerPropertyDelivery && message.customerPropertyDelivery.status !== "accepted") continue;
      if (message.mid !== mid && message.mid2 !== mid && !message.attachments?.some((attachment) => attachment.mid === mid)) continue;
      const ref = message.customerPropertyReference;
      if (ref?.scopeKey === scope.scopeKey && z.string().uuid().safeParse(ref.propertyId).success) ids.push(ref.propertyId);
      // Legacy website cards contain server-built public short IDs, never model fields.
      else if (scope.channel === "WEBSITE" && message.propertyCard?.shortId) {
        const property = await prisma.property.findUnique({ where: { shortId: message.propertyCard.shortId }, select: { id: true } });
        if (property) ids.push(property.id);
      } else {
        // Legacy showcase link messages are server-built public links. Match
        // a complete link only, never an arbitrary number in model prose.
        const parsed = customerPropertyUrl(message.content.trim());
        if ("url" in parsed) ids.push(...await customerPropertyRegistry.url(parsed));
      }
    }
    return [...new Set(ids)].slice(0, 9);
  },
};
