import { randomUUID } from "node:crypto";

/** Server-only execution limits. None of these fields confer customer/staff
 * authority. One object is carried through every outer/inner retry. */
export type ProviderApi = "generateContent" | "cachedContents" | "bidiGenerateContent" | "embedContent";
export type ProviderAdapter = "text" | "tools" | "grounded" | "cache" | "media" | "transcribe" | "tts" | "embeddings" | "live";
export type ProviderOutcome = "success" | "blocked" | "refused" | "invalid" | "error" | "timeout" | "cancelled" | "unknown";
export interface ProviderUsage {
  source: "reported" | "missing";
  completeness: "complete" | "partial" | "missing";
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  thinkingTokens: number | null;
  audioInputTokens: number | null;
  audioOutputTokens: number | null;
  searchUnits: number | null;
}
export interface ProviderAttemptSpec {
  provider: "google"; api: ProviderApi; adapter: ProviderAdapter; model: string;
  profileRevision: string; pricingRevision?: string; endpoint: string;
  /** Bounds include thinking/headroom/widening. Not an observed token count. */
  maxOutputTokens: number;
  features?: Readonly<{ functions?: boolean; structuredReply?: boolean; thinking?: false | "budget" | "level"; cache?: boolean; grounding?: boolean; images?: boolean;
    modalities?: readonly ("image" | "audio" | "video" | "document")[] }>;
}
export interface ProviderAttemptRecord extends ProviderAttemptSpec {
  operationId: string; attemptNo: number; outcome: ProviderOutcome;
  usage: ProviderUsage; elapsedMs: number;
}
export interface ProviderAccountant {
  /** Durable atomic reservation must complete BEFORE provider I/O. */
  reserve(input: ProviderAttemptSpec & { operationId: string; attemptNo: number; deadlineAt: number }): Promise<boolean>;
  /** Idempotent settlement by operation/attempt, unknown usage retains reserve. */
  settle(input: ProviderAttemptRecord): Promise<void>;
  close?(operationId: string): Promise<void>;
}
export class ProviderOperationError extends Error {
  constructor(readonly reason: "cancelled" | "deadline" | "attempt_budget" | "unsupported" | "budget_denied" | "accounting_unavailable") {
    super(`Provider operation stopped: ${reason}`); this.name = "ProviderOperationError";
  }
}
export function isProviderOperationError(error: unknown): error is ProviderOperationError {
  return error instanceof ProviderOperationError;
}
/** Preserve a provider's optional call ID when returning a function result.
 * The original model parts (including thought signatures) stay in history. */
export function geminiFunctionResponsePart(call: { name: string; id?: string }, result: unknown): Record<string, unknown> {
  return { functionResponse: { name: call.name, ...(typeof call.id === "string" ? { id: call.id } : {}), response: { result } } };
}
export function providerDayKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dushanbe", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
/** Managed finite generation/cache operation only. A future realtime session
 * needs its own chunk/day accounting; this does not terminate existing calls. */
export function providerDayDeadline(requested: number, now = new Date()): number {
  if (!Number.isSafeInteger(requested)) throw new TypeError("Invalid provider deadline");
  return Math.min(requested, Date.parse(`${providerDayKey(now)}T00:00:00+05:00`) + 86_400_000);
}

const count = (value: unknown): number | null => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : null;
/** No metadata is different from provider-reported zero. Thinking remains a
 * separate billable component; no raw thoughts, prompt or output is retained. */
export function geminiReportedUsage(raw: unknown, adapter: ProviderAdapter = "text"): ProviderUsage {
  const metadata = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const prompt = count(metadata?.promptTokenCount), cached = count(metadata?.cachedContentTokenCount);
  const output = count(metadata?.candidatesTokenCount), thinking = count(metadata?.thoughtsTokenCount);
  const input = prompt === null ? null : cached === null ? prompt : cached <= prompt ? prompt - cached : null;
  return {
    source: metadata ? "reported" : "missing",
    completeness: !metadata ? "missing" : input !== null && output !== null && thinking !== null && cached !== null && adapter !== "grounded" ? "complete" : "partial",
    inputTokens: input, outputTokens: output, thinkingTokens: thinking, cacheReadTokens: cached,
    audioInputTokens: null, audioOutputTokens: null, searchUnits: null,
  };
}

export interface ProviderAttempt {
  readonly signal: AbortSignal;
  readonly attemptNo: number;
  check(): void;
  /** Records usage even when parsing/validation later fails. */
  reportUsage(raw: unknown): void;
  finish(outcome: ProviderOutcome): Promise<void>;
}
export interface ProviderOperation {
  readonly id: string;
  readonly deadlineAt: number;
  readonly signal: AbortSignal | undefined;
  readonly managed: boolean;
  readonly profileRevision: string;
  readonly pricingRevision: string | undefined;
  /** Exact existing accountant policy hash. Optional for compatibility paths. */
  readonly policyHash?: string;
  readonly stopped: boolean;
  check(): void;
  supports(spec: ProviderAttemptSpec): boolean;
  assertCompatible(spec: ProviderAttemptSpec): void;
  remainingMs(): number;
  sleep(ms: number): Promise<void>;
  begin(spec: ProviderAttemptSpec, timeoutMs: number): Promise<ProviderAttempt>;
  close(): Promise<void>;
}

/** Explicit policy only: no production monetary default is installed here.
 * Compatibility contexts can cap time/attempts without enabling hard billing. */
type ProviderOperationOptions = {
  id?: string; deadlineAt: number; maxAttempts: number; signal?: AbortSignal;
  managed?: boolean; accountant?: ProviderAccountant;
  profileRevision?: string; pricingRevision?: string; policyHash?: string;
  supports?: (spec: ProviderAttemptSpec) => boolean;
  /** Server factory selects this from ORIGINAL archived policy, never raw usage.
   * Absent preserves the generic decoder for existing/unqualified operations. */
  decodeUsage?: (raw: unknown, spec: Readonly<ProviderAttemptSpec>) => ProviderUsage;
};
export function createProviderOperation(options: ProviderOperationOptions): ProviderOperation {
  return buildProviderOperation(options, 0); // Existing/legacy entry point always starts at zero.
}
/** Server recovery construction only. Durable accountant still enforces the
 * exact next ordinal; this counter is not a budget/customer authority. */
export function createRecoveredProviderOperation(options: ProviderOperationOptions & { completedAttempts: number }): ProviderOperation {
  const { completedAttempts, ...original } = options;
  if (!original.id || !original.managed || !original.accountant || !Number.isSafeInteger(completedAttempts) ||
      completedAttempts < 0 || completedAttempts > original.maxAttempts) throw new TypeError("Invalid recovered provider operation");
  return buildProviderOperation(original, completedAttempts);
}
function buildProviderOperation(options: ProviderOperationOptions, initialAttempts: number): ProviderOperation {
  if (!Number.isSafeInteger(options.deadlineAt) || !Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 1000) {
    throw new TypeError("Invalid provider operation limits");
  }
  const id = options.id ?? randomUUID();
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new TypeError("Invalid provider operation ID");
  let attempts = initialAttempts, stopped = false;
  const supports = (spec: ProviderAttemptSpec) => !options.managed || (!!options.accountant && !!options.supports?.(spec));
  const assertCompatible = (spec: ProviderAttemptSpec) => {
    if (!supports(spec)) { stopped = true; throw new ProviderOperationError("unsupported"); }
  };
  const check = () => {
    if (options.signal?.aborted) { stopped = true; throw new ProviderOperationError("cancelled"); }
    if (Date.now() >= options.deadlineAt) { stopped = true; throw new ProviderOperationError("deadline"); }
    if (stopped) throw new ProviderOperationError("attempt_budget");
  };
  return {
    id, deadlineAt: options.deadlineAt, signal: options.signal, managed: options.managed ?? false,
    profileRevision: options.profileRevision ?? "legacy", pricingRevision: options.pricingRevision, policyHash: options.policyHash,
    get stopped() { return stopped || !!options.signal?.aborted || Date.now() >= options.deadlineAt; },
    check,
    supports, assertCompatible,
    async close() { stopped = true; await options.accountant?.close?.(id); },
    remainingMs: () => Math.max(0, options.deadlineAt - Date.now()),
    async sleep(ms) {
      check();
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new ProviderOperationError("cancelled")); };
        const timer = setTimeout(() => { options.signal?.removeEventListener("abort", abort); resolve(); }, Math.min(Math.max(0, ms), Math.max(0, options.deadlineAt - Date.now())));
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
      });
      check();
    },
    async begin(spec, timeoutMs) {
      // Preserve the actual reserved spec across caller mutation/async reserve.
      spec = Object.freeze({ ...spec, ...(spec.features ? { features: Object.freeze({ ...spec.features,
        ...(spec.features.modalities ? { modalities: Object.freeze([...spec.features.modalities]) } : {}) }) } : {}) });
      check();
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("Invalid provider attempt timeout");
      assertCompatible(spec);
      if (attempts >= options.maxAttempts) { stopped = true; throw new ProviderOperationError("attempt_budget"); }
      const attemptNo = ++attempts;
      if (options.accountant) {
        let reserved: boolean;
        try { reserved = await options.accountant.reserve({ ...spec, operationId: id, attemptNo, deadlineAt: options.deadlineAt }); }
        catch { stopped = true; throw new ProviderOperationError("accounting_unavailable"); }
        if (!reserved) { stopped = true; throw new ProviderOperationError("budget_denied"); }
      }
      const controller = new AbortController(), started = Date.now();
      const abort = () => controller.abort(options.signal?.reason);
      const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, options.deadlineAt - Date.now())));
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted || Date.now() >= options.deadlineAt) controller.abort();
      let finished = false, usage = geminiReportedUsage(undefined, spec.adapter);
      return {
        signal: controller.signal, attemptNo,
        check() { check(); if (controller.signal.aborted) throw new DOMException("Provider attempt timed out", "TimeoutError"); },
        reportUsage(raw) {
          try { usage = options.decodeUsage ? options.decodeUsage(raw, spec) : geminiReportedUsage(raw, spec.adapter); }
          catch {
            // A decoder fault cannot fall back to a possibly complete generic
            // counter set/refund. finish() still retains the missing reserve.
            usage = geminiReportedUsage(undefined, spec.adapter);
            stopped = true;
            throw new ProviderOperationError("accounting_unavailable");
          }
          // The generic decoder has no image billing qualification. An original
          // archived-policy decoder owns that decision when explicitly installed;
          // it must not be overridden after validating multimodal counters.
          if (!options.decodeUsage && spec.features?.images && usage.completeness === "complete") usage.completeness = "partial";
        },
        async finish(outcome) {
          if (finished) return;
          finished = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
          try { await options.accountant?.settle({ ...spec, operationId: id, attemptNo, usage,
            outcome: options.signal?.aborted ? "cancelled" : controller.signal.aborted || Date.now() >= options.deadlineAt ? "timeout" : outcome,
            elapsedMs: Math.max(0, Date.now() - started) }); }
          catch {
            if (options.managed) { stopped = true; throw new ProviderOperationError("accounting_unavailable"); }
            console.error("[provider-accounting] compatibility observation could not be settled");
          }
          // Paid usage is settled even if authority/time expires during that
          // await. A successful provider result still must not escape afterward.
          if (outcome === "success") check();
        },
      };
    },
  };
}
