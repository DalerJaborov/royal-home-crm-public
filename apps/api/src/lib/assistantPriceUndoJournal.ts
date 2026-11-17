import { isReadOnlyRole } from "@royal-home/shared";
import { loadAgentAccess } from "../auth/middleware.js";
import type { TxClient } from "../db.js";
import type { Property } from "../generated/prisma/client.js";
import { canManagePropertyAs } from "./propertyAccess.js";
import type { AssistantPriceUndoLink } from "./propertyChangeRequests.js";

export const ASSISTANT_PRICE_UNDO_JOB = "assistant-price-undo";

export function appliedPriceUndoResult(result: unknown) {
  if (!result || typeof result !== "object") return null;
  const value = result as { requestId?: unknown; applied?: unknown; appliedPropertyVersion?: unknown };
  if (value.applied !== true || typeof value.requestId !== "string" || !value.requestId) return null;
  const version = value.appliedPropertyVersion;
  return { requestId: value.requestId, propertyVersion: typeof version === "number" ? version : undefined };
}

export async function canResumeAssistantPriceUndo(tx: TxClient, agentId: string, property: Property) {
  await tx.$queryRaw`SELECT id FROM "Agent" WHERE id = ${agentId} FOR SHARE`;
  const access = await loadAgentAccess(agentId, tx);
  return Boolean(access?.isActive && !isReadOnlyRole(access.role) && access.permissions.has("properties.requestChange") &&
    (property.status !== "RESERVED" || access.permissions.has("properties.editForeign")) &&
    canManagePropertyAs({ agentId, can: (permission) => access.permissions.has(permission) }, property));
}

/** This receipt and the price must commit together. Delivery runs from its own durable queue. */
export async function recordAssistantPriceUndo(
  tx: TxClient,
  link: AssistantPriceUndoLink,
  request: { id: string; propertyId: string; authorId: string; agentName: string },
) {
  if (link.actionId !== request.id) throw new Error("Invalid assistant price undo request link");
  const action = await tx.assistantAction.findUnique({ where: { id: link.actionId } });
  if (!action || (action.snapshotAfter as { propertyId?: string } | null)?.propertyId !== request.propertyId ||
    !appliedPriceUndoResult(action.result)) {
    throw new Error("Assistant price undo lacks matching source action");
  }
  const updated = await tx.assistantAction.updateMany({
    where: {
      id: link.actionId, tool: "change_property_price", agentId: request.authorId, status: "EXECUTED", undoClaimedAt: { not: null },
    },
    data: { status: "UNDONE", undoneAt: new Date() },
  });
  if (updated.count !== 1) throw new Error("Assistant price undo receipt could not be committed");
  await tx.auditLog.create({
    data: {
      action: "ASSISTANT_CHANGE_PROPERTY_PRICE_UNDO",
      entityType: "AssistantAction",
      entityId: link.actionId,
      agentId: request.authorId,
      agentName: request.agentName,
      meta: { source: "assistant.undo", actionId: link.actionId, channel: link.channel, requestId: request.id },
    },
  });
}
