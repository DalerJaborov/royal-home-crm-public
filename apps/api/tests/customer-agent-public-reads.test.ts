import { describe, expect, it } from "vitest";
import { AGENCY_FACTS } from "../src/ai/agencyFacts.js";
import { readCustomerAgentCompanyKnowledge } from "../src/lib/customerAgentPublicReads.js";
import { customerAgentCompanyKnowledgeHash, customerAgentPublicListingSignature, customerAgentSearchFit,
  isPinnedCompanyPolicy, isPublicPropertySearch, publicSearchProjection, type CustomerAgentSearchObservation } from "../src/ai/customerAgentPublicProtocol.js";
import { renderCustomerAgentDecision } from "../src/ai/customerAgentRenderer.js";
import { customerAgentPropertySearchCallSchema, type CustomerAgentQuestion } from "@royal-home/shared";

// PRIVATE PROPOSAL, NOT EXECUTED. Pure response/projection obligations only.
// A synthetic observation below is not a principal, actual registry or OUT proof.
const knowledge = readCustomerAgentCompanyKnowledge();
const sourceHash = customerAgentCompanyKnowledgeHash(knowledge);
it.each(["topic", "role", "rooms", "budget", "phone", "job_position", "job_experience"] as const)(
  "a verified unavailable rental answer does not append the unrelated %s questionnaire", question => {
    const rentalHash = customerAgentCompanyKnowledgeHash({ ...knowledge, rent: false });
    const result = renderCustomerAgentDecision({ evidence: [{ ref: "e0", value: { kind: "company_policy", topic: "rental", sourceHash: rentalHash, knowledge: { ...knowledge, rent: false } } }],
      decision: { kind: "reply", refs: ["e0"], social: "greet", question }, language: "ru", inputText: "Здравствуйте! Мне нужно квартира аренда",
      requestedFacts: [], knownPhoneSource: "none", maxOutputChars: 3000, surface: "dm",
      knowledgeSourceHash: customerAgentCompanyKnowledgeHash({ ...knowledge, rent: false }) });
    expect(result).toBe("Здравствуйте!\nСейчас арендой не занимаемся: не сдаём и не подбираем в аренду.");
  });
const facts = { propertyId: "00000000-0000-4000-8000-000000000101", shortId: 123, price: "110000.00", currency: "TJS" as const,
  availability: "AVAILABLE" as const, publicAddress: "Сино, Душанбе", addressPolicy: "district_city_only" as const,
  builder: null, publicLink: null, updatedAt: "2026-10-15T00:00:00.000Z", signature: "b".repeat(64) };
function render(value: Parameters<typeof renderCustomerAgentDecision>[0]["evidence"][number]["value"], question: CustomerAgentQuestion = "none", language: "ru" | "tg" = "ru") {
  return renderCustomerAgentDecision({ evidence: [{ ref: "e0", value }],
    decision: { kind: "reply", refs: ["e0"], social: "none", question }, language,
    requestedFacts: [], knownPhoneSource: "none", maxOutputChars: 3000, surface: "dm", knowledgeSourceHash: sourceHash });
}
function search(rooms: number | null = 3): CustomerAgentSearchObservation {
  const query = { type: "APARTMENT" as const, rooms: 2, budget: { max: "100000", currency: "TJS" as const } };
  const data = { type: "APARTMENT" as const, rooms, districtName: "Сино" };
  const listing = { ...data, signature: customerAgentPublicListingSignature(facts.signature, data) };
  return { kind: "property_search", query, coverage: "bounded_ranked_pool", poolLimit: 500, policyHash: "c".repeat(64),
    cards: [{ facts, listing, match: customerAgentSearchFit(query, listing, { cardTjs: 110000, minTjs: null, maxTjs: 100000 }) }] };
}

describe("actual canonical public company source, draft", () => {
  it("projects only actual approved AGENCY_FACTS, not another fee/phone constant", () => {
    expect(knowledge.commission).toEqual(AGENCY_FACTS.commission);
    expect(knowledge.rent).toBe(AGENCY_FACTS.rent); expect(knowledge.mortgage).toBe(AGENCY_FACTS.mortgage);
    expect(knowledge.installments).toBe(AGENCY_FACTS.installments);
    for (const key of ["phone", "office", "owner", "client"]) expect(Object.keys(knowledge)).not.toContain(key);
  });
  it("answers service commission before asking one useful role question", () => {
    const text = render({ kind: "company_policy", topic: "commission", sourceHash, knowledge }, "role");
    expect(text).toContain(`для продавца — ${AGENCY_FACTS.commission.sellerPercent}%`);
    expect(text).toContain(`для покупателя — ${AGENCY_FACTS.commission.buyerPercent}%`);
    expect(text).toContain("купить или продать"); expect(text?.match(/[?？]/gu)).toHaveLength(1);
    expect(text).not.toMatch(/номер телефона|позвонят|создан|сохран/iu);
  });
  it("honestly answers rental and payment instead of starting the housing questionnaire", () => {
    expect(render({ kind: "company_policy", topic: "rental", sourceHash, knowledge })).toContain("арендой не занимаемся");
    const text = render({ kind: "company_policy", topic: "payment", sourceHash, knowledge });
    expect(text).toContain("Рассрочки нет."); expect(text).toContain("Ипотеки нет.");
    expect(text).not.toMatch(/телефон|ипотека доступна|предодобр/iu);
  });
  it("TG negotiation is conditional, no invented owner agreement or completed contact", () => {
    const text = render({ kind: "company_policy", topic: "negotiation", sourceHash, knowledge }, "property", "tg");
    expect(text).toContain("агент бо соҳибмулк"); expect(text).toContain("тасдиқ карда наметавонам");
    expect(text).toContain("Рақами объект"); expect(text?.match(/[?？]/gu)).toHaveLength(1);
    expect(text).not.toMatch(/розӣ шуд|занг зад|сабт шуд|%/u);
  });
  it("wrong/unpinned knowledge cannot assert a different commission", () => {
    const changed = { ...knowledge, commission: { ...knowledge.commission, sellerPercent: 9 } };
    expect(isPinnedCompanyPolicy({ kind: "company_policy", topic: "commission", knowledge: changed, sourceHash }, sourceHash)).toBe(false);
    expect(render({ kind: "company_policy", topic: "commission", knowledge: changed, sourceHash })).toBeNull();
    expect(customerAgentCompanyKnowledgeHash(changed)).not.toBe(sourceHash);
  });
});

describe("bounded public search DTO and useful truthful output, draft", () => {
  it("preserves relaxed rooms AND price caveats, rather than claiming exact fit", () => {
    const value = search(); expect(value.cards[0].match).toEqual({ status: "relaxed", notes: ["rooms_more", "over_budget"] });
    expect(isPublicPropertySearch(value)).toBe(true);
    const text = render(value, "clarify_previous");
    expect(text).toContain("110 000.00 сомони"); expect(text).toContain("Комнат: 3.");
    expect(text).toContain("комнат больше, чем запрошено"); expect(text).toContain("выше названного бюджета");
    expect(text?.match(/[?？]/gu)).toHaveLength(1); expect(text).not.toContain("точно соответствует");
  });
  it("a missing room count is unknown even if other fields are known", () => {
    const value = search(null); expect(value.cards[0].match.status).toBe("unknown");
    const text = render(value); expect(text).toContain("число комнат не подтверждено");
    expect(text).not.toContain("Комнат: null"); expect(text).toContain("110 000.00 сомони");
  });
  it("an exact known result may be presented without warning or claiming catalog completeness", () => {
    const value = search(2);
    value.query = { type: "APARTMENT", rooms: 2, budget: { max: "120000", currency: "TJS" } };
    value.cards[0].match = customerAgentSearchFit(value.query, value.cards[0].listing, { cardTjs: 110000, minTjs: null, maxTjs: 120000 });
    expect(value.cards[0].match.status).toBe("exact");
    const text = render(value); expect(text).toContain("объекта №123"); expect(text).not.toContain("Примечание");
    expect(text).not.toMatch(/всего|все объекты|заброниров|заявка/iu);
  });
  it("model projection excludes IDs, raw address, signature and policy hash", () => {
    const serialized = JSON.stringify(publicSearchProjection(search()));
    expect(serialized).toContain('"shortId":123'); expect(serialized).toContain('"rooms":3');
    expect(serialized).not.toContain(facts.propertyId); expect(serialized).not.toContain(facts.signature);
    expect(serialized).not.toMatch(/policyHash|listingSignature|owner|agentId|street|profile|latitude/iu);
  });
  it("raw room changes cannot reuse the signed public listing projection", () => {
    const value = search(); value.cards[0].listing.rooms = 2;
    expect(isPublicPropertySearch(value)).toBe(false); expect(render(value)).toBeNull();
  });
  it("zero candidates means only this bounded search, not a global inventory assertion", () => {
    const text = render({ ...search(), cards: [] });
    expect(text).toBe("В текущей подборке подходящих вариантов не найдено.");
  });
  it.each([
    { type: "APARTMENT", budget: { max: "100000" } },
    { rooms: 2, budget: { max: "100000", currency: "TJS" } },
    { type: "APARTMENT", budget: { min: "200000", max: "100000", currency: "TJS" } },
    { type: "APARTMENT", street: "private synthetic address" },
    { type: "APARTMENT", accountId: "fabricated" },
    { type: "APARTMENT", includeOffSite: true },
  ])("rejects unsupported/identity/unbounded arguments %j", args => {
    expect(customerAgentPropertySearchCallSchema.safeParse({ name: "search_public_properties", args }).success).toBe(false);
  });
});
