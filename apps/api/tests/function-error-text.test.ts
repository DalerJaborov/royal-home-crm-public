import { describe, expect, it } from "vitest";
import { describeFunctionError } from "../src/lib/functionErrorText.js";

/** Причина сбоя по-человечески (К17, ревью #340): сервис назван, сказано, что делать, и фраза не врёт. */
describe("описание сбоя для экрана «Состояние функций»", () => {
  const cases: Array<[string, string]> = [
    ["Gemini 429 RESOURCE_EXHAUSTED: quota exceeded", "Кончился лимит Gemini — подождите или пополните счёт."],
    ["OpenAI 402 Payment Required", "Кончился лимит OpenAI — подождите или пополните счёт."],
    ["fetch failed UND_ERR_CONNECT_TIMEOUT (api.telegram.org)", "Telegram не отвечает — проверьте позже."],
    ["Gemini не ответил (marketing-insights), повтор тоже не помог", "Gemini не ответил, повтор тоже не помог — проверьте позже."],
    // отказ на сам запрос — не «не отвечает»
    ["Gemini 400 INVALID_ARGUMENT: bad value", "Gemini отклонил запрос — нужен разработчик."],
    ["Gemini FAILED_PRECONDITION: User location is not supported for the API use", "Gemini отклонил запрос — нужен разработчик."],
    ["Gemini finishReason SAFETY", "Gemini отклонил запрос — нужен разработчик."],
    // переменная сервера, а не «ключ в Настройках»
    ["GEMINI_API_KEY не задан", "Не задана настройка сервера — скажите разработчику."],
    ["не задана CUSTOMER_AGENT_ANSWER_MODE", "Не задана настройка сервера — скажите разработчику."],
    ["OpenAI API key is missing", "Не задан ключ OpenAI — добавьте его в Настройках."],
    // ключ Meta истёк
    ["Meta graph.facebook.com: (#190) Error validating access token: Session has expired", "Ключ Meta истёк — переподключите в Настройках, «Каналы»."],
    ["Instagram: Session has expired on Friday", "Ключ Meta истёк — переподключите в Настройках, «Каналы»."],
    ["OpenAI 401 Unauthorized: invalid api key", "OpenAI не принял ключ — проверьте ключ в Настройках."],
    // googleapis — не YouTube; fcm — уведомления на телефон
    ["fetch failed ETIMEDOUT fcm.googleapis.com", "Уведомления на телефон (Google) не отвечает — проверьте позже."],
    ["что-то странное в базе", "Сбой в работе. Подробности — в блоке «Для разработчика»."],
  ];
  for (const [raw, human] of cases) {
    it(`«${raw.slice(0, 60)}»`, () => expect(describeFunctionError(raw)).toBe(human));
  }
  it("не приписывает googleapis к YouTube", () => {
    expect(describeFunctionError("timeout storage.googleapis.com")).toBe("Внешний сервис не отвечает — проверьте позже.");
  });
  it("повтор тоже не помог — без внутреннего запроса в тексте", () => {
    expect(describeFunctionError("Gemini не ответил (marketing-insights), повтор тоже не помог")).not.toContain("marketing-insights");
  });
  it("пусто — null", () => {
    expect(describeFunctionError("")).toBeNull();
    expect(describeFunctionError(null)).toBeNull();
  });
});
