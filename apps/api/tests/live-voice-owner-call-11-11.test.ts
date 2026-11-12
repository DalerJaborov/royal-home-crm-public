import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { ELEVENLABS_NORMAL_CLOSE_CODE, ElevenLabsVoiceClient } from "../src/ai/elevenLabsVoiceClient.js";
import { mergeAsrKeywords, ASR_KEYWORDS_MAX, TAJIK_ASR_KEYWORDS } from "../src/ai/tajikVoiceLexicon.js";
import { BargeInHold, bargeInHoldFrames, BARGE_IN_HOLD_DEFAULT_MS } from "../src/lib/telephony/liveVoiceBargeInHold.js";
import { callerLanguageSwitchNote } from "../src/lib/telephony/liveVoiceCallerLanguage.js";
import { sendLanguageNote } from "../src/lib/telephony/liveVoiceBridge.js";

/**
 * ЗВОНКИ ВЛАДЕЛЬЦА 11.11.2026 (~19:16 Душанбе, номер 1413, ElevenLabs) — что нашлось и чем чинится:
 *  1. Пометка «человек говорит по-таджикски» уходила user_message: агент обрывал начатый
 *     ответ («...») и отвечал заново — пауза ~6 с. Теперь — contextual_update.
 *  2. Модель перешла на таджикский текстом, а language_detection не вызвала: таджикский читал
 *     русский голос. Пометка у ElevenLabs теперь велит вызвать инструмент.
 *  3. Робот обрывал себя от коротких звуков поверх своей речи (эхо линии −40 дБ — не эхо).
 *  4. Сокет закрывался без кода (1005) — в истории ElevenLabs «Client disconnected unexpectedly».
 *  5. «ЦУМ» распознавание записало «Туми» — слово в подсказках распознавания.
 */

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closeArgs: unknown[] | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(...args: unknown[]): void {
    if (this.closeArgs) return;
    this.closeArgs = args;
    this.readyState = 3;
    this.emit("close", (args[0] as number | undefined) ?? 1005, Buffer.from(String(args[1] ?? "")));
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  server(msg: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

async function connectedClient(): Promise<{ client: ElevenLabsVoiceClient; ws: FakeSocket }> {
  const sockets: FakeSocket[] = [];
  const client = new ElevenLabsVoiceClient(
    { apiKey: "sk_test", agentId: "agent_1", voiceIdRu: "voice_ru", voiceIdTg: null },
    {
      signedUrl: vi.fn(async () => "wss://example.test/v1/convai/conversation?agent_id=a&token=t"),
      prepareAgent: vi.fn(async () => new Map<string, string>()),
      socketFactory: () => {
        const ws = new FakeSocket();
        sockets.push(ws);
        setImmediate(() => ws.open());
        return ws as unknown as WebSocket;
      },
    }
  );
  const connecting = client.connect({ systemInstruction: "ПРОМТ", tools: [], language: "ru", direction: "inbound" });
  for (let i = 0; i < 50 && sockets[0]?.readyState !== 1; i++) await new Promise((r) => setImmediate(r));
  const ws = sockets[0]!;
  ws.server({
    type: "conversation_initiation_metadata",
    conversation_initiation_metadata_event: { conversation_id: "conv_1", agent_output_audio_format: "ulaw_8000", user_input_audio_format: "ulaw_8000" },
  });
  await connecting;
  return { client, ws };
}

describe("звонок владельца 11.11: пометка о языке без нового хода агента", () => {
  it("ElevenLabs: sendContext шлёт contextual_update, а не user_message", async () => {
    const { client, ws } = await connectedClient();
    client.sendContext("(Служебное: человек говорит по-таджикски.)");
    expect(ws.sent.at(-1)).toEqual({ type: "contextual_update", text: "(Служебное: человек говорит по-таджикски.)" });
    client.close();
  });

  it("мост: пометка о языке идёт в sendContext, если он есть, иначе — прежний sendText (Gemini)", () => {
    const withContext = { sendContext: vi.fn(), sendText: vi.fn() };
    sendLanguageNote({ gemini: withContext as never }, "заметка");
    expect(withContext.sendContext).toHaveBeenCalledWith("заметка");
    expect(withContext.sendText).not.toHaveBeenCalled();

    const geminiOnly = { sendText: vi.fn() };
    sendLanguageNote({ gemini: geminiOnly as never }, "заметка");
    expect(geminiOnly.sendText).toHaveBeenCalledWith("заметка");
  });

  it("у ElevenLabs пометка велит вызвать language_detection нужным языком; у Gemini — нет", () => {
    expect(callerLanguageSwitchNote("tg", { languageTool: true })).toContain('language_detection с language "tg"');
    expect(callerLanguageSwitchNote("ru", { languageTool: true })).toContain('language_detection с language "ru"');
    expect(callerLanguageSwitchNote("tg")).not.toContain("language_detection");
    // Прежний текст для Gemini не изменился.
    expect(callerLanguageSwitchNote("tg")).toBe(
      "(Служебное: человек говорит по-таджикски — дальше говори с ним по-таджикски, живым разговорным языком, пока он сам не перейдёт на русский. Об этом не говори и не извиняйся. Эту пометку вслух не читай.)"
    );
  });
});

describe("звонок владельца 11.11: сокет закрывается обычным кодом", () => {
  it("close() — код 1000, а не закрытие без кода", async () => {
    const { client, ws } = await connectedClient();
    const closed = vi.fn();
    client.on("close", closed);
    client.close();
    expect(ws.closeArgs?.[0]).toBe(ELEVENLABS_NORMAL_CLOSE_CODE);
    expect(ELEVENLABS_NORMAL_CLOSE_CODE).toBe(1000);
    // Закрыли мы сами — мост не получает «поставщик закончил разговор».
    expect(closed).not.toHaveBeenCalled();
  });
});

describe("звонок владельца 11.11: короткий звук поверх робота его не перебивает", () => {
  const frame = (v: number) => new Int16Array(160).fill(v);
  const isSilence = (f: Int16Array) => f.every((x) => x === 0);
  const isQuarter = (f: Int16Array, v: number) => f.every((x) => x === Math.round(v / 4));

  it("по умолчанию 240 мс = 12 кадров; 0 — выключено; потолок 600 мс", () => {
    expect(BARGE_IN_HOLD_DEFAULT_MS).toBe(240);
    expect(bargeInHoldFrames({})).toBe(12);
    expect(bargeInHoldFrames({ LIVE_VOICE_BARGE_IN_HOLD_MS: "0" })).toBe(0);
    expect(bargeInHoldFrames({ LIVE_VOICE_BARGE_IN_HOLD_MS: "abc" })).toBe(0);
    expect(bargeInHoldFrames({ LIVE_VOICE_BARGE_IN_HOLD_MS: "5000" })).toBe(30);
  });

  it("робот молчит — звук идёт как есть, без задержки", () => {
    const hold = new BargeInHold(12);
    const f = frame(900);
    expect(hold.push(f, false, true)).toEqual([f]);
  });

  it("вздох 100 мс поверх робота уходит приглушённым (−12 дБ) той же длины, поток не рвётся", () => {
    const hold = new BargeInHold(12);
    const out: Int16Array[] = [];
    for (let i = 0; i < 5; i++) out.push(...hold.push(frame(900), true, true));
    expect(out).toHaveLength(0); // придержано
    for (let i = 0; i < 5; i++) out.push(...hold.push(frame(8), true, false));
    expect(out).toHaveLength(10); // 5 громких + 5 тихих — ни один кадр не потерян
    expect(out.slice(0, 5).every((f) => isQuarter(f, 900))).toBe(true);
    expect(out.some(isSilence)).toBe(false);
    expect(hold.suppressed).toBe(1);
  });

  it("речь поверх робота (12 кадров речи, смычки между слогами) уходит целиком, начало фразы не теряется", () => {
    const hold = new BargeInHold(12);
    const out: Int16Array[] = [];
    const sent: Int16Array[] = [];
    for (let i = 0; i < 16; i++) {
      const loud = !(i >= 3 && i < 7) || i === 5; // смычка 60 мс между слогами
      const f = frame(loud ? 900 + i : 5);
      sent.push(f);
      out.push(...hold.push(f, true, loud));
    }
    expect(out).toEqual(sent);
    expect(out.some(isSilence)).toBe(false);
    // Дальше до конца реплики робота — без придержки.
    const next = frame(7);
    expect(hold.push(next, true, false)).toEqual([next]);
    expect(hold.suppressed).toBe(0);
  });

  it("человек заговорил на последних кадрах робота — придержанное уходит как есть", () => {
    const hold = new BargeInHold(12);
    const a = frame(800);
    const b = frame(810);
    expect(hold.push(a, true, true)).toEqual([]);
    expect(hold.push(b, false, true)).toEqual([a, b]);
  });

  it("долгий редкий шум (мало громких кадров за двойное окно) — тишиной", () => {
    const hold = new BargeInHold(4);
    const out: Int16Array[] = [];
    const pattern = [true, false, false, true, false, false, true, false];
    for (const loud of pattern) out.push(...hold.push(frame(loud ? 900 : 5), true, loud));
    expect(out.length).toBeGreaterThan(0);
    expect(hold.suppressed).toBeGreaterThan(0);
  });
});

describe("звонок владельца 11.11: «ЦУМ» в подсказках распознавания", () => {
  it("ЦУМ есть, предел Scribe Realtime соблюдён", () => {
    expect(TAJIK_ASR_KEYWORDS).toContain("ЦУМ");
    expect(TAJIK_ASR_KEYWORDS.length).toBeLessThanOrEqual(ASR_KEYWORDS_MAX);
    expect(mergeAsrKeywords([])).toContain("ЦУМ");
  });
});

describe("звонок владельца 12.11 12:38: русский по досье не запрещает таджикский", () => {
  it("без замка: на вопрос про таджикский — сразу по-таджикски, «не говорю по-таджикски» запрещено", async () => {
    const { languageLockRule } = await import("../src/ai/liveVoiceConsultantPersona.js");
    const rule = languageLockRule("ru", true, false);
    expect(rule).toContain("ЯЗЫК ЭТОГО ЗВОНКА — РУССКИЙ");
    expect(rule).toContain("Никогда не отвечай, что не говоришь по-таджикски");
    expect(rule).not.toContain("отвечай только по-русски");
  });

  it("замок «только русский» — по-прежнему только по-русски", async () => {
    const { languageLockRule } = await import("../src/ai/liveVoiceConsultantPersona.js");
    expect(languageLockRule("ru", true, true)).toContain("отвечай только по-русски");
  });
});

describe("звонок владельца 12.11: эмоциональный режим включён, скорость не задаётся", () => {
  it("настройки телефонного агента", async () => {
    const { ELEVENLABS_PHONE_AGENT_TUNING } = await import("../src/ai/elevenLabsAgentSync.js");
    expect(ELEVENLABS_PHONE_AGENT_TUNING.tts.expressive_mode).toBe(true);
    expect("speed" in ELEVENLABS_PHONE_AGENT_TUNING.tts).toBe(false);
  });
});
