/**
 * THE ONLY DOOR TO THE OLD CUSTOMER BOT (one brain, step 2 — owner 16.11.2026).
 *
 * Every channel that still answers customers with the old qualifier (`ai/leadQualifier.ts`) comes through here:
 * Meta DMs on the LEGACY lane (Royal Home and Arvan accounts), website chat, YouTube, the Telegram bot and its retry,
 * Telegram direct messages and their retry, and the scoped read-only adapter (messengers/customerQualifierTurn.ts).
 * No other production file may import `leadQualifier` (CI guard: src/ai/legacyQualifyDoor.guard.test.ts).
 *
 * What the door adds: a per-channel shadow switch (lib/customerAgentChannelSwitch.ts, default = old behaviour, nothing
 * extra is called). In `shadow` the core runs on the same words afterwards and both verdicts land in one BotTurnTrace
 * record (lib/customerAgentLegacyShadow.ts). The old turn itself is returned unchanged and is never delayed.
 *
 * Step 3 replaces this file's body and deletes leadQualifier.ts; the callers then no longer change their imports.
 */
import { runQualifyTurn, type QualifyResult, type QualifyTurnOptions } from "./leadQualifier.js";
import type { ChatMessage } from "./client.js";
import type { LeadDraft } from "./leadDraft.js";
import { mentionsPhoneRequest } from "./replyGuards.js";
import { scheduleLegacyCoreShadow, type LegacyShadowAction, type LegacyTurnSummary } from "../lib/customerAgentLegacyShadow.js";

// Helpers of the old bot that callers still need. Re-exported here so that the old module has exactly one importer;
// step 3 moves each of them to its own module and this list disappears.
export { mergeDraft, ensurePhoneAskKept, normalizeReplyBubbles, DEFAULT_BOT_PERSONA, BOT_CORE_RULES, resolveBotPersona } from "./leadQualifier.js";
export type { QualifyResult, QualifyTurnOptions } from "./leadQualifier.js";

/** Where the turn came from, for the shadow record. `null` = no shadow (a retry of an already-shadowed turn). */
export interface LegacyShadowSource {
  /** Conversation channel (TELEGRAM callers do not pass `options.channel`). */
  channel: string;
  /** Same raw values as the legacy trace uses (Meta: accountExternalId / message id), so both records share keys. */
  traceAccount?: string | null;
  eventId?: string | null;
}

/** Pure: what the old bot did, as flags. Text and lead values never leave this function. */
export function legacyTurnSummary(result: QualifyResult | null): LegacyTurnSummary {
  if (!result) return { replied: false, bubbles: 0, askedPhone: false, action: "none" };
  const bubbles = result.reply.filter(text => typeof text === "string" && text.trim());
  const action: LegacyShadowAction = result.showing ? "showing" : result.callbackRequest ? "callback" : result.askOwner ? "ask_owner"
    : result.jobApplication ? "job_application" : result.sendGuide ? "guide" : result.showPropertyNumber != null ? "property" : "none";
  return { replied: bubbles.length > 0, bubbles: bubbles.length, askedPhone: bubbles.some(mentionsPhoneRequest), action };
}

export async function runLegacyQualifyTurn(history: ChatMessage[], draft: LeadDraft, options: QualifyTurnOptions,
  shadow: LegacyShadowSource | null): Promise<QualifyResult | null> {
  const result = await runQualifyTurn(history, draft, options);
  if (shadow) {
    try {
      scheduleLegacyCoreShadow({ channel: shadow.channel, accountId: options.accountId ?? null, traceAccount: shadow.traceAccount ?? null,
        conversationId: options.conversationId ?? null, eventId: shadow.eventId ?? null,
        history: history.map(item => ({ role: item.role, content: item.content })), phoneKnown: options.phoneKnown === true,
        legacy: legacyTurnSummary(result) });
    } catch { /* the shadow never costs the customer the old reply */ }
  }
  return result;
}
