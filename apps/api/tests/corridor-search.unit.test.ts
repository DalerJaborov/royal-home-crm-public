import { describe, expect, it } from "vitest";
import {
  CORRIDOR_DEFAULT_WIDTH_M, CORRIDOR_MAX_WIDTH_M, clampCorridorWidth, corridorBoundingBox, distanceToSegmentM,
  parseCorridorPhrase, segmentLengthM,
} from "../src/lib/corridorSearch.js";

const A = { lat: 38.56, lng: 68.78 };
const B = { lat: 38.56, lng: 68.82 };

describe("полоса «от А до Б» — расстояние до отрезка", () => {
  it("точка над серединой отрезка: расстояние — перпендикуляр", () => {
    const d = distanceToSegmentM({ lat: 38.5636, lng: 68.8 }, A, B);
    expect(d).toBeGreaterThan(390);
    expect(d).toBeLessThan(410);
  });
  it("точка на отрезке — ноль; за концом — расстояние до ближайшего конца, а не до прямой", () => {
    expect(distanceToSegmentM({ lat: 38.56, lng: 68.8 }, A, B)).toBeLessThan(1);
    const beyond = distanceToSegmentM({ lat: 38.56, lng: 68.83 }, A, B);
    expect(beyond).toBeGreaterThan(850);
    expect(beyond).toBeLessThan(900);
  });
  it("ориентиры в одной точке — обычный круг; длина отрезка сходится", () => {
    expect(distanceToSegmentM({ lat: 38.5609, lng: 68.78 }, A, A)).toBeGreaterThan(95);
    expect(segmentLengthM(A, B)).toBeGreaterThan(3400);
    expect(segmentLengthM(A, B)).toBeLessThan(3600);
  });
  it("рамка накрывает оба конца с запасом; ширина ограничена", () => {
    const box = corridorBoundingBox(A, B, 800);
    expect(box.minLng).toBeLessThan(A.lng);
    expect(box.maxLng).toBeGreaterThan(B.lng);
    expect(clampCorridorWidth(undefined)).toBe(CORRIDOR_DEFAULT_WIDTH_M);
    expect(clampCorridorWidth(99_999)).toBe(CORRIDOR_MAX_WIDTH_M);
    expect(clampCorridorWidth(5)).toBe(200);
  });
});

describe("полоса — разбор фразы", () => {
  it.each([
    ["от цирка до автоцентра", "цирка", "автоцентра"],
    ["между Ашаном и Корвоном", "Ашаном", "Корвоном"],
    ["тарафи цирк то автоцентра", "цирк", "автоцентра"],
    ["аз цирк то автоцентр", "цирк", "автоцентр"],
  ])("«%s»", (text, from, to) => {
    expect(parseCorridorPhrase(text)).toEqual({ from, to });
  });
  it("обычный ориентир и русское «то» — не полоса", () => {
    expect(parseCorridorPhrase("около Ашана")).toBeNull();
    expect(parseCorridorPhrase("что то там")).toBeNull();
    expect(parseCorridorPhrase(undefined)).toBeNull();
  });
});
