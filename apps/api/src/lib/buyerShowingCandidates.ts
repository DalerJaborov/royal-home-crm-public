import { confirmedClientIntents } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { resolveShowingSlot, type ShowingRequest } from "./showingBooking.js";
import { assignmentSourceEpochIsCurrent } from "./investigationAssignmentEpoch.js";
import { readSellerControlConfig } from "./sellerControlMachine.js";
import { addAlarmWorkingDays } from "./alarmCalendar.js";
import { newBuyerCandidateMode } from "./buyerCandidateControl.js";

const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
export async function rememberConversationShowingRequest(conversationId: string, request: ShowingRequest) {
  if (request.action === "cancel" || !request.propertyCode) return null;
  const source = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { messages: true } });
  const messages = Array.isArray(source?.messages) ? source.messages : [];
  const latest = [...messages].reverse().find(message => message && typeof message === "object" && !Array.isArray(message) && message.role === "user");
  if (!latest || typeof latest !== "object" || Array.isArray(latest) || typeof latest.at !== "string") return null;
  if (latest.by != null || latest.silentCapture === true || typeof latest.mid !== "string" || !latest.mid) return null;
  const occurredAt = new Date(latest.at);
  if (!Number.isFinite(occurredAt.getTime())) return null;
  const slot = /^\d{1,2}:\d{2}$/.test(request.time ?? "") ? resolveShowingSlot(request, occurredAt) : null;
  const code = String(request.propertyCode);
  const property = await prisma.property.findFirst({ where: { deletedAt: null,
    ...(/^\d+$/.test(code) ? { shortId: Number(code) } : { id: code }) }, select: { id: true } });
  if (!property) return null;
  return rememberConversationShowingCandidate(conversationId, slot?.ok ? slot.at : null, property.id, occurredAt, latest.mid,
    typeof latest.content === "string" ? latest.content.slice(0, 1000) : "");
}
/** A hypothesis, never a SHOWING or proof of misconduct. All new rows are PREVIEW. */
export async function rememberCallShowingCandidate(interactionId: string, proposedAt: Date | null, propertyId: string | null = null, quote?: string | null) {
  if (proposedAt && !Number.isFinite(proposedAt.getTime())) return null;
  return prisma.$transaction(async tx => {
    const source = await tx.interaction.findUnique({ where: { id: interactionId } });
    if (!source || source.type !== "CALL" || source.callAttempt !== "TALKED" || !source.recordingUrl || !source.transcript || source.investigationOnly) return null;
    const excerpt = quote?.trim();
    if (!proposedAt && (!excerpt || excerpt.length < 10 || !source.transcript.includes(excerpt))) return null;
    return rememberCandidateTx(tx, { sourceType: "CALL", sourceId: source.id, sourceInteractionId: source.id,
      clientId: source.clientId, occurredAt: source.createdAt, proposedAt, propertyId, authorId: source.agentId,
      sourceExcerpt: excerpt && source.transcript.includes(excerpt) ? excerpt.slice(0, 1000) : source.transcript.slice(0, 1000) });
  });
}

/** Only the authenticated conversation pipeline calls this, never an agent-note API. */
async function rememberConversationShowingCandidate(conversationId: string, proposedAt: Date | null, propertyId: string | null, occurredAt: Date, messageId: string, sourceExcerpt: string) {
  if (proposedAt && !Number.isFinite(proposedAt.getTime())) return null;
  return prisma.$transaction(async tx => {
    const source = await tx.botConversation.findUnique({ where: { id: conversationId },
      select: { id: true, clientId: true, lastMessageAt: true, messages: true } });
    if (!source?.clientId || !source.lastMessageAt || !Array.isArray(source.messages)
      || !source.messages.some(message => message && typeof message === "object" && !Array.isArray(message) && message.role === "user"
        && message.by == null && message.silentCapture !== true && message.mid === messageId && message.at === occurredAt.toISOString()
        && typeof message.content === "string" && message.content.slice(0, 1000) === sourceExcerpt)) return null;
    return rememberCandidateTx(tx, { sourceType: "CONVERSATION", sourceId: `${source.id}:${messageId}`,
      sourceConversationId: source.id, clientId: source.clientId, occurredAt, proposedAt, propertyId, sourceExcerpt });
  });
}

async function rememberCandidateTx(tx: TxClient, input: { sourceType: string; sourceId: string; sourceInteractionId?: string;
  sourceConversationId?: string; clientId: string; occurredAt: Date; proposedAt: Date | null; propertyId: string | null; authorId?: string | null; sourceExcerpt: string }) {
  const cutover = await tx.workflowCheckpoint.findUnique({ where: { key: "buyer-showing-candidates-v1" }, select: { createdAt: true } });
  if (!cutover || input.occurredAt < cutover.createdAt) return null;
  await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${input.clientId} FOR UPDATE`;
  const client = await tx.client.findUnique({ where: { id: input.clientId } });
  if (!client || client.deletedAt || client.assignmentCompletedAt || !confirmedClientIntents(client).buys
    || !client.assignedAt || input.occurredAt < client.assignedAt
    || (input.authorId && client.assignedAgentId !== input.authorId)) return null;
  if (!await assignmentSourceEpochIsCurrent(tx, { clientId: client.id, subjectAgentId: client.assignedAgentId,
    assignmentAt: client.assignedAt, sourceAt: input.occurredAt, now: new Date() })) return null;
  // Never bind a candidate to an unrelated guessed property.
  const property = input.propertyId ? await tx.property.findFirst({ where: { id: input.propertyId, deletedAt: null }, select: { id: true } }) : null;
  return tx.buyerShowingCandidate.upsert({ where: { sourceKey: `${input.sourceType}:${input.sourceId}` }, update: {}, create: {
    sourceKey: `${input.sourceType}:${input.sourceId}`, sourceType: input.sourceType, sourceId: input.sourceId,
    sourceInteractionId: input.sourceInteractionId, sourceConversationId: input.sourceConversationId,
    sourceExcerpt: input.sourceExcerpt, sourceOccurredAt: input.occurredAt,
    clientId: client.id, agentId: client.assignedAgentId, assignmentAt: client.assignedAt, proposedAt: input.proposedAt,
    propertyId: property?.id ?? null, reviewDueAt: new Date(input.occurredAt.getTime() + THREE_DAYS), executionMode: newBuyerCandidateMode(input.occurredAt),
  } });
}

export async function previewBuyerShowingCandidates(now = new Date()) {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { sellerControlConfig: true, companyDaysOff: true } });
  const followupDays = readSellerControlConfig(settings?.sellerControlConfig)?.buyerCandidateFollowupWorkingDays;
  const rows = await prisma.buyerShowingCandidate.findMany({ where: { status: "OPEN" }, orderBy: { detectedAt: "desc" }, take: 100 });
  return Promise.all(rows.map(async row => {
    const client = await prisma.client.findUnique({ where: { id: row.clientId }, select: { assignedAt: true, assignedAgentId: true, deletedAt: true, assignmentCompletedAt: true } });
    if (!client || client.deletedAt || client.assignmentCompletedAt || client.assignedAt?.getTime() !== row.assignmentAt.getTime() || client.assignedAgentId !== row.agentId)
      return { ...row, evaluation: "ASSIGNMENT_ENDED", plannedAction: null };
    if (!await assignmentSourceEpochIsCurrent(prisma, { clientId: row.clientId, subjectAgentId: row.agentId,
      assignmentAt: row.assignmentAt, sourceAt: row.sourceOccurredAt ?? row.detectedAt, now }))
      return { ...row, evaluation: "ASSIGNMENT_ENDED", plannedAction: null };
    const showing = row.proposedAt && row.propertyId ? await prisma.interaction.findFirst({ where: { clientId: row.clientId, type: "SHOWING", taskCancelledAt: null, declinedAt: null,
      createdAt: { gte: row.assignmentAt }, ...(row.propertyId ? { propertyId: row.propertyId } : {}),
      nextActionDate: row.proposedAt }, select: { id: true } }) : null;
    const possible = !showing && row.propertyId ? await prisma.interaction.findFirst({ where: {
      clientId: row.clientId, propertyId: row.propertyId, type: "SHOWING", taskCancelledAt: null, declinedAt: null,
      createdAt: { gte: row.sourceOccurredAt ?? row.detectedAt }, nextActionDate: { not: null },
    }, select: { id: true } }) : null;
    if (possible) return { ...row, evaluation: "MATCH_UNCERTAIN", plannedAction: null, confidence: "HUMAN_LINK_REQUIRED", followupEscalation: "NOT_CONFIGURED" };
    const agent = followupDays && row.agentId ? await prisma.agent.findUnique({ where: { id: row.agentId }, select: { weeklyDaysOff: true } }) : null;
    const followupDueAt = followupDays ? addAlarmWorkingDays(row.reviewDueAt, followupDays,
      { companyDaysOff: settings?.companyDaysOff ?? [], agentDaysOff: agent?.weeklyDaysOff ?? [] }) : null;
    return { ...row, evaluation: showing ? "RECORDED" : row.reviewDueAt > now ? "WAITING" : "MISSING_SHOWING",
      plannedAction: !showing && row.reviewDueAt <= now ? "AGENT_REMINDER_PREVIEW" : null,
      followupDueAt, followupEscalation: !followupDueAt ? "NOT_CONFIGURED" : showing ? "NOT_NEEDED"
        : followupDueAt > now ? "WAITING" : "PRIVATE_REVIEW_PREVIEW",
      confidence: !row.proposedAt ? "DATE_UNKNOWN" : row.propertyId ? "OBJECT_LINKED" : "OBJECT_UNKNOWN" };
  }));
}
