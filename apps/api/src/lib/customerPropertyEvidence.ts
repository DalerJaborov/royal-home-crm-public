import { customerPropertyEvidenceSchema, type CustomerPropertyEvidence } from "@royal-home/shared";
import type { MetaIncoming } from "../messengers/meta.js";
import { customerPropertyUrl } from "./customerPropertyUrls.js";
import { propertyNumberSelectors, schemelessPropertyUrls } from "./customerPropertyReferenceText.js";

export function mergeCustomerPropertyEvidence(groups: readonly (readonly CustomerPropertyEvidence[])[]): CustomerPropertyEvidence[] {
  const unique = [...new Map(groups.flat().map((item) => [JSON.stringify(item), item])).values()];
  if (unique.length <= 16) return unique;
  // Overflow must not hide a conflicting seventeenth reference and pick the first.
  return [...unique.slice(0, 15), { kind: "untrusted_reference", origin: "message", reference: "too_many_references" }];
}
function urlEvidence(raw: string, origin: CustomerPropertyEvidence["origin"]): CustomerPropertyEvidence {
  const parsed = customerPropertyUrl(raw);
  if ("url" in parsed) return { kind: "url", origin, reference: parsed.url };
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
  // WA mediaId is a downloadable file ID, never a published-property ID.
  if (message.attachmentMediaId) evidence.push({ kind: "media", origin: "shared_media", reference: message.attachmentMediaId });
  if (message.replyToMessageId) evidence.push({ kind: "reply", origin: "reply_to", reference: message.replyToMessageId });
  if (message.replyToStoryUrl) evidence.push(urlEvidence(message.replyToStoryUrl, "story"));
  const attachments = [{ type: message.attachmentType, url: message.attachmentUrl, attachmentMediaId: message.attachmentMediaId },
    ...message.extraAttachments ?? []];
  for (const attachment of attachments) {
    if (attachment.attachmentMediaId) evidence.push({ kind: "media", origin: "shared_media", reference: attachment.attachmentMediaId });
    if (!attachment.url) continue;
    const parsed = customerPropertyUrl(attachment.url);
    if ("url" in parsed) evidence.push(urlEvidence(attachment.url, "shared_media"));
    // Meta's CDN is transport data. A registry media ID is the evidence for
    // that share; a CDN URL neither overrides it nor clears a known focus.
    else if (attachment.type === "share" && !attachment.attachmentMediaId) {
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
