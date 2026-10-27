import { describe, expect, it, vi } from "vitest";
import { customerAgentDecisionSchema, type CustomerAgentApprovedFileState } from "@royal-home/shared";
import { runCustomerAgentTurn, type CustomerCoreFrame, type CustomerCorePorts } from "../src/ai/customerAgentCore.js";
import { renderCustomerAgentDecision, customerBuyerGuideFollowText, customerAgentRenderedQuestion } from "../src/ai/customerAgentRenderer.js";
import { createProviderOperation } from "../src/ai/providerContract.js";

const decision = { kind: "reply" as const, refs: [], social: "none" as const, question: "none" as const, attachment: "buyer_guide" as const };
const base = { decision, evidence: [], language: "ru" as const, surface: "dm" as const, requestedFacts: [], knownPhoneSource: "none" as const, maxOutputChars: 2000 };
const hash = "a".repeat(64);
const revision = { id: hash, coreHash: hash, rendererHash: hash, modelSchemaHash: hash, toolSchemaHash: hash,
  knowledgeSchemaHash: hash, knowledgeSourceHash: hash, providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
  limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } };

function fixture(state?: CustomerAgentApprovedFileState) {
  const controller = new AbortController();
  const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 3,
    signal: controller.signal, accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
  const frame: CustomerCoreFrame = { surface: "dm", language: "ru", inputText: "Что проверить перед покупкой квартиры?",
    approvedFileState: state, knownPhoneSource: "none", requestedFacts: [], revision, startedAt: Date.now(), operation, tools: [] };
  const modelTurn = vi.fn<CustomerCorePorts["modelTurn"]>(async () => ({ text: JSON.stringify(decision), calls: [], modelParts: [] }));
  const executeAllowedTool = vi.fn<CustomerCorePorts["executeAllowedTool"]>(async () => ({ status: "denied", reason: "no_tools" }));
  const ports: CustomerCorePorts = { modelTurn, executeAllowedTool, assertCurrent: async () => true,
    requestStop: reason => controller.abort(reason), observeLateToolResult: () => {} };
  return { frame, ports, modelTurn, executeAllowedTool };
}

describe("approved buyer guide is a closed suggestion, not a file grant", () => {
  it("accepts only one closed guide suggestion on reply, never model URLs or assets", () => {
    expect(customerAgentDecisionSchema.safeParse(decision).success).toBe(true);
    for (const change of [{ attachment: "private_contract" }, { attachment: ["buyer_guide"] },
      { url: "https://external.example/file.pdf" }, { campaignId: "synthetic" }, { kind: "propose", ref: "e0" }]) {
      expect(customerAgentDecisionSchema.safeParse({ ...decision, ...change }).success).toBe(false);
    }
  });

  it.each(["ru", "tg"] as const)("uses a neutral caption without a false sent claim in %s", language => {
    const text = renderCustomerAgentDecision({ ...base, language, approvedFileState: "available" });
    expect(text).toBe(language === "ru" ? "Памятка по покупке квартиры." : "Ёддошт барои харидани манзил.");
    expect(text).not.toMatch(/отправил|отправлен|доставлен|фиристодам/iu);
  });

  it("does not invent file state from a model suggestion alone", () => {
    expect(renderCustomerAgentDecision(base)).toBeNull();
  });
  it.each(["unavailable", "awaiting_follow", "pending_delivery", "already_sent"] as const)("answers the verified guide status without a new send when state is %s", approvedFileState => {
    const text = renderCustomerAgentDecision({ ...base, approvedFileState });
    expect(text).toBeTruthy();
    if (approvedFileState !== "already_sent") expect(text).not.toMatch(/уже отправлена|фиристода шудааст/iu);
  });

  it("keeps one follow instruction and never records an unasked phone question", () => {
    const input = { ...base, decision: { ...decision, question: "phone" as const }, approvedFileState: "needs_follow" as const };
    expect(renderCustomerAgentDecision(input)).toBe(customerBuyerGuideFollowText("ru"));
    expect(customerAgentRenderedQuestion(input)).toBe("none");
  });

  it("preserves an actual receipt while preparing the guide", () => {
    const text = renderCustomerAgentDecision({ ...base, approvedFileState: "available", decision: { ...decision, refs: ["e0"] },
      evidence: [{ ref: "e0", value: { kind: "receipt", outcome: "contact_saved" } }] });
    expect(text).toContain("Памятка по покупке квартиры.");
    expect(text).toMatch(/Контакт|контакт/u);
  });

  it("does not offer a guide from a public comment or replace a proposal confirmation", () => {
    expect(renderCustomerAgentDecision({ ...base, surface: "public_comment", approvedFileState: "available" })).toBeNull();
    const text = renderCustomerAgentDecision({ ...base, approvedFileState: "available",
      decision: { kind: "propose", ref: "e0", social: "none" },
      evidence: [{ ref: "e0", value: { kind: "proposal", summary: { ru: "Записать контакт.", tg: "Тамосро сабт кунед." } } }] });
    expect(text).toBe("Записать контакт.\nПодтверждаете?");
  });

  it("exposes only closed server state to the model and returns a draft without any delivery or tool", async () => {
    const f = fixture("available");
    const result = await runCustomerAgentTurn(f.frame, f.ports);
    expect(result).toMatchObject({ status: "ready", decision, rounds: 1, toolCalls: 0 });
    const modelInput = JSON.stringify(f.modelTurn.mock.calls[0][0]);
    expect(modelInput).toContain('serverApprovedFileState');
    expect(modelInput).not.toContain('campaignId');
    expect(modelInput).not.toContain('/uploads/');
    expect(f.executeAllowedTool).not.toHaveBeenCalled();
  });

  it("answers an unavailable suggestion honestly without executing any action", async () => {
    const f = fixture("unavailable");
    expect(await runCustomerAgentTurn(f.frame, f.ports)).toMatchObject({ status: "ready", text: "Сейчас не могу отправить памятку.", toolCalls: 0 });
    expect(f.executeAllowedTool).not.toHaveBeenCalled();
  });
});
