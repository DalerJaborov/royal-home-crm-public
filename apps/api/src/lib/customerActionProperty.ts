import { customerPropertyFocusSchema, type CustomerFence } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { readCustomerPropertyFacts } from "./customerPropertyFacts.js";
import { customerPropertyScopeKey } from "./customerPropertyScope.js";

export interface CustomerActionProperty {
  propertyId: string; shortId: number; signature: string; updatedAt: string;
  focusGeneration: string; focusRevision: number;
}
/** Public catalog only. Canonical input/owner and write rights are checked by
 * the issuer separately. This projection can never discover Client identity. */
export async function readCustomerActionProperty(fence: CustomerFence, db: TxClient = prisma): Promise<CustomerActionProperty | null> {
  if (!fence.nativeId) return null;
  const native = await db.botConversation.findUnique({ where: { id: fence.nativeId }, select: {
    endpointScopeId: true, channel: true, subscriberId: true, accountId: true,
    customerPropertyFocus: true, customerPropertyFocusRevision: true,
  } });
  const endpoint = fence.endpoint;
  if (!native || native.endpointScopeId !== endpoint.endpointScopeId || native.channel !== endpoint.channel ||
      native.accountId !== endpoint.accountId || native.subscriberId !== endpoint.peerId) return null;
  const focus = customerPropertyFocusSchema.safeParse(native.customerPropertyFocus);
  if (!focus.success || focus.data.status !== "resolved" || !focus.data.propertyId ||
      focus.data.scopeKey !== customerPropertyScopeKey(endpoint.channel, endpoint.peerId, endpoint.accountId, endpoint.endpointScopeId)) return null;
  const facts = await readCustomerPropertyFacts(focus.data.propertyId, endpoint.channel, db);
  return facts ? { propertyId: facts.propertyId, shortId: facts.shortId, signature: facts.signature, updatedAt: facts.updatedAt,
    focusGeneration: focus.data.generation, focusRevision: native.customerPropertyFocusRevision } : null;
}
/** Call after canonical native/focus lock AND target Property lock. Compare the
 * original observation, including updatedAt for publication/facts ABA. */
export async function assertCustomerActionProperty(tx: TxClient, fence: CustomerFence, expected: CustomerActionProperty): Promise<void> {
  const current = await readCustomerActionProperty(fence, tx);
  if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("Customer action property changed");
}
