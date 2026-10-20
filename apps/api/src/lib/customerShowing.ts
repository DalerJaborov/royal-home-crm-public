import { type TxClient } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { createShowingTx, rescheduleShowingTx, cancelShowingTx, lockShowingClientTx,
  lockShowingPropertiesTx, lockShowingTx, ShowingMutationError } from "./showingMutation.js";

export type CustomerShowingKind = "book_showing" | "reschedule_showing" | "cancel_showing";
type Reference = { inquiryId: string; kind: CustomerShowingKind; originBookingActionId?: string };
type Origin = { clientId: string; interactionId: string | null; propertyId: string | null; originBookingActionId: string | null };
// This is a lock-order witness, NEVER customer identity or mutation authority.
// Its lifetime is also checked against the actual active transaction callback.
const prelocked = new WeakMap<object, Map<string, Origin>>();
const key = (input: Reference) => `${input.inquiryId}:${input.kind}:${input.originBookingActionId ?? ""}`;

async function resolveOrigin(tx: TxClient, input: Reference): Promise<Origin | null> {
  if (input.kind === "book_showing") {
    const rows = await tx.$queryRaw<Origin[]>`SELECT c."id" AS "clientId",NULL::text AS "interactionId",NULL::text AS "propertyId",NULL::text AS "originBookingActionId"
      FROM "CustomerInquiry" i JOIN "BotConversation" b ON b."id"=i."conversationId"
      JOIN "Client" c ON c."id"=b."clientId" AND c."deletedAt" IS NULL
      JOIN "CustomerAction" a ON a."inquiryId"=i."id" AND a."kind"='new_lead' AND a."status"='COMMITTED'
        AND a."resourceType"='Client' AND a."resourceId"=c."id"
      WHERE i."id"=${input.inquiryId} AND i."closedAt" IS NULL AND b."endpointScopeId"=i."endpointScopeId"
        AND b."subscriberId"=i."peerId" LIMIT 2`;
    return rows.length === 1 ? rows[0] : null;
  }
  if (!input.originBookingActionId) return null;
  const rows = await tx.$queryRaw<Origin[]>`SELECT s."clientId",s."id" AS "interactionId",s."propertyId",a."id" AS "originBookingActionId"
    FROM "CustomerAction" a JOIN "CustomerInquiry" i ON i."id"=a."inquiryId"
    JOIN "BotConversation" b ON b."id"=i."conversationId"
    JOIN "Interaction" s ON s."id"=a."resourceId" AND s."customerBookingActionId"=a."id"
    JOIN "Client" c ON c."id"=s."clientId" AND c."deletedAt" IS NULL
    WHERE a."id"=${input.originBookingActionId} AND a."inquiryId"=${input.inquiryId} AND a."kind"='book_showing'
      AND a."status"='COMMITTED' AND a."resourceType"='Interaction' AND i."closedAt" IS NULL
      AND a."bindingRevision"=i."bindingRevision"
      AND b."clientId"=s."clientId" AND b."endpointScopeId"=i."endpointScopeId" AND b."subscriberId"=i."peerId"`;
  return rows.length === 1 ? rows[0] : null;
}

/** Call BEFORE canonical native/scope/policy/Inquiry locks. No phone, profile or
 * nearest-showing lookup. Preliminary joins only select the row to lock; they
 * do not authorize the action. The exact origin is reread after canonical locks. */
export async function prelockCustomerShowingTx(tx: TxClient, input: Reference): Promise<{ clientId: string } | null> {
  if (!isActiveTransactionClient(tx)) throw new Error("Customer showing requires an active transaction");
  const origin = await resolveOrigin(tx, input);
  if (!origin) return null;
  await lockShowingClientTx(tx, origin.clientId);
  const locked = await resolveOrigin(tx, input);
  if (!locked || JSON.stringify(locked) !== JSON.stringify(origin)) return null;
  const witnesses = prelocked.get(tx) ?? new Map<string, Origin>();
  witnesses.set(key(input), locked); prelocked.set(tx, witnesses);
  return { clientId: locked.clientId };
}

/** Customer-only eligibility on the already prelocked Client. This is not a
 * write grant or automatic lead acceptance; legacy showing policy is separate. */
export async function assertCustomerShowingAgentTx(tx: TxClient, clientId: string): Promise<void> {
  if (!isActiveTransactionClient(tx)) throw new Error("Customer showing requires an active transaction");
  const client = await tx.client.findUnique({ where: { id: clientId }, select: { assignedAgentId: true, acceptedAt: true } });
  if (!client?.assignedAgentId || !client.acceptedAt) throw new ShowingMutationError("no_agent");
  const agent = await tx.agent.findUnique({ where: { id: client.assignedAgentId }, select: { isActive: true } });
  if (!agent?.isActive) throw new ShowingMutationError("no_agent");
}

/** Internal resource adapter for the shared journal. The caller must validate
 * the ORIGINAL current-IN authority/intent/fence and insert its EXECUTING Action
 * first. This adapter neither mints authority nor commits or sends anything. */
export async function executeCustomerShowingTx(tx: TxClient, input: Reference & {
  clientId: string; actionId: string; propertyId: string | null; at: Date; now: Date;
  expectedRevision?: string; channel: string; notes: string; meetingSummaryAfterShowingMinutes: number;
  /** DB-only proposal/consent/public-facts revalidation AFTER target locks.
   * Throw on mismatch; no provider/model/network work is allowed here. */
  validateLockedTarget?: (tx: TxClient) => Promise<void>;
}) {
  if (!isActiveTransactionClient(tx)) throw new Error("Customer showing requires an active transaction");
  const witnessed = prelocked.get(tx)?.get(key(input));
  const origin = await resolveOrigin(tx, input);
  if (!witnessed || !origin || origin.clientId !== input.clientId || JSON.stringify(origin) !== JSON.stringify(witnessed)) throw new ShowingMutationError("stale_showing");
  const actions = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "CustomerAction" WHERE "id"=${input.actionId}
    AND "inquiryId"=${input.inquiryId} AND "kind"=${input.kind} AND "status"='EXECUTING' AND "resourceId" IS NULL FOR UPDATE`;
  if (actions.length !== 1) throw new ShowingMutationError("stale_showing");
  if (input.kind === "book_showing") {
    // Customer actions cannot borrow the property agent as a substitute for an
    // assigned intake Client. The legacy kernel deliberately retains that rule.
    await assertCustomerShowingAgentTx(tx, input.clientId);
  } else {
    // Ownership is not proof of WHICH appointment the customer meant. Until
    // delivery-backed proposal confirmation exists, a bare move/cancel cannot
    // let a model choose between two still-pending owned bookings.
    const eligible = await tx.$queryRaw<{ id: string }[]>`SELECT s."id" FROM "CustomerAction" a
      JOIN "CustomerInquiry" i ON i."id"=a."inquiryId"
      JOIN "Interaction" s ON s."customerBookingActionId"=a."id" AND s."id"=a."resourceId"
      WHERE a."inquiryId"=${input.inquiryId} AND a."kind"='book_showing' AND a."status"='COMMITTED'
        AND a."resourceType"='Interaction' AND a."bindingRevision"=i."bindingRevision"
        AND s."clientId"=${input.clientId} AND s."nextAction" IS NOT NULL AND s."completedAt" IS NULL
        AND s."nextActionDate" IS NOT NULL LIMIT 2`;
    if (eligible.length !== 1 || eligible[0].id !== origin.interactionId) throw new ShowingMutationError("stale_showing");
  }
  await lockShowingPropertiesTx(tx, [origin.propertyId, input.propertyId]);
  let resourceId: string;
  let originBookingActionId: string;
  if (input.kind === "book_showing") {
    if (!input.propertyId) throw new ShowingMutationError("no_property");
    if (await tx.interaction.findFirst({ where: { clientId: input.clientId, type: "SHOWING", completedAt: null,
      nextAction: { not: null }, nextActionDate: { gte: input.now } }, select: { id: true } })) throw new ShowingMutationError("stale_showing");
    if (!input.validateLockedTarget) throw new ShowingMutationError("stale_showing");
    await input.validateLockedTarget(tx);
    const created = await createShowingTx(tx, { clientId: input.clientId, propertyId: input.propertyId, at: input.at, now: input.now,
      notes: input.notes, actor: { kind: "bot", channel: input.channel } });
    resourceId = created.id; originBookingActionId = input.actionId;
    // Origin and initial revision are local effects, in the SAME journal tx.
    // The parent journal still owns receipt/job insertion and final commit.
    await tx.$executeRaw`UPDATE "Interaction" SET "customerBookingActionId"=${input.actionId},"managedShowingRevision"=1
      WHERE "id"=${resourceId} AND "customerBookingActionId" IS NULL`;
  } else {
    if (!origin.interactionId || !origin.originBookingActionId || origin.propertyId !== input.propertyId || !input.expectedRevision || !/^[1-9]\d*$/.test(input.expectedRevision)) throw new ShowingMutationError("stale_showing");
    await lockShowingTx(tx, input.clientId, origin.interactionId);
    const revisions = await tx.$queryRaw<{ revision: bigint | null }[]>`SELECT "managedShowingRevision" AS revision FROM "Interaction"
      WHERE "id"=${origin.interactionId} AND "customerBookingActionId"=${origin.originBookingActionId} FOR UPDATE`;
    if (revisions.length !== 1 || revisions[0].revision === null || revisions[0].revision.toString() !== input.expectedRevision) throw new ShowingMutationError("stale_showing");
    if (input.kind === "reschedule_showing" && !input.validateLockedTarget) throw new ShowingMutationError("stale_showing");
    if (input.validateLockedTarget) await input.validateLockedTarget(tx);
    resourceId = origin.interactionId; originBookingActionId = origin.originBookingActionId;
    if (input.kind === "reschedule_showing") {
      if (!input.propertyId) throw new ShowingMutationError("no_property");
      await rescheduleShowingTx(tx, { clientId: input.clientId, interactionId: resourceId,
        at: input.at, now: input.now, actorKind: "client", meetingSummaryAfterShowingMinutes: input.meetingSummaryAfterShowingMinutes,
        notes: (row) => `${row.notes}\n${input.notes}` });
    }
    else await cancelShowingTx(tx, { clientId: input.clientId, interactionId: resourceId, now: input.now, actorKind: "client",
      notes: (row) => `${row.notes}\n${input.notes}` });
  }
  const observed = await tx.$queryRaw<{ revision: bigint | null; at: Date | null; propertyId: string | null }[]>(Prisma.sql`
    SELECT "managedShowingRevision" AS revision,"nextActionDate" AS at,"propertyId" FROM "Interaction"
    WHERE "id"=${resourceId} AND "customerBookingActionId"=${originBookingActionId}`);
  if (!observed[0] || observed[0].revision === null || !observed[0].at || (input.kind !== "cancel_showing" && !observed[0].propertyId)) throw new ShowingMutationError("stale_showing");
  return { resourceId, revision: observed[0].revision.toString(), at: observed[0].at, propertyId: observed[0].propertyId, originBookingActionId };
}
