import { describe, expect, it } from "vitest";
import { narrationConfigSchema, narrationMixByCrm, narrationTtsOptions, narrationWizardChoiceSchema, renderNarrationTemplate } from "@royal-home/shared";

/**
 * ЗАПРОС СИНТЕЗА И ПРАВИЛА ТЕКСТА (12.11.2026). Одно место добавок к запросу ElevenLabs:
 * язык tg/ru, voice_settings без style и speaker boost для v4 (ФАКТ: can_use_style=false),
 * словарь произношения только для eleven_v4. Голос сам переопределяет общий набор.
 */
const voices = [{ id: "a", name: "А", settings: { speed: 0.9 } }, { id: "b", name: "Б" }];

describe("narrationTtsOptions", () => {
  it("пустой конфиг: только язык по шаблону, остальное — умолчания сервиса", () => {
    expect(narrationTtsOptions({ voices, modelId: "eleven_v4" }, "b", "tg")).toEqual({ language_code: "tg" });
    expect(narrationTtsOptions({ voices, modelId: "eleven_v4" }, "b", null)).toEqual({});
  });
  it("общий набор плюс голос поверх; style и speaker boost не уходят в v4", () => {
    const config = { voices, modelId: "eleven_v4", voiceSettings: { stability: 0.5, similarityBoost: 0.75, speed: 1, style: 0.3, useSpeakerBoost: true } };
    expect(narrationTtsOptions(config, "a", "ru")).toEqual({ voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 0.9 }, language_code: "ru" });
    expect(narrationTtsOptions({ ...config, modelId: "eleven_multilingual_v2" }, "b", "ru").voice_settings).toEqual({ stability: 0.5, similarity_boost: 0.75, style: 0.3, speed: 1, use_speaker_boost: true });
  });
  it("словарь произношения — только для eleven_v4", () => {
    const dict = { pronunciationDictionaries: [{ id: "d1", versionId: "v1" }] };
    expect(narrationTtsOptions({ voices, modelId: "eleven_v4", ...dict }, "b", "tg").pronunciation_dictionary_locators).toEqual([{ pronunciation_dictionary_id: "d1", version_id: "v1" }]);
    expect(narrationTtsOptions({ voices, modelId: "eleven_v4_turbo", ...dict }, "b", "tg").pronunciation_dictionary_locators).toBeUndefined();
  });
});

describe("правила озвучки 12.11.2026", () => {
  it("по умолчанию голос вклеивает монтажёр; «голос кладёт CRM» — только явно", () => {
    expect(narrationMixByCrm({})).toBe(false);
    expect(narrationMixByCrm({ mixByCrm: true })).toBe(true);
  });
  it("тег голоса v4 остаётся в тексте, фрагмент «если есть» работает как раньше", () => {
    const facts = { type: "APARTMENT", rooms: null, areaSqm: "60", floor: null, totalFloors: null, district: null };
    expect(renderNarrationTemplate({ lang: "ru", text: "[excited] В продаже {вид}.[ Комнат: {комнаты}.]" }, facts)).toBe("[excited] В продаже квартира.");
  });
  it("«Без озвучки» в мастере и настройки синтеза проходят проверку; лишнее поле голоса — нет", () => {
    expect(narrationWizardChoiceSchema.parse({ none: true })).toEqual({ none: true });
    expect(narrationConfigSchema.safeParse({ modelId: "eleven_v4", voices: [{ id: "a", name: "А", settings: { stability: 0.5 } }], backfillMontageQueue: false }).success).toBe(true);
    expect(narrationConfigSchema.safeParse({ modelId: "eleven_v4", voices: [{ id: "a", name: "А", settings: { loud: 1 } }] }).success).toBe(false);
  });
});
