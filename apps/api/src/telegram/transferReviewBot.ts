import { prisma } from "../db.js";
import { claimCallback as claim } from "../lib/telegramCallbackClaim.js";
import { reviewRopTransfer } from "../lib/ownershipTransferRequest.js";
import { answerCallbackQuery, sendMessage, type TelegramCallbackQuery } from "./api.js";

/**
 * Кнопки «Подтвердить» / «Отклонить» под сообщением директору о передаче РОП (16.11.2026).
 * callback_data: `tr:a:<id>` — подтвердить, `tr:d:<id>` — отклонить (вернуть прежнему хозяину).
 * Решает только активный директор или администратор, чей Telegram привязан к этому чату; вся логика —
 * в lib/ownershipTransferRequest.ts (одна дверь с кнопками в CRM).
 */
export async function handleTransferReviewCallback(query: TelegramCallbackQuery): Promise<boolean> {
  const data = query.data ?? "";
  if (!data.startsWith("tr:")) return false;
  await answerCallbackQuery(query.id).catch(() => {});
  const chatId = query.message?.chat.id != null ? String(query.message.chat.id) : null;
  if (!chatId) return true;
  if (!(await claim(query.id))) return true;

  const [, action, requestId] = data.split(":");
  if ((action !== "a" && action !== "d") || !requestId) return true;
  const agent = await prisma.agent.findFirst({
    where: { telegramChatId: chatId, isActive: true },
    select: { id: true, role: true },
  });
  if (!agent) {
    await sendMessage(chatId, "Этот Telegram не привязан к сотруднику CRM.").catch(() => {});
    return true;
  }
  const outcome = await reviewRopTransfer(agent, requestId, { decision: action === "a" ? "confirm" : "decline" });
  const text = outcome.ok
    ? action === "a"
      ? "✅ Передача подтверждена."
      : "↩️ Передача отклонена, карточка возвращена прежнему хозяину."
    : `⚠️ ${outcome.body.error}`;
  await sendMessage(chatId, text).catch(() => {});
  return true;
}
