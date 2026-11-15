import { describe, expect, it } from "vitest";
import { customerAgentVerifiedContextSchema, type CustomerAgentCompanyKnowledge } from "@royal-home/shared";
import { renderCustomerAgentDecision, customerAgentFixedLines, customerAgentRetiredRepeatLines,
  type CustomerAgentEvidence, type CustomerAgentObservation } from "../src/ai/customerAgentRenderer.js";
import { customerAgentCompanyKnowledgeHash } from "../src/ai/customerAgentPublicProtocol.js";
import { customerCommissionAmountLine, customerReplyCallsStaff, customerStaffFollowUpFixedLines, customerThanksOnly,
  customerTradeInQuestion, customerPartnershipOffer } from "../src/ai/customerAgentStaffFollowUp.js";
import { detectOutsideCoverage } from "../src/ai/coverageGuard.js";
import { batchWindowFor } from "../src/messengers/debounceBuffer.js";

/**
 * Eight live Instagram chats of 13–15.11.2026 (owner's screenshots), the classes behind them, not the scenarios:
 *  б «я уже писал выше / повторяю ещё раз», в «2% от суммы» not counted, г a call promised without a phone,
 *  е an answer to another question (barter → discount), д two replies to one message, plus the service area said again
 *  to a Dushanbe seller (13 times in 7 days on prod). Tajik wording is from the tajik-phrasebook skill, "шумо" only.
 */
const knowledge: CustomerAgentCompanyKnowledge = { version: 1, source: "AGENCY_FACTS", city: "Душанбе", otherCities: false,
  commission: { sellerPercent: 2, buyerPercent: 0 }, rent: false, installments: false, mortgage: false, botNamesDiscount: false, guarantees: false };
const sourceHash = customerAgentCompanyKnowledgeHash(knowledge);
const policy = (topic: "commission" | "negotiation" | "service_scope"): CustomerAgentObservation =>
  ({ kind: "company_policy", topic, knowledge, sourceHash }) as CustomerAgentObservation;
const user = (text: string) => ({ role: "user" as const, text });
const bot = (text: string) => ({ role: "assistant" as const, text });
const context = (turns: Array<{ role: "user" | "assistant"; text: string }> = [], language: "ru" | "tg" = "tg") =>
  customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: "a".repeat(64), turns,
    publicState: { language, topic: "unknown", openQuestion: "none" } });
type Decision = { kind: "reply" | "clarify"; refs: string[]; social: "none" | "greet" | "thank" | "acknowledge"; question: string };
function render(inputText: string, opts: { decision?: Partial<Decision>; evidence?: CustomerAgentEvidence[]; turns?: Array<{ role: "user" | "assistant"; text: string }>;
  language?: "ru" | "tg"; phone?: "none" | "current_input" | "scoped_contact"; requestedFacts?: string[] } = {}) {
  const language = opts.language ?? "tg";
  return renderCustomerAgentDecision({ decision: { kind: "reply", refs: [], social: "none", question: "none", ...opts.decision } as never,
    evidence: opts.evidence ?? [], language, requestedFacts: (opts.requestedFacts ?? []) as never, knownPhoneSource: opts.phone ?? "none",
    maxOutputChars: 4000, surface: "dm", knowledgeSourceHash: sourceHash, inputText, verifiedContext: context(opts.turns ?? [], language) });
}
const FORBIDDEN = /выше|дар\s+боло|такрор|повтор|уже\s+пис|уже\s+напис|номафҳум/iu;
const SERVICE_TG = "Барои хариду фурӯши амвол дар Душанбе кӯмак мекунем. Дар шаҳрҳои дигар кор намекунем.";
const SELLER_Q_TG = "Барои фурӯш шумораи ҳуҷраҳо, масоҳат, ноҳия ё нишонӣ, ошёна, ҳолати таъмир, нарх бо асъор-ро нависед. Ҳамаашро дар як паём фиристода метавонед.";

describe("class б: never «I already wrote above» or «I repeat»", () => {
  const battery: Array<[string, Parameters<typeof render>]> = [
    ["a fixed question asked again (job)", ["хочу работать", { language: "ru", decision: { kind: "clarify", question: "job_position" },
      turns: [user("хочу работать"), bot("Какая должность вас интересует?")] }]],
    ["a fixed question asked a third time", ["хочу работать", { language: "ru", decision: { kind: "clarify", question: "job_position" },
      turns: [user("хочу работать"), bot("Какая должность вас интересует?"), user("хочу работать"),
        bot("Это точно подскажет наш агент. Напишите, пожалуйста, ваш номер телефона, чтобы агент вам позвонил.")] }]],
    ["the same policy again, not asked (live: «Хона дар Душанбе аст»)", ["Хона дар Душанбе аст", { evidence: [{ ref: "e0", value: policy("service_scope") }],
      decision: { refs: ["e0"] }, turns: [user("Мехоҳам хонаамро фурӯшам"), bot(SERVICE_TG)] }]],
    ["the same commission again (live case 8)", ["Ман нафаҳмидам", { evidence: [{ ref: "e0", value: policy("commission") }], decision: { refs: ["e0"] },
      turns: [user("комиссия чанд?"), bot("Ҳаққи хизмат барои фурӯшанда 2%, барои харидор 0% аст.")] }]],
    ["the seller question asked again (live case 8)", ["Кимат охи", { decision: { kind: "clarify", question: "seller_details" },
      turns: [user("Мехоҳам хонаамро фурӯшам"), bot(`Салом!\n${SELLER_Q_TG}`)] }]],
    ["thanks after a question (live case 4)", ["Рахмат", { decision: { kind: "clarify", question: "topic" },
      turns: [user("Мо дар шахри Кайрокум"), bot("Шумо дар бораи амвол маълумот мехоҳед ё дар бораи кор?")] }]],
  ];
  it.each(battery)("%s", (_name, args) => {
    const text = render(...args);
    expect(text ?? "").not.toMatch(FORBIDDEN);
    for (const retired of customerAgentRetiredRepeatLines()) expect(text ?? "").not.toContain(retired);
  });
  it("guard: no fixed line the renderer can still produce says «above» or «again»", () => {
    const retired = new Set(customerAgentRetiredRepeatLines());
    const live = [...customerAgentFixedLines()].filter(line => !retired.has(line));
    expect(live.filter(line => FORBIDDEN.test(line))).toEqual([]);
    // Old chats still carry the retired wording: memory keeps recognising it.
    for (const line of retired) expect(customerAgentFixedLines().has(line)).toBe(true);
  });
  it("the same fact asked for again is said again after «Албатта.», never «Бори дигар такрор мекунам»", () => {
    const facts = render("Ин чанд?", { evidence: [{ ref: "e0", value: policy("commission") }], decision: { refs: ["e0"] }, requestedFacts: ["price"],
      turns: [user("комиссия чанд?"), bot("Ҳаққи хизмат барои фурӯшанда 2%, барои харидор 0% аст.")] });
    expect(facts).not.toMatch(FORBIDDEN);
  });
});

describe("thanks get a short polite answer", () => {
  it.each(["Рахмат", "раҳмат калон", "Ташаккур ака", "хуб, рахмат", "Спасибо!", "спс", "ок спасибо 🙏"])("%s is a bare thanks", text => {
    expect(customerThanksOnly(text)).toBe(true);
  });
  it.each(["Рахмат, нархаш чанд?", "спасибо, а сколько комнат", "Мехоҳам хонаамро фурӯшам", "рахмат 935000000"])("%s is not", text => {
    expect(customerThanksOnly(text)).toBe(false);
  });
  it("answers «Марҳамат! Саломат бошед!» and another wording the next time (live case 4)", () => {
    const first = render("Рахмат", { decision: { kind: "clarify", question: "topic" }, turns: [user("Мо дар шахри Кайрокум"), bot("Мутаассифона, мо танҳо дар Душанбе кор мекунем.")] });
    expect(first).toBe("Марҳамат! Саломат бошед!");
    const second = render("Рахмат", { turns: [user("Рахмат"), bot(first!), user("хуб")] });
    expect(second).toBe("Марҳамат!");
    expect(render("Спасибо", { language: "ru", decision: { social: "thank", question: "location" }, turns: [bot("Какой район вам подходит?")] }))
      .toBe("Пожалуйста! Всего доброго.");
  });
});

describe("class в: the server counts the commission of a named sum", () => {
  it("live case 8: «2 % анар ма 700 000 фрушум и як копча пул меша» → 14 000", () => {
    const text = render("Кимат охи 2 % анар ма 700 000 фрушум и як копча пул меша", { evidence: [{ ref: "e0", value: policy("commission") }],
      decision: { kind: "clarify", question: "seller_details" }, turns: [user("Мехоҳам хонаамро фурӯшам"), bot(`Салом!\n${SELLER_Q_TG}`)] })!;
    expect(text).toContain("14 000");
    expect(text).toContain("700 000");
    expect(text).not.toMatch(FORBIDDEN);
  });
  it("uses the company percent when the policy was read, the customer's figure otherwise, currency kept", () => {
    expect(customerCommissionAmountLine("сколько будет комиссия с 1 200 000 сомони?", "ru", 2)).toBe("Если продать за 1 200 000 сомони, 2% от этой суммы составит 24 000 сомони.");
    expect(customerCommissionAmountLine("3% от $80 000 это сколько", "ru")).toContain("2 400 USD");
    expect(customerCommissionAmountLine("комиссия 2% а мой номер 935 55 33 35", "tg")).toBeNull(); // a phone is not a price
    expect(customerCommissionAmountLine("комиссия сколько?", "tg", 2)).toBeNull();
  });
  it("a buyer pays nothing: no sum is counted for a buyer", () => {
    const text = render("комиссия 2% от 500 000?", { evidence: [{ ref: "e0", value: policy("commission") }], decision: { refs: ["e0"] },
      turns: [user("хочу купить квартиру"), bot("Какой район вам подходит?")], language: "ru" });
    expect(text ?? "").not.toContain("10 000");
  });
});

describe("class г: a call is promised only with a phone; without one, the phone is asked", () => {
  it("every hand-off line without a phone asks for it; with a phone it never asks", () => {
    const lines = customerStaffFollowUpFixedLines().filter(line => customerReplyCallsStaff(line));
    expect(lines.length).toBeGreaterThan(0);
    const noPhone = render("Мошин ҳам қабул мекунед?", { phone: "none" })!;
    expect(noPhone).toMatch(/рақами телефон/iu);
    const withPhone = render("Мошин ҳам қабул мекунед?", { phone: "scoped_contact" })!;
    expect(withPhone).not.toMatch(/рақами телефон/iu);
    expect(withPhone).toMatch(/занг мезанад/u);
  });
});

describe("class е: a barter question is the agent's, never a discount answer (live case 5)", () => {
  it.each(["Мошин хам кабул мекунед?", "машину в зачёт возьмёте?", "обмен на дом рассматриваете?", "Бартер хаст?"])("%s is barter", text => {
    expect(customerTradeInQuestion(text)).toBe(true);
  });
  it.each(["машину где поставить?", "мошинаи худро мондан мумкин?", "Мехоҳам хонаамро фурӯшам", "скидка будет?"])("%s is not", text => {
    expect(customerTradeInQuestion(text)).toBe(false);
  });
  it("drops the discount line, hands off and tells a person", () => {
    const text = render("Мошин хам кабул мекунед?", { evidence: [{ ref: "e0", value: policy("negotiation") }], decision: { refs: ["e0"], question: "budget" } })!;
    expect(text).not.toMatch(/тахфиф|скидк/iu);
    expect(text).not.toContain("буҷет");
    expect(text).toContain("Инро аниқ агенти мо мегӯяд.");
    expect(customerReplyCallsStaff(text)).toBe(true);
  });
});

describe("a partnership offer goes to management (live case 2)", () => {
  const offer = "Здравствуйте! Меня зовут Шахноза, я менеджер дизайн-студии. Хотела бы предложить вам сотрудничество. Мы занимаемся дизайн-проектами.";
  it("is recognised, a client's own words are not", () => {
    expect(customerPartnershipOffer(offer)).toBe(true);
    expect(customerPartnershipOffer("хочу продать квартиру через ваше агентство")).toBe(false);
  });
  it("is passed on, the phone asked, a person told", () => {
    const text = render(offer, { language: "ru", decision: { social: "thank" } })!;
    expect(text).toBe("Спасибо, передам руководству.\nОставьте, пожалуйста, номер телефона для связи.");
    expect(customerReplyCallsStaff(text)).toBe(true);
  });
});

describe("the service area: said once, «other cities» only to someone outside (live case 4, 13 repeats in a week)", () => {
  it("a Dushanbe seller hears the area once and then the seller question, never «other cities»", () => {
    const first = render("Мехоҳам хонаамро фурӯшам", { evidence: [{ ref: "e0", value: policy("service_scope") }], decision: { refs: ["e0"], question: "seller_details" } })!;
    expect(first).toContain("Барои хариду фурӯши амвол дар Душанбе кӯмак мекунем.");
    expect(first).not.toContain("шаҳрҳои дигар");
    const again = render("Хона дар Душанбе аст", { evidence: [{ ref: "e0", value: policy("service_scope") }], decision: { refs: ["e0"] },
      turns: [user("Мехоҳам хонаамро фурӯшам"), bot(SERVICE_TG)] })!;
    expect(again).not.toContain("кӯмак мекунем");
    expect(again).not.toMatch(FORBIDDEN);
    expect(again).toContain("Барои фурӯш"); // the seller question: the conversation moves on
  });
  it("someone in Qayroqqum gets a short apology and no questionnaire", () => {
    expect(detectOutsideCoverage("Мо дар шахри Кайрокум гулистон")).not.toBeNull();
    const text = render("Мо дар шахри Кайрокум гулистон", { evidence: [{ ref: "e0", value: policy("service_scope") }],
      decision: { refs: ["e0"], question: "seller_details" }, turns: [user("Мехоҳам хонаамро фурӯшам"), bot(`Салом!\n${SELLER_Q_TG}`)] });
    expect(text).toBe("Мутаассифона, мо танҳо дар Душанбе кор мекунем.");
  });
  it("Rudaki is not cut by code (both a district and the main avenue of Dushanbe)", () => {
    expect(detectOutsideCoverage("Дар н Рудаки карор дорад")).toBeNull();
  });
});

describe("class д: two quick messages of a client with a card make one turn (live case 3)", () => {
  it("the accepted text window outlasts a 5 s gap", () => {
    const window = batchWindowFor({ accepted: true, hasMedia: false })!;
    expect(window.delayMs).toBeGreaterThanOrEqual(6_000);
    expect(window.maxWaitMs).toBeGreaterThan(window.delayMs);
  });
});

describe("an empty search is handed to a person, not «budget?» (live case 7)", () => {
  it("says nothing fits, then the hand-off, no qualifier question", () => {
    const empty = { kind: "property_search", query: { type: "APARTMENT", rooms: 2 }, coverage: "bounded_ranked_pool", poolLimit: 500,
      policyHash: "c".repeat(64), cards: [] } as unknown as CustomerAgentObservation;
    const text = render("Салом ман барои салон помишеня харидани хастам то 30 40 квадрат", { evidence: [{ ref: "e0", value: empty }],
      decision: { refs: ["e0"], social: "greet", question: "budget" } })!;
    expect(text).toContain("варианти мувофиқ ёфт нашуд");
    expect(text).not.toContain("буҷет");
    expect(customerReplyCallsStaff(text)).toBe(true);
  });
});
