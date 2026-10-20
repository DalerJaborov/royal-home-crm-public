import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";

export function ownChatClientWhere(agentId: string) {
  return { assignedAgentId: agentId, deletedAt: null, acceptedAt: { not: null } } as const;
}

export function liveOwnedChatPropertyWhere(agentId: string): Prisma.PropertyWhereInput {
  return {
    deletedAt: null, status: { in: ["AVAILABLE", "RESERVED"] },
    OR: [
      { intakeAgentId: agentId },
      { intakeAgentId: null, assignedAgentId: agentId },
      { intakeAgentId: null, assignedAgentId: null, createdById: agentId },
    ],
  };
}

/** Only a client's interest in a live property opens an unassigned conversation.
 * Showing a property ourselves is not interest. Client ownership takes priority. */
export function ownPropertyInterestConversationWhere(agentId: string, ignoreHandler = false): Prisma.BotConversationWhereInput {
  return {
    AND: [
      { OR: [
        { clientId: null }, { client: { is: { assignedAgentId: null, deletedAt: null } } },
        { propertyChatAgentId: agentId, client: { is: { assignedAgentId: agentId, deletedAt: null } } },
      ] },
      ...(ignoreHandler ? [] : [{ OR: [{ propertyChatAgentId: null }, { propertyChatAgentId: agentId }] }]),
      // A merged/linked profile must not bypass another client's ownership.
      { OR: [
        { contactProfileId: null },
        { contactProfile: { is: { mergedIntoId: null, OR: [
          { clientId: null }, { client: { is: { assignedAgentId: null, deletedAt: null } } },
        ] } } },
        { propertyChatAgentId: agentId, contactProfile: { is: { mergedIntoId: null, client: { is: { assignedAgentId: agentId, deletedAt: null } } } } },
      ] },
      { propertyLinks: { some: {
        source: { not: "EXPOSURE" },
        property: { is: liveOwnedChatPropertyWhere(agentId) },
      } } },
    ],
  };
}

/** Carry the object of a real agent conversation into lead assignment, even
 * if it was recognized by a shared post rather than an ad or typed number. */
export async function propertyChatLeadPropertyId(conversationId: string): Promise<string | undefined> {
  const row = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: {
    propertyChatAgentId: true, propertyChatAgent: { select: { isActive: true } },
  } });
  if (!row?.propertyChatAgentId || !row.propertyChatAgent?.isActive) return undefined;
  const owned = await prisma.botConversation.findFirst({
    where: { id: conversationId, ...ownPropertyInterestConversationWhere(row.propertyChatAgentId) },
    select: { propertyLinks: {
      where: { source: { not: "EXPOSURE" }, property: liveOwnedChatPropertyWhere(row.propertyChatAgentId) },
      orderBy: { lastSeenAt: "desc" }, take: 1, select: { propertyId: true },
    } },
  });
  return owned?.propertyLinks[0]?.propertyId;
}

export function ownBotConversationWhere(agentId: string): Prisma.BotConversationWhereInput {
  return { OR: [{ client: { is: ownChatClientWhere(agentId) } }, ownPropertyInterestConversationWhere(agentId)] };
}

/** SQL form of ownBotConversationWhere, for inbox queries with aliases c/cl.
 * Reused by list, search, pagination, segments and waiting alerts. */
export function ownBotConversationSql(agentId: string | null | undefined): Prisma.Sql {
  if (!agentId) return Prisma.sql`TRUE`;
  return Prisma.sql`(
    (cl.id IS NOT NULL AND cl."assignedAgentId" = ${agentId}
      AND cl."deletedAt" IS NULL AND cl."acceptedAt" IS NOT NULL)
    OR (${propertyInterestSql(agentId)})
  )`;
}

/** The Mine segment keeps the existing assigned-client filter for supervisors. */
export function ownBotConversationMineSql(agentId: string | null | undefined): Prisma.Sql {
  if (!agentId) return Prisma.sql`TRUE`;
  return Prisma.sql`((cl.id IS NOT NULL AND cl."assignedAgentId" = ${agentId}) OR (${propertyInterestSql(agentId)}))`;
}

function propertyInterestSql(agentId: string): Prisma.Sql {
  return Prisma.sql`(
      (c."clientId" IS NULL OR (cl.id IS NOT NULL AND cl."deletedAt" IS NULL
        AND (cl."assignedAgentId" IS NULL OR (cl."assignedAgentId" = ${agentId} AND c."propertyChatAgentId" = ${agentId}))))
      AND (c."propertyChatAgentId" IS NULL OR c."propertyChatAgentId" = ${agentId})
      AND NOT EXISTS (SELECT 1 FROM "ContactProfile" cp WHERE cp.id = c."contactProfileId" AND cp."mergedIntoId" IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM "ContactProfile" cp JOIN "Client" pc ON pc.id = cp."clientId"
        WHERE cp.id = c."contactProfileId" AND (pc."deletedAt" IS NOT NULL
          OR (pc."assignedAgentId" IS NOT NULL AND (pc."assignedAgentId" <> ${agentId} OR c."propertyChatAgentId" IS DISTINCT FROM ${agentId})))
      )
      AND EXISTS (
        SELECT 1 FROM "ConversationProperty" link JOIN "Property" p ON p.id = link."propertyId"
        WHERE link."conversationId" = c.id AND link.source <> 'EXPOSURE'
          AND p."deletedAt" IS NULL AND p.status IN ('AVAILABLE', 'RESERVED')
          AND COALESCE(p."intakeAgentId", p."assignedAgentId", p."createdById") = ${agentId}
      )
  )`;
}

/** Property owners who should receive live updates before a lead is assigned. */
export async function propertyInterestChatAgentIds(conversationId: string): Promise<string[]> {
  const row = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: {
    propertyChatAgentId: true,
    client: { select: { assignedAgentId: true, deletedAt: true } },
    contactProfile: { select: { mergedIntoId: true, client: { select: { assignedAgentId: true, deletedAt: true } } } },
    propertyLinks: { where: { source: { not: "EXPOSURE" }, property: { deletedAt: null, status: { in: ["AVAILABLE", "RESERVED"] } } },
      select: { property: { select: { intakeAgentId: true, assignedAgentId: true, createdById: true } } } },
  } });
  if (!row || row.client?.deletedAt || row.contactProfile?.mergedIntoId || row.contactProfile?.client?.deletedAt) return [];
  const owners = [...new Set(row.propertyLinks.map(({ property }) => propertyOwnerAgentId(property)).filter((id): id is string => !!id))];
  const allowed = owners.filter(id => (!row.propertyChatAgentId || row.propertyChatAgentId === id)
    && (!row.client?.assignedAgentId || row.propertyChatAgentId === id && row.client.assignedAgentId === id)
    && (!row.contactProfile?.client?.assignedAgentId || row.propertyChatAgentId === id && row.contactProfile.client.assignedAgentId === id));
  if (!allowed.length) return [];
  return (await prisma.agent.findMany({ where: { id: { in: allowed }, isActive: true }, select: { id: true } })).map(a => a.id);
}
