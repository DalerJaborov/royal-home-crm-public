import { describe, expect, it } from "vitest";
import { geoMatchKey } from "../src/lib/geoNormalize.js";
import { isGenericLandmarkName, landmarkNamesLookAlike } from "../src/lib/landmarkDedup.js";

const alike = (a: string, b: string) => landmarkNamesLookAlike(geoMatchKey(a), geoMatchKey(b));

describe("склейка дублей ориентиров (02.10.2026, проба на живом справочнике)", () => {
  it("одно место разными написаниями склеивается", () => {
    expect(alike("Bozori Korvon", "Корвон")).toBe(true);
    expect(alike("ТЦ Мехргон", "Мехргон")).toBe(true);
    expect(alike("Bekhzoda National Museum", "Bekhzod National Museum")).toBe(true);
    expect(alike("Школа №77", "№77")).toBe(true);
  });

  it("разные номера — разные места", () => {
    expect(alike("Конечная маршрутки №12", "Конечная маршрутки №25")).toBe(false);
    expect(alike("Hospital №2", "Hospital №9")).toBe(false);
    expect(alike("Неврологическое отделение #1", "Неврологическое отделение #2")).toBe(false);
  });

  it("одно слово другое — не опечатка", () => {
    expect(alike("Вазорати адлия", "Вазорати молия")).toBe(false);
  });

  it("общее слово вместо имени не склеивается ни с чем", () => {
    expect(isGenericLandmarkName("Стадион")).toBe(true);
    expect(isGenericLandmarkName("Гостиница")).toBe(true);
    expect(isGenericLandmarkName("Стадион Истиклол")).toBe(false);
  });
});
