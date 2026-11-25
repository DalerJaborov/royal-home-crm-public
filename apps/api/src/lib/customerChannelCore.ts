import { randomUUID } from "node:crypto";
import { channelCoreMessageKey } from "./customerMessageKey.js";
import { customerAgentVerifiedContextSchema, type CustomerAgentLegacyChannel, type CustomerAgentToolCall,
  type CustomerAgentVerifiedContext } from "@royal-home/shared";
import { prisma } from "../db.js";
import { runCustomerAgentTurn, customerCoreFailureTransient, type CustomerAgentToolResult, type CustomerCoreResult } from "../ai/customerAgentCore.js";
import { customerAgentToolDefinitions } from "../ai/customerAgentToolDefinitions.js";
import { resolveCustomerDmLanguage } from "../ai/customerDmLanguage.js";
import { customerPublicLanguage } from "../ai/customerAgentConversationPolicy.js";
import { customerAgentIntake, customerIntakeLocation } from "../ai/customerAgentIntake.js";
import { clientOwnWords, unwrapUntrusted } from "../ai/untrustedContent.js";
import { extractTypedPhone, extractVolunteeredPhone } from "./shared/phoneText.js";
import { accountBrandName } from "../messengers/accounts.js";
import { decodeCustomerAgentRevision } from "./customerAgentRevision.js";
import { openPinnedCustomerAgentRuntime } from "./customerAgentRuntime.js";
import { readCustomerAgentPublicData } from "./customerAgentPublicReads.js";
import { customerAgentAnswerMode, customerAgentSayMode } from "./customerAgentFeaturePolicy.js";
import { readCustomerAgentBrand } from "./customerAgentBrandRead.js";
import { PUBLIC_AGENCY_CONTACT } from "./publicAgencyContact.js";
import { withBotTurnTrace, traceCustomerCoreResult, traceCustomerCoreDisposition, type TraceConfig } from "./botTurnTrace.js";
import { loadLeadOnlyConfig } from "./leadOnlyConfig.js";
import { leadOnlyAppliesTo } from "../ai/leadOnlyMode.js";

/**
 * THE CORE CHANNEL ADAPTER — one brain, step 3 (owner 16.11.2026).
 *
 * Telegram (bot), the website chat and YouTube comments have no core transport of their own (no CustomerEndpointScope,
 * no signed ingress, no installation-bound YouTube credentials), so the full DM pipeline (ingress → claim → outbox) cannot
 * serve them yet. This adapter is the ONE place where those channels meet the core:
 *  - the same pinned revision, `runCustomerAgentTurn`, server renderer and answer verifier (`customerAgentAnswer.ts`) as
 *    Meta DMs: the text returned here is either the verified model answer or the server template, never raw model prose;
 *  - read-only public tools only (contact, policy, public search, company information, vacancies): no write tool is offered,
 *    so the model cannot book, call back or save anything on these channels — the channel's own code keeps lead capture
 *    (phone in the customer's words), staff notification and delivery, exactly where the old bot left them;
 *  - the old bot's prompt history is used as `turns` (bounded, own words only); it grants nothing because no tool writes;
 *  - `mode: "shadow"`: nothing is returned to send (`sayMode: "shadow"`, step 2's comparison); `mode: "live"`: the reply the
 *    channel sends, with the same `say/answer` switch as Meta DMs (CUSTOMER_AGENT_SAY_MODE).
 * The channel decides the mode (lib/customerAgentChannelSwitch.ts); this module never reads the switch itself.
 */

export type ChannelCoreSurface = "dm" | "public_comment";
export interface ChannelCoreTurn {
  /** BotConversation/trace channel: TELEGRAM | WEBSITE | YOUTUBE | INSTAGRAM | FACEBOOK | WHATSAPP. */
  channel: string;
  /** Switch key the turn belongs to (for the trace and the caller's bookkeeping). */
  channelKey: CustomerAgentLegacyChannel;
  surface?: ChannelCoreSurface;
  /** MessengerAccount.id of the conversation (brand); null for channels without accounts. */
  accountId?: string | null;
  /** Same raw values as the legacy trace keys (account = accountExternalId, event = message id). */
  traceAccount?: string | null;
  conversationId?: string | null;
  eventId?: string | null;
  /** The conversation so far, the current customer input last (role "user"). */
  history: readonly { role: "user" | "assistant"; content: string }[];
  /** The phone is already in the client's card: never ask it again. */
  phoneKnown: boolean;
  /**
   * Which run of THIS customer turn this is: 1 = the live turn (default), n = the (n-1)-th repeat of the channel's AI-retry
   * (the job's own attempt + 1; YouTube: the comment row's attempt). Live mode only: see CHANNEL_CORE_MAX_ATTEMPTS.
   * A fallback: the stored message's own run count (claimChannelCoreRun) wins whenever it is known (review 0e463b02 N2).
   */
  attempt?: number;
}
/** What the conversation tells about the lead, from the customer's own words only (never the model). */
export interface ChannelCoreIntake {
  role: "buyer" | "seller" | "unknown";
  locationOutsideDushanbe?: true;
  locationDifferentCountry?: true;
}
export type ChannelCoreOutcome =
  /** A verified reply for the customer (template or verified model answer). `askedPhone`: the server asked for the number. */
  | { status: "reply"; text: string; askedPhone: boolean; intake: ChannelCoreIntake }
  /** The core wants a person (escalate, an action no tool of this channel can do, unreadable input, or a refusal that a
   *  repeat would only reproduce — `core_refused`): no answer of substance, staff are called at once. */
  | { status: "staff"; reason: ChannelCoreStaffReason; intake: ChannelCoreIntake; language: "ru" | "tg" }
  /** Intended silence (thanks, a reaction, a duplicate). */
  | { status: "silent"; reason: string }
  /** Public comment only: spam/abuse, the channel's own moderation decides. */
  | { status: "moderate"; action: "hide" | "delete" }
  /** A transient failure (provider, network, deadline, revision being published): the channel's existing AI-retry takes over. */
  | { status: "unavailable"; reason: string };
export type ChannelCoreStaffReason = "escalate" | "action_needs_staff" | "unreadable_input" | "core_refused" | "core_unavailable";

/**
 * HELD REASONS WORTH A REPEAT (review #223 N3 + R1, 17.11.2026). The channels' AI-retry ladder would play a turn again for up
 * to ~13 hours (jobs/aiReplyRetryPolicy.ts, 46 attempts, each a full core run); on the core it is cut to
 * CHANNEL_CORE_MAX_ATTEMPTS. Only a failure that a later, fresh run can escape is repeated: the deadline ran out, the runtime
 * or the pinned revision is not available right now, the adapter threw, or the turn failed (`turn_unavailable`, or
 * `operation_stopped` when the provider operation stopped too — review #223 R1-1) with a TRANSIENT cause — provider 408/429/5xx, network, timeout (customerCoreFailureTransient). `turn_unavailable` is EVERY
 * exception of the turn, so its cause decides: the core's own limits and refusals (`tool_limit`, `unavailable_tool`,
 * `call_id_reused`…), the model's stops and provider 4xx/budget/unsupported are a person now, like every other reason
 * (no supported answer, surface decision denied, round/output limit, malformed model output, input too large…).
 * Protection by default: a reason or code the core adds later is a person, not a repeat.
 */
export const CHANNEL_CORE_RETRY_REASONS: readonly string[] = [
  // the turn failed (transient causes only, see above) or was stopped by its deadline
  "turn_unavailable", "turn_deadline", "operation_stopped",
  // the adapter could not start the core now (runtime, revision being published), or threw
  "runtime_unavailable", "no_active_revision", "revision_missing", "channel_core_failed",
];
/** Pure: is this HELD turn a transient failure (repeat) rather than the core's refusal (a person now)? */
export function channelCoreRetryable(reason: string, cause?: string): boolean {
  if (!CHANNEL_CORE_RETRY_REASONS.includes(reason)) return false;
  // `operation_stopped` is the same exception with a stopped provider operation (review #223 R1-1): the provider's own
  // `budget_denied` / `unsupported` stop it too (providerContract.ts), so its CAUSE decides exactly as for `turn_unavailable`.
  return !CAUSE_DECIDES.has(reason) || customerCoreFailureTransient(cause);
}
const CAUSE_DECIDES: ReadonlySet<string> = new Set(["turn_unavailable", "operation_stopped"]);
/**
 * At most this many runs of ONE customer turn on the core (owner 17.11.2026, review #223 R1): the live turn and two repeats.
 * After the last one a person is told at once and the customer hears the handover line; a run past the limit (a job that
 * failed after the model answered, a re-queued retry) never calls the model again.
 *
 * A RUN IS NOT ONE PAID CALL (review 0e463b02 N3). One run is one provider operation: up to `maxAttempts: 4` paid generate
 * requests (tool rounds, `maxRounds: 3`, and the provider's own retries share them; customerAgentProviderConfig.ts). The next
 * run opens a new operation with 4 new attempts, and repeats are not charged to the chat's daily budget (`retryOfPaidTurn`).
 * Worst case per customer message: 3 runs × 4 = 12 paid generate requests, about $0.39 at `maxOperationUsd` (an estimate).
 */
export const CHANNEL_CORE_MAX_ATTEMPTS = 3;

/**
 * ONE COUNT OF CORE RUNS PER CUSTOMER MESSAGE, IN THE DATABASE (review #223 R1-2, 17.11.2026).
 *
 * The retry jobs count their own attempts, and a job's count dies with the job: the website's stuck-chat cron
 * (cron.ts `health-automation`, every 30 minutes) queues a NEW `ai-reply-retry` for a chat that is still unanswered, and the
 * manual «Повторить зависшим» button starts from 1 as well — up to ~94 core runs a day on one message. The count lives
 * on the customer's message instead: one `ProcessedMessage` row per run (`channel-core-run`, key = channel + conversation +
 * the stored message's time and content digest + run number), claimed atomically (ON CONFLICT DO NOTHING), so two concurrent
 * runs never share a number and no job, cron tick or button can start the count again. Rows age out with the table's 3-day
 * cleanup (webhookDedupe.ts) — far beyond every retry window (~13 h ladder, today-only stuck list).
 * YouTube needs none of this: its counter is the comment queue row (`attempts`, raised on every claim, never reset).
 * Unknown here (no conversation, a database error) → null: the caller's own attempt number still bounds the runs.
 */
const CORE_RUN_LEDGER = "channel-core-run";

/** Pure: the stored customer message a run answers — one function for the core run count and the retry cap. */
export { channelCoreMessageKey };

/** Which run of the customer's last stored message this is (1…MAX), MAX + 1 when the runs are used up, null = unknown. */
export async function claimChannelCoreRun(turn: Pick<ChannelCoreTurn, "channel" | "conversationId">): Promise<number | null> {
  try {
    if (!turn.conversationId || turn.channel === "YOUTUBE") return null;
    const query = { where: { id: turn.conversationId }, select: { messages: true } } as const;
    const row = turn.channel === "TELEGRAM" ? await prisma.telegramConversation.findUnique(query)
      : turn.channel === "TELEGRAM_DIRECT" ? await prisma.telegramDirectConversation.findUnique(query)
      : await prisma.botConversation.findUnique(query);
    const message = channelCoreMessageKey(row?.messages);
    if (!message) return null;
    const base = `${turn.channel}:${turn.conversationId}:${message}`;
    for (let run = 1; run <= CHANNEL_CORE_MAX_ATTEMPTS; run++) {
      const claimed = await prisma.$executeRaw`INSERT INTO "ProcessedMessage" ("id","channel","messageId","createdAt","completedAt")
        VALUES (${randomUUID()},${CORE_RUN_LEDGER},${`${base}:${run}`},now(),now()) ON CONFLICT ("channel","messageId") DO NOTHING`;
      if (claimed === 1) return run;
    }
    return CHANNEL_CORE_MAX_ATTEMPTS + 1;
  } catch (error) {
    console.error("[one-brain] run count of a customer message unavailable:", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export const CUSTOMER_AGENT_CHANNEL_CORE_TOOLS = ["get_agency_contact", "get_company_policy", "search_public_properties", "get_company_information", "get_open_vacancies"] as const;
/**
 * Pure: the tools of one channel turn. Lead-only mode on this channel (WhatsApp/Instagram/Facebook, owner 12–13.11.2026: no
 * picks, photos or links) takes the search away, the same as the DM core does (lib/customerDmAgentTurn.ts): nothing to pick
 * from, nothing to show. Today such channels reach this adapter only in shadow; the rule holds for any future live use too.
 */
export function channelCoreToolNames(leadOnly: boolean): readonly (typeof CUSTOMER_AGENT_CHANNEL_CORE_TOOLS)[number][] {
  return leadOnly ? CUSTOMER_AGENT_CHANNEL_CORE_TOOLS.filter(name => name !== "search_public_properties") : CUSTOMER_AGENT_CHANNEL_CORE_TOOLS;
}
/** Lead-only mode applies to this channel right now. A settings failure reads as "off" (loadLeadOnlyConfig). */
export async function channelCoreLeadOnly(channel: string): Promise<boolean> {
  return leadOnlyAppliesTo(channel) && (await loadLeadOnlyConfig()).enabled;
}
const MAX_DEADLINE_MS = 60_000;

/** Markers the channels write instead of a file they did not read («[📷]», «[🎤 не расслышал]», «[📎 …]»): not words. */
const ATTACHMENT_MARKER = /\[(?:📷|🎤|📎|🎥|🎬|📄|файл|вложение|видео|фото|документ)[^\]]{0,60}\]/giu;
/**
 * Pure: what the customer said, as the core reads it. The voice transcript IS the customer's own speech and stays
 * (review #224 H2: `stripUntrusted` dropped it, a voice-only turn became «nothing to read»); contents of sent documents,
 * video descriptions and CRM notes are someone else's text and go; attachment markers are not words.
 */
export function channelOwnWords(text: string): string {
  return unwrapUntrusted(clientOwnWords(text)).replace(ATTACHMENT_MARKER, " ").replace(/\s+/g, " ").trim();
}

/** Pure: the core's view of the channel history — own words only, at most six earlier turns, bounded. */
export function channelCoreTurns(history: ChannelCoreTurn["history"]): { inputText: string; turns: CustomerAgentVerifiedContext["turns"] } {
  const own = history.map(item => ({ role: item.role, text: (item.role === "user" ? channelOwnWords(item.content)
    : unwrapUntrusted(item.content).replace(/\s+/g, " ").trim()).slice(0, 1500) }));
  let last = -1;
  for (let i = own.length - 1; i >= 0; i--) if (own[i].role === "user") { last = i; break; }
  if (last < 0) return { inputText: "", turns: [] };
  // Several unanswered customer messages are one turn (the channels batch them): join them as the current input.
  let first = last;
  while (first > 0 && own[first - 1].role === "user") first--;
  const inputText = own.slice(first, last + 1).map(item => item.text).filter(Boolean).join("\n").slice(0, 1500);
  return { inputText, turns: own.slice(0, first).filter(item => item.text).slice(-6) };
}

/** Pure: the lead facts from the customer's own words (role, place). */
export function channelCoreIntake(history: ChannelCoreTurn["history"]): ChannelCoreIntake {
  const ownTexts = history.filter(item => item.role === "user").map(item => channelOwnWords(item.content)).filter(Boolean);
  const intake = customerAgentIntake(ownTexts.slice(0, -1).map(text => ({ role: "user" as const, text })), ownTexts.at(-1) ?? "");
  const location = customerIntakeLocation(ownTexts, intake.role);
  return { role: intake.role, ...(location.locationOutsideDushanbe ? { locationOutsideDushanbe: true as const } : {}),
    ...(location.locationDifferentCountry ? { locationDifferentCountry: true as const } : {}) };
}

/** Pure: map a finished core turn to what the channel does. */
export function channelCoreOutcome(result: CustomerCoreResult, intake: ChannelCoreIntake, surface: ChannelCoreSurface,
  language: "ru" | "tg" = "ru"): ChannelCoreOutcome {
  if (result.status !== "ready") return channelCoreRetryable(result.reason, result.cause) ? { status: "unavailable", reason: result.reason }
    : { status: "staff", reason: "core_refused", intake, language };
  const decision = result.decision;
  if (decision.kind === "skip") return { status: "silent", reason: decision.reason };
  if (decision.kind === "escalate") return { status: "staff", reason: "escalate", intake, language };
  if (decision.kind === "moderation_proposal") return surface === "public_comment" ? { status: "moderate", action: decision.action }
    : { status: "silent", reason: "moderation_in_dm" };
  // A proposal asks the customer to confirm an action (showing, callback, saving): no write tool exists on these channels,
  // so promising it would be a lie. A person follows up instead.
  if (decision.kind === "propose") return { status: "staff", reason: "action_needs_staff", intake, language };
  const text = result.text.trim();
  if (!text) return { status: "silent", reason: "empty_reply" };
  return { status: "reply", text, askedPhone: result.question === "phone", intake };
}

type Runtime = Extract<Awaited<ReturnType<typeof openPinnedCustomerAgentRuntime>>, { status: "ready" }>["runtime"];

type ChannelCoreRunOptions = { mode: "shadow" | "live";
  afterCore?: (result: CustomerCoreResult, context: { historyTurns: number; toolsOffered: number }) => void; traceConfig?: TraceConfig };

/** Pure: the staff outcome when the repeats of one turn are used up (language and lead facts from the customer's words). */
function channelCoreRetriesExhausted(history: ChannelCoreTurn["history"]): ChannelCoreOutcome {
  const { inputText, turns } = channelCoreTurns(history);
  return { status: "staff", reason: "core_unavailable", intake: channelCoreIntake(history),
    language: resolveCustomerDmLanguage(inputText, turns.filter(item => item.role === "user").map(item => item.text)) };
}

/**
 * One core turn on a channel history. Never throws: a transient failure is `unavailable` (the caller's retry plays it again)
 * until the CHANNEL_CORE_MAX_ATTEMPTS-th run, then `staff` (`core_unavailable`); the core's own refusal is `staff`
 * (`core_refused`, see CHANNEL_CORE_RETRY_REASONS). `afterCore` runs inside the trace scope (the shadow writes its comparison there).
 */
export async function runChannelCoreTurn(turn: ChannelCoreTurn, options: ChannelCoreRunOptions): Promise<ChannelCoreOutcome> {
  if (options.mode === "shadow") return runChannelCoreTurnOnce(turn, options);
  const asked = Number.isSafeInteger(turn.attempt) && (turn.attempt as number) >= 1 ? turn.attempt as number : 1;
  // The count of the customer message this run answers decides, not the job's own number (review 0e463b02 N2). A retry job is
  // one per CONVERSATION (its dedupeKey): after the customer wrote again it plays the NEWER message's turn (a failed live turn
  // of that message has no job of its own — the enqueue folds into this one), and its attempt number counts the OLDER message.
  // Taking max(job, message) spent the new message's runs: it could reach its last run, or none at all, on its first try.
  // The job's number bounds the runs only when the message's count is unknown (no conversation, a database error).
  const counted = await claimChannelCoreRun(turn);
  const attempt = counted ?? asked;
  // Past the limit: no model call at all — this message's runs are spent (a re-queued job, a job that failed after the core).
  if (attempt > CHANNEL_CORE_MAX_ATTEMPTS) {
    console.error(`[one-brain] ${turn.channel}: this customer message already had ${CHANNEL_CORE_MAX_ATTEMPTS} core runs — a person answers`);
    return channelCoreRetriesExhausted(turn.history);
  }
  const outcome = await runChannelCoreTurnOnce(turn, options);
  if (outcome.status === "unavailable" && attempt >= CHANNEL_CORE_MAX_ATTEMPTS) {
    console.error(`[one-brain] ${turn.channel}: ${attempt} runs of one turn unavailable (${outcome.reason}) — a person answers`);
    return turn.history.some(item => item.role === "user") ? channelCoreRetriesExhausted(turn.history) : outcome;
  }
  return outcome;
}

async function runChannelCoreTurnOnce(turn: ChannelCoreTurn, options: ChannelCoreRunOptions): Promise<ChannelCoreOutcome> {
  try {
    const surface = turn.surface ?? "dm";
    const { inputText, turns } = channelCoreTurns(turn.history);
    // A turn with nothing readable (photo or file without words, voice without a transcript) is never «intended silence»:
    // a person looks at it (review #224 H2). A history without any customer turn at all is nothing to answer.
    if (!inputText) return turn.history.some(item => item.role === "user")
      ? { status: "staff", reason: "unreadable_input", intake: channelCoreIntake(turn.history),
        language: resolveCustomerDmLanguage("", turns.filter(item => item.role === "user").map(item => item.text)) }
      : { status: "silent", reason: "no_customer_turn" };
    const [policy] = await prisma.$queryRaw<Array<{ activeAgentRevisionId: string | null }>>`
      SELECT "activeAgentRevisionId" FROM "CustomerRuntimePolicy" WHERE "id"='singleton'`;
    if (!policy?.activeAgentRevisionId) return { status: "unavailable", reason: "no_active_revision" };
    const [row] = await prisma.$queryRaw<Array<{ id: string; manifestJson: unknown }>>`
      SELECT "id","manifestJson" FROM "CustomerAgentRevision" WHERE "id"=${policy.activeAgentRevisionId}`;
    if (!row) return { status: "unavailable", reason: "revision_missing" };
    const revision = decodeCustomerAgentRevision(row);
    const intake = channelCoreIntake(turn.history);
    const [brandName, brand] = await Promise.all([accountBrandName(turn.accountId ?? null), readCustomerAgentBrand(turn.accountId ?? null)]);
    return await withBotTurnTrace({ channel: turn.channel, account: turn.traceAccount ?? null, event: turn.eventId ?? null,
      conversation: turn.conversationId ?? null, source: "internal", kind: "text",
      managed: { surface, phase: options.mode === "shadow" ? "shadow" : "channel", revisionId: revision.id } }, async () => {
      const startedAt = Date.now();
      const opened = await openPinnedCustomerAgentRuntime({ revision, providerOperationId: randomUUID(), originalReceivedAt: startedAt,
        providerDeadlineAt: startedAt + Math.min(revision.limits.deadlineMs, MAX_DEADLINE_MS),
        // No ingress authority to re-check: the channel owns its input; no tool here writes anything.
        assertCurrent: async () => true });
      if (opened.status !== "ready") { traceCustomerCoreDisposition("held", "runtime_unavailable"); return { status: "unavailable" as const, reason: "runtime_unavailable" }; }
      const runtime: Runtime = opened.runtime;
      try {
        const priorUser = turns.filter(item => item.role === "user").map(item => item.text);
        const language = surface === "public_comment" ? customerPublicLanguage(inputText) : resolveCustomerDmLanguage(inputText, priorUser);
        const progress = customerAgentIntake(turns.filter(item => item.role === "user").map(item => ({ role: "user" as const, text: item.text })), inputText);
        const context = customerAgentVerifiedContextSchema.safeParse({ surface, revisionId: revision.id, turns,
          publicState: { language: "unknown", topic: progress.role === "unknown" ? "unknown" : progress.role, openQuestion: "none" },
          ...(surface === "dm" && progress.role !== "unknown" ? { intake: { role: progress.role, sellerKnown: progress.sellerKnown,
            buyerKnown: progress.buyerKnown, ...(progress.statements.length ? { statements: progress.statements } : {}) } } : {}) });
        const linkPreference = turn.channel === "WEBSITE" ? "site" as const : "social" as const;
        const knownPhoneSource = turn.phoneKnown ? "scoped_contact" as const
          : extractTypedPhone(inputText) || extractVolunteeredPhone(inputText) ? "current_input" as const : "none" as const;
        const toolNames = channelCoreToolNames(await channelCoreLeadOnly(turn.channel));
        const result = await runCustomerAgentTurn({ surface, language, inputText, knownPhoneSource, requestedFacts: [], revision, startedAt,
          operation: runtime.operation, tools: customerAgentToolDefinitions([...toolNames]),
          ...(context.success ? { verifiedContext: context.data } : {}), ...(brand ? { brand } : {}),
          sayMode: options.mode === "shadow" ? "shadow" : customerAgentSayMode(),
          // Same answer switch as Meta DMs (#211): in shadow the model's own words are only counted.
          answerMode: options.mode === "shadow" ? (customerAgentAnswerMode() === "off" ? "off" : "shadow") : customerAgentAnswerMode() }, {
          assertCurrent: async () => true,
          modelTurn: input => runtime.modelTurn(input),
          executeAllowedTool: call => channelCoreTool(call, { knowledgeSourceHash: revision.knowledgeSourceHash, linkPreference, brandName, toolNames }),
          requestStop: () => runtime.stop(),
          observeLateToolResult: () => {}, // Read-only tools: nothing to replay.
        });
        traceCustomerCoreResult(result);
        options.afterCore?.(result, { historyTurns: context.success ? context.data.turns.length : 0, toolsOffered: toolNames.length });
        const outcome = channelCoreOutcome(result, intake, surface, language);
        // HELD stays HELD in the trace whether it is repeated or handed to a person (the reason tells which).
        if (result.status !== "ready") traceCustomerCoreDisposition("held", result.reason, result.cause);
        else if (outcome.status !== "reply") traceCustomerCoreDisposition("unchanged");
        return outcome;
      } finally {
        // Settle the provider operation exactly like the live adapters (close only; aborting first could leave it HELD).
        await runtime.close().catch(() => {});
      }
    }, options.traceConfig);
  } catch (error) {
    console.error("[one-brain] channel core turn failed:", error instanceof Error ? error.name : "UnknownError");
    return { status: "unavailable", reason: "channel_core_failed" };
  }
}

/** Public reads only, from the same internal data service the live adapters use. Every write is denied. */
async function channelCoreTool(call: CustomerAgentToolCall, options: { knowledgeSourceHash: string; linkPreference: "site" | "social"; brandName: string | null;
  toolNames: readonly string[] }): Promise<CustomerAgentToolResult> {
  if (call.name === "get_agency_contact") return { status: "observed", observation: {
    kind: "agency_contact", contact: { phone: PUBLIC_AGENCY_CONTACT.phone, digits: PUBLIC_AGENCY_CONTACT.digits, channel: "telephone" } } };
  if (!options.toolNames.includes(call.name)) return { status: "denied", reason: "channel_read_only" };
  const read = await readCustomerAgentPublicData(call, { knowledgeSourceHash: options.knowledgeSourceHash,
    linkPreference: options.linkPreference, brandName: options.brandName });
  return read.status === "observed" ? { status: "observed", observation: read.observation } : read;
}
