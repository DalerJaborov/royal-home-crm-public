import { describe, expect, it, vi } from "vitest";
import type { CustomerAgentVerifiedContext } from "@royal-home/shared";
import { runCustomerAgentTurn, type CustomerAgentModelTurn, type CustomerCoreFrame, type CustomerCorePorts } from "../src/ai/customerAgentCore.js";
import { customerSellerAskedTerms, guardSellerDecision, SELLER_TERMS_UNANSWERED_CAUSE } from "../src/ai/customerAgentSellerGuard.js";
import { createProviderOperation } from "../src/ai/providerContract.js";
import { readCustomerAgentCompanyKnowledge } from "../src/lib/customerAgentPublicReads.js";
import { customerAgentCompanyKnowledgeHash } from "../src/ai/customerAgentPublicProtocol.js";

/**
 * Facebook 16.11.2026 17:44 (live). A seller wrote «Мехоҳам хонаамро фурӯшам» four times. The bot asked for an object number,
 * then «амвол ё кор?», demanded a phone without answering «Чи шарту шароит доред», then said «Фаҳмидам.» twice; the client left.
 * Expected: the seller is understood in Tajik and the terms question gets the agency's terms (2% seller, 0% buyer).
 */
const hash = "a".repeat(64);
const knowledge = readCustomerAgentCompanyKnowledge(), knowledgeSourceHash = customerAgentCompanyKnowledgeHash(knowledge);
const SELL = "Мехоҳам хонаамро фурӯшам", TERMS = "Чи шарту шароит доред";
const history = (): CustomerAgentVerifiedContext => ({ surface: "dm", revisionId: hash, publicState: { topic: "unknown" } as never,
  turns: [{ role: "user", text: SELL }, { role: "assistant", text: "Рақами объект ё пайвандашро фиристед." }, { role: "user", text: SELL },
    { role: "assistant", text: "Шумо дар бораи амвол маълумот мехоҳед ё дар бораи кор?" }, { role: "user", text: SELL }, { role: "assistant", text: "Фаҳмидам." }] });

describe("Facebook 16.11 17:44: a Tajik seller asks for the terms", () => {
  it("the seller and the terms question are understood (Tajik and Russian), never a mortgage, rent or job", () => {
    expect(customerSellerAskedTerms({ inputText: TERMS, verifiedContext: history() })).toBe(true);
    expect(customerSellerAskedTerms({ inputText: `${SELL}. ${TERMS}?` })).toBe(true);
    expect(customerSellerAskedTerms({ inputText: "Продаю квартиру. Какие у вас условия?" })).toBe(true);
    expect(customerSellerAskedTerms({ inputText: TERMS })).toBe(false);
    expect(customerSellerAskedTerms({ inputText: "Хочу купить квартиру. Какие у вас условия?" })).toBe(false);
    expect(customerSellerAskedTerms({ inputText: "Продаю квартиру. Какие условия ипотеки?" })).toBe(false);
    expect(customerSellerAskedTerms({ inputText: "Шартҳои кор чӣ гуна аст? Ваканси доред?", verifiedContext: history() })).toBe(false);
  });
  it("the seller guard keeps the commission as the answer instead of the phone demand", () => {
    const evidence = [{ ref: "e0", value: { kind: "company_policy", topic: "commission" } }];
    for (const decision of [{ kind: "clarify", refs: [], social: "none", question: "phone" }, { kind: "reply", refs: [], social: "acknowledge", question: "none" },
      { kind: "clarify", refs: [], social: "none", question: "topic" }]) {
      expect(guardSellerDecision({ decision: decision as never, evidence, surface: "dm", inputText: TERMS, verifiedContext: history() })).toEqual({
        cause: SELLER_TERMS_UNANSWERED_CAUSE, decision: { kind: "reply", refs: ["e0"], social: decision.social, question: "seller_details" } });
    }
    // Before: the commission the model DID choose was thrown away as «a commission nobody asked about».
    expect(guardSellerDecision({ decision: { kind: "reply", refs: ["e0"], social: "none", question: "none" } as never, evidence, surface: "dm",
      inputText: TERMS, verifiedContext: history() })?.decision).toEqual({ kind: "reply", refs: ["e0"], social: "none", question: "seller_details" });
  });
  it("the whole turn: the server reads the commission itself and the customer reads 2% / 0% in Tajik even when the model asks for a phone", async () => {
    const controller = new AbortController();
    const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 30_000, maxAttempts: 8, signal: controller.signal,
      accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
    const frame: CustomerCoreFrame = { surface: "dm", language: "tg", inputText: TERMS, knownPhoneSource: "none", requestedFacts: [],
      revision: { id: hash, coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash, knowledgeSchemaHash: hash, knowledgeSourceHash,
        providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
        limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 40_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 30_000 } },
      startedAt: Date.now(), operation, verifiedContext: history(),
      tools: [{ name: "get_company_policy", description: "Policy" }, { name: "get_agency_contact", description: "Contact" }] };
    const final: CustomerAgentModelTurn = { text: JSON.stringify({ kind: "clarify", refs: [], social: "acknowledge", question: "phone" }), calls: [], modelParts: [] };
    const modelTurn = vi.fn<CustomerCorePorts["modelTurn"]>(async () => final);
    const executeAllowedTool = vi.fn<CustomerCorePorts["executeAllowedTool"]>(async () => ({ status: "observed",
      observation: { kind: "company_policy", topic: "commission", knowledge, sourceHash: knowledgeSourceHash } }));
    const result = await runCustomerAgentTurn(frame, { modelTurn, executeAllowedTool, assertCurrent: vi.fn(async () => true),
      requestStop: vi.fn((reason: "deadline" | "cancelled") => controller.abort(reason)), observeLateToolResult: vi.fn() });
    expect(executeAllowedTool.mock.calls[0]?.[0]).toMatchObject({ name: "get_company_policy", args: { topic: "commission" } });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.text).toContain(`барои фурӯшанда ${knowledge.commission.sellerPercent}%, барои харидор ${knowledge.commission.buyerPercent}%`);
    expect([knowledge.commission.sellerPercent, knowledge.commission.buyerPercent]).toEqual([2, 0]);
    expect(result.text).not.toMatch(/Рақами телефон|Фаҳмидам\.$/u);
    expect(result.fallbackCause).toBe("repair_seller_terms_unanswered");
  });
});
