import { afterEach, describe, expect, it, vi } from "vitest";
import {
  audioFileNameFor,
  baseMime,
  createRecorder,
  formatElapsed,
  micErrorMessage,
  pickRecorderMimeType,
  recordedMime,
} from "../audioRecording";

/**
 * Запись голоса: формат выбирается по возможностям браузера, а не жёстко `audio/webm`.
 * Жалоба владельца 15.11.2026 «микрофон не работает»: Safari/iPhone отвергает webm.
 */
function stubRecorder(supported: string[], throwOn: string[] = []) {
  const created: { mimeType?: string }[] = [];
  class R {
    static isTypeSupported = (m: string) => supported.includes(m);
    constructor(_s: unknown, opts?: { mimeType?: string }) {
      if (opts?.mimeType && throwOn.includes(opts.mimeType)) {
        const e = new Error("nope");
        e.name = "NotSupportedError";
        throw e;
      }
      created.push({ mimeType: opts?.mimeType });
    }
  }
  vi.stubGlobal("MediaRecorder", R);
  return created;
}
afterEach(() => vi.unstubAllGlobals());

describe("pickRecorderMimeType", () => {
  it("Chrome: opus в webm", () => {
    stubRecorder(["audio/webm;codecs=opus", "audio/webm"]);
    expect(pickRecorderMimeType()).toBe("audio/webm;codecs=opus");
  });
  it("Safari/iPhone: webm нет, берётся mp4", () => {
    stubRecorder(["audio/mp4"]);
    expect(pickRecorderMimeType()).toBe("audio/mp4");
  });
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1";
  const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  it("iPhone с iOS 18.4+: умеет и webm, и mp4 — берётся mp4 (webm из Safari модель расшифровки читала пусто)", () => {
    stubRecorder(["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]);
    expect(pickRecorderMimeType(IPHONE)).toBe("audio/mp4");
  });
  it("iPhone, где mp4 нет, — webm как запасной", () => {
    stubRecorder(["audio/webm"]);
    expect(pickRecorderMimeType(IPHONE)).toBe("audio/webm");
  });
  it("Chrome (его UA тоже содержит «Safari/») — по-прежнему opus в webm", () => {
    stubRecorder(["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]);
    expect(pickRecorderMimeType(CHROME)).toBe("audio/webm;codecs=opus");
  });
  it("ничего не заявлено — undefined, браузер выберет сам", () => {
    stubRecorder([]);
    expect(pickRecorderMimeType()).toBeUndefined();
  });
});

describe("createRecorder", () => {
  it("подобранный формат передаётся рекордеру", () => {
    const created = stubRecorder(["audio/mp4"]);
    createRecorder({} as MediaStream);
    expect(created).toEqual([{ mimeType: "audio/mp4" }]);
  });
  it("браузер отверг даже подобранный формат — запись без пожеланий, а не ошибка", () => {
    const created = stubRecorder(["audio/mp4"], ["audio/mp4"]);
    createRecorder({} as MediaStream);
    expect(created).toEqual([{ mimeType: undefined }]);
  });
});

describe("тип и имя файла записи", () => {
  it("тип без параметров кодека", () => {
    expect(baseMime("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(recordedMime({ mimeType: "audio/webm;codecs=opus" }, [])).toBe("audio/webm");
  });
  it("iOS отдаёт пустой mimeType — берётся тип куска, затем формат Safari", () => {
    expect(recordedMime({ mimeType: "" }, [new Blob(["x"], { type: "audio/mp4" })])).toBe("audio/mp4");
    expect(recordedMime({ mimeType: "" }, [])).toBe("audio/mp4");
  });
  it("расширение совпадает с содержимым", () => {
    expect(audioFileNameFor("audio/webm")).toBe("voice.webm");
    expect(audioFileNameFor("audio/mp4")).toBe("voice.m4a");
    expect(audioFileNameFor("audio/ogg;codecs=opus", "voice-note")).toBe("voice-note.ogg");
  });
});

describe("micErrorMessage: причина, а не «не получилось»", () => {
  const msg = (name: string) => micErrorMessage({ name });
  it("разные беды — разные советы", () => {
    expect(msg("NotAllowedError")).toContain("Разрешите");
    expect(msg("NotFoundError")).toContain("не найден");
    expect(msg("NotReadableError")).toContain("занят");
    expect(msg("NotSupportedError")).toContain("браузер");
    expect(msg("Что-то")).toContain("Не удалось включить");
  });
  it("все тексты разные", () => {
    const all = ["NotAllowedError", "NotFoundError", "NotReadableError", "NotSupportedError", "x"].map(msg);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("formatElapsed", () => {
  it("минуты и секунды", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(7_400)).toBe("0:07");
    expect(formatElapsed(65_000)).toBe("1:05");
  });
});
