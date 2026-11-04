import { z } from "zod";
import { prisma } from "../db.js";
import { maskAssistantContacts } from "../lib/assistantContacts.js";
import { findAgentByTelegramUserId } from "../lib/telegramAgentLink.js";
import { groupPropertyReferenceNumbers } from "./assistantGroupParticipation.js";

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

function prepareEvidence(text: string) {
  const withoutLinks = text
    .replace(/(?:https?:\/\/|tg:\/\/|www\.)[^\s<>{}]+/giu, "[ссылка]")
    .replace(/[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/giu, "[почта]")
    .slice(0, TEXT_LIMIT);
  return {
    text: maskAssistantContacts(withoutLinks).slice(0, TEXT_LIMIT),
    // The phone mask can cover a long exact object ID or join it to a following price.
    propertyRefs: groupPropertyReferenceNumbers(withoutLinks).slice(0, RESULT_LIMIT),
  };
}

function groupEvidenceSource(raw: unknown, updateId: number, now: Date) {
  if (!safeTelegramId.positive().safeParse(updateId).success) return;
  const result = groupMessage.safeParse(raw);
  if (!result.success) return;
  const message = result.data;
  if (message.chat.is_direct_messages || message.from.is_bot || message.sender_chat
      || message.is_automatic_forward || message.forward_origin || message.forward_from_message_id
      || message.has_protected_content || message.contact || message.location) return;

  const rawText = (message.text ?? message.caption ?? "").trim();
  const isCommand = rawText.startsWith("/");
  // An edit to a command retracts earlier evidence without keeping the command.
  if (isCommand && message.edit_date === undefined) return;
  const occurredAt = new Date(message.date * 1_000);
  const sourceVersion = new Date((message.edit_date ?? message.date) * 1_000);
  const expiresAt = new Date(occurredAt.getTime() + RETENTION_MS);
  if (!Number.isFinite(sourceVersion.getTime()) || !Number.isFinite(expiresAt.getTime())
      || sourceVersion < occurredAt || expiresAt <= now || sourceVersion.getTime() > now.getTime() + 60_000) return;

  return {
    message, rawText: isCommand ? "" : rawText, occurredAt, sourceVersion, expiresAt,
    groupChatId: String(message.chat.id), sourceUpdateId: BigInt(updateId),
  };
}

/** Call only from a Telegram update received by the common poller/webhook dispatcher. */
export async function captureAssistantTelegramContext(raw: unknown, updateId: number, now = new Date()): Promise<void> {
  const source = groupEvidenceSource(raw, updateId, now);
  if (!source) return;
  const { message, rawText, groupChatId, occurredAt, sourceVersion, sourceUpdateId, expiresAt } = source;
  const { text, propertyRefs } = prepareEvidence(rawText);
  const kind = attachmentKind(message);
  // Keep an empty edit as a tombstone, but don't archive empty service messages.
  const isEdit = message.edit_date !== undefined;
  if (!text && !kind && !isEdit) return;

  const registration = await prisma.assistantTelegramGroup.findUnique({
    where: { chatId: groupChatId },
    select: { contextEnabledAt: true, contextIncludeUnlinked: true },
  });
  const enabledAt = registration?.contextEnabledAt;
  if (!enabledAt || occurredAt < enabledAt) return;

  const authorTelegramId = String(message.from.id);
  const [author, settings] = await Promise.all([
    findAgentByTelegramUserId(authorTelegramId),
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { telegramDiscussionGroupId: true } }),
  ]);
  if ((!author && !registration.contextIncludeUnlinked && !isEdit)
      || String(settings?.telegramDiscussionGroupId ?? "") === groupChatId) return;

  const authorAgentId = author?.id ?? null;
  const where = { groupChatId, messageId: message.message_id };
  const content = { sourceVersion, sourceUpdateId, text, transcript: null, attachmentKind: kind, propertyRefs, authorAgentId, authorTelegramId };
  await prisma.$transaction(async tx => {
    const [active] = await tx.$queryRaw<{ contextIncludeUnlinked: boolean }[]>`
      SELECT "contextIncludeUnlinked" FROM "AssistantTelegramGroup"
      WHERE "chatId" = ${groupChatId} AND "contextEnabledAt" = ${enabledAt}
        AND (${Boolean(author)} OR "contextIncludeUnlinked" OR ${isEdit})
        AND NOT EXISTS (
          SELECT 1 FROM "Settings" WHERE "id" = 'singleton' AND "telegramDiscussionGroupId" = ${groupChatId}
        )
      FOR SHARE
    `;
    if (!active) return;
    const canStore = Boolean(author) || active.contextIncludeUnlinked;
    if (canStore) {
      await tx.assistantTelegramContext.createMany({
        data: {
          ...where, ...content, occurredAt, expiresAt,
          threadId: message.message_thread_id ?? null,
        },
        skipDuplicates: true,
      });
    }
    await tx.assistantTelegramContext.updateMany({
      where: {
        ...where, occurredAt,
        AND: [
          { OR: [{ authorTelegramId }, ...(authorAgentId ? [{ authorTelegramId: null, authorAgentId }] : [])] },
          { OR: [{ sourceVersion: { lt: sourceVersion } }, { sourceVersion, sourceUpdateId: { lt: sourceUpdateId } }] },
        ],
      },
      // The original sender can retract old evidence even if their CRM link was removed.
      data: canStore ? content : { sourceVersion, sourceUpdateId, text: "", transcript: null, propertyRefs: [] },
    });
  });
}

/** Enrich the exact event already captured, using only a successful native group ASR result. */
export async function retainAssistantTelegramTranscript(
  raw: unknown, updateId: number, agentId: string, recognizedText: string, now = new Date(),
): Promise<void> {
  const source = groupEvidenceSource(raw, updateId, now);
  if (!source) return;
  const { message, rawText, groupChatId, occurredAt, sourceVersion, sourceUpdateId } = source;
  const kind = attachmentKind(message);
  if (message.edit_date !== undefined || (kind !== "voice" && kind !== "audio")) return;
  const evidence = prepareEvidence(recognizedText.trim());
  const transcript = evidence.text;
  if (!transcript) return;
  const propertyRefs = [...new Set([
    ...prepareEvidence(rawText).propertyRefs,
    ...evidence.propertyRefs,
  ])];

  await prisma.$transaction(async tx => {
    // Serialize against opt-out, unlinking and deactivation while the evidence is written.
    const active = await tx.$queryRaw<{ chatId: string }[]>`
      SELECT g."chatId"
      FROM "AssistantTelegramGroup" g JOIN "Agent" a ON a."id" = ${agentId}
      WHERE g."chatId" = ${groupChatId} AND g."contextEnabledAt" <= ${occurredAt}
        AND a."isActive" = true AND a."telegramUserId" = ${String(message.from.id)}
        AND NOT EXISTS (
          SELECT 1 FROM "Settings" WHERE "id" = 'singleton' AND "telegramDiscussionGroupId" = ${groupChatId}
        )
      FOR SHARE OF g, a
    `;
    if (!active.length) return;
    await tx.assistantTelegramContext.updateMany({
      where: {
        groupChatId, messageId: message.message_id, threadId: message.message_thread_id ?? null,
        occurredAt, sourceVersion, sourceUpdateId, expiresAt: { gt: now },
        authorAgentId: agentId, attachmentKind: kind, transcript: null,
      },
      data: { transcript, propertyRefs },
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
  authorLabel: string | null;
}[]> {
  const selection = input.selector;
  const isReply = "replyToMessageId" in selection;
  const selectedId = isReply ? selection.replyToMessageId : selection.propertyShortId;
  if (!messageId.safeParse(selectedId).success
      || (input.beforeMessageId !== undefined && !messageId.safeParse(input.beforeMessageId).success)
      || (isReply && input.beforeMessageId !== undefined && selectedId >= input.beforeMessageId)) return [];

  const registration = await prisma.assistantTelegramGroup.findUnique({
    where: { chatId: input.chatId },
    select: { contextEnabledAt: true, contextIncludeUnlinked: true },
  });
  const enabledAt = registration?.contextEnabledAt;
  if (!enabledAt) return [];
  const viewer = await findAgentByTelegramUserId(input.telegramUserId);
  if (viewer?.id !== input.agentId) return [];

  const rows = await prisma.assistantTelegramContext.findMany({
    where: {
      groupChatId: input.chatId,
      group: { contextEnabledAt: enabledAt, contextIncludeUnlinked: registration.contextIncludeUnlinked },
      ...(registration.contextIncludeUnlinked ? {} : { authorAgentId: { not: null } }),
      threadId: input.threadId,
      occurredAt: { gte: enabledAt },
      expiresAt: { gt: now },
      OR: [{ text: { not: "" } }, { transcript: { not: null } }],
      ...(isReply
        ? { messageId: selectedId }
        : { propertyRefs: { has: selectedId }, ...(input.beforeMessageId === undefined ? {} : { messageId: { lt: input.beforeMessageId } }) }),
    },
    select: { messageId: true, occurredAt: true, text: true, transcript: true, attachmentKind: true,
      authorAgentId: true, authorTelegramId: true },
    orderBy: [{ occurredAt: "desc" }, { messageId: "desc" }],
    take: RESULT_LIMIT,
  });
  const authorIds = [...new Set(rows.flatMap(row => row.authorAgentId && row.authorTelegramId ? [row.authorAgentId] : []))];
  const authors = authorIds.length ? await prisma.agent.findMany({
    where: { id: { in: authorIds }, isActive: true }, select: { id: true, telegramUserId: true, fullName: true },
  }) : [];
  const authorById = new Map(authors.map(author => [author.id, author]));
  return rows.map(({ text, transcript, authorAgentId, authorTelegramId, ...source }) => {
    const author = authorAgentId ? authorById.get(authorAgentId) : undefined;
    // A name only belongs to this message if the original staff and Telegram identity still match.
    const authorLabel = author && authorTelegramId && author.telegramUserId === authorTelegramId
      ? prepareEvidence(author.fullName).text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 80) || null
      : null;
    return {
      ...source,
      authorLabel,
      text: transcript === null ? text : [
        text.slice(0, 250), `Расшифровка аудио: ${transcript}`,
      ].filter(Boolean).join("\n").slice(0, TEXT_LIMIT),
    };
  });
}

export async function cleanupAssistantTelegramContext(now = new Date()): Promise<number> {
  const stale = { OR: [
    { expiresAt: { lte: now } },
    { group: { contextEnabledAt: null } },
    { authorAgentId: null, group: { contextIncludeUnlinked: false } },
  ] };
  const batch = await prisma.assistantTelegramContext.findMany({
    where: stale, select: { id: true }, orderBy: [{ expiresAt: "asc" }, { id: "asc" }], take: CLEANUP_BATCH,
  });
  if (!batch.length) return 0;
  return (await prisma.assistantTelegramContext.deleteMany({
    where: { ...stale, id: { in: batch.map(row => row.id) } },
  })).count;
}
