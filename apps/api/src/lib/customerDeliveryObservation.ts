import { prisma, type TxClient } from "../db.js";
import { CUSTOMER_DELIVERY_AMBIGUITY_WINDOW_MS } from "./customerDeliveryOutcome.js";

/** Scoped transport observation only: never customer identity or a grant. A
 * missing MID with a live/unknown attempt cannot safely prove human takeover. */
export async function inspectCustomerDeliveryObservation(input: { endpointScopeId: string; peerId: string; mid?: string; observedAt?: Date },
  db: Pick<TxClient, "$queryRaw"> = prisma): Promise<
  { status: "known_own"; partId: string; attemptId: string } | { status: "ambiguous_own_send" } | { status: "none" }
> {
  if (input.mid) {
    const rows = await db.$queryRaw<Array<{ partId: string; attemptId: string }>>`SELECT p."id" AS "partId",a."id" AS "attemptId"
      FROM "CustomerDeliveryAttempt" a JOIN "CustomerOutboxPart" p ON p."id"=a."partId"
      WHERE a."endpointScopeId"=${input.endpointScopeId} AND (CASE WHEN p."sourceKind"='HANDOVER_ACK' THEN p."fenceJson"->'after'->'endpoint'->>'peerId' ELSE p."fenceJson"->'endpoint'->>'peerId' END)=${input.peerId}
        AND a."providerMid"=${input.mid} AND a."outcome"='ACCEPTED' LIMIT 2`;
    if (rows.length === 1) return { status: "known_own", ...rows[0] };
    if (rows.length > 1) return { status: "ambiguous_own_send" };
  }
  // Ambiguity is bounded in time: a part still IN_FLIGHT/UNKNOWN more than the window after it was
  // created no longer holds later input (it stays UNKNOWN for staff, never resent). Held input is
  // re-classified on recovery and resumes once the window passes or an echo settles the part.
  // Original arrival only bounds outstanding ambiguity; a later exact accepted
  // MID still proves the same own attempt after restart/lease expiry.
  const observedAt = input.observedAt ?? null;
  if (observedAt && !Number.isFinite(observedAt.getTime())) return { status: "ambiguous_own_send" };
  const [pending] = await db.$queryRaw<{ exists: boolean }[]>`SELECT EXISTS(SELECT 1 FROM "CustomerOutboxPart" p
    WHERE p."endpointScopeId"=${input.endpointScopeId} AND (CASE WHEN p."sourceKind"='HANDOVER_ACK' THEN p."fenceJson"->'after'->'endpoint'->>'peerId' ELSE p."fenceJson"->'endpoint'->>'peerId' END)=${input.peerId}
      AND p."status" IN ('IN_FLIGHT','UNKNOWN')
      AND p."createdAt">now()-${CUSTOMER_DELIVERY_AMBIGUITY_WINDOW_MS}*interval '1 millisecond'
      AND (${observedAt}::timestamptz IS NULL OR p."createdAt"<=${observedAt})) AS exists`;
  return { status: pending?.exists ? "ambiguous_own_send" : "none" };
}
