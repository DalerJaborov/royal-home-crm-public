import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { botTurnTracePayloadSchema, BOT_TURN_TRACE_COVERAGE, BOT_CUSTOMER_AGENT_TRACE_COVERAGE, traceManagedContextSchema, traceCustomerCoreSchema, traceManagedDeliverySchema, type TraceCustomerCore, type TraceManagedContext, type TraceManagedDelivery, type BotTurnTracePayload, type BotIngressShape, type TraceModelAttempt, type TraceOutgoingPart, type TraceOutcome, type TraceStage } from "@royal-home/shared";
import { boundedTracePayload, projectTraceModel, sanitizeTraceText, tracePseudonym } from "./botTurnTracePrivacy.js";

type Channel = BotTurnTracePayload["channel"];
export interface TraceConfig { enabled: boolean; secret: string; text: boolean; write?: (payload: BotTurnTracePayload) => void | Promise<void> }
export interface TraceStart { managed?: { surface: TraceManagedContext["surface"]; phase: TraceManagedContext["phase"]; revisionId?: string; operationId?: string | null }; channel: string; peer?: string; account?: string | null; event?: string | null; conversation?: string | null; source?: BotTurnTracePayload["source"]; text?: string; kind?: BotTurnTracePayload["input"]["kind"]; attachments?: number; ingress?: BotIngressShape; knownContacts?: string[] }
interface Context { payload: BotTurnTracePayload; config: TraceConfig; account: string | null; peer?: string; contacts: string[]; secrets: string[]; dropped: boolean; closed: boolean; origin: "bot" | "neutral" | "regenerated"; latestAttempt?: number; deferred?: Promise<unknown> }
const context = new AsyncLocalStorage<Context>();
const outgoingScope = new AsyncLocalStorage<number>();
let warned = false;
const channels = new Set(["WHATSAPP", "INSTAGRAM", "FACEBOOK", "WEBSITE"]);
function runtimeConfig(): TraceConfig {
  return { enabled: /^(1|true)$/.test(process.env.BOT_TURN_TRACE_ENABLED ?? ""), secret: process.env.BOT_TURN_TRACE_HMAC_KEY ?? "", text: process.env.BOT_TURN_TRACE_TEXT_ENABLED === "1" };
}
/** Cheap preflight for optional metadata lookup. No business authorization. */
export function customerManagedTraceEnabled(): boolean {
  const config = runtimeConfig();
  return config.enabled && config.secret.length >= 32;
}
function alarm(): void { if (!warned) { warned = true; console.warn("[bot-trace] diagnostic record omitted; check trace configuration/storage"); } }
function observe(fn: (ctx: Context) => void): void {
  const ctx = context.getStore();
  if (!ctx || ctx.dropped || ctx.closed) return;
  try { fn(ctx); } catch { ctx.dropped = true; alarm(); }
}
function key(ctx: Context, domain: Parameters<typeof tracePseudonym>[1], value: string | null | undefined): string | null {
  return tracePseudonym(ctx.config.secret, domain, ctx.payload.channel, ctx.account, value);
}
function text(ctx: Context, value: string) {
  const base = { present: !!value, chars: value.length };
  if (!ctx.config.text) { if (!ctx.payload.redactedKinds.includes("free_text_omitted")) ctx.payload.redactedKinds.push("free_text_omitted"); return base; }
  const safe = sanitizeTraceText(value, ctx.contacts, ctx.secrets);
  for (const kind of safe.redactedKinds) if (!ctx.payload.redactedKinds.includes(kind)) ctx.payload.redactedKinds.push(kind);
  ctx.payload.omittedCounts.textChars += safe.omitted;
  ctx.payload.truncated ||= safe.omitted > 0;
  return { ...base, text: safe.text };
}
function append<K extends "resolutions" | "modelAttempts" | "filterDeltas" | "outgoing" | "timings">(ctx: Context, field: K, value: BotTurnTracePayload[K][number], limit: number): void {
  const list = ctx.payload[field] as unknown[];
  if (list.length < limit) list.push(value);
  else { ctx.payload.omittedCounts[field]++; ctx.payload.truncated = true; }
}
export function currentBotTurnTrace() { const ctx = context.getStore(); return ctx && !ctx.dropped && !ctx.closed ? { traceId: ctx.payload.traceId, eventKey: ctx.payload.eventKey } : undefined; }
export function traceCheckpoint(): void {
  observe((ctx) => {
    ctx.payload.checkpointSeq++;
    const payload = botTurnTracePayloadSchema.parse(boundedTracePayload(ctx.payload));
    if (ctx.config.write) void Promise.resolve(ctx.config.write(payload)).catch(alarm);
    else void import("./botTurnTraceStore.js").then(({ enqueueBotTurnTrace }) => enqueueBotTurnTrace(payload)).catch(alarm);
  });
}
export async function withBotTurnTrace<T>(input: TraceStart, run: () => Promise<T>, config = runtimeConfig()): Promise<T> {
  const parent = context.getStore();
  if ((parent && !parent.closed && !parent.dropped && !input.managed) || !config.enabled || !channels.has(input.channel)) return run();
  if (config.secret.length < 32) { alarm(); return run(); }
  // Managed model/decision/delivery additions are ALWAYS metadata-only, even
  // when legacy free-text diagnostics were explicitly enabled by an operator.
  if (input.managed) config = { ...config, text: false };
  const now = new Date();
  const ctx: Context = { config, account: input.account ?? null, peer: input.peer, contacts: (input.knownContacts ?? []).slice(0, 12), secrets: [config.secret], dropped: false, closed: false, origin: "bot",
    payload: { schemaVersion: 1, coverage: input.managed ? BOT_CUSTOMER_AGENT_TRACE_COVERAGE : BOT_TURN_TRACE_COVERAGE, traceId: randomUUID(), createdAt: now.toISOString(), completedAt: null,
      expiresAt: new Date(now.getTime() + 7 * 86400000).toISOString(), checkpointSeq: 0, channel: input.channel as Channel,
      source: input.source ?? "internal", outcome: "incomplete", eventKey: null, conversationKey: null, accountKey: null,
      groupedEventKeys: [], groupedTraceIds: [], input: { kind: input.kind ?? "text", textPresent: !!input.text, attachmentCount: Math.min(1000, Math.max(0, input.attachments ?? 0)), mimeKinds: [], language: "unknown", echoReason: null },
      ingress: input.ingress ?? null, resolutions: [], modelAttempts: [], filterDeltas: [], outgoing: [], timings: [], guardHits: 0, checkpointGaps: 0, truncated: false,
      omittedCounts: { resolutions: 0, modelAttempts: 0, filterDeltas: 0, outgoing: 0, timings: 0, textChars: 0, grouped: 0 }, redactedKinds: [] } };
  try { ctx.payload.eventKey = key(ctx, "event", input.event); ctx.payload.conversationKey = key(ctx, "conversation", input.conversation); ctx.payload.accountKey = key(ctx, "account", input.account); }
  catch { alarm(); return run(); }
  if (input.managed) {
    try {
      ctx.payload.managed = traceManagedContextSchema.parse({ surface: input.managed.surface, phase: input.managed.phase,
        ...(input.managed.revisionId === undefined ? {} : { revisionId: input.managed.revisionId }),
        operationKey: key(ctx, "operation", input.managed.operationId) });
    } catch { alarm(); return run(); }
  }
  return context.run(ctx, async () => {
    traceCheckpoint();
    const finish = () => { observe((c) => { c.payload.completedAt = new Date().toISOString(); if (c.payload.outcome === "incomplete") c.payload.outcome = "completed";
      if (c.payload.outgoing.some((p) => p.providerOutcome === "accepted") && c.payload.outgoing.some((p) => p.providerOutcome === "failed" || p.providerOutcome === "unknown" || p.providerOutcome === "blocked")) c.payload.outcome = "partially_sent";
    }); traceCheckpoint(); ctx.closed = true; };
    try { return await run(); }
    catch (err) { traceOutcome("failed"); throw err; }
    finally {
      if (ctx.deferred) void ctx.deferred.then(() => context.run(ctx, finish), () => context.run(ctx, finish));
      else finish();
    }
  });
}
/** Only an already-existing business background task; does not wait or start work. */
export function traceDeferUntil(task: Promise<unknown>): void { observe((ctx) => { ctx.deferred = ctx.deferred ? Promise.allSettled([ctx.deferred, task]) : task; }); }
export function traceNoReply(): void { observe((ctx) => { if (ctx.payload.outcome === "incomplete") ctx.payload.outcome = "no_reply"; }); }
export function traceFinishCustomerTurn(): void { observe((ctx) => { if (ctx.payload.outcome === "incomplete" && ctx.payload.outgoing.length === 0 && ctx.payload.omittedCounts.outgoing === 0) ctx.payload.outcome = "no_reply"; }); }
export function traceEchoReason(reason: NonNullable<BotTurnTracePayload["input"]["echoReason"]>): void { observe((ctx) => { ctx.payload.input.echoReason = reason; ctx.payload.outcome = reason === "manual" ? "manual" : "echo"; }); }
export function traceDeliveryStatus(mid: string, status: "sent" | "delivered" | "read" | "failed"): void { observe((ctx) => append(ctx, "outgoing", {
  ordinal: 0, kind: "other", origin: "bot", requestedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  providerOutcome: status === "sent" ? "accepted" : status, midKey: key(ctx, "mid", mid), stampOutcome: "not_attempted", text: { present: false, chars: 0 },
}, 12)); }
export function traceOutcome(outcome: TraceOutcome): void { observe((ctx) => { ctx.payload.outcome = outcome; }); }
export function traceBindConversation(id: string, language?: string): void { observe((ctx) => { ctx.payload.conversationKey = key(ctx, "conversation", id); if (language === "ru" || language === "tg") ctx.payload.input.language = language; }); }
export function traceBindAccount(account: string | undefined, conversation: string): void { observe((ctx) => { if (ctx.account || !account) return; ctx.account = account; ctx.payload.accountKey = key(ctx, "account", account); ctx.payload.conversationKey = key(ctx, "conversation", conversation); }); }
export function traceMediaKinds(kinds: readonly BotTurnTracePayload["input"]["mimeKinds"][number][]): void { observe((ctx) => { ctx.payload.input.mimeKinds = [...new Set(kinds)].slice(0, 4); }); }
/** Transient exact redaction dictionary, never part of payload/checkpoint/store. */
export function traceKnownSecrets(values: readonly string[]): void { observe((ctx) => { for (const value of values) if (value.length >= 8 && value.length <= 1000 && ctx.secrets.length < 10 && !ctx.secrets.includes(value)) ctx.secrets.push(value); }); }
export function traceKnownContacts(values: readonly (string | null | undefined)[]): void { observe((ctx) => { for (const value of values) if (typeof value === "string" && value.length >= 2 && value.length <= 100 && ctx.contacts.length < 12 && !ctx.contacts.includes(value)) ctx.contacts.push(value); }); }
export async function traceMeasured<T>(stage: TraceStage, run: () => Promise<T>): Promise<T> { const start = performance.now(); try { return await run(); } finally { traceTiming(stage, start); } }
export function traceGrouped(entries: readonly { traceId?: string; eventKey?: string | null }[]): void {
  observe((ctx) => { for (const entry of entries) {
    if (ctx.payload.groupedTraceIds.length >= 32) { ctx.payload.omittedCounts.grouped++; ctx.payload.truncated = true; continue; }
    if (entry.traceId && /^[a-f0-9-]{36}$/i.test(entry.traceId)) { ctx.payload.groupedTraceIds.push(entry.traceId); ctx.payload.groupedEventKeys.push(entry.eventKey ?? null); }
  } });
}
export function traceResolution(kind: BotTurnTracePayload["resolutions"][number]["kind"], propertyId: string | null | undefined): void {
  observe((ctx) => append(ctx, "resolutions", { kind, propertyKey: key(ctx, "property", propertyId), status: propertyId ? "found" : "missing" }, 12));
}
/** P03 metadata only: current focus is distinct from first ad attribution. */
export function traceCustomerPropertyResolution(value: { status: "pending" | "resolved" | "ambiguous" | "missing" | "denied";
  propertyId: string | null; provenanceKinds: NonNullable<BotTurnTracePayload["resolutions"][number]["provenanceKinds"]>; candidateCount?: number }, superseded = false): void {
  observe((ctx) => append(ctx, "resolutions", { kind: "active", propertyKey: key(ctx, "property", value.propertyId),
    status: value.status === "resolved" ? "found" : value.status === "ambiguous" || value.status === "pending" ? "unknown" : "missing",
    resolutionStatus: value.status, provenanceKinds: [...new Set(value.provenanceKinds)].slice(0, 6),
    ...(value.candidateCount === undefined ? {} : { candidateCount: Math.min(8, Math.max(0, value.candidateCount)) }), superseded }, 12));
}
export function traceGuardHit(times = 1): void { observe((ctx) => { ctx.payload.guardHits += Math.max(0, times); }); }
export function traceTiming(stage: TraceStage, start: number): void { observe((ctx) => append(ctx, "timings", { stage, durationMs: Math.max(0, Math.round(performance.now() - start)) }, 12)); }
export function traceModelStart(model: string, cacheUsed: boolean | null, endpoint: TraceModelAttempt["endpoint"] = "lead-qualify"): number | null {
  let index: number | null = null;
  observe((ctx) => { index = ctx.payload.modelAttempts.length + ctx.payload.omittedCounts.modelAttempts; ctx.latestAttempt = index; append(ctx, "modelAttempts", { index, endpoint, model, cacheUsed, outcome: "started", durationMs: 0, schemaIssues: [] }, 8); });
  return index;
}
export function traceModelFinish(index: number | null, outcome: TraceModelAttempt["outcome"], start: number, raw?: unknown): void {
  if (index === null) return;
  observe((ctx) => { const attempt = ctx.payload.modelAttempts.find((item) => item.index === index); if (!attempt) return;
    attempt.outcome = outcome; attempt.durationMs = Math.max(0, Math.round(performance.now() - start));
    if (outcome === "wrong_tool" || outcome === "multiple_calls") attempt.protocolIssue = outcome;
    if (raw !== undefined) attempt.projection = projectTraceModel(raw, (v) => text(ctx, v));
  }); traceCheckpoint();
}
export function traceModelCache(index: number | null, cacheUsed: boolean | null): void { observe((ctx) => { const attempt = ctx.payload.modelAttempts.find((item) => item.index === index); if (attempt) attempt.cacheUsed = cacheUsed; }); }
/** P01 calls this after safeParse; paths/codes are projected, never unknown key names. */
export function traceModelValidation(raw: unknown, issues: readonly { path?: readonly PropertyKey[]; code?: string }[] = []): void {
  observe((ctx) => { const attempt = ctx.payload.modelAttempts.find((item) => item.index === ctx.latestAttempt); if (!attempt) return;
    attempt.projection = projectTraceModel(raw, (v) => text(ctx, v)); attempt.outcome = issues.length ? "invalid" : "parsed";
    const paths = new Set(["reply", "ready", "confident", "lead", "jobApplication", "showing", "topic"]);
    const codes = new Set(["invalid_type", "invalid_value", "too_small", "too_big", "unrecognized_keys", "custom"]);
    attempt.schemaIssues = issues.slice(0, 16).map((issue) => ({ path: (paths.has(String(issue.path?.[0])) ? String(issue.path?.[0]) : "other") as TraceModelAttempt["schemaIssues"][number]["path"], code: (codes.has(issue.code ?? "") ? issue.code : "other") as TraceModelAttempt["schemaIssues"][number]["code"] }));
  }); traceCheckpoint();
}
export function traceReplyOrigin(origin: "bot" | "neutral" | "regenerated"): void { observe((ctx) => { ctx.origin = origin; }); }
export function traceFilterDelta(stage: BotTurnTracePayload["filterDeltas"][number]["stage"], before: string, after: string, guard: BotTurnTracePayload["filterDeltas"][number]["guard"] = "reply_chain"): void {
  observe((ctx) => append(ctx, "filterDeltas", { guard, attemptIndex: ctx.latestAttempt ?? 0, stage, before: text(ctx, before), after: text(ctx, after), changed: before !== after, guardHits: ctx.payload.guardHits }, 16));
}
export function traceProviderAccepted(mid: string | null): void {
  const ordinal = outgoingScope.getStore();
  if (ordinal === undefined) return;
  observe((ctx) => { const part = ctx.payload.outgoing.find((item) => item.ordinal === ordinal); if (!part) return;
    const validMid = typeof mid === "string" && mid.length > 0 && mid.length <= 512 && mid.trim() === mid && !/[\u0000-\u001f\u007f]/.test(mid);
    part.providerOutcome = ctx.payload.managed && !validMid ? "unknown" : "accepted";
    part.finishedAt = new Date().toISOString(); part.midKey = ctx.payload.managed && !validMid ? null : key(ctx, "mid", mid);
  }); traceCheckpoint();
}
export async function traceObserveSend<T>(kind: TraceOutgoingPart["kind"], value: string, origin: string | undefined, send: () => Promise<T>, target?: { channel: string; peer: string }): Promise<T> {
  const ctx = context.getStore();
  if (!ctx || ctx.dropped || ctx.closed || origin === "staff") return send();
  if (target && (target.channel !== ctx.payload.channel || target.peer !== ctx.peer)) return send();
  let ordinal = -1;
  observe((c) => { ordinal = c.payload.outgoing.length + c.payload.omittedCounts.outgoing;
    append(c, "outgoing", { ordinal, kind, origin: c.origin, requestedAt: new Date().toISOString(), finishedAt: null, providerOutcome: "started", midKey: null, stampOutcome: "not_attempted", text: text(c, value) }, 12); });
  traceCheckpoint();
  return outgoingScope.run(ordinal, async () => {
    try { return await send(); }
    catch (err) { observe((c) => { const part = c.payload.outgoing.find((item) => item.ordinal === ordinal); if (!part || part.providerOutcome === "accepted") return;
      part.finishedAt = new Date().toISOString(); const name = err instanceof Error ? err.name : "";
      part.providerOutcome = name === "OutboundBlockedError" ? "blocked" : err instanceof Error && /^Graph API HTTP 4\d\d:/.test(err.message) ? "failed" : "unknown";
    }); throw err; }
    finally { observe((c) => { const part = c.payload.outgoing.find((item) => item.ordinal === ordinal); if (part?.providerOutcome === "started") { part.providerOutcome = "unknown"; part.finishedAt = new Date().toISOString(); } }); traceCheckpoint(); }
  });
}
export function traceStamp(mid: string | null, result: boolean | "missing"): void { observe((ctx) => { const midKey = key(ctx, "mid", mid); const part = ctx.payload.outgoing.slice().reverse().find((item) => item.midKey === midKey && item.providerOutcome === "accepted"); if (part) part.stampOutcome = result === "missing" ? "missing" : result ? "success" : "failed"; }); traceCheckpoint(); }
export function traceWidgetAvailable(value: string): void { observe((ctx) => append(ctx, "outgoing", { ordinal: ctx.payload.outgoing.length, kind: "text", origin: "widget", requestedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), providerOutcome: "available_to_widget", midKey: null, stampOutcome: "not_attempted", text: text(ctx, value) }, 12)); traceCheckpoint(); }
/** Only committed bot messages for THIS website conversation; no extra read. */
export function traceWebsiteMessagesPersisted(conversationId: string, messages: readonly { role: string; content: string; by?: { kind: string }; visibleAt?: string; customerPropertyDelivery?: { status: string } }[], affectedRows: number): void {
  observe((ctx) => {
    if (ctx.payload.channel !== "WEBSITE" || affectedRows < 1 || key(ctx, "conversation", conversationId) !== ctx.payload.conversationKey) return;
    for (const message of messages) {
        if (message.role !== "assistant" || message.by?.kind !== "bot") continue;
        if (message.customerPropertyDelivery && message.customerPropertyDelivery.status !== "accepted") continue;
      append(ctx, "outgoing", { ordinal: ctx.payload.outgoing.length + ctx.payload.omittedCounts.outgoing, kind: "text", origin: "widget", requestedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), providerOutcome: "available_to_widget", midKey: null, stampOutcome: "success", text: text(ctx, message.content), ...(message.visibleAt ? { visibleAt: message.visibleAt } : {}) }, 12);
    }
  }); traceCheckpoint();
}

/** Closed diagnostic categories, NEVER exception/reason text. */
function coreReason(raw: unknown): NonNullable<TraceCustomerCore["heldReason"]> {
  if (typeof raw !== "string") return "other";
  if (["effect_unknown", "receipt_requires_reconciliation"].includes(raw)) return "effect_unknown";
  if (["operation_stopped", "cancelled", "deadline", "expired"].includes(raw)) return "operation_stopped";
  if (["original_context_changed", "context_scope_mismatch", "turn_already_owned"].includes(raw)) return "context_changed";
  if (["round_limit", "tool_limit", "input_limit", "output_limit", "model_payload_limit", "customer_turn_budget_or_context"].includes(raw)) return "limit";
  if (["invalid_model_turn", "mixed_model_protocol", "missing_model_parts", "duplicate_call_id", "invalid_model_call", "invalid_call_id", "call_id_reused", "invalid_model_decision", "duplicate_tool_definition"].includes(raw)) return "protocol_invalid";
  if (["unavailable_tool", "public_write_definition_denied", "surface_decision_denied", "unsupported_decision_evidence", "facts_unavailable", "staff_or_supported_reply_required"].includes(raw)) return "unsupported";
  if (["needs_review", "phone_required"].includes(raw)) return "needs_review";
  return "other";
}
/** The root coordinator supplies the actual validated Core result, never a
 * model/HTTP route JSON. Strict projection below still drops all text/args/IDs. */
export function traceCustomerCoreResult(result: { status: "ready" | "held"; decision?: { kind: unknown };
  rounds: number; toolCalls: number; evidence: readonly { value: { kind: string; outcome?: unknown } }[]; reason?: unknown; fallbackReason?: "invalid_model_decision" }): void {
  observe(ctx => {
    if (!ctx.payload.managed || ctx.payload.managed.phase !== "planning") return;
    ctx.payload.customerCore = traceCustomerCoreSchema.parse({ status: result.status,
      ...(result.status === "ready" && result.decision ? { decisionKind: result.decision.kind } : {}),
      rounds: result.rounds, toolCalls: result.toolCalls,
      receiptOutcomes: [...new Set(result.evidence.filter(e => e.value.kind === "receipt").map(e => e.value.outcome))],
      ...(result.status === "held" ? { heldReason: coreReason(result.reason),
        ...(coreReason(result.reason) === "protocol_invalid" ? { protocolReason: result.reason } : {}) } : {}),
      ...(result.status === "ready" && result.rounds > 0 ? { decisionSource: result.fallbackReason ? "verified_public_fallback" : "model",
        ...(result.fallbackReason ? { protocolReason: result.fallbackReason } : {}) } : {}) });
  }); traceCheckpoint();
}
/** PLANNED is local persistence only; this never appends an outgoing receipt. */
export function traceCustomerCoreDisposition(status: "planned" | "unchanged" | "held", reason?: unknown): void {
  observe(ctx => {
    if (!ctx.payload.managed || ctx.payload.managed.phase !== "planning") return;
    const previous = ctx.payload.customerCore;
    ctx.payload.customerCore = traceCustomerCoreSchema.parse({ ...previous, status,
      rounds: previous?.rounds ?? 0, toolCalls: previous?.toolCalls ?? 0, receiptOutcomes: previous?.receiptOutcomes ?? [],
      ...(status === "held" ? { heldReason: coreReason(reason) } : {}) });
  }); traceCheckpoint();
}
/** Actual dispatcher result only; no text/resource/MID arguments. The existing
 * physical-send hooks keep the real provider receipt independently. */
export function traceCustomerManagedDelivery(result: { status: TraceManagedDelivery["status"]; projectionPending?: boolean }): void {
  observe(ctx => {
    if (!ctx.payload.managed || ctx.payload.managed.phase !== "delivery") return;
    ctx.payload.managedDelivery = traceManagedDeliverySchema.parse({ status: result.status, projectionPending: result.projectionPending === true });
  }); traceCheckpoint();
}
/** Attach only an ORIGINAL actual claim/origin pin. Rebinding one trace to a
 * new operation/revision is diagnostic failure, never a business permission. */
export function traceCustomerManagedBinding(input: { revisionId: string; operationId: string }): void {
  observe(ctx => {
    const previous = ctx.payload.managed; if (!previous) return;
    const next = traceManagedContextSchema.parse({ ...previous, revisionId: input.revisionId,
      operationKey: key(ctx, "operation", input.operationId) });
    if (previous.revisionId !== undefined && previous.revisionId !== next.revisionId ||
        previous.operationKey !== null && previous.operationKey !== next.operationKey) throw new Error("trace_original_binding_changed");
    ctx.payload.managed = next;
  }); traceCheckpoint();
}
