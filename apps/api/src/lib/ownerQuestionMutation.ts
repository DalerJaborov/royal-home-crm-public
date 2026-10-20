import { randomUUID } from "node:crypto";
import { customerOwnerReplyTargetSchema, type CustomerOwnerReplyTarget, type CustomerStateSnapshot } from "@royal-home/shared";
import { Prisma } from "../generated/prisma/client.js";
import type { TxClient } from "../db.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { ownerQuestionStaffRecipients } from "./ownerQuestionAccess.js";
import { resolveCustomerEndpoint, type CustomerTransportReference } from "./customerConversationScope.js";
import { readCustomerPropertyFacts } from "./customerPropertyFacts.js";

/** Only the immutable original namespace, never a Client's current channel. */
export function ownerQuestionTransport(target: CustomerOwnerReplyTarget): CustomerTransportReference {
  const prefix = `settings:${target.channel}:`;
  return { endpointScopeId: target.endpointScopeId, channel: target.channel, accountId: target.accountId,
    transportKey: target.transportKey, scopeRevision: target.scopeRevision,
    ...(target.accountId === null && target.transportKey.startsWith(prefix)
      ? { accountExternalId: target.transportKey.slice(prefix.length) } : {}) };
}

export function ownerQuestionTargetMatches(target: CustomerOwnerReplyTarget, snapshot: CustomerStateSnapshot | null): boolean {
  if (!snapshot || snapshot.closedAt) return false;
  const fence = snapshot.fence;
  return fence.inquiryId === target.inquiryId && fence.nativeId === target.nativeId &&
    fence.endpoint.endpointScopeId === target.endpointScopeId && fence.endpoint.channel === target.channel &&
    fence.endpoint.peerId === target.peer && fence.endpoint.accountId === target.accountId &&
    fence.scopeRevision === target.scopeRevision && fence.bindingRevision === target.bindingRevision;
}

/** Local effect kernel. The journal owns consent, original grant, canonical
 * locks/generation and COMMITTED receipt. This helper owns only resource+job in
 * that SAME active transaction; a queue failure must propagate and roll back. */
export async function createOwnerQuestionTx(tx: TxClient, input: {
  actionId: string; question: string; propertyId: string; replyTarget: CustomerOwnerReplyTarget;
}): Promise<{ resourceId: string; resourceRevision: string }> {
  if (!isActiveTransactionClient(tx)) throw new Error("Owner question requires active customer transaction");
  const target = customerOwnerReplyTargetSchema.parse(input.replyTarget);
  const question = input.question.trim();
  if (!question || question.length > 1000) throw new Error("Owner question text is invalid");
  await resolveCustomerEndpoint({ channel: target.channel, subscriberId: target.peer, transport: ownerQuestionTransport(target) }, tx);
  const linked = await tx.$queryRaw<{ valid: boolean }[]>`SELECT EXISTS(SELECT 1 FROM "CustomerAction" a
    JOIN "CustomerInquiry" i ON i."id"=a."inquiryId" JOIN "BotConversation" c ON c."id"=i."conversationId"
    JOIN "CustomerEndpointScope" s ON s."id"=c."endpointScopeId"
    WHERE a."id"=${input.actionId} AND a."kind"='owner_question' AND a."status"='EXECUTING'
      AND a."inquiryId"=${target.inquiryId} AND a."generation"=${BigInt(target.generation)}
      AND i."conversationId"=${target.nativeId} AND i."endpointScopeId"=${target.endpointScopeId}
      AND i."bindingRevision"=${BigInt(target.bindingRevision)} AND i."closedAt" IS NULL
      AND c."endpointScopeId"=${target.endpointScopeId} AND c."channel"=${target.channel} AND c."subscriberId"=${target.peer}
      AND c."accountId" IS NOT DISTINCT FROM ${target.accountId} AND s."scopeRevision"=${BigInt(target.scopeRevision)}) AS valid`;
  if (!linked[0]?.valid) throw new Error("Owner question action or original binding changed");
  if (!await readCustomerPropertyFacts(input.propertyId, target.channel, tx)) throw new Error("Owner question property unavailable");
  if ((await ownerQuestionStaffRecipients(tx, target.nativeId, target)).length === 0) throw new Error("Owner question has no eligible staff recipient");
  const resourceId = randomUUID();
  await tx.$executeRaw(Prisma.sql`INSERT INTO "OwnerQuestion" ("id","conversationId","clientId","propertyId","question",
      "customerActionId","replyTarget","managedRevision","deliveryStatus")
    VALUES (${resourceId},${target.nativeId},NULL,${input.propertyId},${question},${input.actionId},
      ${JSON.stringify(target)}::jsonb,1,'QUEUED')`);
  await tx.backgroundJob.create({ data: { type: "customer_owner_question_notify", payload: { version: 1, actionId: input.actionId },
    maxAttempts: 5, dedupeKey: `customer_owner_question_notify:${input.actionId}` } });
  const saved = await tx.ownerQuestion.findUniqueOrThrow({ where: { id: resourceId }, select: { managedRevision: true } });
  if (!saved.managedRevision || saved.managedRevision <= 0n) throw new Error("Owner question revision was not persisted");
  return { resourceId, resourceRevision: saved.managedRevision.toString() };
}
