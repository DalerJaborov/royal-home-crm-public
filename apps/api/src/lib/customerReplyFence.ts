import { revalidateCustomerPrincipal, type CustomerPrincipal } from "./customerPrincipal.js";
import type { CustomerTransportReference } from "./customerConversationScope.js";

/** Expected refusal before provider POST, not a network failure or retry grant. */
export class CustomerReplyHeldError extends Error {
  constructor() { super("Customer reply held before provider POST"); }
}

/** Server-only original principal; JSON lookalikes fail P05's opaque lookup.
 * Point-in-time check immediately before POST, never atomic provider delivery. */
export async function assertCustomerReplyPost(principal: CustomerPrincipal, channel: string, peer: string,
  transport: CustomerTransportReference): Promise<void> {
  const result = await revalidateCustomerPrincipal(principal);
  if (result.status !== "current" || principal.scope.channel !== channel || transport.channel !== channel || principal.scope.peer !== peer ||
      principal.scope.accountId !== transport.accountId || principal.scope.endpointScopeId !== transport.endpointScopeId ||
      principal.authority.fence.scopeRevision !== transport.scopeRevision) throw new CustomerReplyHeldError();
}
