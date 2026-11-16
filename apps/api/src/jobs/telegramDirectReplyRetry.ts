import { z } from "zod";
import { prisma } from "../db.js";
import type { JobHandler } from "./registry.js";
import { aiReplyRetryBackoffMs, BOT_TURN_JOB_TIMEOUT_MS } from "./aiReplyRetryPolicy.js";
import { alertChannelStaff } from "../lib/channelStaffAlert.js";

/**
 * ПОВТОР ОТВЕТА В ЛИЧНЫХ СООБЩЕНИЯХ TELEGRAM — СНЯТ ВМЕСТЕ С АВТООТВЕТОМ (один мозг, шаг 3, 16.11.2026).
 *
 * Модель в этом канале больше не отвечает (messengers/telegramDirectMessages.ts; ФАКТ: 0 диалогов за всё время). Тип
 * задания остаётся зарегистрированным, чтобы уже стоящие в очереди задания (после выкатки их может быть несколько)
 * завершились без хода модели: клиент не получает запоздалый ответ старого бота, а сотрудник — «ответьте вручную».
 */
const schema = z.object({ conversationId: z.string() });

export const telegramDirectReplyRetryJob: JobHandler<z.infer<typeof schema>> = {
  type: "telegram-dm-reply-retry",
  schema,
  backoff: aiReplyRetryBackoffMs,
  timeoutMs: BOT_TURN_JOB_TIMEOUT_MS,
  async run(payload) {
    const conversation = await prisma.telegramDirectConversation.findUnique({ where: { id: payload.conversationId },
      select: { id: true, messages: true } });
    if (!conversation) return;
    const messages = Array.isArray(conversation.messages) ? conversation.messages as Array<{ role?: unknown; content?: unknown }> : [];
    const last = [...messages].reverse().find(item => item?.role === "user");
    await alertChannelStaff({ channel: "TELEGRAM_DIRECT", conversationId: conversation.id,
      text: typeof last?.content === "string" ? last.content : "", why: "bot_retired" });
  },
  async onGiveUp() { /* run() never throws for a missing model: nothing to give up on. */ },
};
