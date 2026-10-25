import { describe, expect, it } from "vitest";
import { customerPublicLanguage, isCustomerPublicAppreciation } from "../src/ai/customerAgentConversationPolicy.js";
import { customerColloquialTajikLanguage, resolveCustomerDmLanguage } from "../src/ai/customerDmLanguage.js";
import { wrapUntrusted } from "../src/ai/untrustedContent.js";

describe("customer core colloquial language", () => {
  it.each([
    "Схемаша партоен боша", "Фурухта шуд ё не?", "Шайнакш кичода бд", "Бехтарин макон🙌🔥",
    "Фурӯхта шуд?", "Планировкаша партоед",
  ])("recognizes an own Tajik request: %s", text => {
    expect(customerPublicLanguage(text)).toBe("tg");
    expect(resolveCustomerDmLanguage(text)).toBe("tg");
  });

  it.each([
    "Что означает «фурухта шуд»?", "Как сказать фурухта шуд по-русски?",
    "Здравствуйте, сколько стоит квартира?", "Пришлите схему квартиры",
  ])("does not replace a Russian request: %s", text => {
    expect(customerColloquialTajikLanguage(text)).toBe(false);
    expect(customerPublicLanguage(text)).toBe("ru");
  });

  it("does not take a document's words or a URL as the customer's language", () => {
    expect(customerColloquialTajikLanguage(wrapUntrusted("document", "фурухта шуд, схемаша партоен"))).toBe(false);
    expect(customerColloquialTajikLanguage("https://example.test/фурухта/шуд")).toBe(false);
  });

  it("retains the first greeting's language for an ambiguous follow-up", () => {
    expect(resolveCustomerDmLanguage("Алооооооооо", ["Салом"])).toBe("tg");
    expect(resolveCustomerDmLanguage("Алло", ["Здравствуйте"])).toBe("ru");
    expect(resolveCustomerDmLanguage("Сино", ["Асалому алайкум"])).toBe("tg");
  });

  it("does not let a later neutral greeting defeat a substantive language or explicit switch", () => {
    expect(resolveCustomerDmLanguage("Алло", ["Хочу купить квартиру", "Салом"])).toBe("ru");
    expect(resolveCustomerDmLanguage("Алло", ["Ман хона мехарам", "Здравствуйте"])).toBe("tg");
    expect(resolveCustomerDmLanguage("Ответьте на русском", ["Салом"])).toBe("ru");
  });

  it("treats a standalone positive place reaction as appreciation, not a catalog request", () => {
    expect(isCustomerPublicAppreciation("Бехтарин макон🙌🔥")).toBe(true);
    expect(isCustomerPublicAppreciation("Бехтарин макон, нархаш чанд?")).toBe(false);
  });
});
