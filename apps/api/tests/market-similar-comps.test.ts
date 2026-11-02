import { describe, expect, it } from "vitest";
import { pickSimilar, verdictFor, type SimilarRow, type Subject } from "../src/lib/market/similarComps.js";
import { comparePrice } from "../src/lib/market/comps.js";

const subject: Subject = {
  propertyType: "APARTMENT",
  districtName: "Сино",
  rooms: 3,
  areaSqm: 80,
  floor: 5,
  totalFloors: 9,
  repair: "RENOVATED",
  isNewBuilding: true,
};

function row(i: number, over: Partial<SimilarRow> = {}): SimilarRow {
  return {
    sourceUrl: `https://example.tj/${i}`,
    source: i % 4 === 0 ? "paydo.tj" : "somon.tj",
    title: `Квартира ${i}`,
    rooms: 3,
    areaSqm: 78 + (i % 5),
    floor: 3 + (i % 4),
    totalFloors: 9,
    repair: "RENOVATED",
    isNewBuilding: true,
    buildingReady: true,
    districtName: "Сино",
    priceTjs: 1_000_000 + i * 1000,
    pricePerSqmTjs: 12_500 + i * 10,
    ...over,
  };
}

const many = (n: number, over: Partial<SimilarRow> = {}) => Array.from({ length: n }, (_, i) => row(i, over));

describe("pickSimilar", () => {
  it("меньше MIN_SAMPLE — «данных мало», без числа и вердикта", () => {
    const r = pickSimilar(many(7), subject);
    expect(r.status).toBe("insufficient");
    expect(r.medianPerSqm).toBeNull();
    expect(r.estimatedPriceTjs).toBeNull();
    expect(r.listings).toEqual([]);
  });

  it("8 точных похожих — ступень exact, пять лучших и счётчик остальных", () => {
    const r = pickSimilar(many(12), subject);
    expect(r.status).toBe("ok");
    expect(r.level).toBe("exact");
    expect(r.sampleSize).toBe(12);
    expect(r.listings).toHaveLength(5);
    expect(r.moreCount).toBe(7);
    expect(r.sources.map((s) => s.source).sort()).toEqual(["paydo.tj", "somon.tj"]);
    expect(r.rangeLowTjs).toBeLessThan(r.estimatedPriceTjs!);
    expect(r.rangeHighTjs).toBeGreaterThan(r.estimatedPriceTjs!);
  });

  it("другой ремонт не попадает в exact, лестница отпускает ремонт", () => {
    const rows = [...many(3), ...many(10, { repair: "SHELL" }).map((r, i) => ({ ...r, sourceUrl: `https://example.tj/s${i}` }))];
    const r = pickSimilar(rows, subject);
    expect(r.level).toBe("no_repair");
    expect(r.sampleSize).toBe(13);
  });

  it("старый фонд не смешивается с новостройкой, пока хватает данных", () => {
    const rows = [...many(8), ...many(10, { isNewBuilding: false, pricePerSqmTjs: 7000 })];
    const r = pickSimilar(rows, subject);
    expect(r.level).toBe("exact");
    expect(r.medianPerSqm).toBeGreaterThan(12_000);
  });

  it("дворец 400 м² не оценивается по типовым квартирам", () => {
    const r = pickSimilar(many(20), { ...subject, areaSqm: 400, rooms: 3 });
    expect(r.status).toBe("insufficient");
  });

  it("известный признак дома у объекта null — не фильтруем по нему", () => {
    const r = pickSimilar(many(8, { isNewBuilding: null }), { ...subject, isNewBuilding: null });
    expect(r.status).toBe("ok");
  });
});

describe("verdictFor (порог ±10%)", () => {
  it("в рынке на границе, выше и ниже за ней", () => {
    expect(verdictFor(1_100_000, 1_000_000).verdict).toBe("market");
    expect(verdictFor(900_000, 1_000_000).verdict).toBe("market");
    expect(verdictFor(1_110_000, 1_000_000).verdict).toBe("above");
    expect(verdictFor(890_000, 1_000_000).verdict).toBe("below");
    expect(verdictFor(1_391_000, 1_109_000)).toEqual({ verdict: "above", diffPercent: 25 });
  });

  it("нет цены или оценки — unknown", () => {
    expect(verdictFor(null, 1)).toEqual({ verdict: "unknown", diffPercent: null });
    expect(verdictFor(1, null)).toEqual({ verdict: "unknown", diffPercent: null });
  });

  it("comparePrice (клиентская карточка) использует тот же порог", () => {
    const comps = { estimatedPriceTjs: 1_000_000 } as never;
    expect(comparePrice(1_090_000, comps).verdict).toBe("market");
    expect(comparePrice(1_120_000, comps).verdict).toBe("above");
  });
});
