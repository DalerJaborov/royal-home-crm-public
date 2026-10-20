import { describe, expect, it } from "vitest";
import { effectiveGeminiModels } from "../src/ai/geminiSettings.js";
import {
  GEMINI_MODEL,
  GEMINI_FALLBACK_MODELS,
  GEMINI_IMAGE_MODEL,
  GEMINI_TRANSCRIBE_MODELS,
} from "../src/ai/geminiTransport.js";

/**
 * Имена моделей переехали из переменных сервера в Настройки (22.08.2026), и порядок
 * источников — `Настройки || .env || дефолт из кода` — здесь единственное, что
 * отделяет работающего бота от молчащего.
 *
 * Проверять это тестом стоит по двум причинам, обе взяты из живых поломок августа:
 *
 * 1. ПУСТОЕ ЗНАЧЕНИЕ ОБЯЗАНО ЗНАЧИТЬ «НЕ ЗАПОЛНЕНО», а не «пусто». Стоит пустой
 *    строке просочиться дальше — и бот пойдёт спрашивать у Google модель с пустым
 *    именем, то есть получит 404 на КАЖДЫЙ вызов. Ровно так выглядели обе закрытые
 *    модели (02.08 и 22.08), и оба раза снаружи это не выглядело поломкой.
 *
 * 2. УСТАНОВКА, ГДЕ НАСТРОЙКИ НЕ ТРОГАЛИ, ДОЛЖНА РАБОТАТЬ КАК ДО ПЕРЕЕЗДА. Появление
 *    новых полей не имеет права ничего изменить у того, кто ими не пользуется.
 */
describe("выбор моделей Gemini: Настройки || .env || дефолт", () => {
  it("пустые настройки не меняют поведения — работают прежние значения", () => {
    const models = effectiveGeminiModels(null);
    expect(models.model).toBe(GEMINI_MODEL);
    expect(models.fallbackModels).toEqual(GEMINI_FALLBACK_MODELS);
    expect(models.transcribeModels).toEqual(GEMINI_TRANSCRIBE_MODELS);
    expect(models.imageModel).toBe(GEMINI_IMAGE_MODEL);
  });

  it("выбор владельца перекрывает всё остальное", () => {
    const models = effectiveGeminiModels({
      geminiModel: "gemini-4-flash",
      geminiFallbackModels: ["gemini-3.7-flash", "gemini-3.6-flash"],
      geminiTranscribeModels: ["gemini-4-pro"],
      geminiImageModel: "nano-banana-3",
    });
    expect(models.model).toBe("gemini-4-flash");
    expect(models.fallbackModels).toEqual(["gemini-3.7-flash", "gemini-3.6-flash"]);
    expect(models.transcribeModels).toEqual(["gemini-4-pro"]);
    expect(models.imageModel).toBe("nano-banana-3");
  });

  it("пустая строка и пустой список — это «вернуть заводское», а не пустое имя модели", () => {
    const models = effectiveGeminiModels({
      geminiModel: "",
      geminiFallbackModels: [],
      geminiTranscribeModels: [],
      geminiImageModel: "   ",
    });
    expect(models.model).toBe(GEMINI_MODEL);
    expect(models.model).not.toBe("");
    expect(models.transcribeModels).toEqual(GEMINI_TRANSCRIBE_MODELS);
    expect(models.imageModel).toBe(GEMINI_IMAGE_MODEL);
    expect(models.imageModel.trim()).not.toBe("");
  });

  it("пробелы по краям срезаются: имя из буфера обмена не превращается в 404", () => {
    const models = effectiveGeminiModels({
      geminiModel: "  gemini-3.7-flash  ",
      geminiFallbackModels: [" gemini-3.6-flash ", "", "   "],
      geminiTranscribeModels: null,
      geminiImageModel: null,
    });
    expect(models.model).toBe("gemini-3.7-flash");
    expect(models.fallbackModels).toEqual(["gemini-3.6-flash"]);
  });

  it("закрытой gemini-2.5-pro в заводской расшифровке больше нет", () => {
    // 22.08.2026 Google ответил на неё HTTP 404 «no longer available to new users».
    // Она стояла первой в расшифровке трое суток: каждое голосовое получало отказ и
    // уходило на резервную модель вдвое дороже. Возврат этого имени в дефолт —
    // регрессия, которую снаружи опять никто не заметит.
    expect(effectiveGeminiModels(null).transcribeModels).not.toContain("gemini-2.5-pro");
    expect(effectiveGeminiModels(null).transcribeModels.length).toBeGreaterThan(0);
  });
});

/**
 * Дешёвая ступень (Настройки → ИИ) обязана быть ВЫКЛЮЧЕННОЙ, пока её не включили,
 * и не заменять собой обычную модель, а становиться перед ней.
 *
 * Цена ошибки здесь несимметрична: сэкономленные центы не стоят одного неверно
 * разобранного номера телефона в карточке клиента (живой случай 19.08.2026 —
 * дешёвая модель не расслышала продиктованный номер, и карточки не объединились).
 */
describe("дешёвая ступень для простых задач", () => {
  it("по умолчанию не настроена — простые задачи идут обычной моделью", () => {
    expect(effectiveGeminiModels(null).liteModel).toBe("");
  });

  it("настроенная ступень не подменяет собой основную модель", () => {
    const models = effectiveGeminiModels({
      geminiModel: "gemini-3.7-flash",
      geminiLiteModel: "gemini-3.1-flash-lite",
    });
    expect(models.liteModel).toBe("gemini-3.1-flash-lite");
    expect(models.model).toBe("gemini-3.7-flash");
  });
});
