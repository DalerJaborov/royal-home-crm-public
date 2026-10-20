import { describe, expect, it } from "vitest";
import { PUSH_ERROR_FALLBACK, pushBodyFromSystemError } from "../src/lib/pushErrorText.js";

/**
 * Ночная проверка 01.10.2026, №239: в пуш директору «Новая проблема в CRM»
 * уходил хвост ошибки как есть — UUID, «HTTP 503», английский текст. Теперь
 * остаётся понятное по-русски.
 */
const UUID = "3f2b8c1e-9a44-4d7e-b1f0-52c7a9d0e611";

describe("pushBodyFromSystemError", () => {
  it("UUID убирается, русская часть остаётся", () => {
    const body = pushBodyFromSystemError("очередь заданий", `Задание ${UUID} сдалось после 3 попыток`);
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(body).toContain("сдалось после 3 попыток");
    expect(body.startsWith("очередь заданий: ")).toBe(true);
  });

  it("«HTTP 503» превращается в слова, цифр кода нет", () => {
    const body = pushBodyFromSystemError("ИИ", "Не удалось получить ответ модели: HTTP 503");
    expect(body).not.toMatch(/503|HTTP/);
    expect(body).toContain("Не удалось получить ответ модели");
    expect(body).toContain("сервис временно недоступен");
  });

  it("английский технический хвост отбрасывается", () => {
    const body = pushBodyFromSystemError("сервер CRM", "Не удалось записать уведомления: connect ECONNREFUSED 127.0.0.1:5432");
    expect(body).toBe("сервер CRM: Не удалось записать уведомления");
  });

  it("сообщение целиком по-английски — отсылка к журналу, а не сырой текст", () => {
    const body = pushBodyFromSystemError("Telegram", "Request failed with status code 429 at /bot123/sendMessage");
    expect(body).not.toMatch(/Request failed|sendMessage/);
    expect(body).toContain("превышен лимит запросов");
    expect(pushBodyFromSystemError("Telegram", "TypeError: x is not a function")).toBe(`Telegram: ${PUSH_ERROR_FALLBACK}`);
  });

  it("длинный текст режется по границе слова, слово не рвётся", () => {
    const long = Array.from({ length: 60 }, (_, i) => `слово${i}`).join(" ");
    const body = pushBodyFromSystemError("ИИ", long);
    expect(body.length).toBeLessThanOrEqual("ИИ: ".length + 161);
    expect(body.endsWith("…")).toBe(true);
    const lastWord = body.slice("ИИ: ".length, -1).split(" ").pop()!;
    expect(long.split(" ")).toContain(lastWord);
  });

  it("обычное понятное сообщение проходит без изменений", () => {
    expect(pushBodyFromSystemError("курс валют", "Курс валют не обновлялся двое суток")).toBe("курс валют: Курс валют не обновлялся двое суток");
  });
});
