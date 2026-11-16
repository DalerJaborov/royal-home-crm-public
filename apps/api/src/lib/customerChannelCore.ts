import { randomUUID } from "node:crypto";
import { customerAgentVerifiedContextSchema, type CustomerAgentLegacyChannel, type CustomerAgentToolCall,
  type CustomerAgentVerifiedContext } from "@royal-home/shared";
import { prisma } from "../db.js";
import { runCustomerAgentTurn, type CustomerAgentToolResult, type CustomerCoreResult } from "../ai/customerAgentCore.js";
import { customerAgentToolDefinitions } from "../ai/customerAgentToolDefinitions.js";
import { resolveCustomerDmLanguage } from "../ai/customerDmLanguage.js";
import { customerPublicLanguage } from "../ai/customerAgentConversationPolicy.js";
import { customerAgentIntake, customerIntakeLocation } from "../ai/customerAgentIntake.js";
import { stripUntrusted } from "../ai/untrustedContent.js";
import { extractTypedPhone, extractVolunteeredPhone } from "./shared/phoneText.js";
import { accountBrandName } from "../messengers/accounts.js";
import { decodeCustomerAgentRevision } from "./customerAgentRevision.js";
import { openPinnedCustomerAgentRuntime } from "./customerAgentRuntime.js";
import { readCustomerAgentPublicData } from "./customerAgentPublicReads.js";
import { customerAgentSayMode } from "./customerAgentFeaturePolicy.js";
import { readCustomerAgentBrand } from "./customerAgentBrandRead.js";
import { PUBLIC_AGENCY_CONTACT } from "./publicAgencyContact.js";
import { withBotTurnTrace, traceCustomerCoreResult, traceCustomerCoreDisposition, type TraceConfig } from "./botTurnTrace.js";

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
  /** The core wants a person (escalate, or an action no tool of this channel can do): send nothing, call staff. */
  | { status: "staff"; reason: "escalate" | "action_needs_staff"; intake: ChannelCoreIntake }
  /** Intended silence (thanks, a reaction, a duplicate). */
  | { status: "silent"; reason: string }
  /** Public comment only: spam/abuse, the channel's own moderation decides. */
  | { status: "moderate"; action: "hide" | "delete" }
  /** The core could not finish (provider, deadline, revision): the channel's existing AI-retry takes over. */
  | { status: "unavailable"; reason: string };

export const CHANNEL_CORE_TOOLS = ["get_agency_contact", "get_company_policy", "search_public_properties", "get_company_information", "get_open_vacancies"] as const;
const MAX_DEADLINE_MS = 60_000;

/** Pure: the core's view of the channel history — own words only, at most six earlier turns, bounded. */
export function channelCoreTurns(history: ChannelCoreTurn["history"]): { inputText: string; turns: CustomerAgentVerifiedContext["turns"] } {
  const own = history.map(item => ({ role: item.role, text: stripUntrusted(item.content).replace(/\s+/g, " ").trim().slice(0, 1500) }));
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
  const ownTexts = history.filter(item => item.role === "user").map(item => stripUntrusted(item.content)).filter(Boolean);
  const intake = customerAgentIntake(ownTexts.slice(0, -1).map(text => ({ role: "user" as const, text })), ownTexts.at(-1) ?? "");
  const location = customerIntakeLocation(ownTexts, intake.role);
  return { role: intake.role, ...(location.locationOutsideDushanbe ? { locationOutsideDushanbe: true as const } : {}),
    ...(location.locationDifferentCountry ? { locationDifferentCountry: true as const } : {}) };
}

/** Pure: map a finished core turn to what the channel does. */
export function channelCoreOutcome(result: CustomerCoreResult, intake: ChannelCoreIntake, surface: ChannelCoreSurface): ChannelCoreOutcome {
  if (result.status !== "ready") return { status: "unavailable", reason: result.reason };
  const decision = result.decision;
  if (decision.kind === "skip") return { status: "silent", reason: decision.reason };
  if (decision.kind === "escalate") return { status: "staff", reason: "escalate", intake };
  if (decision.kind === "moderation_proposal") return surface === "public_comment" ? { status: "moderate", action: decision.action }
    : { status: "silent", reason: "moderation_in_dm" };
  // A proposal asks the customer to confirm an action (showing, callback, saving): no write tool exists on these channels,
  // so promising it would be a lie. A person follows up instead.
  if (decision.kind === "propose") return { status: "staff", reason: "action_needs_staff", intake };
  const text = result.text.trim();
  if (!text) return { status: "silent", reason: "empty_reply" };
  return { status: "reply", text, askedPhone: result.question === "phone", intake };
}

type Runtime = Extract<Awaited<ReturnType<typeof openPinnedCustomerAgentRuntime>>, { status: "ready" }>["runtime"];

/**
 * One core turn on a channel history. Never throws: any failure is `unavailable` (the caller's retry decides).
 * `afterCore` runs inside the trace scope (the shadow writes its comparison there).
 */
export async function runChannelCoreTurn(turn: ChannelCoreTurn, options: { mode: "shadow" | "live";
  afterCore?: (result: CustomerCoreResult, context: { historyTurns: number; toolsOffered: number }) => void; traceConfig?: TraceConfig }): Promise<ChannelCoreOutcome> {
  try {
    const surface = turn.surface ?? "dm";
    const { inputText, turns } = channelCoreTurns(turn.history);
    if (!inputText) return { status: "silent", reason: "no_customer_words" };
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
        const result = await runCustomerAgentTurn({ surface, language, inputText, knownPhoneSource, requestedFacts: [], revision, startedAt,
          operation: runtime.operation, tools: customerAgentToolDefinitions([...CHANNEL_CORE_TOOLS]),
          ...(context.success ? { verifiedContext: context.data } : {}), ...(brand ? { brand } : {}),
          sayMode: options.mode === "shadow" ? "shadow" : customerAgentSayMode() }, {
          assertCurrent: async () => true,
          modelTurn: input => runtime.modelTurn(input),
          executeAllowedTool: call => channelCoreTool(call, { knowledgeSourceHash: revision.knowledgeSourceHash, linkPreference, brandName }),
          requestStop: () => runtime.stop(),
          observeLateToolResult: () => {}, // Read-only tools: nothing to replay.
        });
        traceCustomerCoreResult(result);
        options.afterCore?.(result, { historyTurns: context.success ? context.data.turns.length : 0, toolsOffered: CHANNEL_CORE_TOOLS.length });
        const outcome = channelCoreOutcome(result, intake, surface);
        if (outcome.status === "unavailable") traceCustomerCoreDisposition("held", outcome.reason);
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
async function channelCoreTool(call: CustomerAgentToolCall, options: { knowledgeSourceHash: string; linkPreference: "site" | "social"; brandName: string | null }): Promise<CustomerAgentToolResult> {
  if (call.name === "get_agency_contact") return { status: "observed", observation: {
    kind: "agency_contact", contact: { phone: PUBLIC_AGENCY_CONTACT.phone, digits: PUBLIC_AGENCY_CONTACT.digits, channel: "telephone" } } };
  if (!(CHANNEL_CORE_TOOLS as readonly string[]).includes(call.name)) return { status: "denied", reason: "channel_read_only" };
  const read = await readCustomerAgentPublicData(call, { knowledgeSourceHash: options.knowledgeSourceHash,
    linkPreference: options.linkPreference, brandName: options.brandName });
  return read.status === "observed" ? { status: "observed", observation: read.observation } : read;
}
