import { describe, expect, it } from "vitest";
import { customerAgentDecisionSchema } from "@royal-home/shared";
import { repairCustomerAgentDecision } from "../src/ai/customerAgentDecisionRepair.js";
import { runCustomerAgentTurn, type CustomerAgentModelTurn, type CustomerCoreFrame, type CustomerCorePorts } from "../src/ai/customerAgentCore.js";
import { createProviderOperation } from "../src/ai/providerContract.js";

const dm = { surface: "dm" as const, knownRefs: ["e0", "e1"] };
const fixed = (raw: unknown, ctx = dm) => {
  const r = repairCustomerAgentDecision(raw, ctx);
  expect(r).not.toBeNull();
  expect(customerAgentDecisionSchema.safeParse(r!.decision).success).toBe(true);
  return r!;
};

describe("repairCustomerAgentDecision", () => {
  it("propose with question and no ref becomes clarify, keeping social", () => {
    const r = fixed({ kind: "propose", question: "budget", social: "greet" });
    expect(r.decision).toEqual({ kind: "clarify", refs: [], question: "budget", social: "greet" });
    expect(r.repairs[0]).toBe("propose_question_to_clarify");
  });
  it("propose with neither ref nor question asks which property (dm only)", () => {
    expect(fixed({ kind: "propose", social: "none" }).decision).toMatchObject({ kind: "clarify", question: "property" });
    expect(repairCustomerAgentDecision({ kind: "propose", social: "none" }, { surface: "public_comment", knownRefs: [] })).toBeNull();
  });
  it("propose with an unknown ref is not trusted", () => {
    expect(fixed({ kind: "propose", ref: "e9", question: "location", social: "none" }).decision).toMatchObject({ kind: "clarify", question: "location", refs: [] });
  });
  it("reply drops unknown refs and falls to clarify when none remain", () => {
    expect(fixed({ kind: "reply", refs: ["e0", "e7"], social: "none", question: "none" }).decision).toMatchObject({ kind: "reply", refs: ["e0"] });
    expect(fixed({ kind: "reply", refs: ["e7"], social: "none", question: "rooms" }).decision).toMatchObject({ kind: "clarify", question: "rooms", refs: [] });
    expect(fixed({ kind: "reply", refs: ["e7"], social: "none", question: "none" }).decision).toMatchObject({ kind: "clarify", question: "clarify_previous" });
    expect(fixed({ kind: "reply", refs: [], social: "thank", question: "none", note: "x" }).decision).toEqual({ kind: "reply", refs: [], social: "thank", question: "none" });
  });
  it("strips extra top-level fields and normalizes kind", () => {
    expect(fixed({ kind: " Reply ", refs: ["e1"], social: "thank", question: "none", confidence: 0.9 }).decision).toEqual({ kind: "reply", refs: ["e1"], social: "thank", question: "none" });
  });
  it("clarify with question none is defaulted", () => {
    expect(fixed({ kind: "clarify", refs: [], social: "none", question: "none" }).decision).toMatchObject({ question: "clarify_previous" });
  });
  it("leaves valid decisions and junk alone", () => {
    expect(repairCustomerAgentDecision({ kind: "reply", refs: ["e0"], social: "none", question: "none" }, dm)).toBeNull();
    expect(repairCustomerAgentDecision("text", dm)).toBeNull();
    expect(repairCustomerAgentDecision({ kind: "nope" }, dm)).toBeNull();
  });
});

describe("core: malformed propose is repaired without a second model round", () => {
  const hash = "a".repeat(64);
  it("a model that repeats the wrong shape after the correction round still reaches the customer (repair is the last resort)", async () => {
    const controller = new AbortController();
    const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 8, signal: controller.signal,
      accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
    const frame: CustomerCoreFrame = { surface: "dm", language: "ru", inputText: "здравствуйте, хочу квартиру", knownPhoneSource: "none", requestedFacts: [],
      revision: { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash, knowledgeSchemaHash: hash, knowledgeSourceHash: hash,
        providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
        limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } },
      startedAt: Date.now(), operation, tools: [{ name: "get_property_facts", description: "Read public facts" }] };
    const modelTurn = async (): Promise<CustomerAgentModelTurn> => ({ text: JSON.stringify({ kind: "propose", question: "budget", social: "greet" }), calls: [], modelParts: [] });
    let calls = 0;
    const ports: CustomerCorePorts = { modelTurn: async (...a) => { calls++; return modelTurn(); }, executeAllowedTool: async () => ({ status: "failed" } as never),
      assertCurrent: async () => true, requestStop: r => controller.abort(r), observeLateToolResult: () => {} };
    const result = await runCustomerAgentTurn(frame, ports);
    // The correction round comes first (the model may go on to search); the server repair only replaces a held turn.
    expect(calls).toBe(2);
    expect(result).toMatchObject({ status: "ready", rounds: 2, fallbackReason: "invalid_model_decision", fallbackCause: "repair_propose_question_to_clarify",
      decision: { kind: "clarify", question: "budget", social: "greet" } });
    if (result.status === "ready") expect(result.text.length).toBeGreaterThan(0);
  });
});
