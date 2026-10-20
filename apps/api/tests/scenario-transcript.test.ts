import { describe, expect, it } from "vitest";
import { clientLinesOf, looksLikeVoicemail } from "../src/ai/scenarioTranscript.js";

/**
 * Разбор расшифровки сценарного звонка робота (03.10.2026): только реплики
 * собеседника и фразы автоответчика оператора.
 */
describe("scenarioTranscript", () => {
  const transcript = ["Бот: Здравствуйте", "Клиент: Да, слушаю.", "Консультант: Минутку", "Клиент:  Ёлка  стоит 500 "];

  it("clientLinesOf берёт только «Клиент:», консультанта и бота — нет", () => {
    expect(clientLinesOf(transcript)).toEqual(["Да, слушаю.", "Ёлка  стоит 500"]);
  });

  it("автоответчик оператора узнаётся по-русски и по-таджикски, живая речь — нет", () => {
    expect(looksLikeVoicemail(["Абонент временно недоступен"])).toBe(true);
    expect(looksLikeVoicemail(["Оставьте сообщение после сигнала"])).toBe(true);
    expect(looksLikeVoicemail(["Пас аз сигнал паём гузоред"])).toBe(true);
    expect(looksLikeVoicemail(["Да, это я, говорите"])).toBe(false);
  });
});
