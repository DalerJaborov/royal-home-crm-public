import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketBlockView, marketSourceName, scalePosition } from "./MarketBlock";
import type { MarketPropertyEstimate } from "../types";

const base: MarketPropertyEstimate = {
  subject: { districtName: "Сино", rooms: 3, areaSqm: 82, floor: 5, totalFloors: 9, repair: null, isNewBuilding: true, propertyType: "APARTMENT", askingPriceTjs: 1391000 },
  status: "ok",
  medianPerSqm: 13529, p25PerSqm: 11000, p75PerSqm: 14500,
  estimatedPriceTjs: 1109000, rangeLowTjs: 925000, rangeHighTjs: 1190000,
  sampleSize: 41, windowDays: 45, basis: "Сино, 3-комнатные, 70–94 м²", level: "exact",
  sources: [{ source: "somon.tj", count: 32 }, { source: "paydo.tj", count: 9 }],
  comparison: { verdict: "above", diffPercent: 25 },
  listings: Array.from({ length: 5 }, (_, i) => ({
    sourceUrl: `https://somon.tj/adv/${i}`, source: i % 2 ? "paydo.tj" : "somon.tj", title: `Объявление ${i}`,
    rooms: 3, areaSqm: 80 + i, floor: 5, totalFloors: 9, repair: "RENOVATED", isNewBuilding: true, buildingReady: true,
    districtName: "Сино", priceTjs: 1000000 + i * 10000, pricePerSqmTjs: 12500,
  })),
  moreCount: 36,
};

describe("MarketBlockView", () => {
  it("shows verdict, key figures, similar listings and basis for status ok", () => {
    const html = renderToStaticMarkup(<MarketBlockView data={base} />);
    expect(html).toContain("Рынок · Сино · 3 комн.");
    expect(html).toContain("Дорого");
    expect(html).toContain("+25%");
    expect(html).toContain("Просит владелец");
    expect(html).toContain("Середина рынка");
    expect(html).toContain("Вилка");
    expect(html).toContain("https://somon.tj/adv/0");
    expect(html).toContain("Paydo");
    expect(html).toContain("новостройка, сдан");
    expect(html).toContain("Ещё 38 похожих");
    expect(html).toContain("Основание: медиана по 41 объявлениям");
  });

  it("shows «В рынке» without a percent", () => {
    const html = renderToStaticMarkup(<MarketBlockView data={{ ...base, comparison: { verdict: "market", diffPercent: 3 } }} />);
    expect(html).toContain("В рынке");
    expect(html).not.toContain("+3%");
  });

  it("shows «Данных мало» without any price or verdict when insufficient", () => {
    const html = renderToStaticMarkup(
      <MarketBlockView data={{ ...base, status: "insufficient", sampleSize: 5, medianPerSqm: null, estimatedPriceTjs: null, comparison: null, listings: [] }} />,
    );
    expect(html).toContain("Данных мало");
    expect(html).not.toContain("Середина рынка");
    expect(html).not.toContain("Дорого");
    expect(html).not.toContain("1 109");
  });

  it("renders nothing for unsupported property types", () => {
    expect(renderToStaticMarkup(<MarketBlockView data={{ ...base, status: "unsupported" }} />)).toBe("");
  });

  it("maps sources and scale position sensibly", () => {
    expect(marketSourceName("somon.tj")).toBe("Somon");
    expect(marketSourceName("paydo.tj")).toBe("Paydo");
    expect(scalePosition(0)).toBe(50);
    expect(scalePosition(300)).toBe(96);
    expect(scalePosition(-300)).toBe(4);
  });
});
