import { describe, expect, it, vi } from "vitest";
// Pure renderer: no database is touched; the stub keeps tests/setup.ts from resetting one.
vi.mock("../src/db.js", () => ({ prisma: { $disconnect: async () => {} } }));
import { customerAgentVerifiedContextSchema, type CustomerAgentCompanyKnowledge } from "@royal-home/shared";
import { renderCustomerAgentDecision, type CustomerAgentObservation } from "../src/ai/customerAgentRenderer.js";
import { customerAgentCompanyKnowledgeHash } from "../src/ai/customerAgentPublicProtocol.js";
import { customerRentalAsked, customerRentalAskedRecently } from "../src/ai/customerAgentLiveWording.js";
import { watchdogLeadDraft } from "../src/lib/phoneLeadWatchdog.js";

/** Audit 17.11.2026: the code deleted the model's rental refusal unless the CURRENT message had a rent word. */
const knowledge: CustomerAgentCompanyKnowledge = { version: 1, source: "AGENCY_FACTS", city: "Душанбе", otherCities: false,
  commission: { sellerPercent: 2, buyerPercent: 0 }, rent: false, installments: false, mortgage: false, botNamesDiscount: false, guarantees: false };
const sourceHash = customerAgentCompanyKnowledgeHash(knowledge);
const rental = { kind: "company_policy", topic: "rental", knowledge, sourceHash } as CustomerAgentObservation;
type Turn = { role: "user" | "assistant"; text: string };
const user = (text: string): Turn => ({ role: "user", text });
const bot = (text: string): Turn => ({ role: "assistant", text });
function render(inputText: string, turns: Turn[] = []) {
  const verifiedContext = customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: "a".repeat(64), turns,
    publicState: { language: "unknown", topic: "unknown", openQuestion: "none" } });
  return renderCustomerAgentDecision({ decision: { kind: "reply", refs: ["e0"], social: "none", question: "none" } as never,
    evidence: [{ ref: "e0", value: rental }], language: "ru", requestedFacts: [], knownPhoneSource: "none", maxOutputChars: 4000,
    surface: "dm", knowledgeSourceHash: sourceHash, inputText, verifiedContext });
}

describe("the rental refusal stays when the customer speaks about a temporary stay", () => {
  it.each(["Квартира на пару месяцев", "Хочу временно пожить, есть что-то?", "Нужна квартира на месяц", "Ищу жильё на время"])("%s", input => {
    expect(customerRentalAsked(input)).toBe(true);
    expect(render(input)).toMatch(/аренд/u);
  });
  it("a rent word in one of the last three customer turns keeps the line", () => {
    const turns = [user("Здравствуйте, хочу снять квартиру"), bot("Какой район?"), user("Центр"), bot("Бюджет?")];
    expect(render("Сколько это будет стоить?", turns)).toMatch(/аренд/u);
    expect(customerRentalAskedRecently("Сколько?", ["снять", "а", "б"])).toBe(true);
  });
  it("a rent word four customer turns back does not", () => {
    expect(customerRentalAskedRecently("Сколько?", ["Хочу снять квартиру", "Центр", "Двухкомнатную", "Бюджет большой"])).toBe(false);
    expect(render("Сколько стоит дом?", [user("Хочу снять квартиру"), user("Центр"), user("Двухкомнатную"), user("Бюджет большой")])).not.toMatch(/аренд/u);
  });
  it("an ordinary buyer message still gets no rental line", () => {
    expect(render("Сколько стоит дом?", [user("Хочу купить дом")])).not.toMatch(/аренд/u);
  });
});

describe("phone watchdog: a tenant word counts only in the last three customer turns", () => {
  const history = (...texts: string[]) => texts.map(content => ({ role: "user" as const, content }));
  it("an old «снять» does not make a buyer a tenant", () => {
    const draft = watchdogLeadDraft({ draft: null, coreTopic: null, history: history("Хочу снять квартиру", "Хотя нет", "Хочу купить квартиру", "Двухкомнатную", "Мой номер 900000001") });
    expect(draft.intent).not.toBe("rent");
  });
  it("a recent tenant word still makes the lead a rental", () => {
    expect(watchdogLeadDraft({ draft: null, coreTopic: null, history: history("Здравствуйте", "Хочу снять квартиру", "Мой номер 900000001") }).intent).toBe("rent");
  });
});
