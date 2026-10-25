import type { TxClient } from "../db.js";
import { confirmedClientIntents } from "@royal-home/shared";
import { assignmentSourceEpochIsCurrent } from "./investigationAssignmentEpoch.js";

export function buyerCandidateLiveEnabled() {
  return process.env.BUYER_CANDIDATE_INTERNAL_LIVE === "explicitly-approved" && process.env.SELLER_CONTROL_INTERNAL_LIVE === "explicitly-approved";
}
export function newBuyerCandidateMode(sourceAt: Date) {
  const from = Date.parse(process.env.BUYER_CANDIDATE_LIVE_FROM ?? "");
  return buyerCandidateLiveEnabled() && Number.isFinite(from) && sourceAt.getTime() >= from ? "LIVE" : "PREVIEW";
}
export async function buyerCandidateControlFacts(tx: TxClient, candidateId: string, now: Date) {
  const candidate = await tx.buyerShowingCandidate.findUniqueOrThrow({ where: { id: candidateId } });
  const client = await tx.client.findUniqueOrThrow({ where: { id: candidate.clientId } });
  const current = !client.deletedAt && !!client.acceptedAt && !client.assignmentRefusedAt && !client.assignmentCompletedAt
    && client.workStatus === "ACTIVE" && !["LOST", "ARCHIVED", "DEAL_CLOSED"].includes(client.status)
    && confirmedClientIntents(client).buys && client.assignedAgentId === candidate.agentId
    && client.assignedAt.getTime() === candidate.assignmentAt.getTime()
    && await assignmentSourceEpochIsCurrent(tx, { clientId: client.id, subjectAgentId: candidate.agentId,
      assignmentAt: candidate.assignmentAt, sourceAt: candidate.sourceOccurredAt ?? candidate.detectedAt, now });
  const showing = candidate.propertyId && candidate.proposedAt ? await tx.interaction.findFirst({ where: {
    clientId: client.id, propertyId: candidate.propertyId, type: "SHOWING", investigationOnly: false,
    taskCancelledAt: null, declinedAt: null, nextActionDate: candidate.proposedAt,
    createdAt: { gte: candidate.assignmentAt },
  }, select: { id: true } }) : null;
  const possible = !showing && candidate.propertyId ? await tx.interaction.findFirst({ where: {
    clientId: client.id, propertyId: candidate.propertyId, type: "SHOWING", investigationOnly: false,
    taskCancelledAt: null, declinedAt: null, nextActionDate: { not: null },
    createdAt: { gte: candidate.sourceOccurredAt ?? candidate.detectedAt },
  }, select: { id: true } }) : null;
  return { candidate, client, current, inventory: !candidate.propertyId || !candidate.proposedAt ? "UNCERTAIN" as const : showing ? "COMPLETE" as const : possible ? "UNCERTAIN" as const : "MISSING" as const };
}
