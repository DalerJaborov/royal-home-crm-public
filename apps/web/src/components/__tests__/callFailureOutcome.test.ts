import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/apiError";
import { callFailureOutcome } from "../CallClientButton";

/**
 * Кнопка звонка при 502/503/504 (глубокая проверка 02.10.2026, F13).
 *
 * 502 отдаёт и сама станция (тело с причиной от нашего сервера), и прокси
 * перед сервером, когда API перезапускается при выкате (тела нет или там
 * HTML). Раньше оба случая писали «Нет связи с телефонной станцией» и сбрасывали
 * ВЕСЬ кэш — в момент, когда сервер поднимается, это лавина перезапросов.
 */
describe("callFailureOutcome", () => {
  it("станция ответила отказом — текст про станцию и перечитать данные", () => {
    const err = new ApiError("Bad Gateway", 502, { error: "ARI недоступен" });
    const out = callFailureOutcome(err);
    expect(out.text).toMatch(/телефонной станцией/);
    expect(out.text).toMatch(/ARI недоступен/);
    expect(out.refresh).toBe(true);
  });

  it("502 без тела от нашего сервера — сервер CRM недоступен, кэш не трогаем", () => {
    const err = new ApiError("Bad Gateway", 502, "<html>502</html>");
    const out = callFailureOutcome(err);
    expect(out.text).not.toMatch(/телефонной станцией/);
    expect(out.text).toMatch(/сервер/i);
    expect(out.refresh).toBe(false);
  });
});
