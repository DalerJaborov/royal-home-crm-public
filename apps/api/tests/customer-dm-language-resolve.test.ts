import { describe, expect, it } from "vitest";
import { clientLanguageScores, detectClientLanguage } from "../src/ai/clientLanguage.js";
import { isNeutralShortReply, resolveCustomerDmLanguage } from "../src/ai/customerDmLanguage.js";

const RU = "Здравствуйте, сколько стоит квартира в центре?";
const TG = "Салом, мехоҳам хона харам, нархаш чанд аст?";

describe("dialogue language across turns", () => {
  it("RU -> bare link -> RU", () => {
    expect(resolveCustomerDmLanguage("https://www.instagram.com/reel/DAbc123xyz/", [RU])).toBe("ru");
    expect(resolveCustomerDmLanguage("@dalerj", [RU])).toBe("ru");
  });
  it("TG -> bare link -> TG", () => {
    expect(resolveCustomerDmLanguage("https://www.instagram.com/reel/DAbc123xyz/", [TG])).toBe("tg");
  });
  it("TG -> 'Кор' -> TG, RU -> 'Кор' follows the Tajik word", () => {
    expect(resolveCustomerDmLanguage("Кор", [TG])).toBe("tg");
    expect(resolveCustomerDmLanguage("Кор", [RU])).toBe("tg");
  });
  it("TG -> 'я не понимаю русский' -> TG, and it stays Tajik afterwards", () => {
    expect(resolveCustomerDmLanguage("Я не понимаю русский", [RU])).toBe("tg");
    expect(resolveCustomerDmLanguage("Спасибо", [RU, "Я не понимаю русский"])).toBe("tg");
    expect(resolveCustomerDmLanguage("ок", [RU, "Я не понимаю русский", "Мехоҳам хона"])).toBe("tg");
  });
  it("a short neutral reply does not switch the language", () => {
    expect(resolveCustomerDmLanguage("Спасибо", [TG])).toBe("tg");
    expect(resolveCustomerDmLanguage("Рахмат", [RU])).toBe("ru");
    expect(resolveCustomerDmLanguage("Салом", [RU])).toBe("ru");
    expect(resolveCustomerDmLanguage("Добрый день", [TG])).toBe("tg");
    expect(resolveCustomerDmLanguage("Да", [TG])).toBe("tg");
    expect(resolveCustomerDmLanguage("Спасибо", [TG, "Спасибо", "Привет"])).toBe("tg");
  });
  it("a neutral reply with no history keeps its own language", () => {
    expect(resolveCustomerDmLanguage("Спасибо")).toBe("ru");
    expect(resolveCustomerDmLanguage("Рахмат")).toBe("tg");
    expect(resolveCustomerDmLanguage("Асалом")).toBe("tg");
    expect(resolveCustomerDmLanguage("https://www.instagram.com/reel/DAbc123xyz/")).toBe("ru");
  });
  it("a full sentence in the other language switches the dialogue", () => {
    expect(resolveCustomerDmLanguage("Мехоҳам хона харам, нархаш чанд аст?", [RU])).toBe("tg");
    expect(resolveCustomerDmLanguage("Сколько стоит квартира в центре?", [TG])).toBe("ru");
  });
  it("an unreadable turn keeps the earlier decisive language, never the bot's", () => {
    expect(resolveCustomerDmLanguage("Сино", [TG])).toBe("tg");
    expect(resolveCustomerDmLanguage("Сино", [])).toBe("ru");
  });
  it("mixed without history goes by the larger word count, not by default to Russian", () => {
    const tajikHeavy = "Ман хочу хона, цена, чанд";
    expect(detectClientLanguage(tajikHeavy)).toBe("mixed");
    expect(clientLanguageScores(tajikHeavy).tajik).toBeGreaterThan(clientLanguageScores(tajikHeavy).russian);
    expect(resolveCustomerDmLanguage(tajikHeavy)).toBe("tg");
    const russianHeavy = "Ман хочу купить хона, цена";
    expect(detectClientLanguage(russianHeavy)).toBe("mixed");
    expect(clientLanguageScores(russianHeavy).russian).toBeGreaterThan(clientLanguageScores(russianHeavy).tajik);
    expect(resolveCustomerDmLanguage(russianHeavy)).toBe("ru");
  });
  it("neutral-reply detector", () => {
    expect(isNeutralShortReply("Спасибо!")).toBe(true);
    expect(isNeutralShortReply("Добрый день")).toBe(true);
    expect(isNeutralShortReply("👍 https://www.instagram.com/reel/DAbc123xyz/")).toBe(true);
    expect(isNeutralShortReply("Спасибо, а сколько стоит?")).toBe(false);
    expect(isNeutralShortReply("Кор")).toBe(false);
    expect(isNeutralShortReply("Нарх")).toBe(false);
  });
});
