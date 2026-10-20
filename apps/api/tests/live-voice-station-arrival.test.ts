import { describe, expect, it } from "vitest";
import { LIVE_VOICE_KNOWN_ARG, liveVoiceRecordingKey, stationArrival } from "../src/lib/telephony/liveVoiceBridge.js";
import { isLiveVoiceRecording, LIVE_VOICE_RECORDING_PREFIX } from "../src/lib/telephony/callRecordings.js";

/**
 * Как канал попал к консультанту из диалплана (ops/asterisk/extensions_custom.conf):
 * `known` — свой клиент, станция агента не набирала (вердикт known_client, 03.10.2026).
 * Без этого аргумента мост принимал бы такой звонок за «не из диалплана».
 * С 11.10.2026 `known`/`missed` робот не берёт (владелец: клиент агента — только
 * агенту), но узнавать их обязан: только так отказ отдаёт канал диалплану
 * (автоответчик), а не кладёт трубку (live-voice-rtp.test.ts).
 */
describe("stationArrival", () => {
  const ev = (arg?: string) => ({ type: "StasisStart", args: arg ? [arg] : [] }) as never;

  it("known узнаётся, как и остальные аргументы диалплана", () => {
    expect(LIVE_VOICE_KNOWN_ARG).toBe("known");
    expect(stationArrival(ev("known"))).toBe("known");
    expect(stationArrival(ev("missed"))).toBe("missed");
    expect(stationArrival(ev("inbound"))).toBe("inbound");
    expect(stationArrival(ev("returned"))).toBe("returned");
  });

  it("чужой или пустой аргумент — не из диалплана", () => {
    expect(stationArrival(ev("whatever"))).toBeNull();
    expect(stationArrival(ev())).toBeNull();
  });
});

describe("ключ записи консультанта", () => {
  it("строится из общего префикса, и по нему запись узнаётся как запись консультанта", () => {
    const key = liveVoiceRecordingKey("1727000000.42", 1_000);
    expect(key.startsWith(LIVE_VOICE_RECORDING_PREFIX)).toBe(true);
    expect(isLiveVoiceRecording(key)).toBe(true);
    expect(isLiveVoiceRecording("2026/10/03/in-992-1.wav")).toBe(false);
  });
});
