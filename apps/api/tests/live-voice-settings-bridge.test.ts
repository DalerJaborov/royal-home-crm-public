import { describe, expect, it } from "vitest";
import {
  promptSettingsFrom,
  soundDesignFrom,
  type LiveVoiceGateSettings,
} from "../src/lib/telephony/liveVoiceBridge.js";

/**
 * Управление живым голосом из интерфейса (13.09.2026) — эти две функции
 * переводят Settings в то, что реально читают buildLiveVoiceSystemPrompt и
 * generateBreathSound/nextOfficeAmbienceFrame. Чистые функции, без сети/БД —
 * settings приходит уже загруженным объектом.
 *
 * Синтетический гул/щелчки клавиатуры (liveVoiceAmbientNoiseDuringSpeech/Silence,
 * liveVoiceTypingClickEnabled) убраны 14.09.2026 — настоящий офисный амбиент
 * их заменил целиком, см. liveVoiceBridge.ts::soundDesignFrom.
 */
function baseSettings(overrides: Partial<LiveVoiceGateSettings> = {}): LiveVoiceGateSettings {
  return {
    liveVoiceEnabled: true,
    liveVoiceTestExtension: null,
    liveVoicePrompt: null,
    liveVoiceVoiceName: null,
    liveVoiceForceRussianOnly: true,
    liveVoiceBreathEnabled: true,
    liveVoiceOfficeAmbienceEnabled: true,
    liveVoiceOfficeAmbienceVolume: 0.35,
    ...overrides,
  };
}

describe("promptSettingsFrom", () => {
  it("settings = null — безопасные дефолты (замок включён, без замены роли)", () => {
    expect(promptSettingsFrom(null)).toEqual({ roleOverride: null, forceRussianOnly: true });
  });

  it("пустой liveVoicePrompt — roleOverride null", () => {
    expect(promptSettingsFrom(baseSettings({ liveVoicePrompt: null }))).toMatchObject({ roleOverride: null });
  });

  it("заданный liveVoicePrompt — переносится как есть", () => {
    expect(promptSettingsFrom(baseSettings({ liveVoicePrompt: "Своя роль" }))).toMatchObject({
      roleOverride: "Своя роль",
    });
  });

  it("liveVoiceForceRussianOnly читается из настроек, не всегда true", () => {
    expect(promptSettingsFrom(baseSettings({ liveVoiceForceRussianOnly: false }))).toEqual({
      roleOverride: null,
      forceRussianOnly: false,
    });
  });
});

describe("soundDesignFrom", () => {
  it("settings = null — фолбэк из кода: вдох и фон выключены (02.10.2026)", () => {
    expect(soundDesignFrom(null)).toEqual({
      breathEnabled: false,
      officeAmbienceEnabled: false,
      officeAmbienceVolume: 0.35,
    });
  });

  it("настройки переопределяют вдох/офисный амбиент", () => {
    expect(
      soundDesignFrom(
        baseSettings({
          liveVoiceBreathEnabled: false,
          liveVoiceOfficeAmbienceEnabled: false,
          liveVoiceOfficeAmbienceVolume: 0.7,
        })
      )
    ).toEqual({
      breathEnabled: false,
      officeAmbienceEnabled: false,
      officeAmbienceVolume: 0.7,
    });
  });
});
