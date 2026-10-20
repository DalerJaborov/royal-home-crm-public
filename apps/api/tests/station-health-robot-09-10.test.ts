import { describe, expect, it } from "vitest";

/**
 * «ЗДОРОВЬЕ СТАНЦИИ» ВИДИТ РОБОТА (09.10.2026, docs/robot-audit-2026-10-09-pipeline.md,
 * «Мониторинг», п.6 и п.8): зарегистрировано ли приложение робота на станции и жива ли
 * его подписка; стоит ли робот на паузе. Раньше ни того, ни другого не проверял никто.
 */
const { liveVoiceAppCheck, liveVoicePauseCheck, LIVE_VOICE_APP_CHECK, LIVE_VOICE_PAUSE_CHECK } = await import(
  "../src/lib/telephony/stationHealth.js"
);
const { resetLiveVoiceAudioPathForTests } = await import("../src/lib/telephony/liveVoiceBridge.js");

describe("приложение робота на станции", () => {
  it("робот выключен — не проверяется; станция молчит — «не знаем», а не поломка", () => {
    expect(liveVoiceAppCheck({ wanted: false, socketConnected: false, registered: null })).toMatchObject({
      name: LIVE_VOICE_APP_CHECK,
      ok: null,
    });
    expect(liveVoiceAppCheck({ wanted: true, socketConnected: true, registered: null, error: "ETIMEDOUT" })).toMatchObject({
      ok: null,
      cls: "network",
    });
  });

  it("станция не знает приложения или подписка закрыта — поломка конфигурации (тревога через два тика)", () => {
    expect(liveVoiceAppCheck({ wanted: true, socketConnected: true, registered: false })).toMatchObject({ ok: false, cls: "config" });
    expect(liveVoiceAppCheck({ wanted: true, socketConnected: false, registered: true })).toMatchObject({ ok: false, cls: "config" });
    expect(liveVoiceAppCheck({ wanted: true, socketConnected: true, registered: true })).toMatchObject({ ok: true });
  });
});

describe("пауза робота видна", () => {
  it("без паузы — «берёт звонки»", () => {
    resetLiveVoiceAudioPathForTests();
    expect(liveVoicePauseCheck()).toMatchObject({ name: LIVE_VOICE_PAUSE_CHECK, ok: true });
  });
});
