import { describe, expect, it } from "vitest";
import { GEMINI_VOICES, selfGenderReminder, selfGenderRule } from "@royal-home/shared";
import * as pcm from "../src/lib/telephony/pcmCodec.js";
import * as bridge from "../src/lib/telephony/liveVoiceBridge.js";
import {
  selfGenderForCall,
  withSelfGenderReminder,
  withSelfGenderReminderFor,
  withSelfGenderRule,
  withSelfGenderRuleFor,
} from "../src/ai/liveVoiceSelfGender.js";
import { ElevenLabsVoiceClient } from "../src/ai/elevenLabsVoiceClient.js";
import { LiveVoiceClient } from "../src/ai/liveVoiceClient.js";
import { createLiveVoiceProviderClient } from "../src/ai/liveVoiceProvider.js";

/**
 * ELEVENLABS ПОВЕРХ ПРАВОК РОБОТА (03.10.2026): то, что проверяется без станции и
 * сети. Главное — Gemini по умолчанию ведёт себя как на main, а второй поставщик
 * получает тот же звук-путь, тот же родовой замок и тот же ответ на повтор функции.
 */

describe("звук: код переехал в pcmCodec, мост переизлучает те же функции", () => {
  it("ресемплер, потоковый дециматор, ulaw и перевод байтов — те же объекты", () => {
    expect(bridge.resamplePcm16).toBe(pcm.resamplePcm16);
    expect(bridge.StreamingDecimator).toBe(pcm.StreamingDecimator);
    expect(bridge.designLowPassFir).toBe(pcm.designLowPassFir);
    expect(bridge.ulawEncode).toBe(pcm.ulawEncode);
    expect(bridge.ulawDecode).toBe(pcm.ulawDecode);
    expect(bridge.bufferToInt16LE).toBe(pcm.bufferToInt16LE);
    expect(bridge.int16ToBufferLE).toBe(pcm.int16ToBufferLE);
  });

  it("понижение частоты идёт настоящим ФНЧ: 1 кГц проходит, 6 кГц давится", () => {
    const tone = (hz: number) => {
      const out = new Int16Array(2400);
      for (let i = 0; i < out.length; i++) out[i] = Math.round(10_000 * Math.sin((2 * Math.PI * hz * i) / 24_000));
      return out;
    };
    const rms = (a: Int16Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    const low = pcm.resamplePcm16(tone(1000), 24_000, 8_000);
    const high = pcm.resamplePcm16(tone(6000), 24_000, 8_000);
    expect(rms(low)).toBeGreaterThan(6_000);
    expect(rms(high)).toBeLessThan(rms(low) / 20);
  });
});

describe("звук ответа поставщика → линия 8 кГц", () => {
  const chunk = new Int16Array(480).map((_, i) => Math.round(8000 * Math.sin(i / 7)));

  it("Google — потоковый дециматор, как до второго поставщика (24 → 8 кГц)", () => {
    const a = new pcm.StreamingDecimator(3, pcm.lowPassForRate(24_000, 8_000));
    const b = new pcm.StreamingDecimator(3, pcm.lowPassForRate(24_000, 8_000));
    const viaBridge = bridge.providerSpeechToLine("google", 24_000, a, chunk);
    expect(Array.from(viaBridge)).toEqual(Array.from(b.process(chunk)));
    expect(viaBridge.length).toBe(160);
  });

  it("Google — частота клиента не важна: решает поставщик, а не отчёт клиента", () => {
    const d = new pcm.StreamingDecimator(3, pcm.lowPassForRate(24_000, 8_000));
    expect(bridge.providerSpeechToLine("google", Number.NaN, d, chunk).length).toBe(160);
  });

  it("ElevenLabs на 8 кГц — звук как есть, без второго фильтра", () => {
    const d = new pcm.StreamingDecimator(3, pcm.lowPassForRate(24_000, 8_000));
    expect(bridge.providerSpeechToLine("elevenlabs", 8_000, d, chunk)).toBe(chunk);
  });

  it("ElevenLabs на 16 кГц — пересчёт вдвое вниз", () => {
    const d = new pcm.StreamingDecimator(3, pcm.lowPassForRate(24_000, 8_000));
    expect(bridge.providerSpeechToLine("elevenlabs", 16_000, d, chunk).length).toBe(240);
  });
});

describe("род о себе: у Gemini по голосу из каталога, у ElevenLabs — по Настройкам", () => {
  it("для Gemini итоговый промт и реплика те же, что у прежних функций (каждый голос каталога)", () => {
    for (const v of GEMINI_VOICES) {
      const g = selfGenderForCall({ provider: "google" }, v.value);
      expect(g).toBe(v.gender);
      expect(withSelfGenderRuleFor("роль", g)).toBe(withSelfGenderRule("роль", v.value));
      expect(withSelfGenderReminderFor("привет", g)).toBe(withSelfGenderReminder("привет", v.value));
    }
  });

  it("у ElevenLabs имя Gemini-голоса не влияет: мужской голос — мужской род даже при женском Kore", () => {
    const male = selfGenderForCall({ provider: "elevenlabs", voiceGender: "male" }, "Kore");
    expect(male).toBe("male");
    const prompt = withSelfGenderRuleFor("роль", male);
    expect(prompt.startsWith("роль\n<system_role>\n")).toBe(true);
    expect(prompt).toContain(selfGenderRule("male"));
    expect(withSelfGenderReminderFor("привет", male)).toContain(selfGenderReminder("male"));
    expect(selfGenderForCall({ provider: "elevenlabs", voiceGender: "female" }, "Puck")).toBe("female");
  });
});

describe("выбор поставщика: по умолчанию Gemini с прежними частотами", () => {
  it("google — настоящий клиент Gemini 24/16 кГц", () => {
    const c = createLiveVoiceProviderClient({ provider: "google" });
    expect(c).toBeInstanceOf(LiveVoiceClient);
    expect(c.outputSampleRateHz).toBe(24_000);
    expect(c.inputSampleRateHz).toBe(16_000);
  });
});

describe("повтор вызова функции у ElevenLabs", () => {
  it("ответ запоминается и повторяется по id; на неотвеченный id — false", () => {
    const client = new ElevenLabsVoiceClient({ apiKey: "k", agentId: "a", voiceIdRu: null, voiceIdTg: null });
    const sent: string[] = [];
    const WS_OPEN = 1;
    (client as unknown as { ws: unknown }).ws = { readyState: WS_OPEN, send: (m: string) => sent.push(m), close() {} };
    const call = { id: "t1", name: "search_properties", args: {} };
    expect(client.resendToolResponse(call)).toBe(false);
    client.sendToolResponse(call, { ok: true });
    expect(sent).toHaveLength(1);
    expect(client.resendToolResponse(call)).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
  });

  it("запас ответов ограничен — старые вытесняются", () => {
    const client = new ElevenLabsVoiceClient({ apiKey: "k", agentId: "a", voiceIdRu: null, voiceIdTg: null });
    for (let i = 0; i < 60; i++) client.sendToolResponse({ id: `c${i}`, name: "x", args: {} }, { ok: true });
    expect(client.resendToolResponse({ id: "c0", name: "x", args: {} })).toBe(false);
    expect(client.resendToolResponse({ id: "c59", name: "x", args: {} })).toBe(true);
  });
});
