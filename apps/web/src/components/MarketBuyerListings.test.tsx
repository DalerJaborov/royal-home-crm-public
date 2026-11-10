import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MarketBuyerListing, MarketBuyerListingsResponse } from "@royal-home/shared";
import { MarketBuyerListingsView } from "./MarketBuyerListings";

const listing = (i: number): MarketBuyerListing => ({
  source: i % 2 ? "paydo.tj" : "somon.tj", sourceUrl: `https://somon.tj/adv/${i}`, title: `Квартира ${i}`, priceTjs: 600000 + i,
  pricePerSqmTjs: 9500, areaSqm: 60 + i, rooms: 2, floor: 3, totalFloors: 9, districtName: "Сино",
  publishedAt: "2026-11-08T10:00:00.000Z", fit: ["в бюджете"],
});
const ok = (n: number, over: Partial<MarketBuyerListingsResponse> = {}): MarketBuyerListingsResponse => ({
  status: "ok", criteria: ["район Сино", "2-комнатные"], total: n, budgetMaxTjs: 700000, listings: Array.from({ length: n }, (_, i) => listing(i)), ...over,
});

describe("MarketBuyerListingsView", () => {
  it("подписывает, что объявления чужие, и называет площадку, цену и ссылку", () => {
    const html = renderToStaticMarkup(<MarketBuyerListingsView data={ok(2)} />);
    expect(html).toContain("С площадок (Somon/Paydo)");
    expect(html).toContain("не наши объекты");
    expect(html.match(/Чужое/g)).toHaveLength(2);
    expect(html).toContain('href="https://somon.tj/adv/0"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Somon");
    expect(html).toContain("Paydo");
    expect(html).toContain("район Сино, 2-комнатные");
  });

  it("говорит, что показано ближайшее, если подходящих больше", () => {
    expect(renderToStaticMarkup(<MarketBuyerListingsView data={ok(10, { total: 27 })} />)).toContain("Показаны ближайшие 10 из 27");
  });

  it("без пожеланий и без объявлений — человеческие пустые состояния; для не покупателя секции нет", () => {
    expect(renderToStaticMarkup(<MarketBuyerListingsView data={ok(0, { status: "no_criteria" })} />)).toContain("Укажите район или бюджет");
    expect(renderToStaticMarkup(<MarketBuyerListingsView data={ok(0)} />)).toContain("нет подходящих объявлений");
    expect(renderToStaticMarkup(<MarketBuyerListingsView data={ok(0, { status: "not_buyer" })} />)).toBe("");
    expect(renderToStaticMarkup(<MarketBuyerListingsView data={ok(0, { status: "pending_acceptance" })} />)).toBe("");
  });
});
