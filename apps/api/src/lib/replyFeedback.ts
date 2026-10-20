import type { ConversationMessage } from "@royal-home/shared";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { rememberAgentReply, sanitizeStyleText } from "../ai/styleLearning.js";
import { TG_PREFIX } from "./conversationId.js";

/**
 * ОЦЕНКА ОТВЕТА БОТА — общая логика (17.09.2026, вынесена из
 * `routes/conversations.ts POST /:id/reply-feedback` при добавлении «Тренажёра
 * бота», чтобы обе точки входа — сама переписка и тренажёр — вызывали ОДНО и то
 * же место, а не две копии, которые могут разъехаться молча.
 *
 * `good` идёт через `rememberAgentReply()` с источником `APPROVED`. `bad` пишет
 * прямо в `BotLesson` (не через `recordLesson()` — её дедуп по тексту бота здесь
 * мешает, см. комментарий в routes/conversations.ts). Идемпотентность —
 * повторная оценка ТОЙ ЖЕ реплики правит существующую запись, а не плодит новую.
 */
export class ReplyFeedbackError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export async function applyReplyFeedback(input: {
  rawId: string;
  messageKey: string;
  verdict: "good" | "bad";
  note?: string;
  userId: string;
}): Promise<{ feedback: NonNullable<ConversationMessage["feedback"]> }> {
  const { rawId, messageKey, verdict, note, userId } = input;
  const isTelegram = rawId.startsWith(TG_PREFIX);
  const dbId = isTelegram ? rawId.slice(TG_PREFIX.length) : rawId;

  let rawMessages: unknown;
  let channel: string;
  if (isTelegram) {
    const tg = await prisma.telegramConversation.findUnique({ where: { id: dbId }, select: { messages: true } });
    if (!tg) throw new ReplyFeedbackError(404, "Диалог не найден");
    rawMessages = tg.messages;
    channel = "TELEGRAM";
  } else {
    const bot = await prisma.botConversation.findUnique({ where: { id: dbId }, select: { messages: true, channel: true } });
    if (!bot) throw new ReplyFeedbackError(404, "Диалог не найден");
    rawMessages = bot.messages;
    channel = bot.channel;
  }

  const messages = Array.isArray(rawMessages) ? (rawMessages as unknown as ConversationMessage[]) : [];

  let idx = -1;
  if (messageKey.startsWith("idx:")) {
    const n = Number(messageKey.slice(4));
    if (Number.isInteger(n) && n >= 0 && n < messages.length) idx = n;
  } else {
    idx = messages.findIndex((m) => m?.mid === messageKey || m?.mid2 === messageKey);
  }
  if (idx === -1) throw new ReplyFeedbackError(404, "Реплика не найдена");

  const target = messages[idx];
  if (target.role !== "assistant" || (target.by && target.by.kind !== "bot")) {
    throw new ReplyFeedbackError(400, "Это не ответ бота");
  }

  let humanMessage = "";
  for (let i = idx - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      humanMessage = messages[i].content ?? "";
      break;
    }
  }
  const botMessage = sanitizeStyleText(target.content ?? "");
  const humanMessageClean = sanitizeStyleText(humanMessage);
  const nowIso = new Date().toISOString();

  const prevFeedback = target.feedback;
  if (prevFeedback && prevFeedback.verdict !== verdict) {
    if (prevFeedback.verdict === "bad" && prevFeedback.lessonId) {
      await prisma.botLesson.update({ where: { id: prevFeedback.lessonId }, data: { active: false } }).catch(() => {});
    } else if (prevFeedback.verdict === "good" && prevFeedback.styleExampleId) {
      await prisma.styleExample.update({ where: { id: prevFeedback.styleExampleId }, data: { enabled: false } }).catch(() => {});
    }
  }

  let newFeedback: NonNullable<ConversationMessage["feedback"]>;
  if (verdict === "bad") {
    const lesson = note ? sanitizeStyleText(note).slice(0, 300) : null;
    const active = Boolean(note);
    let lessonId: string;
    if (prevFeedback?.verdict === "bad" && prevFeedback.lessonId) {
      await prisma.botLesson.update({
        where: { id: prevFeedback.lessonId },
        data: { botMessage, humanMessage: humanMessageClean, lesson, active },
      });
      lessonId = prevFeedback.lessonId;
    } else {
      const created = await prisma.botLesson.create({
        data: { kind: "owner_bad", channel, conversationId: rawId, botMessage, humanMessage: humanMessageClean, lesson, active },
      });
      lessonId = created.id;
    }
    newFeedback = { verdict, note: note || undefined, by: userId, at: nowIso, lessonId };
  } else {
    const created = await rememberAgentReply({ clientText: humanMessage, agentText: target.content ?? "", channel, source: "APPROVED" });
    let styleExampleId: string | undefined;
    if (created) {
      const row = await prisma.styleExample.findFirst({
        where: { agentText: botMessage, source: "APPROVED" },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      styleExampleId = row?.id;
    } else if (prevFeedback?.verdict === "good") {
      styleExampleId = prevFeedback.styleExampleId;
    }
    newFeedback = { verdict, by: userId, at: nowIso, styleExampleId };
  }

  const table = isTelegram ? "TelegramConversation" : "BotConversation";
  await prisma.$executeRaw`
    UPDATE ${Prisma.raw(`"${table}"`)}
    SET "messages" = jsonb_set("messages", ARRAY[${String(idx)}::text, 'feedback'], ${JSON.stringify(newFeedback)}::jsonb)
    WHERE "id" = ${dbId}`;

  return { feedback: newFeedback };
}
