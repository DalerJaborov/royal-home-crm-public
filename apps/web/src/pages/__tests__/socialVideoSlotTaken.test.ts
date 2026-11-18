import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/apiError";
import { slotTakenOf } from "../socialVideos/helpers";

/**
 * Время свободного ролика занято другой публикацией (19.11.2026): сервер отвечает 409 с кодом SLOT_TAKEN и ближайшим
 * свободным временем — экран показывает выбор («выйти в …» или «оставить моё время»). Любой другой отказ — обычная ошибка.
 */
describe("slotTakenOf", () => {
  it("узнаёт 409 SLOT_TAKEN и отдаёт текст сервера и подсказку", () => {
    const err = new ApiError("В 14:00 уже выходит ролик объекта, ближайшее свободное время — 15:30.", 409, {
      code: "SLOT_TAKEN",
      suggestedAt: "2026-12-01T10:30:00.000Z",
    });
    expect(slotTakenOf(err)).toEqual({ message: err.message, suggestedAt: "2026-12-01T10:30:00.000Z" });
  });

  it("другой 409, другой статус, чужая ошибка и ответ без подсказки — не «время занято»", () => {
    expect(slotTakenOf(new ApiError("Ролик уже публикуется", 409, { error: "x" }))).toBeNull();
    expect(slotTakenOf(new ApiError("Неверное время", 422, { code: "SLOT_TAKEN", suggestedAt: "2026-12-01T10:30:00.000Z" }))).toBeNull();
    expect(slotTakenOf(new ApiError("x", 409, { code: "SLOT_TAKEN" }))).toBeNull();
    expect(slotTakenOf(new Error("boom"))).toBeNull();
    expect(slotTakenOf(null)).toBeNull();
  });
});
