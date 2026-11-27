import { describe, expect, it } from "vitest";
import { gaugePoint, gaugeView, lostTotal, planPercent, sourceColumns, SLOW_FIRST_TOUCH_MIN } from "./model";

/** Правила главной руководителя (пачка home2): шкала скорости, столбики заявок, потери, процент плана. */
describe("шкала скорости ответа", () => {
  it("нет медианы — шкалы нет (а не «0 мин»)", () => {
    expect(gaugeView(null)).toBeNull();
    expect(gaugeView(undefined)).toBeNull();
    expect(gaugeView(Number.NaN)).toBeNull();
  });
  it("порог — существующий в CRM «дольше часа», а не выдуманная норма", () => {
    expect(SLOW_FIRST_TOUCH_MIN).toBe(60);
    expect(gaugeView(13)).toEqual({ share: 13 / 60, tone: "ok", verdict: "быстрее часа" });
    expect(gaugeView(60)?.tone).toBe("ok");
    expect(gaugeView(61)).toEqual({ share: 1, tone: "crit", verdict: "дольше часа" });
    expect(gaugeView(0)?.share).toBe(0);
  });
  it("точка стрелки идёт по дуге слева направо", () => {
    expect(gaugePoint(0)).toEqual({ x: 20, y: 100 });
    expect(gaugePoint(0.5)).toEqual({ x: 100, y: 20 });
    expect(gaugePoint(1)).toEqual({ x: 180, y: 100 });
    expect(gaugePoint(5)).toEqual(gaugePoint(1));
  });
});

describe("столбики «Заявки»", () => {
  const row = (source: string, leads: number) => ({ source, label: source, leads, deals: 0, commission: null });
  it("четыре крупнейших источника, остальные одной суммой; самый крупный отмечен", () => {
    const out = sourceColumns([row("A", 2), row("B", 21), row("C", 0), row("D", 9), row("E", 14), row("F", 7), row("G", 3)]);
    expect(out.columns.map((c) => [c.source, c.leads, c.top])).toEqual([["B", 21, true], ["E", 14, false], ["D", 9, false], ["F", 7, false]]);
    expect(out.columns[1]!.share).toBeCloseTo(14 / 21);
    expect(out).toMatchObject({ restLeads: 5, restCount: 2 });
  });
  it("пусто — пусто, без деления на ноль", () => {
    expect(sourceColumns([row("A", 0)])).toEqual({ columns: [], restLeads: 0, restCount: 0 });
  });
  it("потеряно — сумма причин отказа", () => {
    expect(lostTotal({ lossReasons: [{ reason: "a", label: "a", count: 3 }, { reason: "b", label: "b", count: 4 }] })).toBe(7);
    expect(lostTotal({ lossReasons: [] })).toBe(0);
  });
});

describe("процент плана", () => {
  it("только при настоящем плане", () => {
    expect(planPercent(48200, 60000, false)).toBe(80);
    expect(planPercent(48200, 8000, true)).toBeNull();
    expect(planPercent(100, 0, false)).toBeNull();
    expect(planPercent(100, null, false)).toBeNull();
  });
});
