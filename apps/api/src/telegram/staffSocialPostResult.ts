import { prisma } from "../db.js";
import { sendMessage } from "./api.js";

/**
 * ИТОГ ПУБЛИКАЦИИ ТОМУ, КТО НАЖАЛ «Опубликовать» У ШАБНАМ (21.11.2026). Публикация идёт в фоне
 * минуты (Instagram обрабатывает ролик), поэтому итог приходит отдельным сообщением в ту же
 * личку: это ответ на его же нажатие, а не почин CRM. Пост не от Шабнам — молчим (итог уходит
 * пушем, как раньше). Отдельный файл, чтобы lib/socialVideoPosts.ts не тянул весь Telegram-поток.
 */
export async function tellStaffSocialPostResult(socialVideoPostId: string, text: string): Promise<void> {
  const post = await prisma.staffSocialPost.findUnique({ where: { socialVideoPostId }, select: { chatId: true, agentId: true, status: true } });
  if (!post || (post.status !== "PUBLISHED" && post.status !== "PUBLISHING")) return;
  const agent = await prisma.agent.findUnique({ where: { id: post.agentId }, select: { isActive: true, telegramChatId: true } });
  if (!agent?.isActive || agent.telegramChatId !== post.chatId) return;
  await sendMessage(post.chatId, text.slice(0, 3900));
}
