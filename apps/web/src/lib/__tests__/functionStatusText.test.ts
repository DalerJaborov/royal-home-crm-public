import { describe, expect, it } from "vitest";
import { plainFunctionText } from "../functionStatusText";

describe("«Состояние функций»: без имён моделей, запросов и ключей (К17)", () => {
  it("отказ ИИ после повтора — по-человечески", () => {
    expect(plainFunctionText("Gemini не ответил (marketing-insights), повтор тоже не помог")).toBe("ИИ не ответил, повтор тоже не помог");
    expect(plainFunctionText("Gemini не ответил (chat), повтор тоже не помог")).toBe("ИИ не ответил, повтор тоже не помог");
  });
  it("имена моделей и внутренних запросов не доходят до экрана", () => {
    const out = plainFunctionText("Ошибка gemini-2.5-flash-lite (call-analysis): quota exceeded");
    expect(out).not.toMatch(/gemini|call-analysis/i);
    expect(plainFunctionText("Claude вернул отказ")).toBe("ИИ вернул отказ");
  });
  it("имена переменных и ключи прячутся", () => {
    expect(plainFunctionText("Тумблер включён, но переменная GEMINI_API_KEY на сервере не задана.")).toBe("Тумблер включён, но настройка сервера на сервере не задана.");
    // Ключ-образец собирается из частей, чтобы сторож секретов не принял тестовую строку за настоящий ключ.
    const fakeKey = ["AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"].join("");
    expect(plainFunctionText(`Ключ ${fakeKey} недействителен`)).not.toContain("AIza");
    expect(plainFunctionText("ошибка API key")).toBe("ошибка ключ доступа");
  });
  it("обычный текст не трогаем", () => {
    for (const ok of ["ещё не было", "Фото объектов в чате", "Сервер не ответил вовремя. Попробуйте ещё раз."]) expect(plainFunctionText(ok)).toBe(ok);
    expect(plainFunctionText(null)).toBe("");
  });
});
