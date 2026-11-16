import type { LeadIntent, WhoIsThis } from "./botContract.js";
import type { ShowingRequest } from "../lib/showingBooking.js";
import type { JobApplicationDraft } from "./jobApplication.js";
import type { TopicTurnAnswer } from "./topicLock.js";

/**
 * What one customer turn produced, in the shape the channels already consume (one brain, step 3b, 16.11.2026).
 *
 * The old customer bot (`ai/leadQualifier.ts`, deleted) defined this shape as `QualifyResult`. The channels' bodies
 * (messengers/conversation.ts, telegram/bot.ts, jobs/telegramReplyRetry.ts, messengers/customerQualifierTurn.ts) read it
 * after the brain: lead capture on a phone, guards, history, delivery. The brain now is the core channel adapter
 * (ai/customerChannelTurn.ts), which fills `reply`, `ready`, `intent`, `lead` and `silent` only.
 */
export interface ChannelTurnResult {
  /** 1–2 bubbles. The core gives one verified text. */
  reply: string[];
  /** The server asked for the phone in this reply: the channel waits for the number. */
  ready: boolean;
  intent?: LeadIntent;
  lead: {
    budgetMin?: number;
    budgetMax?: number;
    districtName?: string;
    type?: string;
    rooms?: number;
    notes?: string;
    locationOutsideDushanbe?: boolean;
    locationDifferentCountry?: boolean;
  } | null;
  /**
   * The brain deliberately sends nothing: `intended` (thanks, a reaction, a duplicate) or `staff` (a person was called).
   * The channel must then send nothing at all — never its "sorry for the delay" fallback, which is for a failed model.
   */
  silent?: "intended" | "staff";
  /**
   * Fields only the deleted old bot ever set. The channels still have their branches (showing, owner question, callback,
   * job application, guide, property photos, topic lock); they are inert now and are removed in step 3c.
   */
  whoIsThis?: WhoIsThis;
  confident?: boolean;
  showing?: ShowingRequest;
  showPropertyNumber?: number | null;
  askOwner?: string | null;
  callbackRequest?: string | null;
  jobApplication?: JobApplicationDraft | null;
  sendGuide?: boolean;
  topicAnswer?: TopicTurnAnswer | null;
}

/** What the channel tells the brain about the turn. Server facts only; nothing here is customer text. */
export interface ChannelTurnOptions {
  /** Conversation channel (INSTAGRAM | FACEBOOK | WHATSAPP | WEBSITE | TELEGRAM). */
  channel?: string;
  /** MessengerAccount.id (brand); null for channels without accounts. */
  accountId?: string | null;
  /** BotConversation.id, or TelegramConversation.id on TELEGRAM. */
  conversationId?: string | null;
  /** The phone is already in the client's card: never ask it again. */
  phoneKnown?: boolean;
}
