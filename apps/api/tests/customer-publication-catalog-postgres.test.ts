import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { readCustomerPublicationCatalog, readCustomerPublicationObservation, customerPublicationObservationCurrent } from "../src/lib/customerPublicationCatalog.js";
import { renderCustomerAgentDecision } from "../src/ai/customerAgentRenderer.js";
import { readPublicCommentPropertyFacts } from "../src/lib/customerPublicCommentStore.js";
const tag = `synthetic-publication-${randomUUID()}`, properties: string[] = [], digests: string[] = [];
const source = (suffix: string, channel: "INSTAGRAM" | "FACEBOOK" = "INSTAGRAM") =>
  ({ channel, resourceId: `${tag}-account`, publicationId: `${tag}-${suffix}` });
async function property(extra: Record<string, unknown> = {}) {
  const p = await prisma.property.create({ data: { title: "Synthetic catalog fixture", type: "APARTMENT", status: "AVAILABLE",
    publishedOnSite: true, rooms: 2, areaSqm: 64.5, floor: 3, totalFloors: 9, condition: "GOOD", price: 456789, currency: "TJS",
    address: "PRIVATE HOUSE APARTMENT SENTINEL", instagramUrl: `https://www.instagram.com/p/${randomUUID().replaceAll("-", "")}/`, ...extra } }); properties.push(p.id); return p;
}
afterAll(async () => {
  await prisma.socialDigestPost.deleteMany({ where: { id: { in: digests } } });
  await prisma.property.deleteMany({ where: { id: { in: properties } } });
});
it("preserves the existing exact YouTube facts reader without enabling managed YouTube delivery", async () => {
  const publicationId = `${tag}-youtube`, p = await property({ publishedPostIds: { YOUTUBE: publicationId } });
  const facts = await readPublicCommentPropertyFacts({ source: { table: "meta", id: randomUUID() }, text: "Цена?", target: {
    channel: "YOUTUBE", accountExternalId: `${tag}-channel`, publicationId, commentId: `${tag}-yt-comment`,
    parentId: null, threadId: `${tag}-yt-comment`, threadKind: "comment_anchor" } });
  expect(facts?.propertyId).toBe(p.id); expect(facts?.price).toBe("456789");
});
it("reuses published repost and secondary Facebook ledger IDs without provider I/O", async () => {
  const s = source("repost"), p = await property();
  await prisma.propertySocialRepost.create({ data: { propertyId: p.id, round: 1, hook: "Synthetic", channel: s.channel, status: "PUBLISHED", mediaId: s.publicationId } });
  expect((await readCustomerPublicationCatalog(s))?.ids).toEqual([p.id]);
  const fb = { channel: "FACEBOOK" as const, resourceId: `${tag}-page`, publicationId: `${tag}-page_${tag}-bare` };
  await prisma.propertyPhotoPost.create({ data: { propertyId: p.id, channel: "FACEBOOK", status: "PUBLISHED", secondaryId: `${tag}-bare` } });
  expect((await readCustomerPublicationCatalog(fb))?.ids).toEqual([p.id]);
  expect(await readCustomerPublicationCatalog({ ...fb, resourceId: "other-page" })).toBeNull();
});
it("does not select the latest property when two cards claim the same publication", async () => {
  const s = source("collision"); await property({ publishedPostIds: { INSTAGRAM: s.publicationId } });
  await property({ publishedPostIds: { INSTAGRAM: s.publicationId } });
  expect(await readCustomerPublicationCatalog(s)).toBeNull();
});
it("ignores failed/removed posts and the same ID in another channel", async () => {
  const s = source("removed"), p = await property();
  await prisma.propertyPhotoPost.create({ data: { propertyId: p.id, channel: "INSTAGRAM", status: "REMOVED", mediaId: s.publicationId } });
  await prisma.propertySocialRepost.create({ data: { propertyId: p.id, round: 1, hook: "Synthetic", channel: "FACEBOOK", status: "PUBLISHED", mediaId: s.publicationId } });
  expect(await readCustomerPublicationCatalog(s)).toBeNull();
});
it("deduplicates consistent direct/photo mappings rather than inventing ambiguity", async () => {
  const s = source("same"), p = await property({ publishedPostIds: { INSTAGRAM: s.publicationId } });
  await prisma.propertyPhotoPost.create({ data: { propertyId: p.id, channel: s.channel, status: "PUBLISHED", mediaId: s.publicationId } });
  expect((await readCustomerPublicationCatalog(s))?.ids).toEqual([p.id]);
});
it("renders real multi-property digest facts in RU/TG while dropping sold/private members", async () => {
  // A CI retry must not reuse a synthetic publication left by a failed attempt.
  const s = source(`digest-${randomUUID()}`), a = await property(), b = await property({ currency: "USD", price: 54000 }),
    sold = await property({ status: "SOLD" }), hidden = await property({ offSite: true });
  const post = await prisma.socialDigestPost.create({ data: { kind: "ROOMS", title: "Historic WRONG PRICE 1", channel: s.channel,
    status: "PUBLISHED", mediaId: s.publicationId, propertyIds: [a.id, b.id, sold.id, hidden.id] } }); digests.push(post.id);
  const value = await readCustomerPublicationObservation(s, ["price", "characteristics"]);
  expect(value?.cards).toHaveLength(2); expect(await customerPublicationObservationCurrent(value!)).toBe(true);
  for (const language of ["ru", "tg"] as const) {
    const priceOnly = renderCustomerAgentDecision({ decision: { kind: "reply", refs: [], social: "none", question: "none" }, evidence: [{ ref: "e0", value: value! }],
      language, requestedFacts: ["price"], knownPhoneSource: "none", maxOutputChars: 6000, surface: "public_comment" });
    expect(priceOnly).not.toBeNull(); expect(priceOnly).toContain("456 789"); expect(priceOnly).toContain("54 000 USD");
    expect(priceOnly).not.toContain("64,5");
    expect(priceOnly).not.toMatch(/PRIVATE|WRONG|телефон|Рақаматон|записал/); expect(priceOnly).not.toContain(a.id);
    const text = renderCustomerAgentDecision({ decision: { kind: "reply", refs: [], social: "none", question: "none" }, evidence: [{ ref: "e0", value: value! }],
      language, requestedFacts: ["price", "characteristics"], knownPhoneSource: "none", maxOutputChars: 6000, surface: "public_comment" });
    expect(text).toContain("456 789"); expect(text).toContain("54 000 USD"); expect(text).toContain("64,5");
    expect(text).not.toMatch(/PRIVATE|WRONG|телефон|Рақаматон|записал/); expect(text).not.toContain(a.id);
  }
  await prisma.property.update({ where: { id: a.id }, data: { price: 999999 } });
  expect(await customerPublicationObservationCurrent(value!)).toBe(false);
});
it("membership/status changes invalidate publication delivery evidence", async () => {
  const s = source("fresh"), p = await property();
  const post = await prisma.socialDigestPost.create({ data: { kind: "ROOMS", title: "Synthetic", channel: s.channel,
    status: "PUBLISHED", mediaId: s.publicationId, propertyIds: [p.id] } }); digests.push(post.id);
  const value = await readCustomerPublicationObservation(s, ["price"]); expect(value).not.toBeNull();
  await prisma.socialDigestPost.update({ where: { id: post.id }, data: { status: "REMOVED" } });
  expect(await customerPublicationObservationCurrent(value!)).toBe(false);
});
it("does not merge independent single/digest claims or truncate an oversized digest", async () => {
  const s = source("ambiguous-digest"), p = await property({ publishedPostIds: { INSTAGRAM: s.publicationId } });
  const post = await prisma.socialDigestPost.create({ data: { kind: "ROOMS", title: "Synthetic", channel: s.channel,
    status: "PUBLISHED", mediaId: s.publicationId, propertyIds: [p.id] } }); digests.push(post.id);
  expect(await readCustomerPublicationCatalog(s)).toBeNull();
  await prisma.property.update({ where: { id: p.id }, data: { publishedPostIds: {} } });
  await prisma.socialDigestPost.update({ where: { id: post.id }, data: { propertyIds: Array.from({ length: 6 }, () => randomUUID()) } });
  expect(await readCustomerPublicationCatalog(s)).toBeNull();
});
