import { describe, expect, it } from "vitest";
import { marketWhatsAppText, marketWhatsAppUrl } from "../marketWhatsApp";

describe("marketWhatsApp", () => {
  it("текст называет площадку и содержит ссылку", () => {
    const t = marketWhatsAppText("somon.tj", "3-комн. квартира", "https://somon.tj/adv/1");
    expect(t).toContain("Здравствуйте! Интересует объявление");
    expect(t).toContain("Somon");
    expect(t).toContain("https://somon.tj/adv/1");
  });

  it("номер в любом формате превращается в wa.me с кодом страны", () => {
    expect(marketWhatsAppUrl("+992 90 123 45 67", "a b")).toBe("https://wa.me/992901234567?text=a%20b");
    expect(marketWhatsAppUrl("901234567", "x")).toBe("https://wa.me/992901234567?text=x");
  });

  it("мусор вместо номера — null", () => {
    expect(marketWhatsAppUrl("12345", "x")).toBeNull();
    expect(marketWhatsAppUrl("", "x")).toBeNull();
  });
});
