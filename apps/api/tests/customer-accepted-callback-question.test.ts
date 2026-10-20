import { describe, expect, it } from "vitest";
import { customerAgentDeliveryEvidenceSchema, type CustomerAgentDecision } from "@royal-home/shared";
import { customerCallbackConsentDecision, isCustomerCallbackAffirmative } from "../src/lib/customerCallbackConsent.js";
import { customerAgentRenderedQuestion, customerAgentCallbackQuestionText,
  renderCustomerAgentDecision } from "../src/ai/customerAgentRenderer.js";

const decision: CustomerAgentDecision = { kind: "reply", refs: [], social: "none", question: "callback_consent" };
const base = { version: 1, agentRevisionId: "a".repeat(64), knowledgeSourceHash: "b".repeat(64), linkPreference: "social", observations: [] };
describe("tiny affirmation is data until an actual accepted question is verified", () => {
  it("never changes the generic classifier into a yes-to-call grant", () => {
    for (const text of ["Да", "Ҳа", "ДА!", " Ҳа. "]) {
      expect(isCustomerCallbackAffirmative(text)).toBe(true);
      expect(customerCallbackConsentDecision(text)).toBe("none");
    }
  });
  it("rejects reported, negated, ambiguous and unrelated affirmatives", () => {
    for (const text of ["Да?", "Нет", "Да, но не звоните", "Не надо", "Он сказал: да", "«Да»", '"Ҳа"', "Ҳа не", "👍", "да\nпозже"]) {
      expect(isCustomerCallbackAffirmative(text), text).toBe(false);
    }
    expect(customerCallbackConsentDecision("Не звоните мне")).toBe("cancelled");
    expect(customerCallbackConsentDecision("занг назанед")).toBe("cancelled");
  });
  it("allows question-only encrypted evidence, never an empty sideband", () => {
    expect(customerAgentDeliveryEvidenceSchema.safeParse(base).success).toBe(false);
    expect(customerAgentDeliveryEvidenceSchema.safeParse({ ...base,
      callbackQuestion: { version: 1, kind: "callback_consent", language: "ru" } }).success).toBe(true);
    expect(customerAgentDeliveryEvidenceSchema.safeParse({ ...base,
      callbackQuestion: { version: 1, kind: "phone", language: "ru" } }).success).toBe(false);
  });
  it("uses actual server renderer effective question in both languages", () => {
    for (const language of ["ru", "tg"] as const) {
      const input = { decision, evidence: [], language, requestedFacts: [], knownPhoneSource: "none" as const,
        maxOutputChars: 1200, surface: "dm" as const };
      expect(customerAgentRenderedQuestion(input)).toBe("callback_consent");
      expect(renderCustomerAgentDecision(input)).toBe(customerAgentCallbackQuestionText(language));
    }
  });
  it("does not witness the model question when the actual renderer suppresses it", () => {
    expect(customerAgentRenderedQuestion({ decision, evidence: [], surface: "public_comment", knownPhoneSource: "none" })).toBe("none");
    expect(customerAgentRenderedQuestion({ decision: { ...decision, refs: ["e0"] },
      evidence: [{ ref: "e0", value: { kind: "property_unresolved", status: "ambiguous" } }],
      surface: "dm", knownPhoneSource: "none" })).toBe("property");
  });
});
