import { describe, expect, it } from "vitest";
import { customerAgentVerifiedContextSchema, type CustomerPropertyFactKind } from "@royal-home/shared";
import { renderCustomerAgentDecision, type CustomerAgentEvidence } from "../src/ai/customerAgentRenderer.js";
import { validateCustomerAgentSay } from "../src/ai/customerAgentSay.js";
import { classifyCustomerPropertyFactIntent } from "../src/lib/customerPropertyFactIntent.js";

// Independent review of 49bce6d8f (08.11.2026): one test per finding, each red on that commit.
type Turn = { role: "user" | "assistant"; text: string };
const context = (turns: Turn[]) => customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: "a".repeat(64), turns,
  publicState: { language: "unknown", topic: "buyer", openQuestion: "none" } });
const facts = (id: number, kinds: CustomerPropertyFactKind[], district = "Сино"): CustomerAgentEvidence => ({ ref: "e0", value: { kind: "facts", kinds, facts: {
  propertyId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`, shortId: id, publicLink: null, publicAddress: `${district}, Душанбе`,
  addressPolicy: "district_city_only", price: "500000", currency: "TJS", availability: "AVAILABLE", builder: null, updatedAt: "2026-11-01T00:00:00.000Z",
  signature: "s".repeat(64), characteristics: { type: "APARTMENT", rooms: 2, areaSqm: "65", landAreaSotka: null, floor: 5, totalFloors: 9, condition: "GOOD",
    marketType: null, stage: null } } } as never });
const render = (o: { text: string; turns: Turn[]; ev: CustomerAgentEvidence[]; req: CustomerPropertyFactKind[]; decision?: object; lang?: "ru" | "tg";
  recentBotMessage?: boolean }) => renderCustomerAgentDecision({
  decision: { kind: "reply", refs: o.ev.map(e => e.ref), social: "none", question: "none", ...o.decision } as never, evidence: o.ev, language: o.lang ?? "ru",
  requestedFacts: o.req, knownPhoneSource: "none", maxOutputChars: 4000, surface: "dm", inputText: o.text, verifiedContext: context(o.turns),
  ...(o.recentBotMessage !== undefined ? { recentBotMessage: o.recentBotMessage } : {}) });
const say = (text: string, language: "ru" | "tg", extra: Record<string, unknown> = {}) => {
  const verdict = validateCustomerAgentSay({ say: text, language, surface: "dm", inputText: "салом, хона лозим", priorAssistantTurns: [], ...extra });
  return verdict.ok ? "ok" : verdict.reason;
};
function addressLoop(id: number, times: number) {
  let turns: Turn[] = [];
  for (let i = 0; i < times; i++) {
    const t = render({ text: "где?", turns: turns.slice(-6), ev: [facts(id, ["address"])], req: ["address"] })!;
    turns = [...turns, { role: "user", text: "где?" }, { role: "assistant", text: t }];
  }
  return turns;
}

describe("review 1: an address loop belongs to one object", () => {
  it("after two address questions about №192, the address of №250 is answered with №250's district", () => {
    const turns = addressLoop(192, 2);
    const other = render({ text: "а объект №250 где находится?", turns: turns.slice(-6), ev: [facts(250, ["address"], "Фирдавси")], req: ["address"] })!;
    expect(other).toContain("Объект №250 находится в районе Фирдавси, Душанбе.");
    expect(other).not.toMatch(/указан только район|точный адрес\. Его знает/u);
  });
});

describe("review 2: a loop is about one kind of fact", () => {
  it("card, then an address loop, then «цена?»: the price is answered, not «nothing more in the card»", () => {
    const card = render({ text: "расскажите", turns: [], ev: [facts(192, ["price", "address", "characteristics"])], req: [] })!;
    let turns: Turn[] = [{ role: "user", text: "расскажите" }, { role: "assistant", text: card }];
    for (let i = 0; i < 2; i++) {
      const t = render({ text: "где?", turns: turns.slice(-6), ev: [facts(192, ["address"])], req: ["address"] })!;
      turns = [...turns, { role: "user", text: "где?" }, { role: "assistant", text: t }];
    }
    const price = render({ text: "цена?", turns: turns.slice(-6), ev: [facts(192, ["price"])], req: ["price"] })!;
    expect(price).toContain("Цена объекта №192: 500 000 сомони.");
    expect(price).not.toMatch(/Больше данных|в карточке нет/u);
  });
});

describe("review 3: a phrase never greets (the server owns the greeting)", () => {
  it("is dropped even on the first turn with no greeting chosen", () => {
    expect(say("Ассалому алайкум, фаҳмидам.", "tg")).toBe("double_greet");
    expect(say("Здравствуйте, понял вас.", "ru")).toBe("double_greet");
  });
  it("the first answer then carries exactly one greeting", () => {
    const text = render({ text: "салом, хона лозим", turns: [], ev: [], req: [], lang: "tg",
      decision: { kind: "clarify", question: "budget", say: "Ассалому алайкум, фаҳмидам." } })!;
    expect(text.match(/Ассалому/gu)).toHaveLength(1);
  });
});

describe("review 4: never on «ты» / «ту»", () => {
  it.each([["Ташаккур, ки навиштӣ.", "tg"], ["Фаҳмидам, ба ту хона лозим аст.", "tg"], ["Понял, тебе нужна квартира.", "ru"],
    ["Спасибо, твой вопрос понятен.", "ru"], ["Понимаю, ты ищешь жильё.", "ru"]] as const)("drops %s", (text, language) => {
    expect(say(text, language)).toBe("tone");
  });
  it.each([["Фаҳмидам, ба шумо хона лозим аст.", "tg"], ["Ташаккур, ки навиштед.", "tg"], ["Понял, вам нужна квартира.", "ru"],
    ["Понял, речь про ту квартиру.", "ru"], ["Хуб, туроб ва тур нест, фаҳмидам.", "tg"]] as const)("keeps %s (no false «ту»)", (text, language) => {
    expect(say(text, language)).not.toBe("tone");
  });
});

describe("review 5: every dash form", () => {
  it.each(["Понял - вам нужна квартира.", "Понял ― вам нужна квартира.", "Фаҳмидам - ба шумо хона лозим аст."])("drops %s", text => {
    expect(say(text, /[ҳҷқӣӯғ]/u.test(text) ? "tg" : "ru")).toBe("cliche");
  });
  it("a hyphen inside a word is not a dash", () => { expect(say("Понял, вам нужна квартира где-нибудь рядом.", "ru")).not.toBe("cliche"); });
});

describe("review 6: a bare «Салом!» is a greeting, not a repeat notice", () => {
  it("the facts asked after a «Салом!» turn are answered, not replaced by a loop line", () => {
    // The price (not the address: an address asked again is the address loop by design, whatever came between).
    const first = render({ text: "цена?", turns: [], ev: [facts(192, ["price"])], req: ["price"] })!;
    const turns: Turn[] = [{ role: "user", text: "цена?" }, { role: "assistant", text: first }, { role: "user", text: "салом" }, { role: "assistant", text: "Салом!" }];
    const again = render({ text: "цена?", turns, ev: [facts(192, ["price"])], req: ["price"] })!;
    expect(again).toContain("Цена объекта №192: 500 000 сомони.");
  });
});

describe("review 7: no greeting when a bot wrote in this dialogue within 12 hours", () => {
  it("the dialogue history decides, not only the core memory", () => {
    expect(render({ text: "цена?", turns: [], ev: [facts(192, ["price"])], req: ["price"], recentBotMessage: true })).not.toMatch(/Здравствуйте/u);
    expect(render({ text: "цена?", turns: [], ev: [facts(192, ["price"])], req: ["price"], recentBotMessage: false })).toMatch(/^Здравствуйте!\n/u);
    // A long-quiet dialogue whose bot turns left the memory greets again after 12 hours; a recent one does not.
    const turns: Turn[] = [{ role: "user", text: "салом" }];
    expect(render({ text: "цена?", turns, ev: [facts(192, ["price"])], req: ["price"], recentBotMessage: true })).not.toMatch(/Здравствуйте/u);
  });
});

describe("review 8: «нишона» is a landmark question only when asked", () => {
  it.each([["нишона", null], ["нишонаи хуб", null], ["нишонааш куҷо?", ["address"]], ["кадом нишона?", ["address"]], ["нишонааш?", ["address"]]] as const)(
    "%s", (text, expected) => { expect(classifyCustomerPropertyFactIntent(text, { hasPropertyContext: true })).toEqual(expected); });
});
