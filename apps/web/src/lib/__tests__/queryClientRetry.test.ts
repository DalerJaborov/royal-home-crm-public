import { describe, expect, it } from "vitest";
import { isTransientFailure, retryDelayFor } from "../queryClient";
import { ApiError } from "../apiError";

/**
 * Разбор 19.09.2026 («то дашборд не грузится, то чаты»). Выкат пересоздаёт
 * контейнеры, и на десятки секунд API отвечает 502/503 или не отвечает вовсе.
 * Такой отказ обязан повторяться сам, иначе агент видит «не загрузилось» при
 * живом сервере. А 429 и обычные 4xx повторять нельзя: 429 добьёт то же окно
 * лимитера, остальные от повтора не изменятся.
 */
describe("что считается временным отказом", () => {
  it("перезапуск и перегрузка сервера — повторяем", () => {
    for (const status of [408, 425, 500, 502, 503, 504]) {
      expect(isTransientFailure(new ApiError("", status, null))).toBe(true);
    }
  });

  it("обрыв связи (fetch бросает TypeError без статуса) — повторяем", () => {
    expect(isTransientFailure(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("429 не повторяем: повтор добивает то же окно лимитера", () => {
    expect(isTransientFailure(new ApiError("Слишком много запросов", 429, null))).toBe(false);
  });

  it("обычные ответы клиенту не повторяем", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 423, 428]) {
      expect(isTransientFailure(new ApiError("", status, null))).toBe(false);
    }
  });
});

/**
 * Ночная проверка 24.09.2026 (P1): `retryAfterMs` — это `Retry-After` сервера
 * как есть, и у `brandingLimiter` (apps/api/src/routes/settings.ts) окно 15
 * минут — то есть до 900 000 мс. Без потолка react-query держал бы запрос
 * `pending` почти всё это время, и экран крутил бы «Загружаем…» вместо честной
 * ошибки. Проверяем, что задержка перед единственным повтором 429 не превышает
 * MAX_429_RETRY_DELAY_MS, каким бы ни был Retry-After сервера.
 */
describe("retryDelayFor — потолок паузы перед повтором 429", () => {
  it("короткий Retry-After уважается как есть", () => {
    expect(retryDelayFor(0, new ApiError("", 429, null, 5_000))).toBe(5_000);
  });

  it("Retry-After на весь час окна лимитера ограничен потолком", () => {
    expect(retryDelayFor(0, new ApiError("", 429, null, 900_000))).toBeLessThanOrEqual(30_000);
  });

  it("нет Retry-After — запасное значение тоже не выходит за потолок", () => {
    expect(retryDelayFor(0, new ApiError("", 429, null))).toBe(10_000);
  });

  it("обычный (не 429) отказ считается бэкоффом с ростом до 8 секунд плюс разброс", () => {
    expect(retryDelayFor(0, new Error("Failed to fetch"))).toBeGreaterThanOrEqual(1_000);
    expect(retryDelayFor(0, new Error("Failed to fetch"))).toBeLessThanOrEqual(1_300);
    expect(retryDelayFor(3, new Error("Failed to fetch"))).toBeLessThanOrEqual(8_000 * 1.3);
  });
});
