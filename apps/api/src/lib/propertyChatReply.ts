import { prisma, type TxClient } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { ownPropertyInterestConversationWhere } from "./ownBotConversationScope.js";
import type { MessageSender } from "@royal-home/shared";
import { lockCustomerNative } from "./customerNativeLock.js";

export type DeliveryOwnershipFence = { inquiryId: string; ownershipEpoch: string; bindingRevision: string };
export type PropertyChatClaimUndo = { conversationId: string; agentId: string; at: Date; ownershipFence: DeliveryOwnershipFence };

/** Staff delivery already has an authorized native ID. This lock is an undo
 * fence, never a customer identity/permission grant. Missing anchors fail closed. */
export async function lockDeliveryOwnershipFence(tx: TxClient, target: { kind: "bot" | "telegram"; id: string }): Promise<DeliveryOwnershipFence | null> {
  if (!await lockCustomerNative(tx, target)) return null;
  const anchor = target.kind === "telegram" ? Prisma.sql`"telegramConversationId"` : Prisma.sql`"conversationId"`;
  const rows = await tx.$queryRaw<DeliveryOwnershipFence[]>(Prisma.sql`
    SELECT "id" AS "inquiryId", "ownershipEpoch"::text, "bindingRevision"::text
    FROM "CustomerInquiry" WHERE ${anchor} = ${target.id} AND "closedAt" IS NULL FOR UPDATE`);
  return rows.length === 1 ? rows[0] : null;
}
export function sameDeliveryOwnershipFence(left: DeliveryOwnershipFence | null, right: DeliveryOwnershipFence): boolean {
  return !!left && left.inquiryId === right.inquiryId && left.ownershipEpoch === right.ownershipEpoch && left.bindingRevision === right.bindingRevision;
}

/** Claim on the first actual reply, with one conditional UPDATE for competing owners.
 * Ordinary client conversations and supervisor help do not acquire a claim. */
export async function claimPropertyChatReply(conversationId: string, sender?: MessageSender, transaction?: TxClient): Promise<
  { ok: true; undo: PropertyChatClaimUndo | null } | { ok: false; status: number; error: string }
> {
  if (sender?.kind !== "agent") return { ok: true, undo: null };
  if (!transaction) return prisma.$transaction(tx => claimPropertyChatReply(conversationId, sender, tx));
  const before = await lockDeliveryOwnershipFence(transaction, { kind: "bot", id: conversationId });
  if (!before) return { ok: false, status: 409, error: "Диалог изменился. Обновите чат и отправьте сообщение ещё раз." };
  const eligible = await transaction.botConversation.findFirst({
    where: { id: conversationId, ...ownPropertyInterestConversationWhere(sender.agentId, true) },
    select: { propertyChatAgentId: true, propertyChatAgentAt: true },
  });
  if (!eligible) return { ok: true, undo: null };
  if (eligible.propertyChatAgentId === sender.agentId) {
    // A newer reply by the same agent protects the claim from an earlier
    // failed send's rollback. CAS also resolves two concurrent replies.
    const at = new Date(Math.max(Date.now(), (eligible.propertyChatAgentAt?.getTime() ?? 0) + 1));
    const touched = await transaction.botConversation.updateMany({
      where: { id: conversationId, ...ownPropertyInterestConversationWhere(sender.agentId),
        propertyChatAgentId: sender.agentId, propertyChatAgentAt: eligible.propertyChatAgentAt },
      data: { propertyChatAgentAt: at },
    });
    return touched.count ? { ok: true, undo: null }
      : { ok: false, status: 409, error: "Диалог изменился. Обновите чат и отправьте сообщение ещё раз." };
  }
  const at = new Date();
  const claimed = await transaction.botConversation.updateMany({
    where: { id: conversationId, ...ownPropertyInterestConversationWhere(sender.agentId), propertyChatAgentId: null },
    data: { propertyChatAgentId: sender.agentId, propertyChatAgentAt: at },
  });
  if (!claimed.count) return { ok: false, status: 409, error: "Диалог уже ведёт другой агент или изменилось назначение клиента. Обновите чат." };
  const ownershipFence = await lockDeliveryOwnershipFence(transaction, { kind: "bot", id: conversationId });
  if (!ownershipFence) throw new Error("Claim lost its customer inquiry anchor");
  return { ok: true, undo: { conversationId, agentId: sender.agentId, at, ownershipFence } };
}

export async function rollbackPropertyChatReply(undo: PropertyChatClaimUndo | null | undefined, transaction?: TxClient): Promise<void> {
  if (!undo) return;
  if (!transaction) return prisma.$transaction(tx => rollbackPropertyChatReply(undo, tx));
  const current = await lockDeliveryOwnershipFence(transaction, { kind: "bot", id: undo.conversationId });
  if (!sameDeliveryOwnershipFence(current, undo.ownershipFence)) return;
  await transaction.botConversation.updateMany({
    where: { id: undo.conversationId, propertyChatAgentId: undo.agentId, propertyChatAgentAt: undo.at },
    data: { propertyChatAgentId: null, propertyChatAgentAt: null },
  });
}
