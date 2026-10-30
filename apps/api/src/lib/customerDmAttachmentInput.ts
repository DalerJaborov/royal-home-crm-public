import type { CustomerAgentAttachmentInput } from "../ai/customerAgentAttachmentInput.js";
import type { CustomerNormalizedIngressInput } from "./customerIngressPayload.js";
import { customerPropertyUrl } from "./customerPropertyUrls.js";

/** Interpret the ORIGINAL encrypted transport payload without rewriting its
 * identity/hash or promoting an attachment caption into customer consent.
 * Older ig_reel/ig_post payloads were stored as unknown: publication ID and a
 * validated public post URL still identify them as a shared publication. */
export function customerDmAttachmentInput(payload: CustomerNormalizedIngressInput): CustomerAgentAttachmentInput | undefined {
  const kinds = payload.media.map((media, index) => {
    const classified = payload.observations.classifier?.mediaKinds?.[index];
    if (classified && classified !== "unknown") return classified;
    if (media.kind !== "unknown") return media.kind;
    const url = media.url ? customerPropertyUrl(media.url) : null;
    if (media.publicationId || url?.kind === "instagram" || url?.kind === "media") return "share" as const;
    if (url?.kind === "site") return "link" as const;
    return "unknown" as const;
  });
  if (!kinds.length && payload.propertyEvidence.some(e => (e.kind === "url" || e.kind === "media") && e.origin === "story")) kinds.push("share");
  return kinds.length ? { kinds } : undefined;
}
