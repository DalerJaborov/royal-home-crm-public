import { describe, expect, it, vi } from "vitest";
import {
  createCustomerSpeechPlanner, customerSpeechPlanInputSchema,
  type CustomerSpeechAuthority, type CustomerRenderedSpeech, type CustomerSpeechValidationStage,
} from "../src/ai/customerSpeechPlan.js";

const input = () => ({
  version: 1, agentRevision: { id: "revision-1", manifestHash: "a".repeat(64) },
  language: "tg", verifiedText: "Нарх 500 сомонӣ.", facts: [{ ref: "property-observation-1", signature: "price-v1" }],
  receipts: [], proposalRef: null, criticalRanges: [{ start: 5, end: 8, kind: "fact", ref: "property-observation-1" }],
  originalDeadlineMs: 2000,
});
const audio = () => ({ sampleRateHz: 8000, pcm16: Buffer.alloc(960) }); // 480 samples, three frames
function fixture() {
  let now = 1000, valid = true;
  const checks: CustomerSpeechValidationStage[] = [];
  const planner = createCustomerSpeechPlanner({ now: () => now, revalidate: async (_plan, stage) => {
    checks.push(stage); return valid;
  } });
  return { planner, checks, advance: () => { now = 2000; }, revoke: () => { valid = false; } };
}
async function prepared(f: ReturnType<typeof fixture>) {
  const authority = await f.planner.issue(input());
  if (authority.status !== "ready") throw new Error("Expected genuine issued speech authority");
  const rendered = await f.planner.render(authority.value, async () => audio());
  if (rendered.status !== "ready") throw new Error("Expected rendered speech");
  return { authority: authority.value, rendered: rendered.value };
}

describe("verified speech leaf boundaries (offline; no provider/playback proof)", () => {
  it("strictly rejects arbitrary authority fields and unlinked/overlapping critical claims", async () => {
    expect(customerSpeechPlanInputSchema.safeParse({ ...input(), authority: { verified: true } }).success).toBe(false);
    expect(customerSpeechPlanInputSchema.safeParse({ ...input(), criticalRanges: [
      { start: 5, end: 8, kind: "receipt", ref: "model-chosen-receipt" },
    ] }).success).toBe(false);
    expect(customerSpeechPlanInputSchema.safeParse({ ...input(), criticalRanges: [
      ...input().criticalRanges, { start: 7, end: 9, kind: "fact", ref: "property-observation-1" },
    ] }).success).toBe(false);
  });

  it("does not mint authority from serialized/cross-context plans and freezes retained evidence", async () => {
    const a = fixture(), b = fixture(), issued = await a.planner.issue(input());
    if (issued.status !== "ready") throw new Error("issue");
    const plan = a.planner.inspect(issued.value)!;
    expect(Object.isFrozen(plan.facts[0])).toBe(true);
    const renderer = vi.fn(async () => audio());
    const serialized = JSON.parse(JSON.stringify(issued.value)) as CustomerSpeechAuthority;
    expect(await a.planner.render(serialized, renderer)).toMatchObject({ status: "held", reason: "authority_unknown" });
    expect(await b.planner.render(issued.value, renderer)).toMatchObject({ status: "held", reason: "authority_unknown" });
    expect(renderer).not.toHaveBeenCalled();
  });

  it("does not disclose text/start rendering after controller or facts were revoked since issue", async () => {
    const f = fixture(), issued = await f.planner.issue(input()), renderer = vi.fn(async () => audio());
    if (issued.status !== "ready") throw new Error("issue");
    f.revoke();
    expect(await f.planner.render(issued.value, renderer)).toEqual({ status: "held", reason: "stale" });
    expect(renderer).not.toHaveBeenCalled();
    expect(f.checks).toEqual(["issue", "before_render"]);
  });

  it.each(["expired", "cancelled"] as const)("does not render if %s occurs during before_render validation", async reason => {
    let now = 1000;
    const abort = new AbortController(), renderer = vi.fn(async () => audio());
    const planner = createCustomerSpeechPlanner({ now: () => now, signal: abort.signal,
      revalidate: async (_plan, stage) => {
        if (stage === "before_render") {
          await Promise.resolve();
          if (reason === "expired") now = 2000;
          else abort.abort();
        }
        return true;
      } });
    const issued = await planner.issue(input());
    if (issued.status !== "ready") throw new Error("issue");
    expect(await planner.render(issued.value, renderer)).toEqual({ status: "held", reason });
    expect(renderer).not.toHaveBeenCalled();
  });

  it("rejects a controller/facts change while rendering before it can reach a queue", async () => {
    const f = fixture(), issued = await f.planner.issue(input());
    if (issued.status !== "ready") throw new Error("issue");
    const result = await f.planner.render(issued.value, async () => { f.revoke(); return audio(); });
    expect(result).toEqual({ status: "held", reason: "stale" });
    expect(f.checks).toEqual(["issue", "before_render", "after_render"]);
  });

  it("revalidates after render and again immediately before queue ownership transfer", async () => {
    const f = fixture(), p = await prepared(f), enqueue = vi.fn(() => "queued" as const);
    f.revoke();
    expect(await f.planner.queue(p.rendered, enqueue)).toEqual({ status: "held", reason: "stale" });
    expect(enqueue).not.toHaveBeenCalled();
    expect(f.checks).toEqual(["issue", "before_render", "after_render", "before_queue"]);
  });

  it("retains the original deadline through asynchronous rendering/validation", async () => {
    const f = fixture(), issued = await f.planner.issue(input());
    if (issued.status !== "ready") throw new Error("issue");
    expect(await f.planner.render(issued.value, async () => { f.advance(); return audio(); }))
      .toEqual({ status: "held", reason: "expired" });
    const expired = await f.planner.issue(input());
    expect(expired).toEqual({ status: "held", reason: "expired" });
  });

  it("claims a rendered handle before awaiting validation so concurrent queue calls cannot duplicate audio", async () => {
    const f = fixture(), p = await prepared(f), enqueue = vi.fn(() => "queued" as const);
    const results = await Promise.all([f.planner.queue(p.rendered, enqueue), f.planner.queue(p.rendered, enqueue)]);
    expect(results.map(r => r.status).sort()).toEqual(["held", "queued"]);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await f.planner.queue({} as CustomerRenderedSpeech, enqueue)).toMatchObject({ status: "held", reason: "authority_unknown" });
  });

  it("tracks exact sample ranges without equating RTP acceptance, interruption or missing callbacks with human consent", async () => {
    const f = fixture(), p = await prepared(f);
    const result = await f.planner.queue(p.rendered, ({ frames, observation }) => {
      expect(frames.map(frame => [frame.startSample, frame.endSample])).toEqual([[0, 160], [160, 320], [320, 480]]);
      observation.record(0, "local_rtp_sent");
      observation.interruptFrom(1);
      observation.record(1, "local_rtp_sent"); // late socket completion retains the actual fact
      expect(observation.record(999, "local_rtp_sent")).toBe(false);
      return "queued";
    });
    if (result.status !== "queued") throw new Error("queue");
    expect(result.observation.snapshot().ranges).toEqual([
      { startSample: 0, endSample: 320, outcome: "local_rtp_sent" },
      { startSample: 320, endSample: 480, outcome: "interrupted" },
    ]);
    expect(result.observation.snapshot()).not.toHaveProperty("heard");
    expect(result.observation.snapshot()).not.toHaveProperty("consent");
  });

  it("retains partial queue facts and unknown suffix on queue exception without enabling a resend", async () => {
    const f = fixture(), p = await prepared(f);
    const result = await f.planner.queue(p.rendered, ({ observation }) => {
      observation.record(0, "local_rtp_sent"); throw new Error("adapter failed after a prefix");
    });
    expect(result.status).toBe("unknown");
    if (result.status !== "unknown") throw new Error("unknown");
    expect(result.observation.snapshot().ranges).toEqual([
      { startSample: 0, endSample: 160, outcome: "local_rtp_sent" },
      { startSample: 160, endSample: 480, outcome: "unknown" },
    ]);
    const retry = vi.fn(() => "queued" as const);
    expect(await f.planner.queue(p.rendered, retry)).toMatchObject({ status: "held", reason: "already_used" });
    expect(retry).not.toHaveBeenCalled();
  });

  it("copies rendered PCM before revalidation awaits and keeps ambiguous async queue results unknown", async () => {
    const pcm = Buffer.alloc(960, 1);
    const planner = createCustomerSpeechPlanner({ now: () => 1000, revalidate: async (_plan, stage) => {
      if (stage === "after_render") pcm.fill(9); // A retained renderer buffer changes during validation.
      return true;
    } });
    const issued = await planner.issue(input());
    if (issued.status !== "ready") throw new Error("issue");
    const rendered = await planner.render(issued.value, async () => ({ sampleRateHz: 8000, pcm16: pcm }));
    if (rendered.status !== "ready") throw new Error("render");
    const queued = await planner.queue(rendered.value, ({ frames }) => {
      expect(frames[0].pcm16[0]).toBe(1);
      return "queued";
    });
    expect(queued.status).toBe("queued");
    const f = fixture(), p = await prepared(f);
    // A malformed integration may return a thenable despite the sync port type.
    const asyncAdapter = (() => Promise.reject(new Error("late enqueue failure"))) as unknown as
      Parameters<typeof f.planner.queue>[1];
    expect((await f.planner.queue(p.rendered, asyncAdapter)).status).toBe("unknown");
    await Promise.resolve();
  });

  it("bounds audio and fails closed on validation errors/cancellation", async () => {
    const abort = new AbortController();
    const planner = createCustomerSpeechPlanner({ now: () => 1000, signal: abort.signal,
      revalidate: async () => { throw new Error("credential store unavailable"); } });
    expect(await planner.issue(input())).toMatchObject({ status: "held", reason: "validation_unavailable" });
    abort.abort();
    expect(await planner.issue(input())).toMatchObject({ status: "held", reason: "cancelled" });
    const f = fixture(), issued = await f.planner.issue(input());
    if (issued.status !== "ready") throw new Error("issue");
    expect(await f.planner.render(issued.value, async () => ({ sampleRateHz: 8000, pcm16: Buffer.alloc(1) })))
      .toMatchObject({ status: "held", reason: "invalid_audio" });
  });
});
