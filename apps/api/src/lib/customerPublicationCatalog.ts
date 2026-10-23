import { createHash } from "node:crypto";
import { customerAgentPublicationObservationSchema, type CustomerAgentPublicationObservation, type CustomerPropertyFactKind } from "@royal-home/shared";
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { readCustomerPropertyFacts } from "./customerPropertyFacts.js";
import { customerPropertyRegistry } from "./customerPropertyRegistry.js";
import { customerPropertyUrl } from "./customerPropertyUrls.js";

export type CustomerPublicationSource = CustomerAgentPublicationObservation["source"];
/** Existing publisher ledgers only. Facebook bare IDs are qualified with the
 * VERIFIED page; never a global suffix scan or arbitrary latest-property win.
 * Independent single-property mappings conflict with a digest, even if one of
 * its members coincides. Missing/ambiguous catalog entries remain unresolved. */
export async function readCustomerPublicationCatalog(source: CustomerPublicationSource) {
  if (!customerAgentPublicationObservationSchema.shape.source.safeParse(source).success) return null;
  if (!["INSTAGRAM", "FACEBOOK"].includes(source.channel) || !source.publicationId || !source.resourceId ||
      source.publicationId.length > 512 || source.resourceId.length > 512) return null;
  const keys = [source.publicationId];
  if (source.channel === "FACEBOOK") {
    const prefix = `${source.resourceId}_`;
    if (source.publicationId.includes("_")) {
      if (!source.publicationId.startsWith(prefix)) return null;
      keys.push(source.publicationId.slice(prefix.length));
    } else keys.push(`${prefix}${source.publicationId}`);
  }
  const channels = source.channel === "FACEBOOK" ? ["FACEBOOK", "FACEBOOK_POST"] : ["INSTAGRAM"];
  const rows = await prisma.$queryRaw<Array<{ kind: string; ids: string[] }>>(Prisma.sql`
    SELECT 'single' AS kind, ARRAY[p."id"] AS ids FROM "Property" p
      WHERE p."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM jsonb_each(
        CASE WHEN jsonb_typeof(p."publishedPostIds")='object' THEN p."publishedPostIds" ELSE '{}'::jsonb END) e
        WHERE e.key IN (${Prisma.join(channels)}) AND e.value #>> '{}' IN (${Prisma.join(keys)}))
    UNION ALL SELECT 'single', ARRAY["propertyId"] FROM "PropertyPhotoPost"
      WHERE "channel"=${source.channel} AND "status"='PUBLISHED'
        AND ("mediaId" IN (${Prisma.join(keys)}) OR "secondaryId" IN (${Prisma.join(keys)}))
    UNION ALL SELECT 'single', ARRAY["propertyId"] FROM "PropertySocialRepost"
      WHERE "channel"=${source.channel} AND "status"='PUBLISHED'
        AND ("mediaId" IN (${Prisma.join(keys)}) OR "secondaryId" IN (${Prisma.join(keys)}))
    UNION ALL SELECT 'digest', "propertyIds" FROM "SocialDigestPost"
      WHERE "channel"=${source.channel} AND "status"='PUBLISHED'
        AND ("mediaId" IN (${Prisma.join(keys)}) OR "secondaryId" IN (${Prisma.join(keys)})) LIMIT 12`);
  if (source.permalink) {
    const url = customerPropertyUrl(source.permalink);
    if (source.channel !== "INSTAGRAM" || url.kind !== "instagram") return null;
    const ids = await customerPropertyRegistry.url(url);
    if (ids.length > 1) return null;
    if (ids.length === 1) rows.push({ kind: "single", ids });
  }
  if (!rows.length || rows.length >= 12) return null;
  const normalized = rows.map(row => ({ kind: row.kind, ids: [...new Set(row.ids)].sort() }));
  const unique = [...new Map(normalized.map(row => [JSON.stringify(row), row])).values()];
  if (unique.length !== 1 || !unique[0].ids.length || unique[0].ids.length > 5) return null;
  const entry = unique[0];
  return { ids: entry.ids, signature: createHash("sha256").update(JSON.stringify({ source, entry })).digest("hex") };
}

export async function readCustomerPublicationObservation(source: CustomerPublicationSource, kinds: readonly CustomerPropertyFactKind[]): Promise<CustomerAgentPublicationObservation | null> {
  const catalog = await readCustomerPublicationCatalog(source);
  if (!catalog) return null;
  const all = [], open = [];
  for (const id of catalog.ids) {
    const facts = await readCustomerPropertyFacts(id, source.channel);
    if (!facts) continue;
    all.push(facts);
    if (facts.availability !== "SOLD") open.push(facts);
  }
  // A single known sold publication can answer status only. A sold member of a
  // multi-card showcase is not offered among the remaining properties, but when
  // EVERY member is sold the observation keeps them all (status only) so the
  // customer is told so instead of "could not identify the object".
  const cards = catalog.ids.length === 1 || (!open.length && all.length === catalog.ids.length) ? all : open;
  if (!cards.length || (await readCustomerPublicationCatalog(source))?.signature !== catalog.signature) return null;
  return customerAgentPublicationObservationSchema.parse({ kind: "publication_properties", source,
    mappingSignature: catalog.signature, kinds, cards, linksAllowed: (await loadCustomerAgentFeaturePolicy()).links });
}

export async function customerPublicationObservationCurrent(value: CustomerAgentPublicationObservation): Promise<boolean> {
  const parsed = customerAgentPublicationObservationSchema.safeParse(value);
  if (!parsed.success) return false;
  const fresh = await readCustomerPublicationObservation(parsed.data.source, parsed.data.kinds);
  return !!fresh && fresh.mappingSignature === value.mappingSignature && (fresh.linksAllowed !== false) === (value.linksAllowed !== false) && fresh.cards.length === value.cards.length &&
    fresh.cards.every((card, i) => card.propertyId === value.cards[i].propertyId && card.signature === value.cards[i].signature);
}
import { loadCustomerAgentFeaturePolicy } from "./customerAgentFeaturePolicy.js";
