import { prisma } from "../db.js";
import { NOT_YET_ACCEPTED_STATUSES } from "./sellerNoPropertyAlarm.js";
import { findStalledSellers, STALLED_AGENT_WORKING_DAYS, STALLED_DIRECTOR_WORKING_DAYS } from "./sellerWorkStalledAlarm.js";

export function classifySellerInventory(input: {
  expected: number | null; declaredAt: Date | null; assignedAt: Date; statuses: string[];
}) {
  const drafts = input.statuses.filter(status => (NOT_YET_ACCEPTED_STATUSES as readonly string[]).includes(status)).length;
  const terminal = input.statuses.filter(status => status === "SOLD" || status === "WITHDRAWN").length;
  const accepted = input.statuses.length - drafts;
  const reasons: string[] = [];
  if (input.expected === null) reasons.push("EXPECTED_COUNT_UNKNOWN");
  if (!input.declaredAt || input.declaredAt < input.assignedAt) reasons.push("COUNT_PREDATES_ASSIGNMENT_OR_UNDATED");
  if (terminal) reasons.push("TERMINAL_OBJECTS_NEED_RECONCILIATION");
  return { expected: input.expected, accepted, drafts, terminal,
    missing: input.expected === null ? null : Math.max(0, input.expected - accepted),
    state: reasons.length ? "UNCERTAIN" : accepted < input.expected! ? "MISSING" : "COMPLETE", reasons };
}

/** Read-only shadow of existing facts. Never invokes either legacy alarm tick. */
export async function sellerControlPreview(page: number, now = new Date()) {
  const where = { deletedAt: null, assignmentCompletedAt: null, workStatus: "ACTIVE" as const,
    status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] as ("LOST" | "DEAL_CLOSED" | "ARCHIVED")[] },
    OR: [{ kind: "SELLER" as const }, { kind: "BUYER" as const, dualIntent: true, dualIntentConfirmedAt: { not: null } }] };
  const [clients, total, stalled] = await Promise.all([
    prisma.client.findMany({ where, orderBy: { id: "asc" }, skip: (page - 1) * 50, take: 50, select: {
      id: true, shortId: true, fullName: true, assignedAt: true, propertyAcceptedAt: true, sellerDeclaredPropertyCount: true,
      sellerDeclaredPropertyCountAt: true, lastAgentAttemptAt: true, lastClientMessageAt: true,
      assignedAgent: { select: { fullName: true } },
    } }), prisma.client.count({ where }), findStalledSellers(now),
  ]);
  const ids = clients.map(client => client.id);
  const [properties, anchors, planned] = await Promise.all([
    prisma.property.findMany({ where: { sellerClientId: { in: ids }, deletedAt: null }, select: { sellerClientId: true, status: true } }),
    prisma.interaction.findMany({ where: { clientId: { in: ids }, outcome: "SELLER_MEETING", declinedAt: null, taskCancelledAt: null,
      OR: [{ nextActionDate: { not: null } }, { completedAt: { not: null } }] }, orderBy: [{ clientId: "asc" }, { createdAt: "desc" }],
      distinct: ["clientId"], select: { clientId: true, id: true, nextActionDate: true, completedAt: true } }),
    prisma.interaction.findMany({ where: { clientId: { in: ids }, taskCancelledAt: null, completedAt: null, declinedAt: null,
      nextAction: { not: null }, nextActionDate: { gt: now } }, distinct: ["clientId"], select: { clientId: true } }),
  ]);
  return { mode: "PREVIEW", page, pageSize: 50, total,
    acceptanceBasis: "EXISTING_MATERIAL_SUBMISSION_POLICY_NOT_MANAGER_APPROVAL", stalledLookupCoverage: "EXISTING_HELPER_CAP_500",
    thresholds: { agentWorkingDays: STALLED_AGENT_WORKING_DAYS, directorWorkingDays: STALLED_DIRECTOR_WORKING_DAYS },
    items: clients.map(client => {
      const anchor = anchors.find(row => row.clientId === client.id);
      const anchorAt = anchor?.nextActionDate ?? anchor?.completedAt ?? client.propertyAcceptedAt;
      const hasNextStep = planned.some(row => row.clientId === client.id);
      const stalledFact = stalled.find(row => row.id === client.id);
      return { id: client.id, shortId: client.shortId, name: client.fullName, agentName: client.assignedAgent?.fullName ?? null,
        ...classifySellerInventory({ expected: client.sellerDeclaredPropertyCount, declaredAt: client.sellerDeclaredPropertyCountAt,
          assignedAt: client.assignedAt, statuses: properties.filter(row => row.sellerClientId === client.id).map(row => row.status) }),
        declaredAt: client.sellerDeclaredPropertyCountAt, anchorAt, anchorSource: anchor ? "SELLER_MEETING" : client.propertyAcceptedAt ? "PROPERTY_ACCEPTED" : "UNKNOWN",
        lastAgentAttemptAt: client.lastAgentAttemptAt, lastClientMessageAt: client.lastClientMessageAt,
        agentAttemptAfterAnchor: anchorAt && client.lastAgentAttemptAt ? client.lastAgentAttemptAt > anchorAt : null,
        clientReplyAfterAnchor: anchorAt && client.lastClientMessageAt ? client.lastClientMessageAt > anchorAt : null,
        hasPlannedNextStep: hasNextStep, workingDaysSilent: stalledFact?.workingDaysSilent ?? null,
        proposedStage: hasNextStep ? "EXISTING_AGENT_TASK" : stalledFact ? "AGENT_REVIEW_PREVIEW" : "UNKNOWN",
        ropInaction: "UNKNOWN_NO_LINKED_ESCALATION_RECEIPT", directorAction: "NOT_PROPOSED_WITHOUT_ROP_EVIDENCE",
      };
    }) };
}
