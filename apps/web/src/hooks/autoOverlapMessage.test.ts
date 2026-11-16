import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/apiError";
import { autoOverlapMessage } from "./useFinance";

/** Форма расхода узнаёт отказ «уже учтено автоматически» только по коду сервера (14.11.2026). */
describe("autoOverlapMessage", () => {
  it("409 с кодом AUTO_EXPENSE_OVERLAP — текст сервера для человека", () => {
    const text = "Этот расход, похоже, уже учтён автоматически: Реклама Meta за октябрь 2026, 905,92 $.";
    expect(autoOverlapMessage(new ApiError(text, 409, { error: text, code: "AUTO_EXPENSE_OVERLAP" }))).toBe(text);
  });

  it("другие отказы и обычные ошибки — не про это", () => {
    expect(autoOverlapMessage(new ApiError("Нет курса", 409, { error: "Нет курса", code: "NO_USD_RATE" }))).toBeNull();
    expect(autoOverlapMessage(new ApiError("Неверные данные", 400, { error: "Неверные данные", code: "AUTO_EXPENSE_OVERLAP" }))).toBeNull();
    expect(autoOverlapMessage(new Error("сеть"))).toBeNull();
    expect(autoOverlapMessage(null)).toBeNull();
  });
});
