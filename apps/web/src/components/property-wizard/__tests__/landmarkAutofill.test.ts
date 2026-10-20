import { describe, expect, it } from "vitest";
import { nextLandmarkValue } from "../usePointLandmarks";

/** Поле «Ориентир» заполняется само, но правку агента не перетирает (25.09.2026). */
describe("nextLandmarkValue", () => {
  const A = "рядом ТЦ Садбарг, 400 м от ЦУМа";
  const B = "рядом Мехргон";

  it("пустое поле заполняется подсказкой", () => {
    expect(nextLandmarkValue("", null, A)).toBe(A);
  });

  it("свою прошлую подсказку сайт обновляет при сдвиге точки", () => {
    expect(nextLandmarkValue(A, A, B)).toBe(B);
  });

  it("текст агента не трогается", () => {
    expect(nextLandmarkValue("за Овиром", A, B)).toBeNull();
    expect(nextLandmarkValue(`${A}, второй подъезд`, A, B)).toBeNull();
  });

  it("возврат на шаг: поле совпадает с ответом по той же точке — менять нечего", () => {
    expect(nextLandmarkValue(A, null, A)).toBeNull();
  });

  it("рядом ничего нет — прошлая подсказка от другой точки стирается, текст агента остаётся", () => {
    expect(nextLandmarkValue(A, A, "")).toBe("");
    expect(nextLandmarkValue("за Овиром", A, "")).toBeNull();
    expect(nextLandmarkValue("", null, "")).toBeNull();
  });
});
