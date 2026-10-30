import { describe, expect, it, vi } from "vitest";
import { runCustomerAgentTurn, type CustomerAgentModelTurn, type CustomerCoreFrame, type CustomerCorePorts } from "../src/ai/customerAgentCore.js";
import { createProviderOperation } from "../src/ai/providerContract.js";
import { readCustomerAgentCompanyKnowledge } from "../src/lib/customerAgentPublicReads.js";
import { customerAgentCompanyKnowledgeHash } from "../src/ai/customerAgentPublicProtocol.js";
import { customerTextRole } from "../src/ai/customerAgentRole.js";

const hash = "a".repeat(64);
const knowledge = readCustomerAgentCompanyKnowledge(), sourceHash = customerAgentCompanyKnowledgeHash(knowledge);
const final = (change = {}): CustomerAgentModelTurn => ({ text: JSON.stringify({ kind: "reply", refs: [], social: "none", question: "none", ...change }), calls: [], modelParts: [] });
async function run(inputText: string, language: "ru" | "tg", topic: "rental" | "commission" | null, change = {}) {
  const controller = new AbortController();
  const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 8, signal: controller.signal,
    accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
  const frame: CustomerCoreFrame = { surface: "dm", language, inputText, knownPhoneSource: "none", requestedFacts: [],
    revision: { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash, knowledgeSchemaHash: hash, knowledgeSourceHash: sourceHash,
      providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
      limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } },
    startedAt: Date.now(), operation, tools: [{ name: "get_company_policy", description: "Read approved public company policy" }] };
  const modelTurn = vi.fn<CustomerCorePorts["modelTurn"]>();
  if (topic) modelTurn.mockResolvedValueOnce({ text: "", calls: [{ name: "get_company_policy", args: { topic }, id: "p1" }],
    modelParts: [{ functionCall: { name: "get_company_policy", args: { topic }, id: "p1" } }] });
  modelTurn.mockResolvedValueOnce(final(topic ? { refs: ["e0"], ...change } : change));
  const ports: CustomerCorePorts = { modelTurn,
    executeAllowedTool: async () => ({ status: "observed", observation: { kind: "company_policy", topic: topic!, knowledge, sourceHash } }),
    assertCurrent: async () => true, requestStop: reason => controller.abort(reason), observeLateToolResult: () => {} };
  return runCustomerAgentTurn(frame, ports);
}

describe("seller is not answered with an unasked rental refusal or commission (30.10.2026 live probes)", () => {
  it.each([
    ["у меня дом на продажу, фото скину", "ru", "rental"],
    ["у меня два объекта на продажу", "ru", "rental"],
    ["продам двушку 65 м 5 этаж 450000", "ru", "commission"],
    ["продам квартиру в новостройке, сколько получу на руки", "ru", "rental"],
    ["хонаи фуруши дорам", "tg", "rental"],
  ] as const)("%s -> seller_details, tagged for the trace", async (text, language, topic) => {
    const result = await run(text, language, topic, { question: "none" });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.decision).toMatchObject({ kind: "clarify", question: "seller_details", refs: [] });
    expect(result.fallbackReason).toBe("invalid_model_decision");
    expect(result.fallbackCause).toBe("repair:seller_policy_mismatch");
    expect(result.text).not.toMatch(/арендой не занимаемся|Комиссия для продавца/u);
  });
  it("a bare topic question to a TG seller becomes the seller intake", async () => {
    const result = await run("хонаи фуруши дорам", "tg", null, { question: "topic" });
    expect(result.status === "ready" && result.decision.kind === "clarify" && result.decision.question).toBe("seller_details");
  });
  it.each([
    ["сколько берёте с продавца, продам квартиру", "ru", "commission"],
    ["продам квартиру, какая комиссия?", "ru", "commission"],
    ["хонаи фуруши дорам, чанд фоиз мегиред", "tg", "commission"],
    ["сдам квартиру, сдаёте в аренду?", "ru", "rental"],
    ["хочу купить, аренда есть?", "ru", "rental"],
  ] as const)("keeps the model answer when the customer asked: %s", async (text, language, topic) => {
    const result = await run(text, language, topic, { question: "none" });
    expect(result.status === "ready" && result.fallbackCause).not.toBe("repair:seller_policy_mismatch");
    expect(result.status === "ready" && result.decision.kind).toBe("reply");
  });
  it.each([["сколько берёте с продавца, продам квартиру", "ru"], ["продам квартиру, сколько получу на руки", "ru"], ["хонаи фуруши дорам, чанд фоиз мегиред", "tg"]] as const)(
    "commission asked by a seller keeps the commission and adds seller_details: %s", async (text, language) => {
      const result = await run(text, language, "commission", { question: "none" });
      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      expect(result.decision).toMatchObject({ kind: "reply", question: "seller_details", refs: ["e0"] });
      expect(result.fallbackCause).toBe("repair:seller_commission_no_intake");
      expect(result.text).toMatch(/2\s*%/u);
    });
  it("recognises 'на продажу' as a seller", () => {
    expect(customerTextRole("у меня дом на продажу, фото скину", false)).toBe("seller");
    expect(customerTextRole("есть ли квартиры на продажу?", false)).not.toBe("seller");
  });
});
