import { describe, expect, it } from "vitest";
import { pickNarrationVoice } from "@royal-home/shared";
import { stepperHasBothGenders, stepperStartPos, stepperVoices, stepperWrap, voiceFilterOf } from "../src/lib/narrationVoiceStepper.js";

/** 24.11.2026: голос по одному в Шабнам. Порядок и «голос по умолчанию первым» те же, что у списка CRM (pickNarrationVoice). */
const config = {
  defaultVoiceId: "v3",
  voices: [
    { id: "v1", name: "Анна", gender: "female" as const },
    { id: "v2", name: "Фаррух", gender: "male" as const },
    { id: "v3", name: "Мадина", gender: "female" as const },
    { id: "v4", name: "Рустам", gender: "male" as const },
  ],
};

describe("голос по одному", () => {
  it("голос по умолчанию первый, как в CRM; индекс указывает в настройки", () => {
    const list = stepperVoices(config, "a");
    expect(list[0]!.id).toBe(pickNarrationVoice(config));
    expect(list.map((v) => v.id)).toEqual(["v3", "v1", "v2", "v4"]);
    expect(list.every((v) => config.voices[v.index]!.id === v.id)).toBe(true);
  });
  it("голос по умолчанию с номером за пределом восьми всё равно первый", () => {
    const many = { defaultVoiceId: "v10", voices: Array.from({ length: 12 }, (_, i) => ({ id: `v${i + 1}`, name: `Г${i + 1}`, gender: "female" as const })) };
    const list = stepperVoices(many, "a");
    expect(list[0]!.id).toBe("v10");
    expect(list).toHaveLength(8);
  });
  it("фильтры «Муж.» и «Жен.»", () => {
    expect(stepperVoices(config, "m").map((v) => v.id)).toEqual(["v2", "v4"]);
    expect(stepperVoices(config, "f").map((v) => v.id)).toEqual(["v3", "v1"]);
    expect(stepperHasBothGenders(config)).toBe(true);
    expect(stepperHasBothGenders({ voices: [config.voices[0]!, config.voices[2]!] })).toBe(false);
  });
  it("старт с последнего выбранного голоса; нет такого — с начала", () => {
    const list = stepperVoices(config, "a");
    expect(stepperStartPos(list, "v2")).toBe(2);
    expect(stepperStartPos(list, "нет")).toBe(0);
    expect(stepperStartPos(list, undefined)).toBe(0);
  });
  it("листание по кругу и разбор кнопки", () => {
    expect(stepperWrap(-1, 4)).toBe(3);
    expect(stepperWrap(4, 4)).toBe(0);
    expect(stepperWrap(3, 0)).toBe(0);
    expect(voiceFilterOf("12m")).toEqual({ pos: 12, filter: "m" });
    expect(voiceFilterOf("3x")).toBeNull();
    expect(voiceFilterOf(undefined)).toBeNull();
  });
  it("callback_data помещается в 64 байта", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    expect(Buffer.byteLength(`fnr:v:${id}:11m`)).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(`fnr:p:${id}:7:abcd`)).toBeLessThanOrEqual(64);
  });
});
