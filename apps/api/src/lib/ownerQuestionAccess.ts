import { parsePermissionOverrides, resolvePermissions, type CustomerOwnerReplyTarget, type Role } from "@royal-home/shared";
import type { TxClient } from "../db.js";
import { ownBotConversationWhere } from "./ownBotConversationScope.js";

type StaffDb = Pick<TxClient, "agent" | "botConversation">;
function access(agent: { isActive?: boolean; role: string; permissions: unknown } | null) {
  if (!agent || agent.isActive === false) return null;
  const permissions = resolvePermissions(agent.role as Role, parsePermissionOverrides(agent.permissions));
  if (!permissions.has("dashboard.analytics")) return null;
  return { all: permissions.has("messages.view"), own: permissions.has("messages.viewOwn") };
}

export async function ownerQuestionVisibleNativeIds(db: StaffDb, agentId: string, nativeIds: string[]): Promise<Set<string>> {
  const actor = await db.agent.findUnique({ where: { id: agentId }, select: { isActive: true, role: true, permissions: true } });
  const rights = access(actor);
  if (!rights || (!rights.all && !rights.own)) return new Set();
  if (rights.all) return new Set(nativeIds);
  const rows = await db.botConversation.findMany({ where: { id: { in: nativeIds }, ...ownBotConversationWhere(agentId) }, select: { id: true } });
  return new Set(rows.map(row => row.id));
}

export async function ownerQuestionQueueScope(db: Pick<StaffDb, "agent">, agentId: string): Promise<"all" | "own" | "none"> {
  const actor = await db.agent.findUnique({ where: { id: agentId }, select: { isActive: true, role: true, permissions: true } });
  const rights = access(actor);
  return rights?.all ? "all" : rights?.own ? "own" : "none";
}

/** Notification and answering share actual staff ACL. A task/phone/profile is
 * never a grant to another agent's conversation. */
export async function ownerQuestionStaffRecipients(db: StaffDb, nativeId: string, target: CustomerOwnerReplyTarget): Promise<string[]> {
  const agents = await db.agent.findMany({ where: { isActive: true }, select: { id: true, role: true, permissions: true } });
  const eligible: string[] = [];
  for (const agent of agents) {
    const rights = access(agent);
    if (rights?.all || (rights?.own && await db.botConversation.count({ where: { id: nativeId, ...ownBotConversationWhere(agent.id),
      endpointScopeId: target.endpointScopeId, accountId: target.accountId, channel: target.channel, subscriberId: target.peer,
      endpointScope: { is: { scopeRevision: BigInt(target.scopeRevision) } },
      customerInquiry: { is: { id: target.inquiryId, bindingRevision: BigInt(target.bindingRevision), closedAt: null } },
    } }) === 1)) {
      eligible.push(agent.id);
    }
  }
  return eligible;
}
