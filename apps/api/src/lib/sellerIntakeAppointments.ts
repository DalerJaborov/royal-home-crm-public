import { confirmedClientIntents } from "@royal-home/shared";
import { prisma } from "../db.js";
import { recordInvestigationSignal } from "./investigationCases.js";
import { newSellerIntakeMode } from "./sellerIntakeExecution.js";
import { bindSellerIntakeControl } from "./sellerIntakeReschedule.js";
import { assignmentSourceEpochIsCurrent } from "./investigationAssignmentEpoch.js";

/** Four appointments can contain three moves; repeated dates are not moves. */
export function countIntakeDateChanges(rows: Array<{ proposedAt: Date }>): number {
  let previous: number | undefined;
  let changes = 0;
  for (const row of rows) {
    const current = row.proposedAt.getTime();
    if (previous !== undefined && current !== previous) changes++;
    previous = current;
  }
  return changes;
}

/** Future immutable snapshots, not reconstruction from today's overwritten task date. */
export async function rememberSellerIntakeAppointment(interactionId: string, proposedAt: Date) {
  if (!Number.isFinite(proposedAt.getTime())) return null;
  return prisma.$transaction(async tx => {
    const source = await tx.interaction.findUnique({ where: { id: interactionId } });
    if (!source || source.type !== "CALL" || source.callAttempt !== "TALKED" || !source.recordingUrl || !source.transcript || source.investigationOnly) return null;
    const cutover = await tx.workflowCheckpoint.findUnique({ where: { key: "seller-intake-appointments-v1" }, select: { createdAt: true } });
    if (!cutover || source.createdAt < cutover.createdAt) return null;
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${source.clientId} FOR UPDATE`;
    const client = await tx.client.findUnique({ where: { id: source.clientId } });
    if (!client || client.deletedAt || client.assignmentCompletedAt || !confirmedClientIntents(client).sells
      || source.createdAt < client.assignedAt || (source.agentId && source.agentId !== client.assignedAgentId)) return null;
    if (!await assignmentSourceEpochIsCurrent(tx, { clientId: client.id, subjectAgentId: client.assignedAgentId,
      assignmentAt: client.assignedAt, sourceAt: source.createdAt, now: new Date() })) return null;
    const saved = await tx.sellerIntakeAppointmentEvidence.upsert({ where: { sourceInteractionId: source.id }, update: {}, create: {
      sourceKey: `CALL:${source.id}`, sourceInteractionId: source.id, clientId: client.id, agentId: client.assignedAgentId,
      assignmentAt: client.assignedAt, proposedAt, sourceOccurredAt: source.createdAt, sourceExcerpt: source.transcript.slice(0, 1000),
      executionMode: newSellerIntakeMode(source.createdAt),
    } });
    await bindSellerIntakeControl(tx, saved);
    const rows = await tx.sellerIntakeAppointmentEvidence.findMany({ where: { clientId: client.id, agentId: client.assignedAgentId,
      assignmentAt: client.assignedAt, sourceOccurredAt: { lte: source.createdAt } }, orderBy: [{ sourceOccurredAt: "asc" }, { id: "asc" }] });
    // Random identifiers cannot establish which of two simultaneous conflicting
    // appointments came first. Preserve both sources without counting moves.
    if (rows.some((row, index) => index > 0
      && row.sourceOccurredAt.getTime() === rows[index - 1].sourceOccurredAt.getTime()
      && row.proposedAt.getTime() !== rows[index - 1].proposedAt.getTime())) return saved;
    const changes = countIntakeDateChanges(rows);
    const last = rows.at(-1), previous = rows.at(-2);
    if (changes >= 3 && last?.id === saved.id && previous && last.proposedAt.getTime() !== previous.proposedAt.getTime()) await recordInvestigationSignal({ clientId: client.id, subjectAgentId: client.assignedAgentId,
      assignmentAt: client.assignedAt, sourceType: "CALL", sourceId: source.id, kind: "SELLER_INTAKE_DATE_CHANGES",
      independenceKey: `call:${source.id}`, summary: "В записях разговоров несколько раз менялась дата приёма объекта. Причины требуют проверки; проведение встречи не установлено.",
      occurredAt: source.createdAt, payload: { mode: "PREVIEW", dateChanges: changes, sourceEvidenceIds: rows.map(row => row.id),
        historicalCoverage: "FUTURE_SNAPSHOTS_ONLY", assessment: "NOT_A_VERDICT" } }, tx);
    return saved;
  });
}
