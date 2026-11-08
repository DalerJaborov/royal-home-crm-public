import { describe, expect, it } from "vitest";
import { customerAgentVerifiedContextSchema, type CustomerPropertyFactKind } from "@royal-home/shared";
import { renderCustomerAgentDecision, type CustomerAgentEvidence } from "../src/ai/customerAgentRenderer.js";
import { validateCustomerAgentSay, CUSTOMER_AGENT_SAY_TG_REVIEW_SAMPLES, CUSTOMER_AGENT_SAY_EXAMPLES } from "../src/ai/customerAgentSay.js";
import { classifyCustomerPropertyFactIntent } from "../src/lib/customerPropertyFactIntent.js";

// Second review of the tone change (5a951039d, 08.11.2026): one test per finding, each red on that commit.
type Turn = { role: "user" | "assistant"; text: string };
const context = (turns: Turn[]) => customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: "a".repeat(64), turns,
  publicState: { language: "unknown", topic: "buyer", openQuestion: "none" } });
const facts = (id: number, kinds: CustomerPropertyFactKind[]): CustomerAgentEvidence => ({ ref: "e0", value: { kind: "facts", kinds, facts: {
  propertyId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`, shortId: id, publicLink: null, publicAddress: "Сино, Душанбе",
  addressPolicy: "district_city_only", price: "500000", currency: "TJS", availability: "AVAILABLE", builder: null, updatedAt: "2026-11-01T00:00:00.000Z",
  signature: "s".repeat(64), characteristics: { type: "APARTMENT", rooms: 2, areaSqm: "65", landAreaSotka: null, floor: 5, totalFloors: 9, condition: "GOOD",
    marketType: null, stage: null } } } as never });
/** One dialogue the way production runs it: the core memory sees the last six turns, the message history sees every bot reply. */
function dialogue(language: "ru" | "tg" = "ru") {
  let turns: Turn[] = [];
  const said: string[] = [];
  return {
    said,
    ask(text: string, ev: CustomerAgentEvidence[], req: CustomerPropertyFactKind[]) {
      const reply = renderCustomerAgentDecision({ decision: { kind: "reply", refs: ev.map(e => e.ref), social: "none", question: "none" } as never,
        evidence: ev, language, requestedFacts: req, knownPhoneSource: "none", maxOutputChars: 4000, surface: "dm", inputText: text,
        verifiedContext: context(turns.slice(-6)), recentBotMessage: said.length > 0, botMessages: [...said] })!;
      turns = [...turns, { role: "user", text }, { role: "assistant", text: reply }];
      said.push(reply);
      return reply;
    },
  };
}
const say = (text: string, language: "ru" | "tg") => {
  const verdict = validateCustomerAgentSay({ say: text, language, surface: "dm", inputText: "хона лозим", social: "none", priorAssistantTurns: [] });
  return verdict.ok ? "ok" : verdict.reason;
};

describe("review2 #2 (blocker): the kind check covers the whole repeat condition", () => {
  it("«цена и адрес?» twice, then «цена?»: the price is answered", () => {
    const d = dialogue();
    d.ask("цена и адрес?", [facts(192, ["price", "address"])], ["price", "address"]);
    d.ask("цена и адрес?", [facts(192, ["price", "address"])], ["price", "address"]);
    const price = d.ask("цена?", [facts(192, ["price"])], ["price"]);
    expect(price).toContain("Цена объекта №192: 500 000 сомони.");
    expect(price).not.toMatch(/Больше данных|в карточке нет/u);
  });
});

describe("review2 #9: the address loop is remembered beyond the three-exchange memory", () => {
  it.each(["ru", "tg"] as const)("ten identical «где?» (%s): district once, phone at most twice, never the same reply twice in a row", language => {
    const d = dialogue(language);
    for (let i = 0; i < 10; i++) d.ask(language === "tg" ? "куҷо?" : "где?", [facts(192, ["address"])], ["address"]);
    const district = language === "tg" ? "дар ноҳияи Сино, Душанбе ҷойгир" : "находится в районе Сино, Душанбе";
    expect(d.said.filter(text => text.includes(district))).toHaveLength(1);
    const phone = language === "tg" ? /рақами телефон/u : /номер телефона/u;
    expect(d.said.filter(text => phone.test(text)).length).toBeLessThanOrEqual(2);
    for (let i = 1; i < d.said.length; i++) expect(d.said[i]).not.toBe(d.said[i - 1]);
  });
});

describe("review2 #7a: two turns at once — a bot turn in memory means no greeting", () => {
  it("history says nothing recent yet, but the other turn's reply is in memory", () => {
    const text = renderCustomerAgentDecision({ decision: { kind: "reply", refs: ["e0"], social: "none", question: "none" }, evidence: [facts(192, ["price"])],
      language: "ru", requestedFacts: ["price"], knownPhoneSource: "none", maxOutputChars: 4000, surface: "dm", inputText: "цена?", recentBotMessage: false,
      verifiedContext: context([{ role: "user", text: "салом" }, { role: "assistant", text: "Здравствуйте!\nКакой район вам подходит?" }]) })!;
    expect(text).not.toMatch(/Здравствуйте/u);
  });
});

describe("review2 #4: «ты» filter", () => {
  it.each(["Фаҳмидам, хонаат калон аст.", "Хуб, худат бин.", "Фаҳмидам, барои худат беҳтар аст."])("drops %s", text => { expect(say(text, "tg")).toBe("tone"); });
  it.each(["Омади кор.", "Хуб, аз диди шумо ин муҳим аст.", "Фаҳмидам, ҳаёти оила муҳим аст.", "Фаҳмидам, сифати хона муҳим аст.",
    "Хуб, муҳаббати шумо ба хона фаҳмо шуд."])("keeps %s", text => { expect(say(text, "tg")).not.toBe("tone"); });
  it("no Tajik review sample or prompt example is dropped", () => {
    expect([...CUSTOMER_AGENT_SAY_TG_REVIEW_SAMPLES, ...CUSTOMER_AGENT_SAY_EXAMPLES.tg].filter(text => say(text, "tg") !== "ok")).toEqual([]);
  });
});

describe("review2 #5: a dash at the start and U+2010", () => {
  it.each(["- Понял, вам нужна квартира.", "Понял ‐ вам нужна квартира."])("drops %s", text => { expect(say(text, "ru")).toBe("cliche"); });
  it("a word hyphen still passes", () => { expect(say("Понял, это кое-что важное.", "ru")).not.toBe("cliche"); });
});

describe("review2 #8: «нишона» only with the question at the word", () => {
  it.each([["Ин нишона аст?", null], ["Ин чӣ нишона аст?", null], ["Нишонаи хона куҷост?", ["address"]], ["нишонааш куҷо?", ["address"]],
    ["кадом нишона?", ["address"]]] as const)("%s", (text, expected) => {
    expect(classifyCustomerPropertyFactIntent(text, { hasPropertyContext: true })).toEqual(expected);
  });
});
