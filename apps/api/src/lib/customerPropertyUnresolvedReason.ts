import type { CustomerPropertyEvidence } from "@royal-home/shared";

/** Why the current property reference could not be turned into an object.
 * Derived only from the server-held focus evidence, never from model text. */
export type CustomerPropertyUnresolvedReason = "no_reference" | "unsupported" | "untrusted_origin" | "not_found" | "lookup_unavailable"
  /** The customer came from our ad and sent no link or number, and the ad is not tied to an object. */
  | "ad_unmapped";

export function customerPropertyUnresolvedReason(evidence: readonly CustomerPropertyEvidence[] | undefined,
  status: "missing" | "ambiguous" | "denied" | "pending", lookupAttempts?: number): CustomerPropertyUnresolvedReason | undefined {
  if (status === "ambiguous") return undefined;
  // The last read of this evidence failed transiently (not "no such object").
  if (status === "missing" && lookupAttempts) return "lookup_unavailable";
  const items = evidence ?? [];
  const untrusted = items.filter(item => item.kind === "untrusted_reference");
  if (untrusted.some(item => item.reference === "untrusted_origin")) return "untrusted_origin";
  if (untrusted.length) return "unsupported";
  // Only an ad (no link, number or media the customer could have mistyped): do not blame a "link or number".
  if (items.length && items.every(item => item.kind === "ad")) return "ad_unmapped";
  return items.length ? "not_found" : "no_reference";
}
