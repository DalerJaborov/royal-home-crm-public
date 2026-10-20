import { describe, expect, it } from "vitest";
import {
  MAX_LISTEN_LINES,
  PLAYBACK_LEAD_SEC,
  PLAYBACK_MAX_AHEAD_SEC,
  appendListenText,
  listenRoleLabel,
  pcm16LeBase64ToFloat32,
  planPlaybackStart,
  takeSseFrames,
} from "../liveVoiceListen";
import { activeCallTitle } from "../../components/LiveVoiceListen";

/** Прослушка робота: чистые функции ленты, звука и разбора потока. */

describe("лента расшифровки", () => {
  it("куски одного говорящего склеиваются в одну реплику", () => {
    let lines = appendListenText([], "bot", "Здрав");
    lines = appendListenText(lines, "bot", "ствуйте");
    lines = appendListenText(lines, "bot", "Чем помочь?");
    expect(lines).toEqual([{ role: "bot", text: "Здравствуйте Чем помочь?" }]);
  });

  it("смена говорящего начинает новую реплику, исходный массив не меняется", () => {
    const first = appendListenText([], "bot", "Слушаю");
    const second = appendListenText(first, "client", "Алло");
    expect(first).toHaveLength(1);
    expect(second).toEqual([
      { role: "bot", text: "Слушаю" },
      { role: "client", text: "Алло" },
    ]);
  });

  it("пустой кусок ничего не добавляет", () => {
    expect(appendListenText([{ role: "bot", text: "а" }], "bot", "")).toEqual([{ role: "bot", text: "а" }]);
  });

  it("длинный разговор обрезается с начала", () => {
    let lines: ReturnType<typeof appendListenText> = [];
    for (let i = 0; i < MAX_LISTEN_LINES + 20; i++) lines = appendListenText(lines, i % 2 ? "bot" : "client", `r${i}`);
    expect(lines).toHaveLength(MAX_LISTEN_LINES);
    expect(lines[lines.length - 1].text).toBe(`r${MAX_LISTEN_LINES + 19}`);
  });

  it("подписи говорящих — по-русски", () => {
    expect(listenRoleLabel("client")).toBe("Клиент");
    expect(listenRoleLabel("bot")).toBe("Робот");
  });
});

describe("звук", () => {
  it("PCM16 LE из base64 переводится в числа [-1, 1)", () => {
    // 0, 16384 (0x4000), -32768 (0x8000), -1 (0xFFFF), 32767 (0x7FFF)
    const bytes = Uint8Array.from([0x00, 0x00, 0x00, 0x40, 0x00, 0x80, 0xff, 0xff, 0xff, 0x7f]);
    const out = pcm16LeBase64ToFloat32(btoa(String.fromCharCode(...bytes)));
    expect(out).toHaveLength(5);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(0.5, 5);
    expect(out[2]).toBe(-1);
    expect(out[3]).toBeCloseTo(-1 / 32768, 8);
    expect(out[4]).toBeCloseTo(32767 / 32768, 8);
  });

  it("нечётный хвост байтов отбрасывается, пустая строка — пустой звук", () => {
    expect(pcm16LeBase64ToFloat32(btoa("\u0001\u0000\u0002"))).toHaveLength(1);
    expect(pcm16LeBase64ToFloat32("")).toHaveLength(0);
  });

  it("первый кусок и догнавший очередь ждут запас, идущий встык — встык", () => {
    expect(planPlaybackStart(0, 10)).toBeCloseTo(10 + PLAYBACK_LEAD_SEC, 8);
    expect(planPlaybackStart(9.9, 10)).toBeCloseTo(10 + PLAYBACK_LEAD_SEC, 8);
    expect(planPlaybackStart(10.3, 10)).toBe(10.3);
  });

  it("очередь, убежавшая слишком далеко вперёд, сбрасывается", () => {
    expect(planPlaybackStart(10 + PLAYBACK_MAX_AHEAD_SEC + 0.5, 10)).toBeCloseTo(10 + PLAYBACK_LEAD_SEC, 8);
  });
});

describe("разбор потока событий", () => {
  it("достаёт целые кадры, комментарии пропускает, хвост оставляет", () => {
    const text =
      ": поток открыт\n\n" +
      'event: ready\ndata: {"id":"a"}\n\n' +
      ": ping\n\n" +
      'event: transcript\ndata: {"role":"bot","text":"Привет"}\n\n' +
      'event: audio\ndata: {"side":"cl';
    const { frames, rest } = takeSseFrames(text);
    expect(frames).toEqual([
      { event: "ready", data: '{"id":"a"}' },
      { event: "transcript", data: '{"role":"bot","text":"Привет"}' },
    ]);
    expect(rest).toBe('event: audio\ndata: {"side":"cl');
  });

  it("кадр, разорванный посреди, дособирается со следующим куском", () => {
    const a = takeSseFrames('event: end\ndata: {"reas');
    expect(a.frames).toHaveLength(0);
    const b = takeSseFrames(a.rest + 'on":"hangup"}\n\n');
    expect(b.frames).toEqual([{ event: "end", data: '{"reason":"hangup"}' }]);
    expect(b.rest).toBe("");
  });

  it("переводы строк CRLF понимаются", () => {
    expect(takeSseFrames("event: end\r\ndata: {}\r\n\r\n").frames).toEqual([{ event: "end", data: "{}" }]);
  });
});

describe("подпись активного звонка", () => {
  it("направление и номер", () => {
    expect(activeCallTitle({ direction: "inbound", callerNumber: "+992900000001" })).toBe("Входящий · +992900000001");
    expect(activeCallTitle({ direction: "outbound", callerNumber: null })).toBe("Исходящий");
    expect(activeCallTitle({ direction: "test", callerNumber: null })).toBe("Тестовый");
  });
});
