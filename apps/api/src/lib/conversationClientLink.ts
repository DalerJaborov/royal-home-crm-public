import type { ConversationClientLinkInput } from "@royal-home/shared";
import { prisma } from "../db.js";
import { TG_PREFIX } from "./conversationId.js";
import { mergeContactProfilesInTransaction } from "./contactProfiles.js";
import { findPhoneOwners, phoneTail } from "./clientPhones.js";
import { whatsAppPhoneFromSubscriberId } from "./whatsappPhone.js";

export class ConversationClientLinkError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** A human confirms identity; moving conversations and dossier memory is atomic. */
export async function linkConversationClient(rawId: string, input: ConversationClientLinkInput, byId: string | null) {
  const telegram = rawId.startsWith(TG_PREFIX);
  const id = telegram ? rawId.slice(TG_PREFIX.length) : rawId;
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const conversation = telegram
          ? await tx.telegramConversation.findUnique({ where: { id } })
          : await tx.botConversation.findUnique({ where: { id } });
        const client = await tx.client.findFirst({ where: { id: input.clientId, deletedAt: null } });
        if (!conversation || !client) throw new ConversationClientLinkError(404, "Диалог или клиент не найден");
        if (conversation.clientId && conversation.clientId !== client.id) {
          throw new ConversationClientLinkError(409, "Диалог уже связан с другим клиентом. Используйте объединение карточек");
        }
        const related = await tx.contactProfile.findMany({
          where: { mergedIntoId: null, OR: [
            ...(conversation.contactProfileId ? [{ id: conversation.contactProfileId }] : []),
            { clientId: client.id }, { botConversations: { some: { clientId: client.id } } },
            { telegramConversations: { some: { clientId: client.id } } },
            { telegramDirectConversations: { some: { clientId: client.id } } },
            { incomingCalls: { some: { clientId: client.id } } },
          ] },
          orderBy: [{ firstSeenAt: "asc" }, { id: "asc" }], take: 51,
        });
        if (related.length > 50) throw new ConversationClientLinkError(409, "Слишком много досье: требуется разбор дубликатов");
        const profileIds = related.map((p) => p.id);
        if (conversation.contactProfileId && !profileIds.includes(conversation.contactProfileId)) {
          throw new ConversationClientLinkError(409, "Досье изменилось. Обновите переписку и повторите");
        }
        // Never move another client's satellites, including those whose profile.clientId is empty.
        const foreignProfile = await tx.contactProfile.findFirst({ where: { id: { in: profileIds }, OR: [
          { clientId: { not: client.id } },
          { botConversations: { some: { clientId: { not: client.id } } } },
          { telegramConversations: { some: { clientId: { not: client.id } } } },
          { telegramDirectConversations: { some: { clientId: { not: client.id } } } },
          { incomingCalls: { some: { clientId: { not: client.id } } } },
          { jobApplications: { some: { clientId: { not: client.id } } } },
        ] } });
        if (foreignProfile) throw new ConversationClientLinkError(409, "Досье связано с другим клиентом. Сначала разберите дубликаты карточек");
        const target = related.find((p) => p.clientId === client.id) ?? related[0];
        if (target) {
          for (const source of related) {
            if (source.id === target.id) continue;
            await mergeContactProfilesInTransaction(tx, { targetId: target.id, sourceId: source.id,
              reason: "MANUAL_CLIENT_LINK", byId });
          }
          await tx.contactProfile.update({ where: { id: target.id }, data: { clientId: client.id } });
          const where = { contactProfileId: target.id, clientId: null };
          await tx.botConversation.updateMany({ where, data: { clientId: client.id } });
          await tx.telegramConversation.updateMany({ where, data: { clientId: client.id } });
          await tx.telegramDirectConversation.updateMany({ where, data: { clientId: client.id } });
          await tx.incomingCall.updateMany({ where, data: { clientId: client.id } });
          await tx.jobApplication.updateMany({ where, data: { clientId: client.id } });
        }
        const data = { clientId: client.id, ...(target ? { contactProfileId: target.id } : {}) };
        if (telegram) await tx.telegramConversation.update({ where: { id }, data });
        else await tx.botConversation.update({ where: { id }, data });
        const waPhone = "subscriberId" in conversation && "channel" in conversation
          ? whatsAppPhoneFromSubscriberId(conversation.channel, conversation.subscriberId) : null;
        if (waPhone) {
          const owners = await findPhoneOwners([waPhone], { exceptClientId: client.id, db: tx, limit: 1 });
          if (owners.length) throw new ConversationClientLinkError(409, "Номер WhatsApp уже есть в другой карточке. Сначала объедините карточки");
          if (!client.whatsappPhone) {
            await tx.client.update({ where: { id: client.id }, data: { whatsappPhone: waPhone } });
          } else if (![client.phone, client.whatsappPhone, ...client.extraPhones].some((p) => phoneTail(p) === phoneTail(waPhone))) {
            await tx.client.update({ where: { id: client.id }, data: { extraPhones: { push: waPhone } } });
          }
        }
        // Audit belongs to the same transaction, so success always has a receipt.
        const actor = byId ? await tx.agent.findUniqueOrThrow({ where: { id: byId }, select: { fullName: true } }) : null;
        await tx.auditLog.create({ data: { agentId: byId, agentName: actor?.fullName ?? "Система (по поручению владельца)", action: "CONVERSATION_CLIENT_LINK", entityType: "Client",
          entityId: client.id, meta: { conversationId: rawId, profileId: target?.id ?? null, profileIds,
            source: byId ? "crm" : "owner-authorized-maintenance" } } });
        return { ok: true, clientId: client.id, clientShortId: String(client.shortId) };
      }, { isolationLevel: "Serializable", timeout: 20_000 });
    } catch (err) {
      if (attempt < 2 && typeof err === "object" && err && "code" in err && err.code === "P2034") continue;
      throw err;
    }
  }
}
