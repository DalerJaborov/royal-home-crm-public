import { describe, expect, it } from "vitest";
import { formatSomonCard } from "../src/lib/somonLeads/card.js";

const card = { title: "2-комн. квартира", price: "800 000 c.", location: "Сино", sourceUrl: "https://somon.tj/adv/123_example/", assessment: "likely_owner" as const, dateUncertain: false };
describe("Somon message card", () => {
  it("includes a WhatsApp link without claiming registration", () => {
    const text = formatSomonCard({ ...card, phone: "+992 900 000 000" });
    expect(text).toContain("https://wa.me/992900000000");
    expect(text).toContain("Вероятно собственник");
  });
  it("does not generate a link from an invalid number", () => {
    expect(formatSomonCard({ ...card, phone: "123" })).not.toContain("wa.me");
  });
  it("normalizes local and international phone forms", () => {
    expect(formatSomonCard({ ...card, phone: "992900000000" })).toContain("https://wa.me/992900000000");
    expect(formatSomonCard({ ...card, phone: "0900000000" })).toContain("https://wa.me/992900000000");
  });
  it("keeps the source link and number within Telegram photo caption limits", () => {
    const sourceUrl = `https://somon.tj/adv/123_${"x".repeat(180)}/`;
    const text = formatSomonCard({ ...card, title: "x".repeat(500), location: "x".repeat(500), price: "9".repeat(120), sourceUrl, phone: "+992900000000" });
    expect(text.length).toBeLessThanOrEqual(1024);
    expect(text).toContain(sourceUrl);
    expect(text).toContain("+992900000000");
  });
  it("rejects a non-Somon URL", () => {
    expect(() => formatSomonCard({ ...card, phone: null, sourceUrl: "https://somon.tj.example.com/adv/123" })).toThrow();
  });
  it("clearly separates an advert with an uncertain date", () => {
    const text = formatSomonCard({ ...card, phone: null, dateUncertain: true });
    expect(text).toContain("Проверить дату");
    expect(text).not.toContain("НОВОЕ ОБЪЯВЛЕНИЕ");
  });
});
