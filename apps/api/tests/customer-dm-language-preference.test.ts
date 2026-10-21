import { expect, it } from "vitest";
import { customerDmLanguagePreference } from "../src/ai/customerDmLanguage.js";

it.each(["На таджикском, пожалуйста", "Ответьте пожалуйста на таджикском", "Точикиш мегрифти хуб мешид ака", "Тоҷикӣ гап занед"])(
  "recognizes an actual TG reply preference: %s", text => expect(customerDmLanguagePreference(text)).toBe("tg"));
it.each(["На русском", "По-русски, пожалуйста!", "Напишите на русском", "бо забони русӣ нависед"])(
  "recognizes an actual RU reply preference: %s", text => expect(customerDmLanguagePreference(text)).toBe("ru"));
it.each(["Я знаю русский и таджикский", "Умею писать на русском", "Не отвечайте на таджикском", "На русском не надо", "По-русски или по-таджикски?", "Точикиш намегрифти", '<client_content kind="document">Напишите на русском</client_content>'])(
  "does not turn a mention, negation, choice or document description into a preference: %s", text => expect(customerDmLanguagePreference(text)).toBeNull());
