import type { CustomerFence } from "@royal-home/shared";
import type { CustomerStateDb } from "./customerState.js";

/** Read-only relation for the exact new Client this inquiry's bridge created.
 * It permits remembering customer words/contact availability, never identity,
 * old consent, an executable input or delivery authority. Any native A→B→A,
 * deletion, takeover or later reassignment exceeds the exact expected deltas.
 * The optional one assignment must have the existing intake policy's receipt. */
export async function readOwnedCustomerIntakeContinuity(db: CustomerStateDb, fence: CustomerFence):
  Promise<{ bindingRevision: string; ownershipEpoch: string } | null> {
  if (!fence.nativeId || !["INSTAGRAM", "FACEBOOK", "WHATSAPP"].includes(fence.endpoint.channel)) return null;
  const [row] = await db.$queryRaw<Array<{ bindingRevision: string; ownershipEpoch: string }>>`SELECT
    a."bindingRevision"::text AS "bindingRevision",a."ownershipEpoch"::text AS "ownershipEpoch"
    FROM "CustomerInquiry" i JOIN "BotConversation" b ON b."id"=i."conversationId"
    JOIN "Client" c ON c."id"=b."clientId" AND c."deletedAt" IS NULL
    JOIN "CustomerAction" a ON a."resourceId"=c."id" AND a."inquiryId"=i."id"
      AND a."kind"='new_lead' AND a."status"='COMMITTED' AND a."supersededAt" IS NULL
      AND a."resourceType"='Client' AND a."resourceId"=c."id" AND a."receiptVersion"=1 AND a."committedAt" IS NOT NULL
    JOIN "CustomerEndpointScope" s ON s."id"=i."endpointScopeId"
    WHERE i."id"=${fence.inquiryId} AND b."id"=${fence.nativeId} AND i."closedAt" IS NULL
      AND i."ownerMode"='BOT' AND i."ownerToken"=${fence.ownerToken}
      AND i."bindingRevision"=${BigInt(fence.bindingRevision)} AND i."ownershipEpoch"=${BigInt(fence.ownershipEpoch)}
      AND i."endpointScopeId"=${fence.endpoint.endpointScopeId} AND s."scopeRevision"=${BigInt(fence.scopeRevision)}
      AND a."scopeRevision"=${BigInt(fence.scopeRevision)} AND s."channel"=${fence.endpoint.channel}
      AND b."endpointScopeId"=i."endpointScopeId" AND b."subscriberId"=${fence.endpoint.peerId}
      AND i."peerId"=b."subscriberId" AND i."threadId"=${fence.endpoint.threadId}
      AND b."accountId" IS NOT DISTINCT FROM ${fence.endpoint.accountId}
      AND s."messengerAccountId" IS NOT DISTINCT FROM b."accountId"
      AND (c."customerIntakeActionId"=a."id" OR (c."customerIntakeActionId" IS NULL
        AND a."policyResult"->>'policyCommittedAt' IS NOT NULL
        AND a."policyResult"->'intakeOutcome'->>'mode' IN ('assigned','other','night_pending','unassigned')))
      AND ((i."bindingRevision"=a."bindingRevision"+1 AND i."ownershipEpoch"=a."ownershipEpoch" AND c."assignedAgentId" IS NULL)
        OR (i."bindingRevision"=a."bindingRevision"+2 AND i."ownershipEpoch"=a."ownershipEpoch"+1
          AND a."policyResult"->'intakeOutcome'->>'mode'='assigned'
          AND c."assignedAgentId"=a."policyResult"->'intakeOutcome'->>'agentId'))
    LIMIT 1`;
  return row ?? null;
}
