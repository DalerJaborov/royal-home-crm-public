import { describe, expect, it } from "vitest";
import { describeFunctionError } from "../src/lib/functionErrorText.js";

/** Причина сбоя по-человечески (К17, ревью #340): сервис назван, сказано, что делать; сырой текст не теряется смысл. */
describe("описание сбоя для экрана «Состояние функций»", () => {
  it("лимит Gemini: «Кончился лимит Gemini»", () => {
    expect(describeFunctionError("Gemini 429 RESOURCE_EXHAUSTED: quota exceeded")).toBe("Кончился лимит Gemini — подождите или пополните счёт.");
  });
  it("Telegram не отвечает", () => {
    expect(describeFunctionError("fetch failed UND_ERR_CONNECT_TIMEOUT (api.telegram.org)")).toBe("Telegram не отвечает — проверьте позже.");
  });
  it("ИИ не ответил и повтор не помог — с названием сервиса, без внутреннего запроса", () => {
    const text = describeFunctionError("Gemini не ответил (marketing-insights), повтор тоже не помог");
    expect(text).toBe("Gemini не ответил, повтор тоже не помог — проверьте позже.");
    expect(text).not.toContain("marketing-insights");
  });
  it("не задан ключ: просит добавить в Настройках", () => {
    expect(describeFunctionError("GEMINI_API_KEY не задан")).toBe("Не задан ключ Gemini — добавьте его в Настройках.");
    expect(describeFunctionError("OpenAI API key is missing")).toBe("Не задан ключ OpenAI — добавьте его в Настройках.");
  });
  it("ключ не принят", () => {
    expect(describeFunctionError("OpenAI 401 Unauthorized: invalid api key")).toBe("OpenAI не принял ключ — проверьте ключ в Настройках.");
  });
  it("незнакомое — честный запасной текст, без выдумок; пусто — null", () => {
    expect(describeFunctionError("что-то странное в базе")).toBe("Сбой в работе. Подробности — в блоке «Для разработчика».");
    expect(describeFunctionError("")).toBeNull();
    expect(describeFunctionError(null)).toBeNull();
  });
});
