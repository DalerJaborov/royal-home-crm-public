import type { CustomerPropertyAdmission, CustomerPropertyEvidence, CustomerPropertyResolution } from "@royal-home/shared";
import { customerPropertyShareLink, customerPropertyUrl, type CustomerPropertyUrl } from "./customerPropertyUrls.js";
import { logSystemError } from "./systemError.js";

export interface CustomerPropertyRegistry {
  ad(id: string): Promise<{ ids: string[] } | null>;
  media(id: string): Promise<string[]>;
  url(url: Exclude<CustomerPropertyUrl, { kind: "denied" | "unsupported" }>): Promise<string[]>;
  reply(mid: string, scope: Pick<CustomerPropertyAdmission, "conversationId" | "scopeKey" | "accountId" | "channel" | "endpointScopeId">): Promise<string[]>;
  selector(reference: string): Promise<string[]>;
  /** One bounded redirect read of an opaque share link; null = unusable, throws = transient failure. */
  expandShare?(share: string): Promise<string | null>;
}
const unique = (ids: readonly string[]) => [...new Set(ids)];

/** Pure decision logic; the registry below is strictly business reads. */
async function resolveOnce(
  evidence: readonly CustomerPropertyEvidence[],
  scope: Pick<CustomerPropertyAdmission, "conversationId" | "scopeKey" | "accountId" | "channel" | "endpointScopeId">,
  registry: CustomerPropertyRegistry,
): Promise<CustomerPropertyResolution> {
  const provenance = evidence.slice(0, 16);
  const result = (status: CustomerPropertyResolution["status"], ids: string[], reason: CustomerPropertyResolution["reason"]): CustomerPropertyResolution => ({
    status, propertyId: status === "resolved" ? ids[0] : null, candidates: unique(ids).slice(0, 8), reason, provenance,
  });
  if (evidence.length > 16) return result("denied", [], "unsupported");
  if (!evidence.length) return result("missing", [], "not_found");
  try {
    const groups: string[][] = [];
    for (const item of evidence) {
      let ids: string[];
      if (item.kind === "untrusted_reference") return result("denied", [], item.reference === "untrusted_origin" ? "untrusted_origin" : "unsupported");
      if (item.kind === "ad") {
        const ad = await registry.ad(item.reference);
        ids = unique(ad?.ids ?? []);
        // Capped registry results cannot prove uniqueness, even if visible
        // subsets would intersect in one property.
        if (ids.length > 8) return result("ambiguous", ids, "conflict");
        if (item.secondaryReference) {
          const material = unique(await registry.media(item.secondaryReference));
          if (material.length > 8) return result("ambiguous", [...ids, ...material], "conflict");
          if (material.length) {
            const common = material.filter((id) => ids.includes(id));
            if (ids.length && !common.length) return result("ambiguous", [...ids, ...material], "conflict");
            ids = ids.length ? common : material;
          }
        }
      } else if (item.kind === "url") {
        let parsed = customerPropertyUrl(item.reference);
        const share = "url" in parsed ? null : customerPropertyShareLink(item.reference);
        // A share link is expanded once into a Meta post URL and then handled like any typed link.
        if (share && registry.expandShare) {
          const destination = await registry.expandShare(share);
          if (destination) parsed = customerPropertyUrl(destination);
        }
        if (!("url" in parsed)) return result("denied", [], parsed.kind === "denied" ? "untrusted_origin" : "unsupported");
        ids = await registry.url(parsed);
      } else if (item.kind === "media") ids = await registry.media(item.reference);
      else if (item.kind === "reply") ids = await registry.reply(item.reference, scope);
      else ids = await registry.selector(item.reference);
      ids = unique(ids);
      // An unidentified explicit reference cannot be silently ignored in favour of A.
      if (!ids.length) return result("missing", [], item.kind === "reply" ? "untrusted_reply" : "not_found");
      if (ids.length > 8) return result("ambiguous", ids, "conflict");
      groups.push(ids);
    }
    const common = groups.reduce((left, right) => left.filter((id) => right.includes(id)));
    if (common.length === 1) return result("resolved", common, "unique");
    return result("ambiguous", groups.flat(), "conflict");
  } catch (error) {
    // A failed read is not "no such object": report it as unavailable, never as not found.
    void logSystemError("api", `customer property lookup failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      { dedupKey: "customer-property-lookup-failed" });
    return result("missing", [], "lookup_unavailable");
  }
}
/** One immediate retry of a transient read failure; a deterministic answer is never retried. */
export async function resolveCustomerPropertyEvidence(
  evidence: readonly CustomerPropertyEvidence[],
  scope: Pick<CustomerPropertyAdmission, "conversationId" | "scopeKey" | "accountId" | "channel" | "endpointScopeId">,
  registry: CustomerPropertyRegistry,
): Promise<CustomerPropertyResolution> {
  // A share link costs a network request: the immediate retry reuses its outcome (one request in all).
  const shares = new Map<string, Promise<string | null>>();
  const bounded: CustomerPropertyRegistry = registry.expandShare ? { ...registry, expandShare: (share) => {
    if (!shares.has(share)) shares.set(share, registry.expandShare!(share));
    return shares.get(share)!;
  } } : registry;
  const first = await resolveOnce(evidence, scope, bounded);
  return first.reason === "lookup_unavailable" ? resolveOnce(evidence, scope, bounded) : first;
}
