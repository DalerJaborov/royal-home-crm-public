import { describe, it, expect } from "vitest";
import { ApiError } from "../../lib/apiError";
import { liveVoiceListErrorText, previewText } from "../LiveVoiceSessions";

/**
 * Список разговоров живого голоса (аудит роботов №6 и №25, 02.10.2026): отказ по
 * правам не должен читаться как «сбой связи», а многоточие ставится только у
 * действительно обрезанной (сервер режет на 300 знаках) расшифровки.
 */
describe("liveVoiceListErrorText", () => {
  it("403 — «нет прав», а не сбой связи", () => {
    const text = liveVoiceListErrorText(new ApiError("Недостаточно прав", 403, undefined));
    expect(text).toMatch(/Нет прав/);
    expect(text).not.toMatch(/сбой связи/);
  });

  it("500 и сетевая ошибка — прежний «сбой связи»", () => {
    expect(liveVoiceListErrorText(new ApiError("Ошибка запроса: 500", 500, undefined))).toMatch(/сбой связи/);
    expect(liveVoiceListErrorText(new TypeError("Failed to fetch"))).toMatch(/сбой связи/);
    expect(liveVoiceListErrorText(null)).toMatch(/сбой связи/);
  });
});

describe("previewText", () => {
  it("короткая расшифровка — без многоточия", () => {
    expect(previewText("Клиент: Алло")).toBe("Клиент: Алло");
  });

  it("обрезанная на 300 знаках — с многоточием", () => {
    const cut = "а".repeat(300);
    expect(previewText(cut)).toBe(`${cut}…`);
  });
});
