import { describe, expect, it } from "vitest";
import type { OwnerReportPeriod } from "@royal-home/shared";
import { periodTiles, reportDateTime, topicBarPercent, weekBars, weekChartSummary } from "../ownerReportView";

const period = (over: Partial<OwnerReportPeriod> = {}): OwnerReportPeriod => ({
  shownToClients: 9,
  contacts: 1,
  showings: 3,
  comments: 0,
  siteViews: null,
  ads: null,
  ...over,
});

describe("periodTiles", () => {
  it("всегда четыре базовых плитки, склонение по числу", () => {
    const tiles = periodTiles(period());
    expect(tiles.map((t) => t.key)).toEqual(["shown", "contacts", "showings", "comments"]);
    expect(tiles[1].label).toBe("контакт по объекту");
    expect(tiles[2].label).toBe("показа проведено");
    expect(tiles[3].label).toBe("комментариев под публикациями");
  });

  it("канал без данных не рисуется, а ноль с данными — рисуется", () => {
    expect(periodTiles(period()).some((t) => t.key === "site" || t.key === "adShows")).toBe(false);
    const withData = periodTiles(period({ siteViews: 0, ads: { impressions: 1200, inquiries: 4 } }));
    expect(withData.find((t) => t.key === "site")?.value).toBe(0);
    expect(withData.find((t) => t.key === "adShows")?.value).toBe(1200);
    expect(withData.find((t) => t.key === "adInquiries")?.label).toBe("обращения из рекламы");
  });
});

describe("weekBars", () => {
  it("высота — доля от пика, пустые недели — ноль, подпись ДД.ММ", () => {
    const { bars, total, peak } = weekBars([
      { weekStart: "2026-09-28", events: 0, people: 0 },
      { weekStart: "2026-10-05", events: 4, people: 2 },
      { weekStart: "2026-10-12", events: 2, people: 1 },
    ]);
    expect(bars.map((b) => b.ratio)).toEqual([0, 1, 0.5]);
    expect(bars[1].label).toBe("05.10");
    expect(total).toBe(6);
    expect(peak).toBe(4);
  });

  it("совсем пустая динамика не делит на ноль", () => {
    expect(weekBars([{ weekStart: "2026-10-05", events: 0, people: 0 }]).bars[0].ratio).toBe(0);
    expect(weekBars([]).peak).toBe(0);
  });
});

describe("тексты", () => {
  it("сводка графика для скринридера честна про тишину", () => {
    expect(weekChartSummary([{ weekStart: "2026-10-05", events: 0, people: 0 }])).toContain("не было");
    expect(
      weekChartSummary([
        { weekStart: "2026-09-28", events: 1, people: 1 },
        { weekStart: "2026-10-05", events: 4, people: 2 },
      ])
    ).toBe("Динамика интереса за 2 недели: всего 5 событий, пик за неделю — 4.");
  });

  it("полоса темы: самая частая — сто процентов, редкая не меньше шести", () => {
    const topics = [
      { key: "PRICE" as const, label: "Цена", count: 20 },
      { key: "FLOOR" as const, label: "Этаж", count: 1 },
    ];
    expect(topicBarPercent(topics, topics[0])).toBe(100);
    expect(topicBarPercent(topics, topics[1])).toBe(6);
  });

  it("дата по Душанбе, а не по часовому поясу браузера", () => {
    // 20:30 UTC = 01:30 следующего дня в Душанбе (UTC+5).
    expect(reportDateTime("2026-10-06T20:30:00.000Z")).toContain("7 октября 2026");
    expect(reportDateTime("не дата")).toBe("");
  });
});
