import { randomUUID } from "node:crypto";
import { customerAgentVerifiedContextSchema, type CustomerAgentLegacyChannel, type CustomerAgentToolCall,
  type CustomerAgentVerifiedContext, type TraceLegacyShadow } from "@royal-home/shared";
import { prisma } from "../db.js";
import { runCustomerAgentTurn, type CustomerAgentToolResult, type CustomerCoreResult } from "../ai/customerAgentCore.js";
import { customerAgentToolDefinitions } from "../ai/customerAgentToolDefinitions.js";
import { resolveCustomerDmLanguage } from "../ai/customerDmLanguage.js";
import { stripUntrusted } from "../ai/untrustedContent.js";
import { accountBrandName } from "../messengers/accounts.js";
import { decodeCustomerAgentRevision } from "./customerAgentRevision.js";
import { openPinnedCustomerAgentRuntime } from "./customerAgentRuntime.js";
import { readCustomerAgentPublicData } from "./customerAgentPublicReads.js";
import { PUBLIC_AGENCY_CONTACT } from "./publicAgencyContact.js";
import { withBotTurnTrace, traceCustomerCoreResult, traceLegacyShadow, customerManagedTraceEnabled, type TraceConfig } from "./botTurnTrace.js";
import { customerAgentChannelMode, customerAgentLegacyChannelKey, customerAgentShadowChannels, customerAgentShadowDailyCap } from "./customerAgentChannelSwitch.js";
import { dushanbeDateString } from "./dushanbeTime.js";

/**
 * ONE BRAIN, STEP 2 — the shadow comparison (owner 16.11.2026).
 *
 * After the old bot produced its turn, the core runs on the SAME customer words and the verdicts of both are written
 * side by side in one BotTurnTrace record (coverage customer_agent_dm_public_v1, managed.phase = "shadow").
 *
 * Hard limits of the shadow, by construction:
 *  - nothing is sent and nothing is written to business tables: only public read tools are offered
 *    (no get_property_facts — it needs the captured DM principal — and no write tool at all); any other call is denied;
 *  - the model's own words stay in `sayMode: "shadow"`, so `text` is the server template and is discarded here;
 *  - the old prompt history is used as `turns` ONLY here: nothing is sent and nothing is written, so it can grant nothing.
 *    The live core keeps its own verified ledger;
 *  - it runs after the old reply, in the background, never throws and never delays or changes the old reply;
 *  - per-process daily cap and at most two at once: it shares the provider budget with live core turns.
 */

export type LegacyShadowAction = TraceLegacyShadow["legacy"]["action"];
/** What the old bot did with the turn. Built by the legacy door; flags only. */
export interface LegacyTurnSummary { replied: boolean; bubbles: number; askedPhone: boolean; action: LegacyShadowAction }
export interface LegacyShadowTurn {
  /** BotConversation channel: INSTAGRAM | FACEBOOK | WHATSAPP | WEBSITE | YOUTUBE | TELEGRAM. */
  channel: string;
  /** MessengerAccount.id of the conversation (brand); null for channels without accounts. */
  accountId?: string | null;
  /** The SAME raw values the legacy trace keys use (account = accountExternalId, event = message id), so the
   *  pseudonymous keys of both records match and the pair can be joined. */
  traceAccount?: string | null;
  conversationId?: string | null;
  eventId?: string | null;
  /** The old bot's prompt history, the current customer input last. */
  history: readonly { role: "user" | "assistant"; content: string }[];
  phoneKnown: boolean;
  legacy: LegacyTurnSummary;
}

const CUSTOMER_AGENT_SHADOW_TOOLS = ["get_agency_contact", "get_company_policy", "search_public_properties", "get_company_information", "get_open_vacancies"] as const;
const MAX_PARALLEL = 2;
const MAX_DEADLINE_MS = 60_000;
let running = 0;
let day = "";
let spent = 0;

/** Test hook: the cap and the parallel counter are process state. */
export function resetLegacyShadowState(): void { running = 0; day = ""; spent = 0; }

/** Fire-and-forget entry for the legacy door. Never throws, never awaited by the customer path. */
export function scheduleLegacyCoreShadow(turn: LegacyShadowTurn): void {
  void runLegacyCoreShadow(turn).catch(error =>
    console.error("[one-brain] shadow failed:", error instanceof Error ? error.name : "UnknownError"));
}

/** Pure: the shadow's view of the old prompt history — own words only, at most six earlier turns, bounded. */
export function legacyShadowTurns(history: LegacyShadowTurn["history"]): { inputText: string; turns: CustomerAgentVerifiedContext["turns"] } {
  const own = history.map(item => ({ role: item.role, text: stripUntrusted(item.content).replace(/\s+/g, " ").trim().slice(0, 1500) }));
  let last = -1;
  for (let i = own.length - 1; i >= 0; i--) if (own[i].role === "user") { last = i; break; }
  if (last < 0) return { inputText: "", turns: [] };
  return { inputText: own[last].text, turns: own.slice(0, last).filter(item => item.text).slice(-6) };
}

/** Pure: did the core plan a customer reply, and what it asked. */
export function legacyShadowCoreView(result: CustomerCoreResult): TraceLegacyShadow["core"] {
  if (result.status !== "ready" || !result.text.trim() || result.decision.kind === "escalate") return { replied: false, askedPhone: false };
  return { replied: true, askedPhone: result.question === "phone", question: result.question };
}

export async function runLegacyCoreShadow(turn: LegacyShadowTurn, options: { traceConfig?: TraceConfig } = {}): Promise<"skipped" | "recorded" | "held"> {
  // Default (switch empty): return before any read, so the old path costs exactly what it cost before.
  if (customerAgentShadowChannels(process.env.CUSTOMER_AGENT_CHANNEL_SHADOW).size === 0) return "skipped";
  const brandName = await accountBrandName(turn.accountId ?? null);
  const key: CustomerAgentLegacyChannel | null = customerAgentLegacyChannelKey(turn.channel, brandName);
  // No trace storage, no comparison: never spend a model call that nobody can read.
  if (!key || customerAgentChannelMode(key) !== "shadow" || !customerManagedTraceEnabled()) return "skipped";
  const { inputText, turns } = legacyShadowTurns(turn.history);
  if (!inputText) return "skipped";
  const today = dushanbeDateString();
  if (today !== day) { day = today; spent = 0; }
  if (spent >= customerAgentShadowDailyCap() || running >= MAX_PARALLEL) return "skipped";
  spent++; running++;
  try {
    const [policy] = await prisma.$queryRaw<Array<{ activeAgentRevisionId: string | null }>>`
      SELECT "activeAgentRevisionId" FROM "CustomerRuntimePolicy" WHERE "id"='singleton'`;
    if (!policy?.activeAgentRevisionId) return "skipped";
    const [row] = await prisma.$queryRaw<Array<{ id: string; manifestJson: unknown }>>`
      SELECT "id","manifestJson" FROM "CustomerAgentRevision" WHERE "id"=${policy.activeAgentRevisionId}`;
    if (!row) return "skipped";
    const revision = decodeCustomerAgentRevision(row);
    return await withBotTurnTrace({ channel: turn.channel, account: turn.traceAccount ?? null, event: turn.eventId ?? null,
      conversation: turn.conversationId ?? null, source: "internal", kind: "text",
      managed: { surface: "dm", phase: "shadow", revisionId: revision.id } }, async () => {
      const startedAt = Date.now();
      const opened = await openPinnedCustomerAgentRuntime({ revision, providerOperationId: randomUUID(), originalReceivedAt: startedAt,
        providerDeadlineAt: startedAt + Math.min(revision.limits.deadlineMs, MAX_DEADLINE_MS),
        // No authority to re-check: the shadow owns no input, claim or customer.
        assertCurrent: async () => true });
      if (opened.status !== "ready") return "held" as const;
      const runtime = opened.runtime;
      try {
        const priorUser = turns.filter(item => item.role === "user").map(item => item.text);
        const language = resolveCustomerDmLanguage(inputText, priorUser);
        const context = customerAgentVerifiedContextSchema.safeParse({ surface: "dm", revisionId: revision.id, turns,
          publicState: { language: "unknown", topic: "unknown", openQuestion: "none" } });
        const linkPreference = turn.channel === "WEBSITE" ? "site" as const : "social" as const;
        const result = await runCustomerAgentTurn({ surface: "dm", language, inputText,
          knownPhoneSource: turn.phoneKnown ? "scoped_contact" : "none", requestedFacts: [], revision, startedAt,
          operation: runtime.operation, tools: customerAgentToolDefinitions([...CUSTOMER_AGENT_SHADOW_TOOLS]),
          ...(context.success ? { verifiedContext: context.data } : {}), sayMode: "shadow" }, {
          assertCurrent: async () => true,
          modelTurn: input => runtime.modelTurn(input),
          executeAllowedTool: call => shadowTool(call, { knowledgeSourceHash: revision.knowledgeSourceHash, linkPreference, brandName }),
          requestStop: () => runtime.stop(),
          observeLateToolResult: () => {},
        });
        traceCustomerCoreResult(result);
        const core = legacyShadowCoreView(result);
        traceLegacyShadow({ channelKey: key, legacy: { ...turn.legacy, bubbles: Math.min(8, Math.max(0, turn.legacy.bubbles)) }, core,
          agree: { replied: core.replied === turn.legacy.replied, askedPhone: core.askedPhone === turn.legacy.askedPhone },
          toolsOffered: CUSTOMER_AGENT_SHADOW_TOOLS.length, historyTurns: context.success ? context.data.turns.length : 0 });
        return "recorded" as const;
      } finally {
        // Settle the provider operation exactly like the live adapters (close only; aborting first could leave it HELD).
        await runtime.close().catch(() => {});
      }
    }, options.traceConfig);
  } finally { running--; }
}

/** Public reads only, from the same internal data service the live adapters use. Every write is denied. */
async function shadowTool(call: CustomerAgentToolCall, options: { knowledgeSourceHash: string; linkPreference: "site" | "social"; brandName: string | null }): Promise<CustomerAgentToolResult> {
  if (call.name === "get_agency_contact") return { status: "observed", observation: {
    kind: "agency_contact", contact: { phone: PUBLIC_AGENCY_CONTACT.phone, digits: PUBLIC_AGENCY_CONTACT.digits, channel: "telephone" } } };
  if (!(CUSTOMER_AGENT_SHADOW_TOOLS as readonly string[]).includes(call.name)) return { status: "denied", reason: "shadow_read_only" };
  const read = await readCustomerAgentPublicData(call, { knowledgeSourceHash: options.knowledgeSourceHash,
    linkPreference: options.linkPreference, brandName: options.brandName });
  return read.status === "observed" ? { status: "observed", observation: read.observation } : read;
}
