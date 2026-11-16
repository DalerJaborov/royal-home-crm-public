/**
 * THE ONE DOOR OF A CUSTOMER TURN ON THE OLD CHANNEL BODIES (one brain, step 3b — owner 16.11.2026: «старый бот удалить полностью»).
 *
 * The old customer bot (`ai/leadQualifier.ts`) is deleted. The channel bodies that used to call it keep working — Meta DMs on
 * the LEGACY lane (messengers/conversation.ts), the website chat (same file), the Telegram bot (telegram/bot.ts) and its
 * AI-retry (jobs/telegramReplyRetry.ts), the scoped read-only adapter (messengers/customerQualifierTurn.ts) — and ask THIS
 * door for the turn. CI guard: tests/one-brain-legacy-door-guard.test.ts (no file may import leadQualifier again).
 *
 * Per channel (lib/customerAgentChannelSwitch.ts):
 *  - `core` (Telegram bot, website): the core channel adapter (lib/customerChannelCore.ts) writes the verified reply;
 *  - anything else — the default, and every Meta subject still on the LEGACY lane (their door to the core is
 *    rolloutConfig.allowed, never this file): NO bot answers. The customer's words are already in the CRM chat; the
 *    responsible agent (or everyone who reads chats) gets «ответьте вручную» and «Здоровье системы» gets one line per
 *    channel, so nothing is lost silently. With `shadow` on, the core also runs on the same words (nothing is sent) so
 *    the owner sees what it would have said before flipping the channel to `core`.
 *
 * Why not «core by default» once the old bot is gone: the core has not been watched on Telegram/website yet, and Arvan's
 * Meta DMs belong to the rolloutConfig door. A person answering is slower but never wrong; a silent drop is never allowed.
 */
import type { ChatMessage } from "./client.js";
import type { LeadDraft } from "./leadDraft.js";
import type { ChannelTurnOptions, ChannelTurnResult } from "./channelTurnResult.js";
import { stripUntrusted } from "./untrustedContent.js";
import { deriveOwnBuyerPreferences } from "../lib/customerBuyerPreferences.js";
import { accountBrandName } from "../messengers/accounts.js";
import { scheduleLegacyCoreShadow } from "../lib/customerAgentLegacyShadow.js";
import { customerAgentChannelMode, customerAgentLegacyChannelKey } from "../lib/customerAgentChannelSwitch.js";
import { runChannelCoreTurn, type ChannelCoreIntake, type ChannelCoreOutcome } from "../lib/customerChannelCore.js";
import { alertChannelStaff } from "../lib/channelStaffAlert.js";
import { logSystemError } from "../lib/systemError.js";

export type { ChannelTurnOptions, ChannelTurnResult } from "./channelTurnResult.js";

/** Where the turn came from. */
export interface ChannelTurnSource {
  /** Conversation channel (TELEGRAM callers do not pass `options.channel`). */
  channel: string;
  /** Same raw values as the trace keys (Meta: accountExternalId / message id). */
  traceAccount?: string | null;
  eventId?: string | null;
  /**
   * A repeat of a turn that already ran: `retry` (the model failed before, a background job plays the turn again — the core
   * runs again in `core` mode; no second shadow or staff call) or `regeneration` (a reply guard asks for another wording:
   * the core's text is already server-verified, so there is no second run and the guard's own fallback applies).
   */
  repeat?: "retry" | "regeneration";
}

/**
 * Pure: the core's outcome in the channels' result shape. Lead fields come from the customer's own words (code), never from
 * the model: role → intent, literal buyer wishes (budget in TJS, rooms, type), the place (outside the zone / abroad).
 * `ready` = the server asked for the phone in this reply (the old meaning: "waiting for the number").
 */
export function channelCoreQualifyResult(outcome: Extract<ChannelCoreOutcome, { status: "reply" | "staff" | "silent" }>,
  ownTexts: readonly string[]): ChannelTurnResult {
  const intake: ChannelCoreIntake | null = outcome.status === "silent" ? null : outcome.intake;
  const role = intake?.role ?? "unknown";
  const wishes = role === "buyer" ? deriveOwnBuyerPreferences(ownTexts) : {};
  const lead = intake ? {
    ...(wishes.budgetMin !== undefined ? { budgetMin: wishes.budgetMin } : {}),
    ...(wishes.budgetMax !== undefined ? { budgetMax: wishes.budgetMax } : {}),
    ...(wishes.desiredRooms !== undefined ? { rooms: wishes.desiredRooms } : {}),
    ...(wishes.desiredType ? { type: wishes.desiredType } : {}),
    ...(intake.locationOutsideDushanbe ? { locationOutsideDushanbe: true } : {}),
    ...(intake.locationDifferentCountry ? { locationDifferentCountry: true } : {}),
  } : null;
  return {
    reply: outcome.status === "reply" ? [outcome.text] : [],
    ready: outcome.status === "reply" && outcome.askedPhone,
    ...(role === "buyer" ? { intent: "buy" as const } : role === "seller" ? { intent: "sell" as const } : {}),
    lead: lead && Object.keys(lead).length ? lead : null,
    ...(outcome.status === "silent" ? { silent: "intended" as const } : outcome.status === "staff" ? { silent: "staff" as const } : {}),
  };
}

const ownWordsOf = (history: readonly { role: "user" | "assistant"; content: string }[]) =>
  history.filter(item => item.role === "user").map(item => stripUntrusted(item.content)).filter(Boolean);

export async function runCustomerChannelTurn(history: ChatMessage[], _draft: LeadDraft, options: ChannelTurnOptions,
  source: ChannelTurnSource): Promise<ChannelTurnResult | null> {
  const channel = options.channel ?? source.channel;
  const brandName = await accountBrandName(options.accountId ?? null);
  const key = customerAgentLegacyChannelKey(channel, brandName);
  const mode = key ? customerAgentChannelMode(key) : "legacy";
  const turnHistory = history.filter(item => item.role === "user" || item.role === "assistant")
    .map(item => ({ role: item.role as "user" | "assistant", content: typeof item.content === "string" ? item.content : "" }));
  const ownTexts = ownWordsOf(turnHistory);
  if (key && mode === "core") {
    if (source.repeat === "regeneration") return null;
    const outcome = await runChannelCoreTurn({ channel, channelKey: key, accountId: options.accountId ?? null,
      traceAccount: source.traceAccount ?? null, conversationId: options.conversationId ?? null, eventId: source.eventId ?? null,
      history: turnHistory, phoneKnown: options.phoneKnown === true }, { mode: "live" });
    // The channel's existing AI-retry job plays the turn again later (and tells staff when it gives up).
    if (outcome.status === "unavailable" || outcome.status === "moderate") return null;
    if (outcome.status === "staff") {
      await alertChannelStaff({ channel, conversationId: options.conversationId ?? null, text: ownTexts.at(-1) ?? "", why: outcome.reason });
    }
    return channelCoreQualifyResult(outcome, ownTexts);
  }
  // No bot for this channel (default after the old bot's removal). A regeneration has nothing to regenerate.
  if (source.repeat === "regeneration") return null;
  if (!source.repeat) {
    if (key && mode === "shadow") {
      try {
        scheduleLegacyCoreShadow({ channel, accountId: options.accountId ?? null, traceAccount: source.traceAccount ?? null,
          conversationId: options.conversationId ?? null, eventId: source.eventId ?? null, history: turnHistory,
          phoneKnown: options.phoneKnown === true,
          // The old bot no longer answers: the "legacy" side of the comparison is "nobody replied".
          legacy: { replied: false, bubbles: 0, askedPhone: false, action: "none" } });
      } catch { /* the shadow never costs the customer the staff call */ }
    }
    await alertChannelStaff({ channel, conversationId: options.conversationId ?? null, text: ownTexts.at(-1) ?? "", why: "bot_retired" });
    void logSystemError("ai", `Автоответ в канале «${key ?? channel}» выключен (старый бот удалён, ядро на канале не включено): ` +
      "клиенты получают ответ только от сотрудника. Включить ядро: CUSTOMER_AGENT_CHANNEL_CORE (Telegram, сайт) или " +
      "rolloutConfig.allowed (Instagram/Facebook/WhatsApp).", { dedupKey: `one-brain-channel-without-bot:${key ?? channel}`, quietPult: true });
  }
  return { reply: [], ready: false, lead: null, silent: "staff" };
}
