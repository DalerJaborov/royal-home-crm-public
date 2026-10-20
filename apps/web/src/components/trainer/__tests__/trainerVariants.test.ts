import { describe, expect, it } from "vitest";
import { shownVariants } from "../trainerVariants";

/**
 * CHAT02: вариант ответа, посчитанный для карточки A, не уходит на карточку B
 * через горячую клавишу A/B (04.10.2026).
 */
describe("shownVariants", () => {
  const list = ["вариант 1", "вариант 2"];

  it("режим «Неверно» открыт на той же карточке: варианты доступны", () => {
    expect(shownVariants(true, list, "A", "A")).toEqual(list);
  });

  it("запоздавший ответ для A, текущая уже B: вариантов нет, хоткей не сработает", () => {
    expect(shownVariants(true, list, "A", "B")).toBeNull();
  });

  it("режим «Неверно» закрыт (Позже/другая карточка): вариантов нет", () => {
    expect(shownVariants(false, list, "A", "A")).toBeNull();
  });

  it("нет карточки или вариантов: null", () => {
    expect(shownVariants(true, null, "A", "A")).toBeNull();
    expect(shownVariants(true, list, "A", null)).toBeNull();
  });
});
