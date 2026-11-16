/**
 * THE ONLY DOOR TO THE OLD CUSTOMER BOT (one brain, steps 2–3 — owner 16.11.2026).
 *
 * Every channel that still answers customers with the old qualifier (`ai/leadQualifier.ts`) comes through here:
 * Meta DMs on the LEGACY lane (Royal Home and Arvan accounts), website chat, the Telegram bot and its retry,
 * Telegram direct messages' retry, and the scoped read-only adapter (messengers/customerQualifierTurn.ts).
 * No other production file may import `leadQualifier` (CI guard: tests/one-brain-legacy-door-guard.test.ts).
 *
 * Per channel (lib/customerAgentChannelSwitch.ts):
 *  - `legacy` (default): the old bot answers, nothing else is called;
 *  - `shadow`: the old bot answers, then the core runs on the same words and both verdicts land in one BotTurnTrace record;
 *  - `core` (Telegram bot, website; never Meta — its door is rolloutConfig): the core channel adapter
 *    (lib/customerChannelCore.ts) writes the reply INSTEAD of the old bot. The result keeps the old shape, so the channel's
 *    body (lead capture on a phone, guards, history, delivery, AI-retry job) stays exactly as it is — only the brain changes.
 *
 * Step 3b deletes leadQualifier.ts; then the `legacy` branch here becomes "hold + staff notification".
 */
import { runQualifyTurn, type QualifyResult, type QualifyTurnOptions } from "./leadQualifier.js";
import type { ChatMessage } from "./client.js";
import type { LeadDraft } from "./leadDraft.js";
import { mentionsPhoneRequest } from "./replyGuards.js";
import { deriveOwnBuyerPreferences } from "../lib/customerBuyerPreferences.js";
import { scheduleLegacyCoreShadow, type LegacyShadowAction, type LegacyTurnSummary } from "../lib/customerAgentLegacyShadow.js";
import { customerAgentChannelMode, customerAgentLegacyChannelKey } from "../lib/customerAgentChannelSwitch.js";
import { channelOwnWords, runChannelCoreTurn, type ChannelCoreIntake, type ChannelCoreOutcome } from "../lib/customerChannelCore.js";
import { customerAgentHandoverLine } from "./customerAgentRenderer.js";
import { alertChannelStaff } from "../lib/channelStaffAlert.js";

// Helpers of the old bot that callers still need. Re-exported here so that the old module has exactly one importer;
// step 3b moves each of them to its own module and this list disappears.
export { mergeDraft, ensurePhoneAskKept, normalizeReplyBubbles, DEFAULT_BOT_PERSONA, BOT_CORE_RULES, resolveBotPersona } from "./leadQualifier.js";
export type { QualifyResult, QualifyTurnOptions } from "./leadQualifier.js";

/** Where the turn came from. */
export interface ChannelTurnSource {
  /** Conversation channel (TELEGRAM callers do not pass `options.channel`). */
  channel: string;
  /** Same raw values as the legacy trace uses (Meta: accountExternalId / message id), so both records share keys. */
  traceAccount?: string | null;
  eventId?: string | null;
  /**
   * A repeat of a turn that already ran: `retry` (the model failed before, a background job plays the turn again — the core
   * runs again in `core` mode, no second shadow) or `regeneration` (a reply guard asks the same brain for another wording:
   * the core's text is already server-verified, so in `core` mode there is no second run and the guard's own fallback applies).
   */
  repeat?: "retry" | "regeneration";
}
/** @deprecated step 2 name, kept for the callers' types. */
export type LegacyShadowSource = ChannelTurnSource;

/** Pure: what the old bot did, as flags. Text and lead values never leave this function. */
export function legacyTurnSummary(result: QualifyResult | null): LegacyTurnSummary {
  if (!result) return { replied: false, bubbles: 0, askedPhone: false, action: "none" };
  const bubbles = result.reply.filter(text => typeof text === "string" && text.trim());
  const action: LegacyShadowAction = result.showing ? "showing" : result.callbackRequest ? "callback" : result.askOwner ? "ask_owner"
    : result.jobApplication ? "job_application" : result.sendGuide ? "guide" : result.showPropertyNumber != null ? "property" : "none";
  return { replied: bubbles.length > 0, bubbles: bubbles.length, askedPhone: bubbles.some(mentionsPhoneRequest), action };
}

/**
 * Pure: the core's outcome in the old result shape. Lead fields come from the customer's own words (code), never from the
 * model: role → intent, literal buyer wishes (budget in TJS, rooms, type), the place (outside the zone / abroad).
 * `ready` = the server asked for the phone in this reply (the old meaning: "waiting for the number").
 */
export function channelCoreQualifyResult(outcome: Extract<ChannelCoreOutcome, { status: "reply" | "staff" | "silent" }>,
  ownTexts: readonly string[]): QualifyResult {
  const intake: ChannelCoreIntake | null = outcome.status === "silent" ? null : outcome.intake;
  const role = intake?.role ?? "unknown";
  const wishes = role === "buyer" ? deriveOwnBuyerPreferences(ownTexts) : {};
  const lead = intake ? {
    ...(wishes.budgetMin !== undefined ? { budgetMin: wishes.budgetMin } : {}),
    ...(wishes.budgetMax !== undefined ? { budgetMax: wishes.budgetMax } : {}),
    ...(wishes.desiredRooms !== undefined ? { rooms: wishes.desiredRooms } : {}),
    ...(wishes.desiredType ? { type: wishes.desiredType } : {}),
    ...(intake.locationOutsideDushanbe ? { locationOutsideDushanbe: true } : {}),
    // «Possibly abroad» is a word-level guess: it never refuses a lead here (review #223 H1); the old field's refusal path
    // in the channels stays for the model-free cases only.
  } : null;
  return {
    reply: outcome.status === "reply" ? [outcome.text] : [],
    ...(outcome.status === "reply" ? { verified: true as const } : {}),
    ready: outcome.status === "reply" && outcome.askedPhone,
    ...(role === "buyer" ? { intent: "buy" as const } : role === "seller" ? { intent: "sell" as const } : {}),
    lead: lead && Object.keys(lead).length ? lead : null,
    ...(outcome.status === "silent" ? { silent: "intended" as const } : outcome.status === "staff" ? { silent: "staff" as const } : {}),
  };
}

export async function runLegacyQualifyTurn(history: ChatMessage[], draft: LeadDraft, options: QualifyTurnOptions,
  source: ChannelTurnSource): Promise<QualifyResult | null> {
  const key = customerAgentLegacyChannelKey(options.channel ?? source.channel, null);
  // Meta keys are never `core` here (their door is rolloutConfig): the switch refuses them.
  if (key && customerAgentChannelMode(key) === "core") {
    if (source.repeat === "regeneration") return null;
    return runCoreChannelTurn(history, options, source, key);
  }
  const result = await runQualifyTurn(history, draft, options);
  if (!source.repeat) {
    try {
      scheduleLegacyCoreShadow({ channel: source.channel, accountId: options.accountId ?? null, traceAccount: source.traceAccount ?? null,
        conversationId: options.conversationId ?? null, eventId: source.eventId ?? null,
        history: history.map(item => ({ role: item.role, content: item.content })), phoneKnown: options.phoneKnown === true,
        legacy: legacyTurnSummary(result) });
    } catch { /* the shadow never costs the customer the old reply */ }
  }
  return result;
}

async function runCoreChannelTurn(history: ChatMessage[], options: QualifyTurnOptions, source: ChannelTurnSource,
  key: NonNullable<ReturnType<typeof customerAgentLegacyChannelKey>>): Promise<QualifyResult | null> {
  const turnHistory = history.filter(item => item.role === "user" || item.role === "assistant")
    .map(item => ({ role: item.role as "user" | "assistant", content: typeof item.content === "string" ? item.content : "" }));
  const outcome = await runChannelCoreTurn({ channel: source.channel, channelKey: key, accountId: options.accountId ?? null,
    traceAccount: source.traceAccount ?? null, conversationId: options.conversationId ?? null, eventId: source.eventId ?? null,
    history: turnHistory, phoneKnown: options.phoneKnown === true }, { mode: "live" });
  // The channel's existing AI-retry job plays the turn again later (and tells staff when it gives up).
  if (outcome.status === "unavailable" || outcome.status === "moderate") return null;
  const ownTexts = turnHistory.filter(item => item.role === "user").map(item => channelOwnWords(item.content)).filter(Boolean);
  if (outcome.status === "staff") {
    const lastUser = [...turnHistory].reverse().find(item => item.role === "user")?.content ?? "";
    const alerted = await alertChannelStaff({ channel: source.channel, conversationId: options.conversationId ?? null,
      text: lastUser, why: outcome.reason, eventId: source.eventId ?? null });
    // The customer hears the core's approved handover line (the Meta receipt wording), but only when a person really is
    // responsible now — the alert went out for this message or already for this batch (review #223 M2).
    if (alerted !== "skipped") return { ...channelCoreQualifyResult(outcome, ownTexts), reply: [customerAgentHandoverLine(outcome.language)],
      silent: undefined, verified: true };
  }
  return channelCoreQualifyResult(outcome, ownTexts);
}
