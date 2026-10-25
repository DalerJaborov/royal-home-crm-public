import { randomUUID } from "node:crypto";
import type { TxClient } from "../db.js";
import { assignmentSourceEpochIsCurrent } from "./investigationAssignmentEpoch.js";

/** Called under Client lock by the immutable station-source producer only. */
export async function bindSellerIntakeControl(tx: TxClient, source: {
  id: string; clientId: string; agentId: string | null; assignmentAt: Date; sourceOccurredAt: Date; proposedAt: Date; executionMode: string;
}, now = new Date()) {
  if (source.executionMode !== "LIVE") return;
  const latest = await tx.sellerIntakeAppointmentEvidence.findMany({ where: { clientId: source.clientId, agentId: source.agentId, assignmentAt: source.assignmentAt },
    orderBy: { sourceOccurredAt: "desc" }, take: 2 });
  if (latest[0]?.id !== source.id || (latest[1] && latest[1].sourceOccurredAt.getTime() === source.sourceOccurredAt.getTime())) return;
  const active = await tx.sellerControlEpisode.findMany({ where: { clientId: source.clientId, agentId: source.agentId!, assignmentAt: source.assignmentAt,
    executionMode: "LIVE", buyerCandidateId: null, status: { in: ["AGENT_TASK", "ROP_RECEIPT", "ROP_ACTION", "DIRECTOR"] } } });
  for (const episode of active) {
    if (!await assignmentSourceEpochIsCurrent(tx, { clientId: source.clientId, subjectAgentId: source.agentId,
      assignmentAt: source.assignmentAt, sourceAt: episode.createdAt, now })) continue;
    const previous = episode.sellerIntakeEvidenceId ? await tx.sellerIntakeAppointmentEvidence.findUnique({ where: { id: episode.sellerIntakeEvidenceId } }) : null;
    if (!previous || source.sourceOccurredAt <= previous.sourceOccurredAt || source.sourceOccurredAt <= episode.createdAt
      || source.proposedAt.getTime() === previous.proposedAt.getTime()) {
      await tx.sellerIntakeAppointmentEvidence.update({ where: { id: source.id }, data: { controlEpisodeId: episode.id } });
      return;
    }
    await tx.sellerControlEpisode.update({ where: { id: episode.id }, data: { status: "CANCELLED", resolvedAt: now, revision: { increment: 1 } } });
    await tx.sellerControlEvent.create({ data: { episodeId: episode.id, requestKey: randomUUID(), actorId: null,
      type: "SOURCE_RESCHEDULED", occurredAt: now, payload: { replacementSourceId: source.id, previousSourceId: previous.id,
        meaning: "New recorded appointment; occurrence remains unconfirmed" } } });
    await tx.interaction.updateMany({ where: { id: { in: [episode.agentTaskId, episode.ropTaskId].filter((id): id is string => !!id) },
      completedAt: null, taskCancelledAt: null }, data: { taskCancelledAt: now } });
    // New source intentionally remains unbound until its own configured deadline.
  }
}
