import { describe, expect, it } from "vitest";
import { buildLiveVoiceSystemPrompt, LIVE_VOICE_SYSTEM_PROMPT } from "../src/ai/liveVoicePersona.js";

/**
 * Контекст конкретного звонка (13.09.2026, разбор «заменить оператора» —
 * см. docs/TASKS.md) — чистая функция сборки промта, без сети/БД.
 */
describe("buildLiveVoiceSystemPrompt", () => {
  it("без контекста — тот же промт, что и константа для ручного теста", () => {
    expect(buildLiveVoiceSystemPrompt()).toBe(LIVE_VOICE_SYSTEM_PROMPT);
  });

  it("без имени и без объекта — блок контекста не добавляется вовсе", () => {
    const prompt = buildLiveVoiceSystemPrompt({});
    expect(prompt).toBe(LIVE_VOICE_SYSTEM_PROMPT);
  });

  it("указано только имя — попадает в блок контекста", () => {
    const prompt = buildLiveVoiceSystemPrompt({ clientName: "Далер" });
    expect(prompt).toContain("КОНТЕКСТ ЭТОГО ЗВОНКА");
    expect(prompt).toContain("Далер");
  });

  it("указан объект — описание попадает в блок контекста дословно", () => {
    const prompt = buildLiveVoiceSystemPrompt({ propertyDescription: "объект №123: 2-комн, Сино, 60 м², 45 000 $" });
    expect(prompt).toContain("объект №123: 2-комн, Сино, 60 м², 45 000 $");
  });

  it("указаны и имя, и объект — оба присутствуют", () => {
    const prompt = buildLiveVoiceSystemPrompt({ clientName: "Далер", propertyDescription: "объект №1" });
    expect(prompt).toContain("Далер");
    expect(prompt).toContain("объект №1");
  });

  it("запрет придумывать личное имя — всегда в промте (живой звонок 13.09.2026: «Исмаил» женским голосом)", () => {
    expect(LIVE_VOICE_SYSTEM_PROMPT).toContain("НЕ ПРИДУМЫВАЙ СЕБЕ ЛИЧНОЕ ИМЯ");
  });

  it("замок на русский по умолчанию (без promptSettings) — таджикских примеров в промте нет", () => {
    // ҷ/ҳ/ӯ — буквы, которых в русском алфавите нет вовсе; их отсутствие и
    // означает отсутствие блока LIVE_VOICE_TAJIK_COLLOQUIAL_EXAMPLES.
    expect(LIVE_VOICE_SYSTEM_PROMPT).not.toMatch(/[ҷҳӯӣ]/);
    expect(LIVE_VOICE_SYSTEM_PROMPT).toContain("ГОВОРИ ТОЛЬКО ПО-РУССКИ");
  });

  it("forceRussianOnly: true явно — тот же результат, таджикских примеров нет", () => {
    const prompt = buildLiveVoiceSystemPrompt(undefined, { roleOverride: null, forceRussianOnly: true });
    expect(prompt).not.toMatch(/[ҷҳӯӣ]/);
    expect(prompt).toContain("ГОВОРИ ТОЛЬКО ПО-РУССКИ");
  });

  it("forceRussianOnly: false — таджикские примеры подключаются, замка на русский нет", () => {
    const prompt = buildLiveVoiceSystemPrompt(undefined, { roleOverride: null, forceRussianOnly: false });
    expect(prompt).toMatch(/[ҷҳӯӣ]/);
    expect(prompt).not.toContain("ГОВОРИ ТОЛЬКО ПО-РУССКИ");
  });

  it("roleOverride заменяет личность, но замок на русский и контекст звонка остаются", () => {
    const prompt = buildLiveVoiceSystemPrompt(
      { clientName: "Далер" },
      { roleOverride: "Своя роль от владельца", forceRussianOnly: true }
    );
    expect(prompt.startsWith("Своя роль от владельца")).toBe(true);
    expect(prompt).toContain("Далер");
    expect(prompt).toContain("ГОВОРИ ТОЛЬКО ПО-РУССКИ");
  });
});
