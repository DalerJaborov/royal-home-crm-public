import type { CommentDecision } from "@royal-home/shared";
import { runChannelCoreTurn, type ChannelCoreOutcome } from "../lib/customerChannelCore.js";
import { scheduleLegacyCoreShadow } from "../lib/customerAgentLegacyShadow.js";

/**
 * YOUTUBE COMMENTS ON THE CORE — one brain, step 3 (owner 16.11.2026).
 *
 * YouTube comments were answered by the old comment generator (`decideOnComment` in messengers/comments.ts), not by the
 * old chat bot. The managed public pipeline (customerPublicAgentTurn) deliberately refuses YouTube: its OAuth session is
 * not bound to an installation, so a managed POST proof is impossible (`managed_public_transport_unbound`). So the core
 * comes in through the channel adapter instead: the core decides and writes the reply (verified by the server), and the
 * existing comment body does the rest exactly as before — loop guard, AI budget, spam/hate/agency filters before the model,
 * the human-like delay, posting through youtubeComments.ts, ESCALATED + push for staff, retry when the AI is down.
 *
 * Mapping (pure, `youtubeCoreDecision`):
 *  - reply → `reply` (but a reply that sends the person to private messages is NOT posted: YouTube has no DMs — staff);
 *  - silent → `ignore`; moderation → `hide` (reversible; never `delete`, which the old path also uses to open an OTHER lead);
 *  - staff → `escalate` (posts nothing, pushes staff), including the core's own refusal (`core_refused`, review #223 N3);
 *    unavailable (a transient failure only) → null (the existing AI-down retry path), at most until the comment's third run:
 *    then staff (`core_unavailable`, review #223 R1).
 */
const PRIVATE_MESSAGES = /личн\p{L}*\s+сообщени|в\s+директ|в\s+личк|паёми\s+шахсӣ|паёми\s+шахси|ба\s+директ|дар\s+директ|direct/iu;

/** Why a person answers this comment, in plain words (the comment card shows it). */
const YOUTUBE_STAFF_REASON: Record<Extract<ChannelCoreOutcome, { status: "staff" }>["reason"], string> = {
  escalate: "бот передал вопрос человеку",
  action_needs_staff: "клиент просит действие, которое бот под роликом не оформляет",
  unreadable_input: "бот не смог прочитать комментарий",
  core_refused: "бот не смог ответить по существу",
  core_unavailable: "ИИ не ответил после нескольких попыток",
};

export function youtubeCoreDecision(outcome: ChannelCoreOutcome): CommentDecision | null {
  if (outcome.status === "unavailable") return null;
  if (outcome.status === "silent") return { action: "ignore", reason: `core:${outcome.reason}` };
  if (outcome.status === "moderate") return { action: "hide", reason: "core:moderation" };
  if (outcome.status === "staff") return { action: "escalate", reason: YOUTUBE_STAFF_REASON[outcome.reason] };
  if (PRIVATE_MESSAGES.test(outcome.text)) return { action: "escalate", reason: "ответ зовёт в личные сообщения, а на YouTube их нет" };
  return { action: "reply", reply: outcome.text };
}

/** `attempts` is the queue row's value BEFORE this claim (messengers/comments.ts increments it on claim): this run is attempts + 1. */
export async function decideYoutubeCommentWithCore(row: { id: string; commentId: string; text: string; attempts?: number }): Promise<CommentDecision | null> {
  const outcome = await runChannelCoreTurn({ channel: "YOUTUBE", channelKey: "youtube", surface: "public_comment",
    conversationId: row.id, eventId: row.commentId, history: [{ role: "user", content: row.text }], phoneKnown: false,
    attempt: (row.attempts ?? 0) + 1 }, { mode: "live" });
  return youtubeCoreDecision(outcome);
}

/** Step 2 shadow for the old generator's YouTube decision: the core runs afterwards on the same comment, nothing is posted. */
export function shadowYoutubeComment(row: { id: string; commentId: string; text: string }, legacy: CommentDecision | null): void {
  try {
    const replied = legacy?.action === "reply" && !!legacy.reply?.trim();
    scheduleLegacyCoreShadow({ channel: "YOUTUBE", surface: "public_comment", accountId: null, traceAccount: null,
      conversationId: row.id, eventId: row.commentId, history: [{ role: "user", content: row.text }], phoneKnown: false,
      legacy: { replied, bubbles: replied ? 1 : 0, askedPhone: false, action: "none" } });
  } catch { /* the shadow never costs the comment its answer */ }
}
