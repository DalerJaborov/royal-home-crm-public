import { createHash } from "node:crypto";

export function customerPropertyScopeKey(channel: string, peer: string, accountId: string | null, endpointScopeId?: string | null): string {
  // Installed Settings Meta channels have no MessengerAccount UUID. Resource
  // A→B must not reuse A's ticket/focus namespace. Old unbound tickets stay held.
  if (channel !== "WEBSITE" && accountId === null) {
    if (!endpointScopeId) throw new Error("Installed Meta property scope requires its exact endpoint namespace");
    return createHash("sha256").update(JSON.stringify(["customer-property-scope-v2", channel, peer, endpointScopeId])).digest("hex");
  }
  return createHash("sha256").update(JSON.stringify(["customer-property-scope-v1", channel, peer, accountId])).digest("hex");
}
export function customerPropertyEventKey(scope: string, kind: string, identity: string): string {
  // The scope digest already identifies v1/v2. Preserve existing stable MID
  // hashes for installed accounts and WEBSITE, including their retry fences.
  return createHash("sha256").update(JSON.stringify(["customer-property-event-v1", scope, kind, identity])).digest("hex");
}
