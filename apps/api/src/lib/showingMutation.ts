import { type TxClient } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { logTimeline, type TimelineActor } from "./timeline.js";

/** Local effects only. The caller owns the transaction and postcommit delivery.
 * Client must be locked BEFORE customer native/scope/policy/Inquiry locks. */
export async function lockShowingClientTx(tx: TxClient, clientId: string): Promise<void> {
  if (!isActiveTransactionClient(tx)) throw new Error("Showing mutation requires an active transaction");
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Client" WHERE "id"=${clientId} FOR UPDATE`;
  if (rows.length !== 1) throw new ShowingMutationError("no_client");
}

export class ShowingMutationError extends Error {
  constructor(readonly reason: "no_client" | "no_property" | "unavailable" | "no_agent" | "no_showing" | "stale_showing") {
    super(`Showing mutation: ${reason}`);
  }
}

export async function lockShowingPropertiesTx(tx: TxClient, ids: Array<string | null | undefined>): Promise<void> {
  if (!isActiveTransactionClient(tx)) throw new Error("Showing mutation requires an active transaction");
  const sorted = [...new Set(ids.filter((id): id is string => !!id))].sort();
  if (sorted.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Property" WHERE "id" IN (${Prisma.join(sorted)}) ORDER BY "id" FOR UPDATE`);
}

/** Never finds a nearest/other showing. The origin/permission/fence checks belong
 * to the server adapter; this kernel only mutates this exact client's resource. */
export async function lockShowingTx(tx: TxClient, clientId: string, interactionId: string) {
  await lockShowingClientTx(tx, clientId);
  const before = await tx.interaction.findUnique({ where: { id: interactionId }, select: { clientId: true, propertyId: true } });
  if (!before || before.clientId !== clientId) throw new ShowingMutationError("no_showing");
  await lockShowingPropertiesTx(tx, [before.propertyId]);
  await tx.$queryRaw`SELECT "id" FROM "Interaction" WHERE "id"=${interactionId} AND "clientId"=${clientId} FOR UPDATE`;
  const showing = await tx.interaction.findUnique({ where: { id: interactionId }, select: {
    id: true, clientId: true, type: true, propertyId: true, nextAction: true, nextActionDate: true,
    completedAt: true, taskCancelledAt: true, declinedAt: true, notes: true, agentId: true, subjectAgentId: true, remindersSent: true,
    property: { select: { title: true } },
  } });
  if (!showing || showing.clientId !== clientId || showing.type !== "SHOWING" || !showing.nextActionDate) throw new ShowingMutationError("no_showing");
  if (showing.propertyId !== before.propertyId) throw new ShowingMutationError("stale_showing");
  if (!showing.nextAction || showing.completedAt || showing.taskCancelledAt) throw new ShowingMutationError("stale_showing");
  return showing;
}
export type LockedShowing = Awaited<ReturnType<typeof lockShowingTx>>;

export async function createShowingTx(tx: TxClient, input: {
  clientId: string; propertyId: string; at: Date; now: Date; notes: string;
  actor: { kind: "agent"; agentId: string } | { kind: "bot"; channel?: string };
}) {
  await lockShowingClientTx(tx, input.clientId);
  await lockShowingPropertiesTx(tx, [input.propertyId]);
  const client = await tx.client.findUnique({ where: { id: input.clientId }, select: { assignedAgentId: true } });
  const property = await tx.property.findUnique({ where: { id: input.propertyId }, select: { assignedAgentId: true, status: true, deletedAt: true } });
  if (!client) throw new ShowingMutationError("no_client");
  if (!property) throw new ShowingMutationError("no_property");
  if (property.deletedAt || property.status !== "AVAILABLE") throw new ShowingMutationError("unavailable");
  const agentId = client.assignedAgentId ?? property.assignedAgentId;
  if (!agentId) throw new ShowingMutationError("no_agent");
  const created = await logTimeline({ clientId: input.clientId, propertyId: input.propertyId,
    actor: input.actor.kind === "agent" ? input.actor : { kind: "bot", source: "showingBooking", subjectAgentId: agentId, channel: input.actor.channel },
    type: "SHOWING", notes: input.notes, nextAction: "Показ объекта", nextActionDate: input.at, tx });
  await tx.client.update({ where: { id: input.clientId }, data: { lastContactAt: input.now } });
  await tx.property.update({ where: { id: input.propertyId }, data: { viewsCount: { increment: 1 } } });
  return { id: created.id, agentId };
}

export async function rescheduleShowingTx(tx: TxClient, input: {
  clientId: string; interactionId: string; at: Date; now: Date; propertyId?: string;
  meetingSummaryAfterShowingMinutes: number; actorKind: "agent" | "client";
  /** Pure formatting only: receives the locked row, never stale preflight notes. */
  notes: (current: LockedShowing) => string;
}) {
  // All properties precede Interaction, including a replacement target. This
  // preflight is NOT authorization; lockShowingTx rereads and rejects rebinding.
  await lockShowingClientTx(tx, input.clientId);
  const before = await tx.interaction.findUnique({ where: { id: input.interactionId }, select: { clientId: true, propertyId: true } });
  if (!before || before.clientId !== input.clientId) throw new ShowingMutationError("no_showing");
  await lockShowingPropertiesTx(tx, [before.propertyId, input.propertyId]);
  const current = await lockShowingTx(tx, input.clientId, input.interactionId);
  if (current.propertyId !== before.propertyId) throw new ShowingMutationError("stale_showing");
  const moved = !!input.propertyId && current.propertyId !== input.propertyId;
  if (moved) {
    const property = await tx.property.findUnique({ where: { id: input.propertyId }, select: { status: true, deletedAt: true } });
    if (!property || property.deletedAt || property.status !== "AVAILABLE") throw new ShowingMutationError("unavailable");
  }
  await tx.interaction.update({ where: { id: current.id }, data: {
    nextActionDate: input.at, ...(moved ? { propertyId: input.propertyId } : {}), notes: input.notes(current),
    confirmAskedAt: null, confirmedAt: null, declinedAt: null, remindersSent: [], reminderSentAt: null, noShowNotifiedAt: null,
  } });
  await tx.client.update({ where: { id: input.clientId }, data: { lastContactAt: input.now } });
  if (!(input.actorKind === "agent" && current.nextActionDate!.getTime() <= input.now.getTime())) {
    await tx.pendingSummary.updateMany({ where: { kind: "meeting", subjectId: current.id, doneAt: null }, data: {
      dueAt: new Date(input.at.getTime() + input.meetingSummaryAfterShowingMinutes * 60_000), dismissedAt: null, snoozedUntil: null, snoozeCount: 0,
    } });
  }
  if (moved) {
    await tx.property.update({ where: { id: input.propertyId }, data: { viewsCount: { increment: 1 } } });
    if (current.propertyId) await tx.property.updateMany({ where: { id: current.propertyId, viewsCount: { gt: 0 } }, data: { viewsCount: { decrement: 1 } } });
  }
  return current;
}

export async function cancelShowingTx(tx: TxClient, input: {
  clientId: string; interactionId: string; now: Date; actorKind: "agent" | "client";
  notes: (current: LockedShowing) => string;
  followUp?: { actor: TimelineActor; notes: string };
}) {
  const current = await lockShowingTx(tx, input.clientId, input.interactionId);
  await tx.interaction.update({ where: { id: current.id }, data: { nextAction: null, declinedAt: input.now, notes: input.notes(current) } });
  if (!(input.actorKind === "agent" && current.nextActionDate!.getTime() <= input.now.getTime())) {
    await tx.pendingSummary.updateMany({ where: { kind: "meeting", subjectId: current.id, doneAt: null }, data: { doneAt: input.now } });
  }
  if (input.followUp) await logTimeline({ clientId: input.clientId,
    actor: { ...input.followUp.actor, subjectAgentId: current.subjectAgentId ?? current.agentId }, type: "SYSTEM", notes: input.followUp.notes,
    nextAction: "Согласовать новую дату показа", nextActionDate: new Date(input.now.getTime() + 24 * 60 * 60 * 1000), tx });
  return current;
}
