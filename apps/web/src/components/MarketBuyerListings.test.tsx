import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MarketBuyerListing, MarketBuyerListingsResponse, MarketBuyerSummary } from "@royal-home/shared";
import { MarketBuyerListingsView, marketBuyerLineText } from "./MarketBuyerListings";

const listing = (i: number): MarketBuyerListing => ({
  source: i % 2 ? "paydo.tj" : "somon.tj", sourceUrl: `https://somon.tj/adv/${i}`, title: `Квартира ${i}`, priceTjs: 600000 + i,
  pricePerSqmTjs: 9500, areaSqm: 60 + i, rooms: 2, floor: 3, totalFloors: 9, districtName: "Сино",
  publishedAt: "2026-11-08T10:00:00.000Z",
});
const ok = (n: number, over: Partial<MarketBuyerListingsResponse> = {}): MarketBuyerListingsResponse => ({
  status: "ok", criteria: ["район Сино", "2-комнатные"], total: n, totalIsLowerBound: false, budgetMaxTjs: 700000, market: null, listings: Array.from({ length: n }, (_, i) => listing(i)), ...over,
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
    expect(renderToStaticMarkup(<MarketBuyerListingsView data={ok(10, { total: 27 })} />)).toContain("Показаны ближайшие 10 из 27.");
    expect(renderToStaticMarkup(<MarketBuyerListingsView data={ok(10, { total: 2000, totalIsLowerBound: true })} />)).toContain("из 2000+");
  });

  it("без пожеланий и без объявлений — человеческие пустые состояния; для не покупателя секции нет", () => {
    expect(renderToStaticMarkup(<MarketBuyerListingsView data={ok(0, { status: "no_criteria" })} />)).toContain("Укажите район или бюджет");
    expect(renderToStaticMarkup(<MarketBuyerListingsView data={ok(0)} />)).toContain("нет подходящих объявлений");
    expect(renderToStaticMarkup(<MarketBuyerListingsView data={ok(0, { status: "not_buyer" })} />)).toBe("");
    expect(renderToStaticMarkup(<MarketBuyerListingsView data={ok(0, { status: "pending_acceptance" })} />)).toBe("");
  });
});

const summary = (over: Partial<MarketBuyerSummary> = {}): MarketBuyerSummary => ({
  status: "ok", districtName: "Сино", rooms: 2, count: 12, minSample: 8, medianPerSqmTjs: 10450, medianPriceTjs: 627000,
  budgetTjs: 700000, budgetVsMedianPercent: 12, ...over,
});

describe("строка рынка над списком (14.11.2026)", () => {
  it("называет типичную цену, число объявлений и бюджет выше/ниже в процентах", () => {
    const up = marketBuyerLineText(summary()) ?? "";
    expect(up).toContain("Сино, 2-комнатные");
    expect(up).toMatch(/627[\s  ]000/);
    expect(up).toContain("по 12 объявл.");
    expect(up).toContain("Бюджет клиента на 12% выше типичной цены.");
    expect(marketBuyerLineText(summary({ budgetVsMedianPercent: -7 }))).toContain("на 7% ниже");
    expect(marketBuyerLineText(summary({ budgetVsMedianPercent: 0 }))).toContain("равен типичной цене");
    expect(marketBuyerLineText(summary({ budgetVsMedianPercent: null }))).not.toContain("Бюджет клиента");
  });

  it("мало данных: честная подпись без чисел цены; нет района/комнат — просьба уточнить", () => {
    const few = marketBuyerLineText(summary({ status: "insufficient", count: 3, medianPriceTjs: null, medianPerSqmTjs: null, budgetVsMedianPercent: null })) ?? "";
    expect(few).toContain("данных мало");
    expect(few).toContain("нужно от 8");
    expect(few).not.toMatch(/\d{3}[\s  ]\d{3}/);
    expect(marketBuyerLineText(summary({ status: "no_segment" }))).toContain("Укажите район и число комнат");
  });

  it("строка показывается над списком и пропадает, когда сервер market не прислал; «—» в тексте нет", () => {
    const withLine = renderToStaticMarkup(<MarketBuyerListingsView data={ok(1, { market: summary() })} />);
    expect(withLine).toContain('data-testid="market-buyer-line"');
    // Строка стоит над списком, а не под ним.
    expect(withLine.indexOf("market-buyer-line")).toBeLessThan(withLine.indexOf('class="list"'));
    // Тексты новой строки без «—» (старая подпись секции с тире не в счёте).
    for (const m of [summary(), summary({ status: "insufficient" }), summary({ status: "no_segment" })]) expect(marketBuyerLineText(m)).not.toContain("—");
    expect(renderToStaticMarkup(<MarketBuyerListingsView data={ok(1)} />)).not.toContain("market-buyer-line");
    // Строка видна и когда подходящих объявлений нет: рынок района известен.
    expect(renderToStaticMarkup(<MarketBuyerListingsView data={ok(0, { market: summary() })} />)).toContain("market-buyer-line");
  });
});
