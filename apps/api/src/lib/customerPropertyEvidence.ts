import { customerPropertyEvidenceSchema, type CustomerPropertyEvidence } from "@royal-home/shared";
import type { MetaIncoming } from "../messengers/meta.js";
import { customerPropertyShareLink, customerPropertyUrl } from "./customerPropertyUrls.js";
import { captionPropertyNumber, propertyNumberSelectors, schemelessPropertyUrls } from "./customerPropertyReferenceText.js";

export function mergeCustomerPropertyEvidence(groups: readonly (readonly CustomerPropertyEvidence[])[]): CustomerPropertyEvidence[] {
  const unique = [...new Map(groups.flat().map((item) => [JSON.stringify(item), item])).values()];
  if (unique.length <= 16) return unique;
  // Overflow must not hide a conflicting seventeenth reference and pick the first.
  return [...unique.slice(0, 15), { kind: "untrusted_reference", origin: "message", reference: "too_many_references" }];
}
function urlEvidence(raw: string, origin: CustomerPropertyEvidence["origin"]): CustomerPropertyEvidence {
  const parsed = customerPropertyUrl(raw);
  if ("url" in parsed) return { kind: "url", origin, reference: parsed.url };
  // An opaque share link is resolved later by one bounded redirect read, not rejected here.
  const share = customerPropertyShareLink(raw);
  if (share) return { kind: "url", origin, reference: share };
  // Never persist credentials, arbitrary query tokens, or the raw rejected URL.
  return { kind: "untrusted_reference", origin, reference: parsed.kind === "denied" ? "untrusted_origin" : "unsupported_format" };
}
export function customerPropertyEvidenceFromText(text: string): CustomerPropertyEvidence[] {
  const urls: CustomerPropertyEvidence[] = [];
  // A link typed without "https://" is the same public reference as one with it.
  const written = [...text.matchAll(/https?:\/\/[^\s<>"']+/giu)].map((match) => match[0].replace(/[),.;!?]+$/, "")).concat(schemelessPropertyUrls(text));
  for (const raw of written) {
    if (urls.length === 4) {
      urls.push({ kind: "untrusted_reference", origin: "message", reference: "too_many_references" });
      break;
    }
    urls.push(urlEvidence(raw, "message"));
  }
  let selectorCount = 0;
  for (const number of propertyNumberSelectors(text)) {
    if (selectorCount++ === 4) {
      urls.push({ kind: "untrusted_reference", origin: "message", reference: "too_many_references" });
      break;
    }
    urls.push({ kind: "public_selector", origin: "message", reference: `short:${number}` });
  }
  return mergeCustomerPropertyEvidence([urls]);
}

/** Raw normalized event only; do not pass the event after legacy referral memory merging. */
export function customerPropertyEvidenceFromMeta(message: MetaIncoming): CustomerPropertyEvidence[] {
  const evidence = customerPropertyEvidenceFromText(message.text);
  if (message.adId) {
    evidence.push({ kind: "ad", origin: message.propertyReferralOrigin ?? "referral", reference: message.adId,
      ...(message.adPostId ? { secondaryReference: message.adPostId } : {}) });
  } else if (message.adPostId) {
    evidence.push({ kind: "media", origin: "referral", reference: message.adPostId });
  }
  // WA mediaId is a downloadable file ID, never a published-property ID. Same item (with the caption
  // number, see the attachment loop) as the loop pushes, so the merge keeps one; the position is unchanged.
  const firstCaption = captionPropertyNumber(message.attachmentTitle);
  if (message.attachmentMediaId) evidence.push({ kind: "media", origin: "shared_media", reference: message.attachmentMediaId,
    ...(firstCaption ? { secondaryReference: `short:${firstCaption}` } : {}) });
  if (message.replyToMessageId) evidence.push({ kind: "reply", origin: "reply_to", reference: message.replyToMessageId });
  // Our own story is identified by its Instagram media id (PropertyStoryPost.mediaId). Its CDN url is
  // transport data and would only poison the resolution as an untrusted origin, so it is kept only
  // when Meta sent no id.
  if (message.replyToStoryId) evidence.push({ kind: "media", origin: "story", reference: message.replyToStoryId });
  else if (message.replyToStoryUrl) evidence.push(urlEvidence(message.replyToStoryUrl, "story"));
  const attachments = [{ type: message.attachmentType, url: message.attachmentUrl, attachmentMediaId: message.attachmentMediaId,
    attachmentTitle: message.attachmentTitle }, ...message.extraAttachments ?? []];
  for (const attachment of attachments) {
    // SHARED POST CAPTION (16.11.2026, Instagram chat of 16.11 21:29): Meta sends the caption of a shared
    // publication as `payload.title`, and our captions end with «Объект №N». It names the object of THIS
    // attachment, so it travels with the attachment's own references as `secondaryReference`: when the
    // publication is not in our registry (an agent's own account, a repost, a post published by hand) the
    // resolver falls back to the number, and a number that contradicts a registry match is a conflict.
    const caption = captionPropertyNumber(attachment.attachmentTitle);
    const captionRef = caption ? { secondaryReference: `short:${caption}` } : {};
    if (attachment.attachmentMediaId) evidence.push({ kind: "media", origin: "shared_media", reference: attachment.attachmentMediaId, ...captionRef });
    const parsed = attachment.url ? customerPropertyUrl(attachment.url) : null;
    if (attachment.url && parsed && "url" in parsed) {
      const item = urlEvidence(attachment.url, "shared_media");
      evidence.push(item.kind === "url" ? { ...item, ...captionRef } : item);
    } else if (caption && !attachment.attachmentMediaId) {
      // Only a CDN file (or nothing) besides the caption: the number is this share's single reference.
      evidence.push({ kind: "public_selector", origin: "shared_media", reference: `short:${caption}` });
    } else if (attachment.url && attachment.type === "share" && !attachment.attachmentMediaId) {
      // Meta's CDN is transport data. A registry media ID is the evidence for
      // that share; a CDN URL neither overrides it nor clears a known focus.
      evidence.push(urlEvidence(attachment.url, "shared_media"));
    }
  }
  // A public selector, never an ownership/capability grant or model instruction.
  const payload = /^rh:property:(\d{1,9}|[a-f0-9-]{36})$/i.exec(message.payload ?? "");
  if (payload) evidence.push({ kind: "public_selector", origin: "postback_payload",
    reference: /^\d+$/.test(payload[1]) ? `short:${payload[1]}` : `uuid:${payload[1]}` });
  return mergeCustomerPropertyEvidence([evidence.map((item) => customerPropertyEvidenceSchema.safeParse(item).success ? item :
    { kind: "untrusted_reference" as const, origin: "message" as const, reference: "invalid_reference" })]);
}

/**
 * The ONE place where perceived customer media becomes property evidence (same-turn media focus and the
 * media of an earlier, set-aside input). Spoken words and a listing card read like typed text. Any other
 * picture — a screenshot of our post, a video frame with its caption — counts only with the explicit
 * «Объект №N» of our captions: a lone «№12» on a photo is a house number as often as an object.
 */
export function customerPropertyEvidenceFromMedia(media: { subject: string; transcript: string; readableText: string }): CustomerPropertyEvidence[] {
  const caption = media.subject === "listing_card" ? null : captionPropertyNumber(media.readableText);
  return mergeCustomerPropertyEvidence([
    customerPropertyEvidenceFromText([media.transcript, media.subject === "listing_card" ? media.readableText : ""].join("\n")),
    caption ? [{ kind: "public_selector" as const, origin: "message" as const, reference: `short:${caption}` }] : [],
  ]);
}

export function customerPropertyEvidenceFromWebsite(input: { text: string; pageUrl?: string | null }): CustomerPropertyEvidence[] {
  const page = input.pageUrl ? customerPropertyUrl(input.pageUrl) : null;
  // The homepage/listing search page is not a new property reference.
  const pageEvidence = page && page.kind !== "unsupported" && input.pageUrl
    ? [urlEvidence(input.pageUrl, "website_page")] : [];
  return mergeCustomerPropertyEvidence([
    customerPropertyEvidenceFromText(input.text),
    pageEvidence,
  ]);
}
