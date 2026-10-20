import { prisma } from "../db.js";
import { sendPushToAgent } from "../push.js";
import { propertyInterestChatAgentIds } from "./ownBotConversationScope.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";

/** Follow-up messages in an unassigned property inquiry. The first incoming
 * message already has an interest notice; subsequent ones use the message kind.
 * The common push path writes the in-app feed even without a device subscription. */
export async function notifyPropertyChatMessage(conversationId: string): Promise<void> {
  try {
    const row = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: {
      client: { select: { assignedAgentId: true } }, messages: true,
    } });
    // Assigned clients have the existing clientMessageAlert path, including
    // acceptance reminders; do not send them a second notification here.
    if (!row || row.client?.assignedAgentId || !Array.isArray(row.messages) || row.messages.length === 0) return;
    const recipients = await propertyInterestChatAgentIds(conversationId);
    await Promise.all(recipients.map(agentId => sendPushToAgent(agentId, {
      kind: "message", title: "Новое сообщение по вашему объекту",
      // No contact details in a lock-screen preview; the chat applies their permissions.
      body: "Клиент написал в переписке по вашему объекту. Откройте «Чаты», чтобы ответить.",
      url: `/messages?open=${conversationId}`, tag: `property-chat-message-${conversationId}`,
    })));
  } catch (err) {
    void logSystemError("api", `Уведомление о сообщении по объекту не отправлено: ${describeError(err)}`, { dedupKey: "property-chat-message" });
  }
}
