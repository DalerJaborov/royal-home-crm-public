// Original envelope ownership, not a customer principal or execution grant.
import type { TxClient } from "../db.js";
import type { CustomerTransportReference } from "./customerConversationScope.js";
import type { CustomerNormalizedIngressInput } from "./customerIngressPayload.js";
import { customerIngressPayloadHash } from "./customerIngressPayload.js";

/** Exact scoped native evidence is a duplicate guard only. It must not turn
 * mutable transcript text into CORE ownership, FINAL-IN or a new action. */
export async function findOriginalNativeMid(tx: TxClient, input: CustomerNormalizedIngressInput,
  transport: CustomerTransportReference): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT c."id" FROM "BotConversation" c
    WHERE c."endpointScopeId"=${transport.endpointScopeId} AND c."channel"=${input.channel}
      AND c."subscriberId"=${input.peer} AND c."accountId" IS NOT DISTINCT FROM ${transport.accountId}
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c."messages")='array'
        THEN c."messages" ELSE '[]'::jsonb END) m WHERE m->>'role'='user' AND m->>'mid'=${input.eventId})
    LIMIT 2 FOR SHARE OF c`;
  if (rows.length > 1) throw new Error("Original native source ambiguous");
  return rows[0]?.id ?? null;
}

export async function persistOriginalLegacySource(tx: TxClient, value: {
  input: CustomerNormalizedIngressInput; transport: CustomerTransportReference;
  eventKey: string; scopeKey: string; assignmentId: string | null;
  nativeHistoryId?: string; receivedAt: number;
}): Promise<{ fresh: boolean; order: string }> {
  const { input, transport, eventKey, scopeKey } = value;
  const hash = customerIngressPayloadHash(input);
  const provenance = value.nativeHistoryId ? "NATIVE_HISTORY" : "META_ENVELOPE";
  const [inserted] = await tx.$queryRaw<Array<{ order: bigint }>>`INSERT INTO "CustomerPropertyIngressTicket"
    ("eventKey","scopeKey","endpointScopeId","eventKind","rolloutAssignmentId","receivedAt","providerOccurredAt",
     "conversationId","originalConversationId","routingSourceVersion","routingSourceHash","routingScopeRevision","routingProvenance")
    VALUES (${eventKey},${scopeKey},${transport.endpointScopeId},${input.eventKind},${value.assignmentId},${new Date(value.receivedAt)},
      ${input.providerOccurredAt ? new Date(input.providerOccurredAt) : null},${value.nativeHistoryId ?? null},${value.nativeHistoryId ?? null},
      1,${hash},${BigInt(transport.scopeRevision)},${provenance})
    ON CONFLICT ("eventKey") DO NOTHING RETURNING "order"`;
  const [stored] = await tx.$queryRaw<Array<{ order: bigint; scopeKey: string; endpointScopeId: string | null;
    rolloutAssignmentId: string | null; routingSourceHash: string | null; routingScopeRevision: bigint | null;
    routingProvenance: string | null }>>`SELECT "order","scopeKey","endpointScopeId","rolloutAssignmentId",
      "routingSourceHash","routingScopeRevision","routingProvenance" FROM "CustomerPropertyIngressTicket"
      WHERE "eventKey"=${eventKey} FOR UPDATE`;
  if (!stored || stored.scopeKey !== scopeKey || stored.endpointScopeId !== transport.endpointScopeId ||
      stored.rolloutAssignmentId !== value.assignmentId || stored.routingSourceHash !== hash ||
      stored.routingScopeRevision?.toString() !== transport.scopeRevision || stored.routingProvenance !== provenance) {
    throw new Error("Original routing source changed");
  }
  return { fresh: inserted !== undefined, order: stored.order.toString() };
}
