import { describe, expect, it } from "vitest";
import { cellVerdict, foldDemandSupply, median, roomsKey } from "../src/lib/demandSupply.js";

/**
 * Чистая свёртка «спрос против предложения» — без базы, на фикстурах.
 * Что держим: пустые данные не падают, ячейки с малой выборкой не получают
 * выводов, дефицит и избыток считаются по порогам из @royal-home/shared.
 */

const names = new Map([
  ["d1", "Сино"],
  ["d2", "Фирдавси"],
]);

const client = (districtId: string | null, rooms: number | null, budgetTjs: number | null = null) => ({
  districtId,
  rooms,
  budgetTjs,
});
const prop = (districtId: string | null, rooms: number | null, priceTjs = 500_000) => ({ districtId, rooms, priceTjs });
const many = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));

describe("roomsKey", () => {
  it("сводит четыре и больше комнат в «4+», нечисло и ноль — в null", () => {
    expect(roomsKey(1)).toBe("1");
    expect(roomsKey(3)).toBe("3");
    expect(roomsKey(4)).toBe("4+");
    expect(roomsKey(7)).toBe("4+");
    expect(roomsKey(0)).toBeNull();
    expect(roomsKey(null)).toBeNull();
    expect(roomsKey(Number.NaN)).toBeNull();
  });
});

describe("median", () => {
  it("пустой список — null, чётный — среднее двух средних", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 9, 3])).toBe(3);
    expect(median([10, 20, 30, 40])).toBe(25);
  });
});

describe("cellVerdict", () => {
  it("меньше трёх ищущих и мало квартир — «мало данных» и никакого коэффициента", () => {
    expect(cellVerdict(0, 4)).toEqual({ verdict: "low-data", ratio: null, lowDemand: false });
    expect(cellVerdict(2, 0)).toEqual({ verdict: "low-data", ratio: null, lowDemand: false });
    expect(cellVerdict(2, 4)).toEqual({ verdict: "low-data", ratio: null, lowDemand: false });
  });

  it("склад при малом спросе — «избыток» с пометкой lowDemand: от пяти квартир, а не от одной", () => {
    expect(cellVerdict(0, 12)).toEqual({ verdict: "surplus", ratio: 0, lowDemand: true });
    expect(cellVerdict(2, 12)).toEqual({ verdict: "surplus", ratio: 0.17, lowDemand: true });
    expect(cellVerdict(2, 5).verdict).toBe("surplus"); // граница: ровно пять
    expect(cellVerdict(2, 4).verdict).toBe("low-data");
  });

  it("при достаточном спросе lowDemand не ставится, «дефицит» малой выборки невозможен", () => {
    expect(cellVerdict(3, 10)).toEqual({ verdict: "surplus", ratio: 0.3, lowDemand: false });
    expect(cellVerdict(2, 0).verdict).not.toBe("shortage");
  });

  it("предложения нет, а ищут трое и больше — дефицит без деления на ноль", () => {
    expect(cellVerdict(3, 0)).toEqual({ verdict: "shortage", ratio: null, lowDemand: false });
  });

  it("границы порогов: 1.5 — уже дефицит, 0.67 — ещё избыток, между — поровну", () => {
    expect(cellVerdict(6, 4).verdict).toBe("shortage"); // 1.5
    expect(cellVerdict(5, 4).verdict).toBe("balanced"); // 1.25
    expect(cellVerdict(3, 3).verdict).toBe("balanced"); // 1
    expect(cellVerdict(4, 6).verdict).toBe("surplus"); // 0.666…
  });
});

describe("foldDemandSupply", () => {
  it("пустые данные дают пустую матрицу, а не ошибку", () => {
    const r = foldDemandSupply([], [], names);
    expect(r.cells).toEqual([]);
    expect(r.districts).toEqual([]);
    expect(r.shortage).toEqual([]);
    expect(r.surplus).toEqual([]);
    expect(r.totals).toEqual({ demandPlaced: 0, demandUnplaced: 0, supplyPlaced: 0, supplyUnplaced: 0 });
  });

  it("клиент без района или комнат, объект без района или комнат — вне матрицы, но посчитаны", () => {
    const r = foldDemandSupply(
      [client(null, 2), client("d1", null), client("d1", 2)],
      [prop(null, 2), prop("d1", null), prop("d1", 2)],
      names
    );
    expect(r.totals).toEqual({ demandPlaced: 1, demandUnplaced: 2, supplyPlaced: 1, supplyUnplaced: 2 });
    expect(r.cells).toHaveLength(1);
  });

  it("малая выборка (2 клиента) — «мало данных», даже если объектов нет вовсе", () => {
    const r = foldDemandSupply([client("d1", 2), client("d1", 2)], [], names);
    expect(r.cells).toHaveLength(1);
    expect(r.cells[0]).toMatchObject({ demand: 2, supply: 0, verdict: "low-data", ratio: null });
    expect(r.shortage).toEqual([]);
  });

  it("склад при малом спросе попадает в «слишком много предложения» с пометкой, после обычного избытка по весу", () => {
    // 12 квартир, ищет 1 → избыток 11 (lowDemand); 10 квартир, ищут 3 → обычный избыток 7.
    const r = foldDemandSupply(
      [client("d1", 2), ...many(3, () => client("d1", 3))],
      [...many(12, () => prop("d1", 2)), ...many(10, () => prop("d1", 3))],
      names
    );
    expect(r.cells.find((c) => c.rooms === "2")).toMatchObject({ verdict: "surplus", lowDemand: true, demand: 1, supply: 12 });
    expect(r.cells.find((c) => c.rooms === "3")).toMatchObject({ verdict: "surplus", lowDemand: false });
    expect(r.surplus.map((c) => c.rooms)).toEqual(["2", "3"]);
    expect(r.shortage).toEqual([]);
  });

  it("дефицит, избыток и «поровну» раскладываются по ячейкам; медианы — в сомони", () => {
    const clients = [
      // Сино, 2 комн.: ищут 6 (бюджеты 100..600), объектов 2 — дефицит
      ...many(6, (i) => client("d1", 2, (i + 1) * 100_000)),
      // Сино, 3 комн.: ищут 3, объектов 10 — избыток
      ...many(3, () => client("d1", 3, 800_000)),
      // Фирдавси, 1 комн.: ищут 4, объектов 4 — поровну
      ...many(4, () => client("d2", 1)),
    ];
    const properties = [
      ...many(2, (i) => prop("d1", 2, 300_000 + i * 100_000)),
      ...many(10, () => prop("d1", 3, 900_000)),
      ...many(4, () => prop("d2", 1)),
    ];
    const r = foldDemandSupply(clients, properties, names);

    const get = (d: string, rooms: string) => r.cells.find((c) => c.districtId === d && c.rooms === rooms)!;
    expect(get("d1", "2")).toMatchObject({
      demand: 6,
      supply: 2,
      ratio: 3,
      verdict: "shortage",
      demandMedianBudget: 350_000,
      supplyMedianPrice: 350_000,
      districtName: "Сино",
    });
    expect(get("d1", "3")).toMatchObject({ demand: 3, supply: 10, verdict: "surplus", ratio: 0.3 });
    expect(get("d2", "1")).toMatchObject({ demand: 4, supply: 4, verdict: "balanced", ratio: 1, demandMedianBudget: null });

    expect(r.shortage.map((c) => `${c.districtId}-${c.rooms}`)).toEqual(["d1-2"]);
    expect(r.surplus.map((c) => `${c.districtId}-${c.rooms}`)).toEqual(["d1-3"]);
    // Район с самым большим спросом идёт первым.
    expect(r.districts.map((d) => d.districtId)).toEqual(["d1", "d2"]);
    expect(r.districts[0]).toMatchObject({ demand: 9, supply: 12 });
  });

  it("в топе дефицита «нет предложения» острее любого коэффициента, топ — не больше пяти", () => {
    const clients = [
      ...many(4, () => client("d2", 4)), // предложения нет вовсе, ищут больше остальных
      ...many(10, () => client("d1", 1)), // 10 против 2 — коэффициент 5
      ...many(3, () => client("d1", 2)),
      ...many(3, () => client("d1", 3)),
      ...many(3, () => client("d2", 1)),
      ...many(3, () => client("d2", 2)),
    ];
    const properties = [prop("d1", 1), prop("d1", 1)];
    const r = foldDemandSupply(clients, properties, names);
    expect(r.shortage).toHaveLength(5);
    expect(r.shortage[0]).toMatchObject({ districtId: "d2", rooms: "4+", supply: 0, demand: 4 });
    // Остальные ячейки без предложения (ищут по трое) идут раньше коэффициента 5.
    expect(r.shortage.every((c) => c.supply === 0)).toBe(true);
  });

  it("район без названия в справочнике не роняет свёртку", () => {
    const r = foldDemandSupply(many(3, () => client("zz", 2)), [], names);
    expect(r.cells[0].districtName).toBe("Без названия");
  });
});
