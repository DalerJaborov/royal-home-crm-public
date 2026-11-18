import { describe, expect, it, vi } from "vitest";
vi.mock("../src/db.js", () => ({ prisma: { $disconnect: async () => {} } }));
import { customerDmDialogueLanguage, customerDmLanguagePreference, customerDmPinnedLanguageRequest, resolveCustomerDmLanguage } from "../src/ai/customerDmLanguage.js";
import { customerRentalAsked } from "../src/ai/customerAgentLiveWording.js";
import { watchdogLeadDraft } from "../src/lib/phoneLeadWatchdog.js";

describe("review 267: only explicit imperatives are pinned, question forms act for one turn", () => {
  it("«Вы говорите по-таджикски?» is not pinned", () => {
    const history = ["Вы говорите по-таджикски?", "Здравствуйте, ищу двухкомнатную квартиру"];
    expect(customerDmPinnedLanguageRequest("Вы говорите по-таджикски?")).toBeNull();
    expect(customerDmDialogueLanguage(history)).toBe("ru");
    expect(resolveCustomerDmLanguage("А сколько это стоит в центре?", history)).toBe("ru");
  });
  it("«Хуҷҷатҳо бо русӣ мешавад?» is not pinned", () => {
    const history = ["Хуҷҷатҳо бо русӣ мешавад?", "Хонаи дусола мехоҳам харам, нархаш чанд?"];
    expect(customerDmPinnedLanguageRequest(history[0])).toBeNull();
    expect(customerDmDialogueLanguage(history)).toBe("tg");
    expect(resolveCustomerDmLanguage("Нархаш чанд аст?", history)).toBe("tg");
  });
  it("a question still switches its own turn, an imperative is pinned", () => {
    expect(customerDmLanguagePreference("Можно на таджикском?")).toBe("tg");
    expect(customerDmPinnedLanguageRequest("Можно на таджикском?")).toBeNull();
    expect(customerDmPinnedLanguageRequest("Пожалуйста, пишите по-таджикски")).toBe("tg");
    expect(customerDmDialogueLanguage(["Тоҷикӣ гап занед", "Здравствуйте, ищу квартиру"])).toBe("tg");
  });
});

describe("review 267: payment context and word edges are not a stay", () => {
  it.each(["Есть рассрочка на 6 месяцев?", "Цена месяц назад была ниже", "Можно оплатить на полгода вперёд?", "Ипотека на 5 месяцев", "Оформление на пару месяцев по кредиту"])(
    "%s", text => expect(customerRentalAsked(text)).toBe(false));
  it("a real stay still counts", () => expect(customerRentalAsked("Квартира на пару месяцев")).toBe(true));
});

describe("review 267: phone watchdog follows the LAST buy/rent signal", () => {
  const history = (...texts: string[]) => texts.map(content => ({ role: "user" as const, content }));
  it("a long-time renter stays a renter", () => {
    expect(watchdogLeadDraft({ draft: null, coreTopic: null, history: history("Хочу снять квартиру", "Центр", "Двухкомнатную", "Этаж не первый", "Мой номер 900000001") }).intent).toBe("rent");
  });
  it("«снять → хотя нет, купить» is a buyer", () => {
    expect(watchdogLeadDraft({ draft: null, coreTopic: null, history: history("Хочу снять квартиру", "Хотя нет, хочу купить квартиру", "Мой номер 900000001") }).intent).not.toBe("rent");
  });
});
