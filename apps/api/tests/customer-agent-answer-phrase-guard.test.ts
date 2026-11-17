// CI guard over the model's vetted words (one brain, 17.11.2026; carried over from PR #180 «say»). The answer validator lets
// the model say ONLY whole phrases of HUMAN_PHRASES and questions of APPROVED_ASKS, so these lists are the whole surface: a
// phrase added later with «ты / ту», a word of the other language or a question in the lead / close would reach the customer
// unchecked. Every entry is checked here with the same lexicons the free-phrase (`say`) check uses.
import { describe, expect, it } from "vitest";
import { APPROVED_ASKS, HUMAN_PHRASES, foreignLanguageWord, informalAddress } from "../src/ai/customerAgentHumanText.js";
import { validateCustomerAgentAnswer } from "../src/ai/customerAgentAnswer.js";

const LANGUAGES = ["ru", "tg"] as const;
const phrases = LANGUAGES.flatMap(language => (["lead", "close"] as const).flatMap(role =>
  HUMAN_PHRASES[language][role].map(([text]) => ({ language, role, text }))));
const asks = LANGUAGES.flatMap(language => Object.values(APPROVED_ASKS[language]).flat().map(text => ({ language, text })));

describe("the vetted model words: «вы / шумо» only, one language, questions only in the question slot", () => {
  it.each(phrases.map(p => [`${p.language} ${p.role}: ${p.text}`, p] as const))("%s", (_name, p) => {
    expect(informalAddress(p.text, p.language)).toBeNull();
    expect(foreignLanguageWord(p.text, p.language)).toBeNull();
    // A question is only ever the server's question kind (APPROVED_ASKS); the lead and the close never ask.
    expect(p.text).not.toMatch(/[?]/u);
  });
  it.each(asks.map(a => [`${a.language} ask: ${a.text}`, a] as const))("%s", (_name, a) => {
    expect(informalAddress(a.text, a.language)).toBeNull();
    expect(foreignLanguageWord(a.text, a.language)).toBeNull();
    expect(a.text).toMatch(/^[^?]+\?$/u);
  });
  it("the lists are not empty (a broken import would pass every check above)", () => {
    expect(phrases.length).toBeGreaterThan(40);
    expect(asks.length).toBeGreaterThan(20);
  });
});

describe("the validator refuses what the lists never carry", () => {
  const template = { social: [], facts: ["Цена 900 000 сомони."], question: null };
  const tgTemplate = { social: [], facts: ["Нарх 900 000 сомонӣ."], question: null };
  const verdict = (language: "ru" | "tg", lead: string) => validateCustomerAgentAnswer({ surface: "dm", language, inputText: "Цена?",
    template: (language === "ru" ? template : tgTemplate) as never, answer: { lead }, maxOutputChars: 2000 } as never);
  it.each([
    ["ru", "Спасибо, что ты написал!"], ["ru", "Понял тебя."], ["tg", "Раҳмат, ки навиштӣ!"], ["tg", "Ташаккур ба ту!"],
    ["ru", "Спасибо, рахмат!"], ["tg", "Раҳмат, спасибо!"], ["ru", "Где вы хотели бы жить."], ["tg", "Шумо дар куҷо зиндагӣ мекунед."],
  ] as const)("%s «%s» is refused", (language, lead) => {
    expect(verdict(language, lead).ok).toBe(false);
  });
  it("a listed phrase passes in both languages (control)", () => {
    expect(verdict("ru", "Спасибо, что написали!").ok).toBe(true);
    expect(verdict("tg", "Раҳмат, ки навиштед!").ok).toBe(true);
  });
});
