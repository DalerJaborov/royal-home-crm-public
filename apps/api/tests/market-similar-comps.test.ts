import { describe, expect, it } from "vitest";
import {
  APARTMENT_RUNGS,
  dedupeAcrossSources,
  pickSimilar,
  rungWhere,
  verdictFor,
  type SimilarRow,
  type Subject,
} from "../src/lib/market/similarComps.js";

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

  it("Somon без признака дома подключается на ступени «без ремонта» и это сказано в основании", () => {
    const rows = [...many(3), ...many(9, { isNewBuilding: null, repair: null, source: "somon.tj" }).map((r, i) => ({ ...r, floor: 20 + i, sourceUrl: `https://example.tj/u${i}` }))];
    const r = pickSimilar(rows, subject);
    expect(r.level).toBe("no_repair_unknown_building");
    expect(r.sampleSize).toBe(12);
    expect(r.basis).toContain("без указанного типа дома");
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

describe("склейка дублей между площадками", () => {
  const twin = (i: number, source: string): SimilarRow => ({
    ...row(i), source, sourceUrl: `https://${source}/${i}`, areaSqm: 76 + i * 2, floor: 2 + i, priceTjs: 1_000_000 + i * 50_000, pricePerSqmTjs: 12_000 + i * 100,
  });

  it("5 квартир на двух площадках = 5, а не 10 → «данных мало»", () => {
    const rows = [...Array.from({ length: 5 }, (_, i) => twin(i, "somon.tj")), ...Array.from({ length: 5 }, (_, i) => ({ ...twin(i, "paydo.tj"), priceTjs: 1_020_000 + i * 50_000 }))];
    expect(dedupeAcrossSources(rows)).toHaveLength(5);
    const r = pickSimilar(rows, subject);
    expect(r.status).toBe("insufficient");
    expect(r.medianPerSqm).toBeNull();
  });

  it("8 уникальных + 8 их копий = 8: порог пройден, в основании уникальные и число склеенных", () => {
    const rows = [...Array.from({ length: 8 }, (_, i) => twin(i, "somon.tj")), ...Array.from({ length: 8 }, (_, i) => twin(i, "paydo.tj"))];
    const r = pickSimilar(rows, { ...subject, areaSqm: 83, floor: 5 });
    expect(r.status).toBe("ok");
    expect(r.sampleSize).toBe(8);
    expect(r.mergedDuplicates).toBe(8);
    expect(r.basis).toContain("8 уникальным");
  });

  it("не склеивает: разный этаж, цена дальше 5%, площадь дальше 3 м², та же площадка, район неизвестен", () => {
    const a = twin(1, "somon.tj");
    expect(dedupeAcrossSources([a, { ...twin(1, "paydo.tj"), floor: (a.floor ?? 0) + 1 }])).toHaveLength(2);
    expect(dedupeAcrossSources([a, { ...twin(1, "paydo.tj"), priceTjs: (a.priceTjs ?? 0) * 1.06 }])).toHaveLength(2);
    expect(dedupeAcrossSources([a, { ...twin(1, "paydo.tj"), areaSqm: (a.areaSqm ?? 0) + 3.5 }])).toHaveLength(2);
    expect(dedupeAcrossSources([a, { ...twin(1, "somon.tj"), sourceUrl: "https://somon.tj/other" }])).toHaveLength(2);
    expect(dedupeAcrossSources([{ ...a, districtName: null }, { ...twin(1, "paydo.tj"), districtName: null }])).toHaveLength(2);
    // этаж неизвестен у одной стороны — на склейку не влияет
    expect(dedupeAcrossSources([a, { ...twin(1, "paydo.tj"), floor: null }])).toHaveLength(1);
  });

  it("из пары остаётся первое — вызывающий ставит ближайшее к объекту первым", () => {
    const near = { ...twin(1, "paydo.tj"), title: "ближе" };
    const far = { ...twin(1, "somon.tj"), title: "дальше" };
    expect(dedupeAcrossSources([near, far]).map((r) => r.title)).toEqual(["ближе"]);
  });
});

describe("rungWhere: фильтры ступени уходят в запрос", () => {
  const ladder = Object.fromEntries(APARTMENT_RUNGS.map((r) => [r.name, r]));

  it("exact: комнаты, площадь ±15%, ремонт и признак дома", () => {
    const and = rungWhere(subject, ladder.exact);
    expect(and).toEqual([
      { rooms: 3 },
      { areaSqm: { gte: 80 * (1 - 0.15), lte: 80 * (1 + 0.15) } },
      { repair: "RENOVATED" },
      { isNewBuilding: true },
    ]);
  });

  it("no_repair_unknown_building: признак дома или null; no_area — только комнаты", () => {
    expect(rungWhere(subject, ladder.no_repair_unknown_building)).toContainEqual({ OR: [{ isNewBuilding: true }, { isNewBuilding: null }] });
    expect(rungWhere(subject, ladder.no_repair_unknown_building)).not.toContainEqual({ repair: "RENOVATED" });
    expect(rungWhere(subject, ladder.no_area)).toEqual([{ rooms: 3 }]);
  });

  it("неизвестные у объекта ремонт/признак дома не фильтруют", () => {
    expect(rungWhere({ ...subject, repair: null, isNewBuilding: null }, ladder.exact)).toEqual([
      { rooms: 3 },
      { areaSqm: { gte: 80 * (1 - 0.15), lte: 80 * (1 + 0.15) } },
    ]);
  });
});

describe("verdictFor (порог ±10% по ОКРУГЛЁННОЙ разнице)", () => {
  it("в рынке на границе, выше и ниже за ней", () => {
    expect(verdictFor(1_100_000, 1_000_000).verdict).toBe("market");
    expect(verdictFor(900_000, 1_000_000).verdict).toBe("market");
    expect(verdictFor(1_110_000, 1_000_000).verdict).toBe("above");
    expect(verdictFor(890_000, 1_000_000).verdict).toBe("below");
    expect(verdictFor(1_391_000, 1_109_000)).toEqual({ verdict: "above", diffPercent: 25 });
  });

  it("10,4% округляется до 10 → «в рынке», подпись и вердикт совпадают", () => {
    expect(verdictFor(1_104_000, 1_000_000)).toEqual({ verdict: "market", diffPercent: 10 });
    expect(verdictFor(896_000, 1_000_000)).toEqual({ verdict: "market", diffPercent: -10 });
  });

  it("10,5% округляется до 11 → «выше»; симметрично −10,5% → «ниже»", () => {
    expect(verdictFor(1_105_000, 1_000_000)).toEqual({ verdict: "above", diffPercent: 11 });
    expect(verdictFor(895_000, 1_000_000)).toEqual({ verdict: "below", diffPercent: -11 });
  });

  it("ноль и нет данных", () => {
    expect(verdictFor(1_000_000, 1_000_000)).toEqual({ verdict: "market", diffPercent: 0 });
    expect(verdictFor(null, 1)).toEqual({ verdict: "unknown", diffPercent: null });
    expect(verdictFor(1, null)).toEqual({ verdict: "unknown", diffPercent: null });
  });
});
