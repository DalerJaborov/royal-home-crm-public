import { describe, expect, it, vi } from "vitest";
import { runCustomerAgentTurn, type CustomerCoreFrame, type CustomerCorePorts } from "../src/ai/customerAgentCore.js";
import { repairCustomerAgentDecision } from "../src/ai/customerAgentDecisionRepair.js";
import { createProviderOperation } from "../src/ai/providerContract.js";
import { customerSearchIntent, customerSearchPreRead } from "../src/ai/customerAgentSearchIntent.js";
import { customerAgentPublicListingSignature, customerAgentSearchFit } from "../src/ai/customerAgentPublicProtocol.js";

const hash = "a".repeat(64);
const facts = { propertyId: "00000000-0000-4000-8000-000000000001", shortId: 123, price: "620000", currency: "TJS" as const,
  availability: "AVAILABLE" as const, publicAddress: "Сино, Душанбе", addressPolicy: "district_city_only" as const, builder: null,
  characteristics: { type: "APARTMENT" as const, rooms: 2, areaSqm: null, landAreaSotka: null, floor: null, totalFloors: null, condition: null, marketType: null, stage: null },
  publicLink: null, updatedAt: "2026-10-15T00:00:00.000Z", signature: hash };
const call = customerSearchPreRead(customerSearchIntent("ищу двушку в Сино"))!;

function fixture() {
  const controller = new AbortController();
  const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 8, signal: controller.signal,
    accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
  const frame: CustomerCoreFrame = { surface: "dm", language: "ru", inputText: "ищу двушку в Сино", knownPhoneSource: "none", requestedFacts: [],
    revision: { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash, knowledgeSchemaHash: hash, knowledgeSourceHash: hash,
      providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
      limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } },
    startedAt: Date.now(), operation, tools: [{ name: "search_public_properties", description: "search" }], preReads: [call] };
  // The live failure: the model answers `propose` without a ref and never calls the search tool, round after round.
  const modelTurn = vi.fn<CustomerCorePorts["modelTurn"]>(async () => ({ text: JSON.stringify({ kind: "propose", social: "none" }), calls: [], modelParts: [] }));
  const executeAllowedTool = vi.fn<CustomerCorePorts["executeAllowedTool"]>(async () => ({ status: "denied", reason: "none" }));
  const ports: CustomerCorePorts = { modelTurn, executeAllowedTool, assertCurrent: async () => true, requestStop: r => controller.abort(r), observeLateToolResult: () => {} };
  return { frame, modelTurn, executeAllowedTool, ports };
}
const observation = (cards: unknown[]) => ({ status: "observed" as const, observation: { kind: "property_search" as const, query: call.args,
  coverage: "bounded_ranked_pool" as const, poolLimit: 500, policyHash: hash, cards: cards as never } });

describe("core: server pre-read of a buyer's search request", () => {
  it("a model that proposes nothing still delivers the cards the server already read", async () => {
    const data = { type: "APARTMENT" as const, rooms: 2, districtName: "Сино" };
    const listing = { ...data, signature: customerAgentPublicListingSignature(facts.signature, data) };
    const match = customerAgentSearchFit(call.args, listing, { cardTjs: 620000, minTjs: null, maxTjs: null });
    const f = fixture();
    f.executeAllowedTool.mockResolvedValue(observation([{ facts, listing, match }]));
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(f.executeAllowedTool).toHaveBeenCalledWith(call, expect.anything());
    expect(JSON.stringify(f.modelTurn.mock.calls[0][0].contents)).toContain("serverObservation");
    if (result.status !== "ready") throw new Error("expected a ready reply " + JSON.stringify(result).slice(0, 400));
    expect(result.fallbackCause).toBe("repair_propose_bare_to_search_reply");
    expect(result.text).toContain("620 000");
  });
  it("an empty ordinary search is not mistaken for 'nothing cheaper': the model still answers", async () => {
    const f = fixture();
    f.executeAllowedTool.mockResolvedValue(observation([]));
    f.modelTurn.mockResolvedValue({ text: JSON.stringify({ kind: "reply", refs: ["e0"], social: "none", question: "none" }), calls: [], modelParts: [] });
    await runCustomerAgentTurn(f.frame, f.ports);
    expect(f.modelTurn).toHaveBeenCalled();
  });
});

describe("repair: a bare propose next to exactly one search result", () => {
  const ctx = { surface: "dm" as const, knownRefs: ["e0"], searchRefs: ["e0"] };
  it("becomes a reply with that search ref", () => {
    expect(repairCustomerAgentDecision({ kind: "propose", social: "greet" }, ctx)?.decision).toEqual({ kind: "reply", refs: ["e0"], social: "greet", question: "none" });
  });
  it("keeps the old clarify when there is no search result, two of them, or the model named a question", () => {
    expect(repairCustomerAgentDecision({ kind: "propose", social: "none" }, { surface: "dm", knownRefs: [] })?.decision).toMatchObject({ kind: "clarify", question: "property" });
    expect(repairCustomerAgentDecision({ kind: "propose", social: "none" }, { ...ctx, knownRefs: ["e0", "e1"], searchRefs: ["e0", "e1"] })?.decision).toMatchObject({ kind: "clarify" });
    expect(repairCustomerAgentDecision({ kind: "propose", social: "none", question: "budget" }, ctx)?.decision).toMatchObject({ kind: "clarify", question: "budget" });
  });
});
