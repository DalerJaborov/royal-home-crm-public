import { describe, expect, it } from "vitest";
import { acceptedDateToSave } from "../acceptedDate";

/**
 * «Дата принятия объекта» (глубокая проверка 02.10.2026, F11): поле слало
 * PATCH на КАЖДОЕ изменение, а при наборе года с клавиатуры браузер выдаёт
 * промежуточные даты (0002, 0020, 0202) — серия запросов, и последним мог лечь
 * промежуточный. Теперь сохраняется по уходу из поля и только правдоподобная
 * дата, отличная от сохранённой.
 */
describe("acceptedDateToSave", () => {
  it("промежуточный год при наборе — не сохраняем", () => {
    expect(acceptedDateToSave("0202-09-15", null)).toBeNull();
    expect(acceptedDateToSave("0020-09-15", null)).toBeNull();
  });
  it("та же дата, что уже сохранена, — не сохраняем", () => {
    expect(acceptedDateToSave("2026-09-15", "2026-09-15")).toBeNull();
  });
  it("пусто — не сохраняем", () => {
    expect(acceptedDateToSave("", "2026-09-15")).toBeNull();
  });
  it("нормальная новая дата — сохраняем", () => {
    expect(acceptedDateToSave("2026-09-20", "2026-09-15")).toBe("2026-09-20");
  });
});
