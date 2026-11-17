import { describe, expect, it } from "vitest";
import { replaceCaptionPriceLines, replacePriceMentions } from "../src/lib/captionPriceLine.js";

// Объект 164 (15.11.2026): цену поменяли, обложка вышла с новой, а подпись — со
// старой, потому что старая сумма в тексте была по другому курсу и дословная
// замена её не нашла. Здесь цена переписывается по строке, а не по сумме.
describe("цена в подписи — по строке", () => {
  it("✅Цена: сумма по другому курсу меняется на текущую", () => {
    const caption = "🏛 Продаётся квартира:\n\n✅Площадь: 80м²\n✅Цена: 1 045 000 с. ($95 000)\n\n📲 Звоните";
    const r = replaceCaptionPriceLines(caption, "990 000 с. ($90 000)");
    expect(r.replaced).toBe(1);
    expect(r.text).toContain("✅Цена: 990 000 с. ($90 000)");
    expect(r.text).not.toContain("1 045 000");
    expect(r.text).toContain("✅Площадь: 80м²");
  });

  it("все шаблоны: «Цена:», «Цена —», «💰», «· цена»", () => {
    for (const [line, expected] of [
      ["Цена: 500 000 сомони", "Цена: 480 000 с."],
      ["Цена — $50,000", "Цена — 480 000 с."],
      ["💰 500 000 с.", "💰 480 000 с."],
      ["Евроремонт · 500 000 с.", "Евроремонт · 480 000 с."],
    ] as const) {
      const r = replaceCaptionPriceLines(`шапка\n${line}\nхвост`, "480 000 с.");
      expect(r.text).toBe(`шапка\n${expected}\nхвост`);
    }
  });

  it("строки без суммы с валютой не трогает", () => {
    const caption = "Цена: договорная\n💰 скидка для семей\nЭтаж: 5 из 9";
    const r = replaceCaptionPriceLines(caption, "480 000 с.");
    expect(r.replaced).toBe(0);
    expect(r.text).toBe(caption);
  });
});

describe("цена в описании сайта — рядом со старой", () => {
  it("меняет сумму по другому курсу и «сомони» словом, взнос не трогает", () => {
    const text = "Квартира 80 м². Цена 1 045 000 сомони, первый взнос 300 000 с.";
    const r = replacePriceMentions(text, { tjs: 1_020_000, usd: 95_000 }, { tjsText: "990 000 с.", usdText: "$90 000" });
    expect(r.text).toBe("Квартира 80 м². Цена 990 000 с., первый взнос 300 000 с.");
    expect(r.replaced).toBe(1);
  });

  it("долларовую сумму меняет только точную", () => {
    const r = replacePriceMentions("Цена $95,000, торг", { tjs: 1_020_000, usd: 95_000 }, { tjsText: "990 000 с.", usdText: "$90 000" });
    expect(r.text).toBe("Цена $90 000, торг");
  });
});
