import { customerShieldPauseFenceSchema, type CustomerFence } from "@royal-home/shared";

/** A timestamp is not ownership: staff claim/unclaim and binding/credential ABA
 * must invalidate shield undo even if the visible pause dates happen to match. */
export function customerShieldPauseMatches(raw: unknown, current: CustomerFence): boolean {
  const parsed = customerShieldPauseFenceSchema.safeParse(raw);
  if (!parsed.success) return false;
  const saved = parsed.data.fence;
  return saved.inquiryId === current.inquiryId && saved.nativeId === current.nativeId &&
    saved.endpoint.endpointScopeId === current.endpoint.endpointScopeId && saved.endpoint.channel === current.endpoint.channel &&
    saved.endpoint.accountId === current.endpoint.accountId && saved.endpoint.peerId === current.endpoint.peerId &&
    saved.endpoint.threadId === current.endpoint.threadId && saved.ownerToken === current.ownerToken &&
    saved.ownershipEpoch === current.ownershipEpoch && saved.bindingRevision === current.bindingRevision &&
    saved.scopeRevision === current.scopeRevision && saved.policyRevision === current.policyRevision;
}
