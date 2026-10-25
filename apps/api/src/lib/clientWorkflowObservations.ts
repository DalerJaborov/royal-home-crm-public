import { assignmentSourceEpochIsCurrent } from "./investigationAssignmentEpoch.js";
import { randomUUID } from "node:crypto";
import { prisma, type TxClient } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { detectRequestedAgent } from "./requestedAgent.js";
import { collectShowingDeliveryFacts } from "./showingDeliveryFacts.js";

interface ObservationInput { kind: string; clientId: string; propertyId?: string; sourceType: string; sourceId: string;
  occurredAt: Date; expectedAssignmentAt?: Date; initialLeadSource?: boolean; payload: Prisma.InputJsonValue }
export async function recordClientWorkflowObservation(tx: TxClient, input: ObservationInput) {
  const cutover = await tx.workflowCheckpoint.findUnique({ where: { key: "client-workflow-observations-v1" }, select: { createdAt: true } });
  if (!cutover || input.occurredAt < cutover.createdAt) return null;
  await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${input.clientId} FOR UPDATE`;
  const client = await tx.client.findUnique({ where: { id: input.clientId }, select: { createdAt: true, assignedAt: true, assignedAgentId: true, deletedAt: true, assignmentCompletedAt: true } });
  if (!client || client.deletedAt || client.assignmentCompletedAt || input.expectedAssignmentAt && input.expectedAssignmentAt.getTime() !== client.assignedAt.getTime()) return null;
  if (input.kind === "NAMED_CLIENT_REQUEST") {
    const now = new Date();
    if (input.occurredAt > now) return null;
    const current = input.occurredAt >= client.assignedAt && await assignmentSourceEpochIsCurrent(tx, {
      clientId: input.clientId, subjectAgentId: client.assignedAgentId, assignmentAt: client.assignedAt, sourceAt: input.occurredAt, now,
    });
    if (!current) {
      // A first lead may name an employee before the client row exists. Never
      // reuse this exception for an existing card or a returning owner (ABA).
      if (!input.initialLeadSource || input.occurredAt > client.createdAt) return null;
      const transitions = await tx.$queryRaw<Array<{ fromAgentId: string | null; toAgentId: string | null; createdAt: Date }>>`
        SELECT a.meta->>'fromAgentId' AS "fromAgentId", a.meta->>'toAgentId' AS "toAgentId", a."createdAt"
        FROM "AuditLog" a WHERE a.action='CLIENT_AGENT_CHANGE' AND a."entityType"='Client' AND a."entityId"=${input.clientId}
          AND (a.meta->>'fromAgentId' IS DISTINCT FROM a.meta->>'toAgentId'
            OR EXISTS (SELECT 1 FROM "ClientWorkflowObservation" o WHERE o.kind='ASSIGNMENT_SNAPSHOT' AND o."sourceType"='OWNERSHIP_AUDIT' AND o."sourceId"=a.id))
        ORDER BY a."createdAt" DESC LIMIT 2`;
      if (transitions.length > 1 || transitions.length === 1 && (transitions[0].fromAgentId !== null
        || transitions[0].toAgentId !== client.assignedAgentId || transitions[0].createdAt < input.occurredAt)) return null;
    }
  }
  const sourceKey = [input.kind, input.sourceType, input.sourceId, input.clientId, client.assignedAt.toISOString()].join(":");
  return tx.clientWorkflowObservation.upsert({ where: { sourceKey }, update: {}, create: { sourceKey,
    kind: input.kind, clientId: input.clientId, propertyId: input.propertyId, subjectAgentId: client.assignedAgentId,
    assignmentAt: client.assignedAt, sourceType: input.sourceType, sourceId: input.sourceId, occurredAt: input.occurredAt,
    payload: input.payload, executionMode: "PREVIEW" } });
}

export async function recordNamedAssignmentDeclaration(tx: TxClient, clientId: string, agentId: string) {
  return recordClientWorkflowObservation(tx, { clientId, kind: "NAMED_ASSIGNMENT", sourceType: "ASSIGNMENT_DECLARATION",
    sourceId: agentId, occurredAt: new Date(), payload: { verification: "UNVERIFIED", requestedAgentId: agentId,
      meaning: "Routing reason alone does not establish who requested this employee", assessment: "NOT_A_VERDICT" } });
}

export async function recordIncomingNamedDeclaration(tx: TxClient, input: { clientId: string; callId: string; interactionId: string | null; requestedAgentId: string; operatorId: string | null }) {
  const declaration = await recordClientWorkflowObservation(tx, { clientId: input.clientId,
    kind: "NAMED_ASSIGNMENT", sourceType: input.operatorId ? "STAFF_DECLARATION" : "ASSIGNMENT_DECLARATION", sourceId: input.callId, occurredAt: new Date(),
    payload: { verification: "UNVERIFIED", requestedAgentId: input.requestedAgentId, assessment: "NOT_A_VERDICT" } });
  if (input.operatorId || !input.interactionId) return declaration;
  const source = await tx.interaction.findUnique({ where: { id: input.interactionId },
    select: { id: true, clientId: true, type: true, callAttempt: true, recordingUrl: true, transcript: true, createdAt: true, investigationOnly: true } });
  if (!source || source.clientId !== input.clientId || source.type !== "CALL" || source.callAttempt !== "TALKED"
    || !source.recordingUrl || !source.transcript || source.investigationOnly) return declaration;
  const match = await detectRequestedAgent(source.transcript);
  if (match.status !== "matched" || match.agentId !== input.requestedAgentId) return declaration;
  return recordClientWorkflowObservation(tx, { clientId: input.clientId, kind: "NAMED_CLIENT_REQUEST", sourceType: "CALL",
    sourceId: source.id, occurredAt: source.createdAt, payload: { verification: "RECORDED_TEXT_SPEAKER_UNVERIFIED",
      requestedAgentId: match.agentId, namedAs: match.namedAs, quote: source.transcript.slice(0, 1000),
      meaning: "Recording is authentic; requester speaker is not independently established", assessment: "NOT_A_VERDICT" } });
}

export async function recordConversationNamedRequest(conversationId: string, source: { messageId?: string; initialLead?: boolean } = {}) {
  const conversation = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { clientId: true, messages: true,
    client: { select: { assignedAt: true } } } });
  if (!conversation?.clientId || !Array.isArray(conversation.messages)) return null;
  // New source timestamp is written by authenticated ingress; never accept staff
  // messages merely because their role has historically been stored as user.
  const messages = [...conversation.messages].reverse();
  // Existing-card ingress supplies the exact turn MID. Default callers examine
  // only the latest genuine inbound message; they cannot search past a newer turn.
  let inspectedInbound = false;
  for (const value of messages) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.role !== "user" || value.by != null
      || value.silentCapture === true || typeof value.mid !== "string" || !value.mid
      || typeof value.at !== "string" || typeof value.content !== "string") continue;
    if (source.messageId && value.mid !== source.messageId) continue;
    if (!source.initialLead && inspectedInbound) return null;
    inspectedInbound = true;
    const occurredAt = new Date(value.at); if (!Number.isFinite(occurredAt.getTime())) continue;
    const match = await detectRequestedAgent(value.content);
    if (match.status !== "matched") continue;
    const quote = value.content.slice(0, 1000);
    return prisma.$transaction(tx => recordClientWorkflowObservation(tx, { clientId: conversation.clientId!, kind: "NAMED_CLIENT_REQUEST",
      sourceType: "CONVERSATION", sourceId: `${conversationId}:${value.mid}`, occurredAt, expectedAssignmentAt: conversation.client?.assignedAt, initialLeadSource: source.initialLead,
      payload: { verification: "AUTHENTICATED_CUSTOMER_TEXT", requestedAgentId: match.agentId, namedAs: match.namedAs,
        quote, conversationId, assessment: "NOT_A_VERDICT" } }));
  }
  return null;
}

/** Must run only after existing transport returned success; no transport here.
 * Failure cannot turn a completed send into a retryable HTTP error. */
export async function recordPropertyDispatchAccepted(clientId: string, assignmentAt: Date, propertyIds: string[], channel: string, senderAgentId: string) {
  const sourceId = randomUUID(), occurredAt = new Date();
  try {
    await prisma.$transaction(async tx => {
      for (const propertyId of propertyIds) await recordClientWorkflowObservation(tx, { clientId, propertyId,
        expectedAssignmentAt: assignmentAt, kind: "PROPERTY_DISPATCH", sourceType: "CRM_SEND_PROPERTIES", sourceId: `${sourceId}:${propertyId}`, occurredAt,
        payload: { state: "DISPATCH_ACCEPTED", channel, senderAgentId, read: "UNKNOWN", deliveredToDevice: "UNKNOWN", assessment: "NOT_A_VERDICT" } });
    });
  } catch { console.error("[workflow-observation] delivery journal temporarily unavailable"); }
}

export async function recordShowingDeliveryObservation(tx: TxClient, input: { clientId: string; propertyId: string; showingId: string; occurredAt: Date }) {
  const cutover = await tx.workflowCheckpoint.findUnique({ where: { key: "client-workflow-observations-v1" }, select: { createdAt: true } });
  if (!cutover || input.occurredAt < cutover.createdAt) return null;
  const facts = await collectShowingDeliveryFacts(tx, input.clientId, input.propertyId, input.occurredAt);
  const direct = await tx.clientWorkflowObservation.findMany({ where: { clientId: input.clientId, propertyId: input.propertyId,
    kind: "PROPERTY_DISPATCH", occurredAt: { lte: input.occurredAt } }, orderBy: { occurredAt: "desc" }, take: 30, select: { id: true } });
  return recordClientWorkflowObservation(tx, { ...input, kind: "SHOWING_DELIVERY_CONTEXT", sourceType: "SHOWING", sourceId: input.showingId,
    payload: { ...facts, directDispatchObservationIds: direct.map(row => row.id),
      directDispatchState: direct.length ? "DISPATCH_ACCEPTED_NOT_READ" : "UNCONFIRMED", assessment: "NOT_A_VERDICT" } });
}
