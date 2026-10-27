import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { botTurnTracePayloadSchema, type BotTurnTracePayload } from "@royal-home/shared";
import { withBotTurnTrace, traceModelStart, traceModelFinish, traceCustomerCoreResult,
  traceCustomerCoreDisposition, traceCustomerManagedBinding, traceCustomerManagedDelivery, traceFilterDelta,
  traceObserveSend, traceProviderAccepted } from "../src/lib/botTurnTrace.js";
import { tracePseudonym } from "../src/lib/botTurnTracePrivacy.js";

const secret = "synthetic-customer-core-trace-secret-only-0000";
const revisionId = "b".repeat(64), operationId = randomUUID();
function recorder() {
  const rows: BotTurnTracePayload[] = [];
  return { rows, config: { enabled: true, text: true, secret, write: (row: BotTurnTracePayload) => { rows.push(row); } } };
}
const start = { channel: "INSTAGRAM", account: "synthetic-exact-scope", peer: "synthetic-peer",
  conversation: "synthetic-native", event: "synthetic-original-event", text: "PRIVATE_USER_TEXT +992 93 123 45 67" };

describe("metadata-only managed core trace, prepared source", () => {
  it("records exact finite protocol cause and verified fallback without raw content", async () => {
    const f=recorder();
    await withBotTurnTrace({...start,managed:{surface:"public_comment",phase:"planning"}},async()=>{
      traceCustomerCoreResult({status:"ready",decision:{kind:"reply"},rounds:3,toolCalls:2,evidence:[],fallbackReason:"invalid_model_decision"});
    },f.config);
    expect(f.rows.at(-1)?.customerCore).toMatchObject({decisionSource:"verified_public_fallback",protocolReason:"invalid_model_decision"});
    expect(JSON.stringify(f.rows)).not.toContain("PRIVATE_USER_TEXT");
  });
  it.each([null, "", "bad\nmid"])("managed provider response without a valid MID (%j) remains unknown in the physical trace", async mid => {
    const f = recorder();
    await withBotTurnTrace({ ...start, managed: { surface: "dm", phase: "delivery" } }, async () => {
      await traceObserveSend("text", "PRIVATE_CUSTOMER_TEXT", "bot", async () => { traceProviderAccepted(mid); });
      traceCustomerManagedDelivery({ status: "unknown" });
    }, f.config);
    expect(f.rows.at(-1)?.outgoing[0]).toMatchObject({ providerOutcome: "unknown", midKey: null });
    expect(f.rows.at(-1)?.managedDelivery?.status).toBe("unknown");
    expect(JSON.stringify(f.rows)).not.toContain("PRIVATE_CUSTOMER_TEXT");
  });
  it("retains old legacy acceptance projection without a managed context", async () => {
    const f = recorder();
    await withBotTurnTrace(start, () => traceObserveSend("text", "legacy text", "bot", async () => { traceProviderAccepted(null); }), f.config);
    expect(f.rows.at(-1)?.outgoing[0].providerOutcome).toBe("accepted");
  });
  it("keeps legacy two-argument lead-qualify start and payloads without new fields compatible", async () => {
    const f = recorder();
    await withBotTurnTrace(start, async () => { const id = traceModelStart("synthetic-model", null); traceModelFinish(id, "empty", performance.now()); }, f.config);
    const last = f.rows.at(-1)!;
    expect(last.coverage).toBe("meta_website_customer_bot_v1"); expect(last.managed).toBeUndefined();
    expect(last.modelAttempts[0]).toMatchObject({ endpoint: "lead-qualify", cacheUsed: null, outcome: "empty" });
    expect(botTurnTracePayloadSchema.safeParse(last).success).toBe(true);
  });
  it("records original HMAC operation and validated summary but no model/user/tool/receipt text or IDs", async () => {
    const f = recorder(), resource = randomUUID(), key = "PRIVATE_PROVIDER_KEY";
    await withBotTurnTrace({ ...start, managed: { surface: "dm", phase: "planning" } }, async () => {
      traceCustomerManagedBinding({ revisionId, operationId });
      const result = { status: "ready" as const, decision: { kind: "reply", refs: ["e0"], rawText: key }, rounds: 2, toolCalls: 1,
        text: "PRIVATE_MODEL_TEXT", evidence: [{ value: { kind: "receipt", outcome: "callback_requested", resourceId: resource,
          rawPhone: "+992931234567", privateArgs: key } }] };
      traceCustomerCoreResult(result);
      traceFilterDelta("reply_chain", "PRIVATE_BEFORE_TEXT", "PRIVATE_AFTER_TEXT");
      traceCustomerCoreDisposition("planned");
    }, f.config);
    const last = f.rows.at(-1)!, serialized = JSON.stringify(f.rows);
    expect(last.managed).toEqual({ surface: "dm", phase: "planning", revisionId,
      operationKey: tracePseudonym(secret, "operation", start.channel, start.account, operationId) });
    expect(last.customerCore).toEqual({ status: "planned", decisionKind: "reply", decisionSource: "model", rounds: 2, toolCalls: 1, receiptOutcomes: ["callback_requested"] });
    expect(last.outgoing).toEqual([]); // PLANNED is not SENT.
    for (const value of ["PRIVATE_USER_TEXT", "PRIVATE_MODEL_TEXT", key, resource, operationId, "+992", "rawPhone", "privateArgs"]) expect(serialized).not.toContain(value);
    expect(botTurnTracePayloadSchema.safeParse(last).success).toBe(true);
  });
  it("a deterministic social reply does not claim a model generation in the trace", async () => {
    const f = recorder();
    await withBotTurnTrace({ ...start, managed: { surface: "public_comment", phase: "planning" } }, async () => {
      traceCustomerCoreResult({ status: "ready", decision: { kind: "reply" }, rounds: 0, toolCalls: 0, evidence: [] });
    }, f.config);
    expect(f.rows.at(-1)?.customerCore).toMatchObject({ status: "ready", decisionKind: "reply", rounds: 0, toolCalls: 0 });
    expect(f.rows.at(-1)?.customerCore?.decisionSource).toBeUndefined();
    expect(botTurnTracePayloadSchema.safeParse(f.rows.at(-1)).success).toBe(true);
  });
  it("uses finite reasons and unique receipt outcomes, never arbitrary exception text", async () => {
    const f = recorder();
    await withBotTurnTrace({ ...start, managed: { surface: "dm", phase: "planning" } }, async () => {
      traceCustomerCoreResult({ status: "held", rounds: 8, toolCalls: 16,
        reason: "PRIVATE ERROR +992931234567 Bearer PRIVATE", evidence: [
          ...Array.from({ length: 12 }, () => ({ value: { kind: "receipt", outcome: "contact_saved" } })),
          { value: { kind: "receipt", outcome: "callback_requested" } },
        ] });
    }, f.config);
    expect(f.rows.at(-1)?.customerCore).toMatchObject({ heldReason: "other", receiptOutcomes: ["contact_saved", "callback_requested"] });
    expect(JSON.stringify(f.rows)).not.toMatch(/PRIVATE|992931234567|Bearer/);
    expect(botTurnTracePayloadSchema.safeParse({ ...f.rows.at(-1), customerCore: { ...f.rows.at(-1)!.customerCore,
      rawToolArguments: "PRIVATE" } }).success).toBe(false);
  });
  it("keeps physical delivery a separate record with the same original operation, not a resumed closed planning ALS", async () => {
    const f = recorder();
    await withBotTurnTrace({ ...start, managed: { surface: "dm", phase: "planning", revisionId, operationId } }, async () => {
      traceCustomerCoreDisposition("planned");
      await withBotTurnTrace({ ...start, managed: { surface: "dm", phase: "delivery", revisionId, operationId } }, async () => {
        traceCustomerManagedDelivery({ status: "unknown" });
      }, f.config);
    }, f.config);
    const finals = f.rows.filter(row => row.completedAt);
    expect(finals).toHaveLength(2); expect(finals[0].traceId).not.toBe(finals[1].traceId);
    expect(finals[0].eventKey).toBe(finals[1].eventKey);
    expect(finals[0].managed?.operationKey).toBe(finals[1].managed?.operationKey);
    expect(finals.find(row => row.managed?.phase === "planning")?.managedDelivery).toBeUndefined();
    expect(finals.find(row => row.managed?.phase === "delivery")?.managedDelivery).toEqual({ status: "unknown", projectionPending: false });
  });
});

describe("customer core trace carries a SAFE cause code (23.10)", () => {
  const managed = { ...start, managed: { surface: "dm" as const, phase: "planning" as const } };
  it("keeps the exact deadline / error-class cause on a held turn while the bucket stays finite", async () => {
    const f = recorder();
    await withBotTurnTrace(managed, async () => {
      traceCustomerCoreResult({ status: "held", reason: "turn_deadline", cause: "turn_deadline", rounds: 1, toolCalls: 0, evidence: [] });
    }, f.config);
    expect(f.rows.at(-1)?.customerCore).toMatchObject({ status: "held", heldReason: "operation_stopped", causeCode: "turn_deadline" });
    const g = recorder();
    await withBotTurnTrace(managed, async () => {
      traceCustomerCoreResult({ status: "held", reason: "turn_unavailable", cause: "TypeError", rounds: 0, toolCalls: 0, evidence: [] });
      traceCustomerCoreDisposition("held", "turn_unavailable", "TypeError");
    }, g.config);
    expect(g.rows.at(-1)?.customerCore).toMatchObject({ heldReason: "other", causeCode: "TypeError" });
  });
  it("an adapter-level failure (customer_core_unavailable) gets its cause through the disposition", async () => {
    const f = recorder();
    await withBotTurnTrace(managed, async () => { traceCustomerCoreDisposition("held", "customer_core_unavailable", "PrismaClientKnownRequestError"); }, f.config);
    expect(f.rows.at(-1)?.customerCore).toMatchObject({ status: "held", causeCode: "PrismaClientKnownRequestError" });
  });
  it("a malformed cause is dropped without losing the trace, and no text can pass", async () => {
    const f = recorder();
    await withBotTurnTrace(managed, async () => {
      traceCustomerCoreResult({ status: "held", reason: "turn_unavailable", cause: "Bearer sk-secret leaked +992931234567", rounds: 0, toolCalls: 0, evidence: [] });
    }, f.config);
    expect(f.rows.at(-1)?.customerCore).toMatchObject({ status: "held", heldReason: "other" });
    expect(f.rows.at(-1)?.customerCore?.causeCode).toBeUndefined();
    expect(JSON.stringify(f.rows)).not.toContain("sk-secret");
  });
  it("a receipt confirmation is recorded as its own decision source with the reason it replaced", async () => {
    const f = recorder();
    await withBotTurnTrace(managed, async () => {
      traceCustomerCoreResult({ status: "ready", decision: { kind: "reply" }, rounds: 3, toolCalls: 3,
        evidence: [{ value: { kind: "receipt", outcome: "callback_requested" } }], fallbackReason: "receipt_confirmation", fallbackCause: "round_limit" });
    }, f.config);
    expect(f.rows.at(-1)?.customerCore).toMatchObject({ status: "ready", decisionSource: "receipt_confirmation", causeCode: "round_limit", receiptOutcomes: ["callback_requested"] });
    expect(f.rows.at(-1)?.customerCore?.protocolReason).toBeUndefined();
  });
});
