import { prisma } from "../../db.js";
import { sendMessage, sendPhoto, TelegramApiError } from "../../telegram/api.js";

function confirmedReceipt(value: unknown, chatId: string): boolean {
  if (!value || typeof value !== "object") return false;
  const data = value as { message_id?: unknown; chat?: { id?: unknown } };
  return Number.isSafeInteger(data.message_id) && Number(data.message_id) > 0 && data.chat != null && String(data.chat.id) === chatId;
}

/** The same lock guards stopping and recipient changes. A stop waits for a
 * request already in flight, and after it returns no later request can start. */
export async function sendReservedSomon(advertId: string, agentId: string, chatId: string, text: string, image: string | null): Promise<"sent" | "unknown" | "cancelled" | "blocked"> {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-owner-delivery'))`;
    const state = await tx.somonMonitor.findUnique({ where: { id: "singleton" } });
    const item = await tx.somonDelivery.findUnique({ where: { advertId } });
    const recipient = await tx.somonRecipient.findUnique({ where: { agentId } });
    const agent = await tx.agent.findUnique({ where: { id: agentId }, select: { role: true, isActive: true, telegramChatId: true } });
    if (!item || item.status !== "SENDING" || item.agentId !== agentId) return "cancelled";
    if (!state?.enabled || state.sourceStopped || !recipient?.enabled || !agent?.isActive || agent.role !== "AGENT" || agent.telegramChatId !== chatId) {
      await tx.somonDelivery.update({ where: { advertId }, data: { status: "CANCELLED" } });
      await tx.somonContactReceipt.deleteMany({ where: { advertId } });
      await tx.somonSeenAdvert.updateMany({ where: { advertId }, data: { status: "PENDING" } });
      return "cancelled";
    }
    try {
      const receipt = image ? await sendPhoto(chatId, image, text, { singleAttempt: true }) : await sendMessage(chatId, text, undefined, undefined, { singleAttempt: true });
      if (!confirmedReceipt(receipt, chatId)) {
        await tx.somonDelivery.update({ where: { advertId }, data: { status: "UNKNOWN" } });
        return "unknown";
      }
      await tx.somonDelivery.update({ where: { advertId }, data: { status: "ACCEPTED" } });
      await tx.somonSeenAdvert.updateMany({ where: { advertId }, data: { slug: null } });
      return "sent";
    } catch (error) {
      if (error instanceof TelegramApiError && error.errorCode === 403) {
        await tx.somonRecipient.update({ where: { agentId }, data: { enabled: false } });
        await tx.somonDelivery.update({ where: { advertId }, data: { status: "FAILED" } });
        await tx.somonContactReceipt.deleteMany({ where: { advertId } });
        await tx.somonSeenAdvert.updateMany({ where: { advertId }, data: { status: "PENDING" } });
        return "blocked";
      }
      await tx.somonDelivery.update({ where: { advertId }, data: { status: "UNKNOWN" } });
      return "unknown";
    }
  }, { timeout: 30000 });
}
