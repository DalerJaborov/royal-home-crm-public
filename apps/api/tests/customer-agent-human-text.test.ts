import { describe, expect, it } from "vitest";
import { informalAddress, foreignLanguageWord, INFORMAL_RU_PRONOUNS, INFORMAL_RU_IMPERATIVES, INFORMAL_TG_PRONOUNS, INFORMAL_TG_IMPERATIVES,
  INFORMAL_TG_VERBS, RUSSIAN_WORDS_IN_TAJIK, TAJIK_WORDS_IN_RUSSIAN } from "../src/ai/customerAgentHumanText.js";
import { validateCustomerAgentSay } from "../src/ai/customerAgentSay.js";

/**
 * One list of words a model may never write to a customer (review #211, 16.11.2026): «ты» forms and mixed language.
 * Every list entry is tested, and so are the polite forms that must pass (owner rule: «вы» / «шумо» only).
 */
describe("«ты» is caught from the lists, in both languages", () => {
  it.each([...INFORMAL_RU_PRONOUNS, ...INFORMAL_RU_IMPERATIVES])("ru «%s»", word => {
    expect(informalAddress(`Хорошо, ${word} это.`, "ru")).not.toBeNull();
  });
  it.each(["хочешь", "можешь", "рассчитываешь", "ищешь", "звонишь", "смотришь", "решишь", "найдёшь", "сможешь", "определишься", "обратись", "стесняйся"])(
    "ru 2nd person verb «%s»", word => { expect(informalAddress(`Скажите, ${word}?`, "ru")).toBe(word); });
  it.each([...INFORMAL_TG_PRONOUNS, ...INFORMAL_TG_IMPERATIVES, ...INFORMAL_TG_VERBS])("tg «%s»", word => {
    expect(informalAddress(`Хуб, ${word} инро.`, "tg")).not.toBeNull();
  });
  it.each(["мехарӣ", "мефурӯшӣ", "мекунӣ", "намехоҳӣ", "гуфтӣ", "харидӣ", "фиристодӣ", "бигӯӣ", "бихарӣ"])("tg 2nd person verb «%s»", word => {
    expect(informalAddress(`Шумо ${word}`, "tg")).toBe(word);
  });
  it.each([
    ["ru", "Подскажите, сколько комнат вам нужно? Хотите, чтобы сотрудник вам позвонил? Можете написать. Лишь бы вам было удобно."],
    ["ru", "Напишите, пожалуйста, свяжитесь с нами, не стесняйтесь, обращайтесь, смотрите сами."],
    ["tg", "Бемалол бигӯед, чӣ қадар маблағ дар назар доред? Нависед, мехоҳед, мехаред ё мефурӯшед?"],
    ["tg", "Раҳмат барои меҳрубонӣ, нархаш бо сомонӣ, мебелӣ, шахсӣ, тоҷикӣ, тандурустӣ."],
  ] as const)("polite %s text passes: %s", (language, text) => {
    expect(informalAddress(text, language)).toBeNull();
  });
});

describe("a word of the other language is caught", () => {
  it.each(RUSSIAN_WORDS_IN_TAJIK)("Russian «%s» in a Tajik reply", word => {
    expect(foreignLanguageWord(`Фаҳмидам, ${word} хуб.`, "tg")).toBe(word);
  });
  it.each(TAJIK_WORDS_IN_RUSSIAN)("Tajik «%s» in a Russian reply", word => {
    expect(foreignLanguageWord(`Понимаю, ${word} вас.`, "ru")).toBe(word);
  });
  it("letters only one language has, and Latin", () => {
    expect(foreignLanguageWord("Фаҳмидам, цена", "tg")).toBe("цена");
    expect(foreignLanguageWord("Понимаю, қарор", "ru")).toBe("қарор");
    expect(foreignLanguageWord("Понимаю, okay", "ru")).toBe("okay");
  });
  it("clean replies pass", () => {
    expect(foreignLanguageWord("Раҳмат, ки навиштед! Чӣ қадар маблағ дар назар доред?", "tg")).toBeNull();
    expect(foreignLanguageWord("Ассалому алайкум! Агенти мо бемалол ёрдам медиҳад.", "tg")).toBeNull();
    expect(foreignLanguageWord("Понимаю вас. На какую сумму вы рассчитываете?", "ru")).toBeNull();
  });
});

describe("the short phrase channel (`say`) reads the same lists (bug class, review #211)", () => {
  const say = (text: string, language: "ru" | "tg" = "ru", inputText = "Вы работаете в Худжанде?") =>
    validateCustomerAgentSay({ say: text, language, surface: "dm", inputText, enabledLanguages: ["ru", "tg"] });
  it("«Да, в Худжанде тоже работаем» passed before because the customer named the city: now a fact claim", () => {
    expect(say("Да, в Худжанде тоже работаем.")).toEqual({ ok: false, reason: "fact_claim" });
  });
  it("«ты» and mixed language", () => {
    expect(say("Понял, хочешь квартиру.", "ru", "Ищу квартиру")).toEqual({ ok: false, reason: "rude" });
    expect(say("Хорошо, фаҳмидам.", "tg", "Хона мехарам")).toEqual({ ok: false, reason: "language" });
  });
  it("the say examples still pass", () => {
    expect(say("Спасибо, что рассказали о своей ситуации.", "ru", "Ищу квартиру").ok).toBe(true);
    expect(say("Фаҳмидам, шуморо ин объект ҷалб кардааст.", "tg", "Хона мехарам").ok).toBe(true);
  });
});
