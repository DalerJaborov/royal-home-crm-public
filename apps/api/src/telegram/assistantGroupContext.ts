import { z } from "zod";
import { prisma } from "../db.js";
import { maskAssistantContacts } from "../lib/assistantContacts.js";
import { findAgentByTelegramUserId } from "../lib/telegramAgentLink.js";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const TEXT_LIMIT = 1_000;
const RESULT_LIMIT = 4;
const CLEANUP_BATCH = 500;
const MESSAGE_ID_MAX = 2_147_483_647;
const messageId = z.number().int().positive().max(MESSAGE_ID_MAX);
const safeTelegramId = z.number().int().safe();

const groupMessage = z.object({
  chat: z.object({
    id: safeTelegramId.negative(),
    type: z.enum(["group", "supergroup"]),
    is_direct_messages: z.boolean().optional(),
  }),
  from: z.object({ id: safeTelegramId.positive(), is_bot: z.boolean().optional() }),
  message_id: messageId,
  message_thread_id: messageId.optional(),
  date: safeTelegramId.positive(),
  edit_date: safeTelegramId.positive().optional(),
  text: z.string().max(4_096).optional(),
  caption: z.string().max(4_096).optional(),
  has_protected_content: z.boolean().optional(),
  is_automatic_forward: z.boolean().optional(),
  sender_chat: z.unknown().optional(),
  forward_origin: z.unknown().optional(),
  forward_from_message_id: z.unknown().optional(),
  contact: z.unknown().optional(),
  location: z.unknown().optional(),
  voice: z.unknown().optional(),
  audio: z.unknown().optional(),
  video: z.unknown().optional(),
  video_note: z.unknown().optional(),
  photo: z.unknown().optional(),
  document: z.unknown().optional(),
});

type GroupMessage = z.infer<typeof groupMessage>;

function attachmentKind(message: GroupMessage): string | null {
  if (message.voice) return "voice";
  if (message.audio) return "audio";
  if (message.video || message.video_note) return "video";
  if (message.photo) return "photo";
  if (message.document) return "document";
  return null;
}

function redactEvidence(text: string): string {
  return maskAssistantContacts(text)
    .replace(/(?:https?:\/\/|tg:\/\/|www\.)[^\s<>{}]+/giu, "[ссылка]")
    .replace(/[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/giu, "[почта]")
    .slice(0, TEXT_LIMIT);
}

function propertyReferences(text: string): number[] {
  const matches = text.matchAll(/(?:^|[^\p{L}\p{N}])(?:об|ob)\s*[-–—]\s*(\d{1,10})(?![\p{L}\p{N}])/giu);
  return [...new Set([...matches].map(match => Number(match[1])))]
    .filter(id => id > 0 && id <= MESSAGE_ID_MAX)
    .slice(0, RESULT_LIMIT);
}

/** Call only from a Telegram update received by the common poller/webhook dispatcher. */
export async function captureAssistantTelegramContext(raw: unknown, updateId: number, now = new Date()): Promise<void> {
  if (!safeTelegramId.positive().safeParse(updateId).success) return;
  const result = groupMessage.safeParse(raw);
  if (!result.success) return;
  const message = result.data;
  if (message.chat.is_direct_messages || message.from.is_bot || message.sender_chat
      || message.is_automatic_forward || message.forward_origin || message.forward_from_message_id
      || message.has_protected_content || message.contact || message.location) return;

  const rawText = (message.text ?? message.caption ?? "").trim();
  if (rawText.startsWith("/")) return;
  const text = redactEvidence(rawText);
  const kind = attachmentKind(message);
  // Keep an empty edit as a tombstone, but don't archive empty service messages.
  if (!text && !kind && message.edit_date === undefined) return;

  const occurredAt = new Date(message.date * 1_000);
  const sourceVersion = new Date((message.edit_date ?? message.date) * 1_000);
  const expiresAt = new Date(occurredAt.getTime() + RETENTION_MS);
  if (!Number.isFinite(sourceVersion.getTime()) || !Number.isFinite(expiresAt.getTime())
      || sourceVersion < occurredAt || expiresAt <= now || sourceVersion.getTime() > now.getTime() + 60_000) return;

  const groupChatId = String(message.chat.id);
  const registration = await prisma.assistantTelegramGroup.findUnique({
    where: { chatId: groupChatId },
    select: { contextEnabledAt: true },
  });
  const enabledAt = registration?.contextEnabledAt;
  if (!enabledAt || occurredAt < enabledAt) return;

  const [author, settings] = await Promise.all([
    findAgentByTelegramUserId(String(message.from.id)),
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { telegramDiscussionGroupId: true } }),
  ]);
  if (!author || String(settings?.telegramDiscussionGroupId ?? "") === groupChatId) return;

  const where = { groupChatId, messageId: message.message_id };
  const sourceUpdateId = BigInt(updateId);
  const content = { sourceVersion, sourceUpdateId, text, attachmentKind: kind, propertyRefs: propertyReferences(text) };
  await prisma.$transaction(async tx => {
    const active = await tx.$queryRaw<{ chatId: string }[]>`
      SELECT "chatId" FROM "AssistantTelegramGroup"
      WHERE "chatId" = ${groupChatId} AND "contextEnabledAt" = ${enabledAt}
      FOR SHARE
    `;
    if (!active.length) return;
    await tx.assistantTelegramContext.createMany({
      data: {
        ...where, ...content, occurredAt, expiresAt,
        threadId: message.message_thread_id ?? null, authorAgentId: author.id,
      },
      skipDuplicates: true,
    });
    await tx.assistantTelegramContext.updateMany({
      where: {
        ...where, occurredAt, authorAgentId: author.id,
        OR: [
          { sourceVersion: { lt: sourceVersion } },
          { sourceVersion, sourceUpdateId: { lt: sourceUpdateId } },
        ],
      },
      data: content,
    });
  });
}

export type AssistantTelegramContextSelector = { replyToMessageId: number } | { propertyShortId: number };

/** Caller supplies the current in-group message's authenticated sender and IDs. Evidence is untrusted. */
export async function loadAssistantTelegramContext(input: {
  chatId: string;
  threadId: number | null;
  agentId: string;
  telegramUserId: string;
  beforeMessageId?: number;
  selector: AssistantTelegramContextSelector;
}, now = new Date()): Promise<{
  messageId: number;
  occurredAt: Date;
  text: string;
  attachmentKind: string | null;
}[]> {
  const isReply = "replyToMessageId" in input.selector;
  const selectedId = isReply ? input.selector.replyToMessageId : input.selector.propertyShortId;
  if (!messageId.safeParse(selectedId).success
      || (input.beforeMessageId !== undefined && !messageId.safeParse(input.beforeMessageId).success)
      || (isReply && input.beforeMessageId !== undefined && selectedId >= input.beforeMessageId)) return [];

  const registration = await prisma.assistantTelegramGroup.findUnique({
    where: { chatId: input.chatId },
    select: { contextEnabledAt: true },
  });
  const enabledAt = registration?.contextEnabledAt;
  if (!enabledAt) return [];
  const viewer = await findAgentByTelegramUserId(input.telegramUserId);
  if (viewer?.id !== input.agentId) return [];

  return prisma.assistantTelegramContext.findMany({
    where: {
      groupChatId: input.chatId,
      group: { contextEnabledAt: enabledAt },
      threadId: input.threadId,
      occurredAt: { gte: enabledAt },
      expiresAt: { gt: now },
      text: { not: "" },
      ...(isReply
        ? { messageId: selectedId }
        : { propertyRefs: { has: selectedId }, ...(input.beforeMessageId === undefined ? {} : { messageId: { lt: input.beforeMessageId } }) }),
    },
    select: { messageId: true, occurredAt: true, text: true, attachmentKind: true },
    orderBy: [{ occurredAt: "desc" }, { messageId: "desc" }],
    take: RESULT_LIMIT,
  });
}

export async function cleanupAssistantTelegramContext(now = new Date()): Promise<number> {
  const stale = { OR: [{ expiresAt: { lte: now } }, { group: { contextEnabledAt: null } }] };
  const batch = await prisma.assistantTelegramContext.findMany({
    where: stale, select: { id: true }, orderBy: [{ expiresAt: "asc" }, { id: "asc" }], take: CLEANUP_BATCH,
  });
  if (!batch.length) return 0;
  return (await prisma.assistantTelegramContext.deleteMany({
    where: { ...stale, id: { in: batch.map(row => row.id) } },
  })).count;
}
