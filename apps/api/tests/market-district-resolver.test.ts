import { describe, expect, it } from "vitest";
import { pickDistrict } from "../src/lib/market/districtResolver.js";

const square: [number, number][] = [[68.7, 38.5], [68.8, 38.5], [68.8, 38.6], [68.7, 38.6], [68.7, 38.5]];

describe("pickDistrict", () => {
  it("точка внутри границы района — этот район", () => {
    const items = [{ name: "Сино", ring: square, lat: null, lng: null }, { name: "Фирдавси", ring: null, lat: 38.55, lng: 68.75 }];
    expect(pickDistrict(items, 38.55, 68.75)).toBe("Сино");
  });

  it("границы нет — ближайший по центру, но не дальше предела", () => {
    const items = [
      { name: "Сино", ring: null, lat: 38.55, lng: 68.75 },
      { name: "Шохмансур", ring: null, lat: 38.58, lng: 68.8 },
    ];
    expect(pickDistrict(items, 38.552, 68.752)).toBe("Сино");
    expect(pickDistrict(items, 39.5, 69.5)).toBeNull();
  });

  it("ничего не знаем о районах — null", () => {
    expect(pickDistrict([{ name: "Сино", ring: null, lat: null, lng: null }], 38.55, 68.75)).toBeNull();
  });
});
