import { randomUUID } from "node:crypto";
import { z } from "zod";
import { customerMutationReceiptSchema } from "@royal-home/shared";

const reference = z.string().min(1).max(128);
const content = z.object({
  version: z.literal(1),
  agentRevision: z.object({ id: reference, manifestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  language: z.enum(["ru", "tg"]),
  // No trim/normalization: offsets and the verifier refer to these exact UTF-16 units.
  verifiedText: z.string().min(1).max(6000).refine(text => text.trim().length > 0),
  facts: z.array(z.object({ ref: reference, signature: z.string().min(1).max(512) }).strict()).max(16),
  receipts: z.array(customerMutationReceiptSchema).max(8),
  proposalRef: z.string().uuid().nullable(),
  criticalRanges: z.array(z.object({
    start: z.number().int().nonnegative(), end: z.number().int().positive(),
    kind: z.enum(["fact", "receipt", "proposal"]), ref: reference,
  }).strict()).max(32),
  originalDeadlineMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
function validateRanges(value: z.infer<typeof content>, context: z.RefinementCtx): void {
  let previousEnd = 0;
  const factRefs = new Set(value.facts.map(fact => fact.ref));
  if (factRefs.size !== value.facts.length) context.addIssue({ code: "custom", message: "Duplicate fact reference" });
  const receiptRefs = new Set(value.receipts.map(receipt => receipt.actionId));
  if (receiptRefs.size !== value.receipts.length) context.addIssue({ code: "custom", message: "Duplicate receipt reference" });
  for (const [index, range] of value.criticalRanges.entries()) {
    const splitSurrogate = (offset: number) => offset > 0 && offset < value.verifiedText.length &&
      /[\uD800-\uDBFF]/u.test(value.verifiedText[offset - 1]) && /[\uDC00-\uDFFF]/u.test(value.verifiedText[offset]);
    const linked = range.kind === "fact" ? factRefs.has(range.ref)
      : range.kind === "receipt" ? receiptRefs.has(range.ref) : range.ref === value.proposalRef;
    if (range.start < previousEnd || range.end <= range.start || range.end > value.verifiedText.length ||
        splitSurrogate(range.start) || splitSurrogate(range.end) || !linked) {
      context.addIssue({ code: "custom", path: ["criticalRanges", index], message: "Invalid or unlinked critical range" });
    }
    previousEnd = range.end;
  }
}
export const customerSpeechPlanInputSchema = content.superRefine(validateRanges);
export const customerSpeechPlanSchema = content.extend({ planId: z.string().uuid() }).strict().superRefine(validateRanges);
export type CustomerSpeechPlan = z.infer<typeof customerSpeechPlanSchema>;
export type CustomerSpeechValidationStage = "issue" | "before_render" | "after_render" | "before_queue";
export interface CustomerSpeechAuthority { readonly __customerSpeechAuthority: unique symbol }
export interface CustomerRenderedSpeech { readonly __customerRenderedSpeech: unique symbol }

export interface CustomerSpeechValidationPort {
  // Trusted server closure revalidates ORIGINAL native/controller/facts/receipt evidence.
  // Returning true from model JSON is never this port; schema validity is not verification.
  revalidate(plan: Readonly<CustomerSpeechPlan>, stage: CustomerSpeechValidationStage): Promise<boolean>;
  now(): number;
  signal?: AbortSignal;
}
export type CustomerSpeechFrame = Readonly<{
  frameIndex: number; startSample: number; endSample: number; pcm16: Buffer;
}>;
export type CustomerSpeechFrameOutcome = "local_rtp_sent" | "interrupted" | "unknown";
export interface CustomerSpeechPlaybackSnapshot {
  planId: string; sampleRateHz: number; totalSamples: number;
  ranges: ReadonlyArray<Readonly<{ startSample: number; endSample: number; outcome: CustomerSpeechFrameOutcome }>>;
}
export interface CustomerSpeechPlaybackObserver {
  // Call local_rtp_sent only after the local socket callback succeeds.
  // Late success is a retained transport fact even if interruption was requested.
  record(frameIndex: number, outcome: CustomerSpeechFrameOutcome): boolean;
  interruptFrom(frameIndex: number): boolean;
  snapshot(): CustomerSpeechPlaybackSnapshot;
}
export type CustomerSpeechResult<T> = { status: "ready"; value: T } |
  { status: "held"; reason: "invalid_plan" | "authority_unknown" | "already_used" | "expired" |
    "cancelled" | "stale" | "validation_unavailable" | "render_failed" | "invalid_audio" };
export type CustomerSpeechQueueResult =
  | { status: "queued" | "unknown"; observation: CustomerSpeechPlaybackObserver }
  | Extract<CustomerSpeechResult<never>, { status: "held" }>;

function freezeTree<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
const audioSchema = z.object({
  sampleRateHz: z.union([z.literal(8000), z.literal(16000), z.literal(24000)]),
  // Bytes remain private to the rendered handle, never in a JSON authority.
  pcm16: z.instanceof(Buffer),
}).strict();
const outcomes = new Set<CustomerSpeechFrameOutcome>(["local_rtp_sent", "interrupted", "unknown"]);
function observer(planId: string, sampleRateHz: number, frames: readonly CustomerSpeechFrame[]): CustomerSpeechPlaybackObserver {
  const state: CustomerSpeechFrameOutcome[] = frames.map(() => "unknown");
  const record = (index: number, outcome: CustomerSpeechFrameOutcome) => {
    if (!Number.isInteger(index) || index < 0 || index >= frames.length || !outcomes.has(outcome)) return false;
    if (state[index] === "local_rtp_sent") return true;
    if (outcome === "local_rtp_sent" || state[index] === "unknown") state[index] = outcome;
    return true;
  };
  return Object.freeze({
    record,
    interruptFrom(index: number) {
      if (!Number.isInteger(index) || index < 0 || index >= frames.length) return false;
      for (let i = index; i < frames.length; i++) record(i, "interrupted");
      return true;
    },
    snapshot() {
      const ranges: Array<{ startSample: number; endSample: number; outcome: CustomerSpeechFrameOutcome }> = [];
      for (const frame of frames) {
        const last = ranges.at(-1), outcome = state[frame.frameIndex];
        if (last?.outcome === outcome) last.endSample = frame.endSample;
        else ranges.push({ startSample: frame.startSample, endSample: frame.endSample, outcome });
      }
      return freezeTree({ planId, sampleRateHz, totalSamples: frames.at(-1)!.endSample, ranges });
    },
  });
}

/** Server-only leaf. It provides no model consent, DB persistence or call identity.
 * P14/P16 adapters must supply real verification and durable P12 playback integration.
 * Instantiate once per ORIGINAL server context, never from model-supplied ports. */
export function createCustomerSpeechPlanner(port: CustomerSpeechValidationPort) {
  const issued = new WeakMap<object, Readonly<CustomerSpeechPlan>>();
  const renderStarted = new WeakSet<object>();
  const rendered = new WeakMap<object, { plan: Readonly<CustomerSpeechPlan>; sampleRateHz: number; frames: readonly CustomerSpeechFrame[] }>();
  const queued = new WeakSet<object>();
  const boundary = async (plan: Readonly<CustomerSpeechPlan>, stage: CustomerSpeechValidationStage): Promise<
    Extract<CustomerSpeechResult<never>, { status: "held" }> | null> => {
    const local = () => port.signal?.aborted ? { status: "held" as const, reason: "cancelled" as const }
      : port.now() >= plan.originalDeadlineMs ? { status: "held" as const, reason: "expired" as const } : null;
    const before = local();
    if (before) return before;
    try {
      if (!await port.revalidate(plan, stage)) return { status: "held", reason: "stale" };
    } catch { return { status: "held", reason: "validation_unavailable" }; }
    return local();
  };
  return Object.freeze({
    async issue(input: unknown): Promise<CustomerSpeechResult<CustomerSpeechAuthority>> {
      const parsed = customerSpeechPlanInputSchema.safeParse(input);
      if (!parsed.success) return { status: "held", reason: "invalid_plan" };
      const plan = freezeTree(customerSpeechPlanSchema.parse({ ...parsed.data, planId: randomUUID() }));
      const denied = await boundary(plan, "issue");
      if (denied) return denied;
      const authority = Object.freeze({}) as CustomerSpeechAuthority;
      issued.set(authority, plan);
      return { status: "ready", value: authority };
    },
    inspect(authority: CustomerSpeechAuthority): Readonly<CustomerSpeechPlan> | null {
      return issued.get(authority) ?? null; // Inspection/serialization never recreates the brand.
    },
    async render(authority: CustomerSpeechAuthority, renderer: (plan: Readonly<CustomerSpeechPlan>) => Promise<unknown>):
      Promise<CustomerSpeechResult<CustomerRenderedSpeech>> {
      const plan = issued.get(authority);
      if (!plan) return { status: "held", reason: "authority_unknown" };
      if (renderStarted.has(authority)) return { status: "held", reason: "already_used" };
      renderStarted.add(authority);
      // Validate original evidence BEFORE disclosing text to a potentially paid renderer.
      const beforeRender = await boundary(plan, "before_render");
      if (beforeRender) return beforeRender;
      let raw: unknown;
      try { raw = await renderer(plan); } catch { return { status: "held", reason: "render_failed" }; }
      const audio = audioSchema.safeParse(raw);
      if (!audio.success || !audio.data.pcm16.length || audio.data.pcm16.length % 2 ||
          audio.data.pcm16.length > audio.data.sampleRateHz * 2 * 120) return { status: "held", reason: "invalid_audio" };
      // Snapshot BEFORE another await; renderer mutation cannot race the verifier.
      const pcm = Buffer.from(audio.data.pcm16);
      const denied = await boundary(plan, "after_render");
      if (denied) return denied;
      const size = audio.data.sampleRateHz / 50; // 20 ms, matching current RTP framing.
      const samples = pcm.length / 2;
      const frames: CustomerSpeechFrame[] = [];
      for (let start = 0; start < samples; start += size) {
        const end = Math.min(start + size, samples);
        frames.push(Object.freeze({ frameIndex: frames.length, startSample: start, endSample: end,
          pcm16: Buffer.from(pcm.subarray(start * 2, end * 2)) }));
      }
      const handle = Object.freeze({}) as CustomerRenderedSpeech;
      rendered.set(handle, { plan, sampleRateHz: audio.data.sampleRateHz, frames });
      return { status: "ready", value: handle };
    },
    async queue(handle: CustomerRenderedSpeech, enqueue: (input: Readonly<{
      planId: string; sampleRateHz: number; frames: readonly CustomerSpeechFrame[];
      observation: CustomerSpeechPlaybackObserver;
    }>) => "queued"): Promise<CustomerSpeechQueueResult> {
      const value = rendered.get(handle);
      if (!value) return { status: "held", reason: "authority_unknown" };
      if (queued.has(handle)) return { status: "held", reason: "already_used" };
      // Claim BEFORE await: two concurrent queue calls cannot both pass.
      queued.add(handle);
      const denied = await boundary(value.plan, "before_queue");
      if (denied) return denied;
      const observation = observer(value.plan.planId, value.sampleRateHz, value.frames);
      try {
        // Synchronous queue ownership transfer after the final check.
        // The real adapter must persist the attempt BEFORE any physical send.
        const receipt: unknown = enqueue(Object.freeze({ planId: value.plan.planId, sampleRateHz: value.sampleRateHz,
          frames: value.frames.map(frame => Object.freeze({ ...frame, pcm16: Buffer.from(frame.pcm16) })), observation }));
        if (receipt !== "queued") {
          // Async/ambiguous adapter result cannot be an atomic queue acknowledgement.
          if (receipt && typeof receipt === "object" && "then" in receipt) void Promise.resolve(receipt).catch(() => undefined);
          return { status: "unknown", observation };
        }
        return { status: "queued", observation };
      } catch {
        // Queue may have accepted a prefix. Never retry automatically/reissue this handle.
        return { status: "unknown", observation };
      }
    },
  });
}
