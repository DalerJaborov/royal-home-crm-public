import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { z } from "zod";
import { customerFenceSchema, customerRevisionSchema, customerOwnerModeSchema, isReadOnlyRole, parsePermissionOverrides, resolvePermissions,
  type CustomerFence, type CustomerStateSnapshot, type Role } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { can } from "../auth/middleware.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { lockCustomerStateSnapshot, transitionCustomerState } from "./customerState.js";
import { ownBotConversationWhere } from "./ownBotConversationScope.js";

export type ManagedCustomerRequestKind = "CALLBACK" | "HUMAN";
export type ManagedCustomerRequestStatus = "QUEUED" | "ACCEPTED" | "CLOSED";
export interface ManagedCustomerCallbackView {
  id: string; requestKind: ManagedCustomerRequestKind; lifecycleStatus: ManagedCustomerRequestStatus;
  lifecycleRevision: string; assignedAgentId: string | null; acceptedAt: string | null; closureReason: string | null;
}
type TaskRow = {
  id: string; customerActionId: string; inquiryId: string; conversationId: string | null;
  requestKind: string | null; lifecycleStatus: string | null; lifecycleRevision: string | null;
  assignedAgentId: string | null; acceptedAt: Date | null; closureReason: string | null; doneAt: Date | null;
  actionKind: string; generation: bigint; actionStatus: string; supersededAt: Date | null; handoverFence: unknown; currentIntent: boolean;
};
export type CustomerCallbackStaffCommand = {
  requestId: string; expectedRevision: string; action: "accept" | "return" | "close";
};
export type CustomerCallbackStaffResult =
  | { status: "applied"; task: ManagedCustomerCallbackView }
  | { status: "not_found" | "denied" | "stale"; reason: string }
  | { status: "unknown"; reason: "commit_unconfirmed" };

function lifecycleView(row: TaskRow): ManagedCustomerCallbackView | null {
  if ((row.requestKind !== "CALLBACK" && row.requestKind !== "HUMAN") ||
      (row.lifecycleStatus !== "QUEUED" && row.lifecycleStatus !== "ACCEPTED" && row.lifecycleStatus !== "CLOSED") ||
      (!customerRevisionSchema.safeParse(row.lifecycleRevision).success || row.lifecycleRevision === "0")) return null;
  return { id: row.id, requestKind: row.requestKind, lifecycleStatus: row.lifecycleStatus,
    lifecycleRevision: row.lifecycleRevision!, assignedAgentId: row.assignedAgentId,
    acceptedAt: row.acceptedAt?.toISOString() ?? null, closureReason: row.closureReason };
}
// Staff can handle a pending task after global rollback/OFF. This grants no
// BOT OUT/write capability: semantic state/intent/policy revisions may advance,
// while native binding, namespace revision and owner epoch/token must match.
function sameOwnerBinding(left: CustomerFence, right: CustomerFence): boolean {
  return left.inquiryId === right.inquiryId && left.nativeId === right.nativeId && left.ownerToken === right.ownerToken &&
    left.ownershipEpoch === right.ownershipEpoch && left.bindingRevision === right.bindingRevision &&
    left.scopeRevision === right.scopeRevision &&
    left.endpoint.endpointScopeId === right.endpoint.endpointScopeId && left.endpoint.accountId === right.endpoint.accountId &&
    left.endpoint.channel === right.endpoint.channel && left.endpoint.peerId === right.endpoint.peerId &&
    left.endpoint.threadId === right.endpoint.threadId;
}
function sameFence(left: CustomerFence, right: CustomerFence): boolean {
  return sameOwnerBinding(left, right) && left.stateRevision === right.stateRevision &&
    left.intentRevision === right.intentRevision && left.policyRevision === right.policyRevision;
}
const witnessSchema = z.object({ version: z.literal(1), fence: customerFenceSchema,
  ownerMode: customerOwnerModeSchema, ownerAgentId: z.string().uuid().nullable() }).strict();
function handoverWitness(value: unknown) {
  const parsed = witnessSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
/** Structural witness comparison only, never customer/staff authorization.
 * Semantic IN/policy changes do not rebind a persisted task to a new owner. */
export function managedCustomerCallbackWitnessMatches(value: unknown, snapshot: CustomerStateSnapshot): boolean {
  const witness = handoverWitness(value);
  return !!witness && sameOwnerBinding(witness.fence, snapshot.fence) &&
    witness.ownerMode === snapshot.ownerMode && witness.ownerAgentId === snapshot.ownerAgentId;
}
async function saveWitness(tx: TxClient, requestId: string, snapshot: CustomerStateSnapshot): Promise<void> {
  const witness = witnessSchema.parse({ version: 1, fence: snapshot.fence, ownerMode: snapshot.ownerMode, ownerAgentId: snapshot.ownerAgentId });
  const count = await tx.$executeRaw`UPDATE "CallbackRequest" SET "handoverFence"=${JSON.stringify(witness)}::jsonb
    WHERE "id"=${requestId} AND "customerActionId" IS NOT NULL`;
  if (count !== 1) throw new Error("Customer request lost its ownership witness");
}

/** Local journal mutation only, never an authority issuer. The journal must
 * have validated its opaque grant and inserted this EXECUTING action first.
 * Canonical locks precede action/task locks; no provider call occurs here. */
export async function createManagedCustomerCallbackTx(tx: TxClient, input: {
  actionId: string; fence: CustomerFence; requestKind: ManagedCustomerRequestKind; topic: string; phone: string | null;
}): Promise<{ resourceId: string; lifecycleRevision: string; snapshot: CustomerStateSnapshot }> {
  if (!isActiveTransactionClient(tx) || !customerFenceSchema.safeParse(input.fence).success ||
      !["CALLBACK", "HUMAN"].includes(input.requestKind) || !input.topic.trim() || input.topic.trim().length > 500 ||
      (input.requestKind === "CALLBACK" && !input.phone)) throw new Error("Invalid managed customer request mutation");
  const snapshot = await lockCustomerStateSnapshot(tx, { inquiryId: input.fence.inquiryId });
  if (!snapshot || !sameFence(snapshot.fence, input.fence) || snapshot.ownerMode !== "BOT" || snapshot.closedAt ||
      !snapshot.fence.nativeId) throw new Error("Managed customer request fence changed");
  const rows = await tx.$queryRaw<Array<{ id: string; kind: string; status: string }>>`SELECT "id","kind","status" FROM "CustomerAction"
    WHERE "id"=${input.actionId} AND "inquiryId"=${snapshot.fence.inquiryId} FOR UPDATE`;
  const action = rows[0];
  if (rows.length !== 1 || action.status !== "EXECUTING" ||
      action.kind !== (input.requestKind === "HUMAN" ? "handover" : "callback")) throw new Error("Managed customer request requires executing journal");
  const resourceId = randomUUID();
  const inserted = await tx.$executeRaw`INSERT INTO "CallbackRequest" ("id","customerActionId","conversationId","clientId","channel","phone","topic","byClientRequest",
    "requestKind","lifecycleStatus","lifecycleRevision")
    VALUES (${resourceId},${input.actionId},${snapshot.fence.nativeId},NULL,${snapshot.fence.endpoint.channel},
      ${input.requestKind === "CALLBACK" ? input.phone : null},${input.topic.trim()},true,${input.requestKind},'QUEUED',1)`;
  if (inserted !== 1) throw new Error("Managed customer request was not inserted");
  // Required notification is atomic with resource/journal persistence. It
  // cannot be a best-effort facade or a second enqueue by the caller.
  await tx.backgroundJob.create({ data: { type: "customer-callback-notify", payload: { version: 1, actionId: input.actionId },
    maxAttempts: 5, dedupeKey: `customer-callback-notify:${input.actionId}` } });
  if (input.requestKind === "CALLBACK") await saveWitness(tx, resourceId, snapshot);
  // HUMAN HOLD is finalized only AFTER the journal commits its intent.
  return { resourceId, lifecycleRevision: "1", snapshot };
}

/** Called by the journal in the SAME tx, after intent_committed. It does not
 * authorize a receipt ACK: our own HOLD revokes the original BOT OUT fence. */
export async function finalizeManagedHandoverHoldTx(tx: TxClient, input: {
  requestId: string; expectedFence: CustomerFence;
}): Promise<CustomerStateSnapshot> {
  if (!isActiveTransactionClient(tx) || !customerFenceSchema.safeParse(input.expectedFence).success) {
    throw new Error("Handover HOLD requires an active transaction and fence");
  }
  const snapshot = await lockCustomerStateSnapshot(tx, { inquiryId: input.expectedFence.inquiryId });
  if (!snapshot || !sameFence(snapshot.fence, input.expectedFence) || snapshot.closedAt || snapshot.ownerMode !== "BOT") {
    throw new Error("Handover HOLD fence changed");
  }
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT r."id" FROM "CallbackRequest" r
    JOIN "CustomerAction" a ON a."id"=r."customerActionId"
    JOIN "CustomerInquiry" i ON i."id"=a."inquiryId"
    WHERE r."id"=${input.requestId} AND r."conversationId"=${snapshot.fence.nativeId} AND a."inquiryId"=${snapshot.fence.inquiryId}
      AND a."kind"='handover' AND a."status" IN ('EXECUTING','COMMITTED') AND r."requestKind"='HUMAN'
      AND r."lifecycleStatus"='QUEUED' AND r."lifecycleRevision"=1 AND r."handoverFence" IS NULL
      AND i."actionIntents"->'handover'->>'status'='committed'
      AND i."actionIntents"->'handover'->>'generation'=a."generation"::text
    FOR UPDATE OF r`;
  if (rows.length !== 1) throw new Error("Handover intent/resource was not committed");
  const changed = await transitionCustomerState(tx, snapshot.fence, { type: "owner", mode: "HOLD", agentId: null,
    token: randomUUID(), leaseUntil: null });
  if (changed.status !== "applied") throw new Error("Managed handover could not hold bot ownership");
  await saveWitness(tx, input.requestId, changed.snapshot);
  return changed.snapshot;
}

async function readTask(tx: TxClient, requestId: string, lock: boolean): Promise<TaskRow | null> {
  const rows = lock
    ? await tx.$queryRaw<TaskRow[]>`SELECT r."id",r."customerActionId",r."conversationId",r."requestKind",r."lifecycleStatus",
      r."lifecycleRevision"::text,r."assignedAgentId",r."acceptedAt",r."closureReason",r."doneAt",
      a."inquiryId",a."kind" AS "actionKind",a."generation",a."status" AS "actionStatus",a."supersededAt",r."handoverFence",
      (i."actionIntents"->a."kind"->>'generation'=a."generation"::text AND i."actionIntents"->a."kind"->>'status'='committed') AS "currentIntent"
      FROM "CallbackRequest" r JOIN "CustomerAction" a ON a."id"=r."customerActionId" AND a."resourceId"=r."id"
      JOIN "CustomerInquiry" i ON i."id"=a."inquiryId"
      WHERE r."id"=${requestId} FOR UPDATE OF r`
    : await tx.$queryRaw<TaskRow[]>`SELECT r."id",r."customerActionId",r."conversationId",r."requestKind",r."lifecycleStatus",
      r."lifecycleRevision"::text,r."assignedAgentId",r."acceptedAt",r."closureReason",r."doneAt",
      a."inquiryId",a."kind" AS "actionKind",a."generation",a."status" AS "actionStatus",a."supersededAt",r."handoverFence",
      (i."actionIntents"->a."kind"->>'generation'=a."generation"::text AND i."actionIntents"->a."kind"->>'status'='committed') AS "currentIntent"
      FROM "CallbackRequest" r JOIN "CustomerAction" a ON a."id"=r."customerActionId" AND a."resourceId"=r."id"
      JOIN "CustomerInquiry" i ON i."id"=a."inquiryId"
      WHERE r."id"=${requestId}`;
  return rows.length === 1 ? rows[0] : null;
}
async function staffCanAccess(tx: TxClient, req: Request, nativeId: string): Promise<boolean> {
  if (!req.agent || (!can(req, "messages.view") && !can(req, "messages.viewOwn"))) return false;
  // Recheck current DB role/permissions as well as the authenticated route
  // context; queue assignment itself is never a staff access grant.
  const agent = await tx.agent.findUnique({ where: { id: req.agent.id }, select: { isActive: true, role: true, permissions: true } });
  if (!agent?.isActive || isReadOnlyRole(agent.role as Role)) return false;
  const permissions = resolvePermissions(agent.role as Role, parsePermissionOverrides(agent.permissions));
  if (permissions.has("messages.view")) return true;
  if (!permissions.has("messages.viewOwn")) return false;
  return !!await tx.botConversation.findFirst({ where: { id: nativeId, ...ownBotConversationWhere(req.agent.id) }, select: { id: true } });
}

async function staffCanCloseObsolete(tx: TxClient, req: Request): Promise<boolean> {
  if (!req.agent || !can(req, "messages.view") || !can(req, "clients.assign")) return false;
  const agent = await tx.agent.findUnique({ where: { id: req.agent.id }, select: { isActive: true, role: true, permissions: true } });
  if (!agent?.isActive || isReadOnlyRole(agent.role as Role)) return false;
  const permissions = resolvePermissions(agent.role as Role, parsePermissionOverrides(agent.permissions));
  return permissions.has("messages.view") && permissions.has("clients.assign");
}

/** Administrative terminal cleanup only. An obsolete witness cannot be used
 * to move the current owner, mint a new witness or restart the bot. */
async function closeObsoleteTask(tx: TxClient, req: Request, row: TaskRow, command: CustomerCallbackStaffCommand): Promise<CustomerCallbackStaffResult> {
  const current = lifecycleView(row);
  if (!current || current.lifecycleRevision !== command.expectedRevision || current.lifecycleStatus === "CLOSED" || row.doneAt) {
    return { status: "stale", reason: "request_or_ownership_revision_changed" };
  }
  if (!await staffCanCloseObsolete(tx, req)) return { status: "denied", reason: "obsolete_request_cleanup_requires_current_admin_rights" };
  const now = new Date(), revision = BigInt(command.expectedRevision) + 1n;
  const count = await tx.$executeRaw`UPDATE "CallbackRequest" SET "lifecycleStatus"=${"CLOSED"},"lifecycleRevision"=${revision},
    "assignedAgentId"=${row.assignedAgentId},"acceptedAt"=${row.acceptedAt},"closureReason"=${"obsolete_context"},
    "doneAt"=${now},"doneById"=${req.agent!.id}
    WHERE "id"=${row.id} AND "customerActionId"=${row.customerActionId} AND "lifecycleRevision"=${BigInt(command.expectedRevision)}
      AND "lifecycleStatus"=${current.lifecycleStatus} AND "doneAt" IS NULL`;
  if (count !== 1) throw new Error("Obsolete managed request CAS lost its revision");
  return { status: "applied", task: { ...current, lifecycleStatus: "CLOSED", lifecycleRevision: revision.toString(), closureReason: "obsolete_context" } };
}

/** Staff-only local request lifecycle, not a customer/model tool. requireAuth
 * supplies req.agent; fresh DB rights and exact native ACL are checked inside
 * the transaction. Rollback/OFF can leave tasks for humans, never resume BOT. */
export async function transitionManagedCustomerCallback(req: Request, command: CustomerCallbackStaffCommand): Promise<CustomerCallbackStaffResult> {
  if (!req.agent || !/^[0-9a-f-]{36}$/i.test(command.requestId) ||
      (!customerRevisionSchema.safeParse(command.expectedRevision).success || command.expectedRevision === "0") ||
      !["accept", "return", "close"].includes(command.action)) return { status: "denied", reason: "staff_request_required" };
  try {
    return await prisma.$transaction(async (tx): Promise<CustomerCallbackStaffResult> => {
      const anchor = await readTask(tx, command.requestId, false);
      if (!anchor) return { status: "not_found", reason: "managed_request_missing" };
      const snapshot = await lockCustomerStateSnapshot(tx, { inquiryId: anchor.inquiryId });
      if (!snapshot && command.action === "close") {
        // A deleted native has no canonical outbound authority. Lock its
        // closed tombstone before the task; never follow a replacement peer.
        const tombstones = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "CustomerInquiry"
          WHERE "id"=${anchor.inquiryId} AND "conversationId" IS NULL AND "closedAt" IS NOT NULL FOR UPDATE`;
        if (tombstones.length === 1) {
          const orphan = await readTask(tx, command.requestId, true);
          if (orphan && orphan.inquiryId === anchor.inquiryId && orphan.customerActionId === anchor.customerActionId &&
              orphan.conversationId === anchor.conversationId &&
              (!orphan.conversationId || handoverWitness(orphan.handoverFence)?.fence.nativeId === orphan.conversationId) &&
              orphan.actionStatus === "COMMITTED" &&
              orphan.actionKind === (orphan.requestKind === "HUMAN" ? "handover" : "callback")) {
            return closeObsoleteTask(tx, req, orphan, command);
          }
        }
      }
      if (!snapshot?.fence.nativeId || snapshot.fence.nativeId !== anchor.conversationId ||
          !await staffCanAccess(tx, req, snapshot.fence.nativeId)) return { status: "denied", reason: "request_scope_or_staff_access" };
      // Canonical native/scope/policy/Inquiry locks are held BEFORE task lock.
      const row = await readTask(tx, command.requestId, true);
      if (!row || row.inquiryId !== snapshot.fence.inquiryId || row.conversationId !== snapshot.fence.nativeId ||
          row.customerActionId !== anchor.customerActionId || row.actionStatus !== "COMMITTED" ||
          row.actionKind !== (row.requestKind === "HUMAN" ? "handover" : "callback")) {
        return { status: "stale", reason: "request_binding_changed" };
      }
      const current = lifecycleView(row), witness = handoverWitness(row.handoverFence);
      const obsolete = !!snapshot.closedAt || !!row.supersededAt || !row.currentIntent || !witness || !sameOwnerBinding(witness.fence, snapshot.fence) ||
        witness.ownerMode !== snapshot.ownerMode || witness.ownerAgentId !== snapshot.ownerAgentId;
      if (command.action === "close" && obsolete) return closeObsoleteTask(tx, req, row, command);
      if (!current || obsolete || current.lifecycleRevision !== command.expectedRevision) {
        return { status: "stale", reason: "request_or_ownership_revision_changed" };
      }
      if (current.lifecycleStatus === "CLOSED" || row.doneAt) return { status: "stale", reason: "request_closed" };
      const actorId = req.agent!.id;
      if (command.action === "accept" ? current.lifecycleStatus !== "QUEUED" :
          command.action === "return" ? current.lifecycleStatus !== "ACCEPTED" || current.assignedAgentId !== actorId :
          current.lifecycleStatus === "ACCEPTED" && current.assignedAgentId !== actorId) {
        return { status: "denied", reason: "request_not_owned_by_staff_actor" };
      }
      let next = snapshot;
      if (row.requestKind === "HUMAN" && !(command.action === "close" && current.lifecycleStatus === "QUEUED")) {
        if (command.action === "accept" ? snapshot.ownerMode !== "HOLD" :
            snapshot.ownerMode !== "HUMAN" || snapshot.ownerAgentId !== actorId) return { status: "stale", reason: "handover_owner_changed" };
        const moved = await transitionCustomerState(tx, snapshot.fence, { type: "owner",
          mode: command.action === "accept" ? "HUMAN" : "HOLD", agentId: command.action === "accept" ? actorId : null,
          token: randomUUID(), leaseUntil: null });
        if (moved.status !== "applied") throw new Error("Managed handover owner transition lost its fence");
        next = moved.snapshot;
      }
      const nextStatus = command.action === "accept" ? "ACCEPTED" : command.action === "return" ? "QUEUED" : "CLOSED";
      const now = new Date(), revision = BigInt(command.expectedRevision) + 1n;
      const assigned = command.action === "accept" ? actorId : command.action === "return" ? null : row.assignedAgentId;
      const acceptedAt = command.action === "accept" ? now : command.action === "return" ? null : row.acceptedAt;
      const count = await tx.$executeRaw`UPDATE "CallbackRequest" SET "lifecycleStatus"=${nextStatus},"lifecycleRevision"=${revision},
        "assignedAgentId"=${assigned},"acceptedAt"=${acceptedAt},"closureReason"=${command.action === "close" ? "staff_closed" : null},
        "doneAt"=${command.action === "close" ? now : null},"doneById"=${command.action === "close" ? actorId : null}
        WHERE "id"=${row.id} AND "customerActionId"=${row.customerActionId} AND "lifecycleRevision"=${BigInt(command.expectedRevision)}
          AND "lifecycleStatus"=${current.lifecycleStatus} AND "doneAt" IS NULL`;
      if (count !== 1) throw new Error("Managed request CAS lost its revision");
      await saveWitness(tx, row.id, next);
      if (command.action === "return") await tx.backgroundJob.create({ data: { type: "customer-callback-notify",
        payload: { version: 1, actionId: row.customerActionId }, maxAttempts: 5,
        dedupeKey: `customer-callback-notify:${row.customerActionId}:r${revision}` } });
      return { status: "applied", task: { ...current, lifecycleStatus: nextStatus, lifecycleRevision: revision.toString(),
        assignedAgentId: assigned, acceptedAt: acceptedAt?.toISOString() ?? null, closureReason: command.action === "close" ? "staff_closed" : null } };
    }, { maxWait: 3000, timeout: 5000 });
  } catch {
    // Possible commit acknowledgement loss: read/reconcile task, never retry a
    // different task or assume that staff acceptance/provider delivery happened.
    return { status: "unknown", reason: "commit_unconfirmed" };
  }
}
