import { describe, expect, it } from "vitest";
import { customerDmDialogueLanguage, customerDmLanguagePreference, resolveCustomerDmLanguage } from "../src/ai/customerDmLanguage.js";

describe("language request inside a sentence (audit 17.11.2026)", () => {
  it.each(["Пожалуйста, пишите по-таджикски", "Можно на таджикском?", "Привет! Можно мне на таджикском", "Здравствуйте, ответьте мне пожалуйста на таджикском языке",
    "Тоҷикӣ гап занед лутфан", "бо тоҷикӣ нависед", "Салом, тоҷикӣ нависед"])(
    "asks for Tajik: %s", text => expect(customerDmLanguagePreference(text)).toBe("tg"));
  it.each(["на русском пожалуйста", "Пожалуйста, пишите по-русски", "Можно на русском?", "Давайте на русском", "русӣ нависед", "бо русӣ нависед",
    "Салом, лутфан бо русӣ нависед", "бо забони русӣ гап занед", "Мне не понятно, говорите на русском"])(
    "asks for Russian: %s", text => expect(customerDmLanguagePreference(text)).toBe("ru"));
  it.each(["Я знаю русский", "Русский район есть?", "Квартира в русском районе", "Не пишите по-русски", "Умею писать на русском",
    "Можно посмотреть квартиру на русском проспекте", "По-русски или по-таджикски?", "Мой русский плохой"])(
    "is not a request: %s", text => expect(customerDmLanguagePreference(text)).toBeNull());
});

describe("an explicit request stays in force", () => {
  it("the next turns keep Tajik after the request, even over a full Russian sentence", () => {
    const history = ["Пожалуйста, пишите по-таджикски", "Здравствуйте, ищу двухкомнатную квартиру"];
    expect(resolveCustomerDmLanguage("А сколько это стоит в центре?", history)).toBe("tg");
    expect(customerDmDialogueLanguage(history)).toBe("tg");
  });
  it("a later request switches back", () => {
    const history = ["Пожалуйста, пишите по-таджикски", "Здравствуйте, ищу квартиру", "Лучше на русском"];
    expect(resolveCustomerDmLanguage("Сколько стоит?", history)).toBe("ru");
    expect(customerDmDialogueLanguage(history)).toBe("ru");
  });
});
