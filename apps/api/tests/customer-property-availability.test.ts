import { describe, expect, it } from "vitest";
import { customerAgentToolCallSchema, customerAgentPublicationObservationSchema } from "@royal-home/shared";
import { classifyCustomerPropertyFactIntent } from "../src/lib/customerPropertyFactIntent.js";
import { renderCustomerAgentDecision } from "../src/ai/customerAgentRenderer.js";
import { renderCustomerPropertyFacts } from "../src/lib/customerPropertyFacts.js";

const facts = { propertyId: "00000000-0000-4000-8000-000000000001", shortId: 123, price: "123456", currency: "TJS" as const,
  availability: "AVAILABLE" as const, publicAddress: "Synthetic district", addressPolicy: "district_city_only" as const,
  builder: null, publicLink: null, updatedAt: "2026-10-21T00:00:00.000Z", signature: "a".repeat(64) };

describe("Verified property availability questions", () => {
  it.each(["Квартира ещё есть?", "Объект №123 доступен?", "Эта квартира не продана?", "Салом хона Холо хам хаст", "Ин хона ҳоло ҳам ҳаст?"])("recognizes a direct availability request: %s", input => {
    expect(classifyCustomerPropertyFactIntent(input)).toEqual(["availability"]);
  });
  it.each(["Есть вакансии?", "Квартира ещё есть? Позвоните завтра", "Квартира есть, хочу продать", "Ҳоло ҳам ҳаст, хонаамро фурӯхтан мехоҳам"])("retains mixed or unrelated intent: %s", input => {
    expect(classifyCustomerPropertyFactIntent(input)).toBeNull();
  });
  it("accepts availability only as a declared, strictly validated read kind", () => {
    expect(customerAgentToolCallSchema.safeParse({ name: "get_property_facts", args: { kinds: ["availability"] } }).success).toBe(true);
    expect(customerAgentToolCallSchema.safeParse({ name: "get_property_facts", args: { kinds: ["availability"], propertyId: facts.propertyId } }).success).toBe(false);
    expect(customerAgentToolCallSchema.safeParse({ name: "get_property_facts", args: { kinds: ["private_owner"] } }).success).toBe(false);
  });
  it.each(["ru", "tg"] as const)("renders verified available/reserved states in %s, without phone or unrelated card details", language => {
    for (const availability of ["AVAILABLE", "RESERVED"] as const) {
      const current = { ...facts, availability };
      const input = { decision: { kind: "reply" as const, refs: ["e0"], social: "none" as const, question: "none" as const },
        evidence: [{ ref: "e0", value: { kind: "facts" as const, facts: current, kinds: ["availability" as const] } }],
        language, requestedFacts: ["availability" as const], knownPhoneSource: "none" as const, maxOutputChars: 1000, surface: "dm" as const };
      const expected = availability === "RESERVED" ? language === "tg" ? "Объекти №123 ҳоло дар брон аст." : "Объект №123 сейчас в брони."
        : language === "tg" ? "Бале, объекти №123 ҳоло дастрас аст." : "Да, объект №123 ещё доступен.";
      expect(renderCustomerAgentDecision(input)).toBe(expected);
      expect(renderCustomerPropertyFacts(current, ["availability"], language)).toBe(expected);
    }
  });
  it("allows a public publication's verified availability observation through the same contract", () => {
    expect(customerAgentPublicationObservationSchema.safeParse({ kind: "publication_properties",
      source: { channel: "INSTAGRAM", resourceId: "synthetic-resource", publicationId: "synthetic-publication" },
      mappingSignature: "b".repeat(64), kinds: ["availability"], cards: [facts] }).success).toBe(true);
  });
  it("never claims availability if the property is unresolved", () => {
    const reply = renderCustomerAgentDecision({ decision: { kind: "clarify", refs: ["e0"], social: "none", question: "property" },
      evidence: [{ ref: "e0", value: { kind: "property_unresolved", status: "missing" } }], language: "tg", inputText: "Салом хона Холо хам хаст",
      requestedFacts: ["availability"], knownPhoneSource: "none", maxOutputChars: 1000, surface: "dm" });
    expect(reply).toContain("?"); expect(reply).not.toMatch(/дастрас|123|992/u);
  });
});
