import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MarketSegmentsResponse, MarketSegmentStat } from "@royal-home/shared";
import { MarketSegmentsView } from "./MarketSegments";

const seg = (over: Partial<MarketSegmentStat>): MarketSegmentStat => ({
  key: "Сино|2|RENOVATED", districtName: "Сино", rooms: 2, repair: "RENOVATED", count: 12, enough: true,
  medianPerSqmTjs: 13500, averagePerSqmTjs: 13900, medianPriceTjs: 810000, averagePriceTjs: 835000,
  freshestSeenAt: "2026-11-09T10:00:00.000Z", newLast7Days: 3, ...over,
});

const data = (segments: MarketSegmentStat[], over: Partial<MarketSegmentsResponse> = {}): MarketSegmentsResponse => ({
  minSample: 8, windowDays: 45, city: "Душанбе", truncated: false,
  sources: [{ source: "somon.tj", count: 30 }, { source: "paydo.tj", count: 10 }], segments, ...over,
});

describe("MarketSegmentsView", () => {
  it("сегмент с достаточной выборкой показывает типичную и среднюю цену, число объявлений и свежесть", () => {
    const html = renderToStaticMarkup(<MarketSegmentsView data={data([seg({})])} shown={30} onMore={() => {}} />);
    expect(html).toContain("Сино · 2 комн. · с ремонтом");
    expect(html).toContain("12 объявл.");
    expect(html).toContain("новых за неделю: 3");
    expect(html).toMatch(/13[\s\u00a0\u202f]500/);
    expect(html).toMatch(/810[\s\u00a0\u202f]000/);
    expect(html).not.toContain("Данных мало");
    expect(html).toContain("Somon 30 · Paydo 10");
  });

  it("сегмент меньше порога — «Данных мало» и никаких цифр цены", () => {
    const html = renderToStaticMarkup(
      <MarketSegmentsView
        data={data([seg({ count: 5, enough: false, repair: null, medianPerSqmTjs: null, averagePerSqmTjs: null, medianPriceTjs: null, averagePriceTjs: null })])}
        shown={30}
        onMore={() => {}}
      />
    );
    expect(html).toContain("Данных мало");
    expect(html).toContain("5 объявл.");
    expect(html).toContain("ремонт не указан");
    expect(html).toContain("нужно от 8");
    expect(html).not.toContain("/м²");
    expect(html).not.toContain("средняя");
  });

  it("список ограничен: лишнее прячется за «Показать ещё», пусто — понятная фраза", () => {
    const many = Array.from({ length: 5 }, (_, i) => seg({ key: `k${i}`, rooms: i + 1 }));
    const html = renderToStaticMarkup(<MarketSegmentsView data={data(many)} shown={3} onMore={() => {}} />);
    expect((html.match(/market-segment-row/g) ?? []).length).toBe(3);
    expect(html).toContain("Показать ещё · 2");
    expect(renderToStaticMarkup(<MarketSegmentsView data={data([])} shown={30} onMore={() => {}} />)).toContain("активных объявлений нет");
  });
});
