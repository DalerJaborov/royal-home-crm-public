import type { SellerControlConfig } from "@royal-home/shared";
import type { SellerControlEpisode } from "../generated/prisma/client.js";
import type { TxClient } from "../db.js";
import { addAlarmWorkingDays } from "./alarmCalendar.js";
import { logTimeline } from "./timeline.js";

export const controlRecipientAvailable = (agent: { isActive: boolean; frozenAt?: Date | null; absenceUntil?: Date | null } | null, now: Date) =>
  !!agent?.isActive && !agent.frozenAt && (!agent.absenceUntil || agent.absenceUntil <= now);

/** Private control metadata only; never changes client ownership or ordinary work. */
export async function applyControlAvailability(tx: TxClient, input: {
  episode: SellerControlEpisode; unavailable: boolean; recipientId: string | null; weeklyDaysOff: number[]; companyDaysOff: number[];
  config: SellerControlConfig | null; now: Date; requestKey: string; actorId: string | null; action: string; note?: string;
}) {
  const { episode, now } = input;
  const phases = { AGENT_TASK: "agentDueAt", ROP_RECEIPT: "ropReceiptDueAt", ROP_ACTION: "ropActionDueAt" } as const;
  const field = phases[episode.status as keyof typeof phases];
  if (!field) return null;
  const events = await tx.sellerControlEvent.findMany({ where: { episodeId: episode.id, type: { in: ["CONTROL_PAUSED", "CONTROL_RESUMED"] } }, select: { type: true, payload: true } });
  const latest = events.map(event => ({ type: event.type, payload: event.payload as { revision?: number; phase?: string } }))
    .sort((a, b) => (b.payload.revision ?? 0) - (a.payload.revision ?? 0))[0];
  const paused = latest?.type === "CONTROL_PAUSED" && latest.payload.phase === episode.status;
  const taskIds = [episode.status === "AGENT_TASK" ? episode.agentTaskId : episode.ropTaskId].filter((id): id is string => !!id);
  if (input.unavailable) {
    if (paused) return { episode, event: "CONTROL_PAUSED", replay: false };
    await tx.sellerControlEvent.create({ data: { episodeId: episode.id, requestKey: input.requestKey, actorId: input.actorId,
      type: "CONTROL_PAUSED", occurredAt: now, payload: { action: input.action, note: input.note ?? null, phase: episode.status,
        revision: episode.revision + 1, recipientId: input.recipientId, previousDeadline: episode[field]?.toISOString() ?? null, previousTaskIds: taskIds } } });
    await tx.interaction.updateMany({ where: { id: { in: taskIds }, completedAt: null, taskCancelledAt: null }, data: { taskCancelledAt: now } });
    const updated = await tx.sellerControlEpisode.update({ where: { id: episode.id }, data: { revision: { increment: 1 } } });
    return { episode: updated, event: "CONTROL_PAUSED", replay: false };
  }
  if (!paused) return null;
  if (!input.config) return { episode, event: "NOT_CONFIGURED", replay: false };
  const days = episode.status === "AGENT_TASK" ? input.config.agentDueWorkingDays
    : episode.status === "ROP_RECEIPT" ? input.config.ropReceiptDueWorkingDays : input.config.ropActionDueWorkingDays;
  const dueAt = addAlarmWorkingDays(now, episode.buyerCandidateId && episode.status === "AGENT_TASK"
    ? input.config.buyerCandidateFollowupWorkingDays ?? days : days,
  { companyDaysOff: input.companyDaysOff, agentDaysOff: input.weeklyDaysOff });
  const wording = episode.buyerCandidateId ? "Уточнить и записать договорённость о показе" : "Уточните план работы с клиентом и дополните сведения об объектах";
  const task = await logTimeline({ tx, clientId: episode.clientId,
    actor: { kind: "system", source: "client-plan", subjectAgentId: input.recipientId }, type: "SYSTEM",
    notes: wording, nextAction: wording, nextActionDate: dueAt });
  await tx.sellerControlEvent.create({ data: { episodeId: episode.id, requestKey: input.requestKey, actorId: input.actorId,
    type: "CONTROL_RESUMED", occurredAt: now, payload: { action: input.action, note: input.note ?? null, phase: episode.status,
      revision: episode.revision + 1, recipientId: input.recipientId, deadline: dueAt.toISOString(), previousTaskIds: taskIds, newTaskId: task.id } } });
  const taskField = episode.status === "AGENT_TASK" ? "agentTaskId" : "ropTaskId";
  const updated = await tx.sellerControlEpisode.update({ where: { id: episode.id }, data: { [field]: dueAt, [taskField]: task.id, revision: { increment: 1 } } });
  return { episode: updated, event: "CONTROL_RESUMED", replay: false };
}
