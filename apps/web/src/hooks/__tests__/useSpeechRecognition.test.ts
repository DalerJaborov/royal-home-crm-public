import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Диктовка в ассистента (useSpeechRecognition) — те же допущения, что у
 * useVoiceMessageRecorder: отказ микрофона виден человеку, уход с экрана отбрасывает
 * запись, формат файла совпадает с тем, что записал браузер (Safari/iPhone — mp4).
 * React подменён минимальной обвязкой (см. useVoiceMessageRecorder.test.ts).
 */
const h = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  refIdx: 0,
  cleanups: [] as (() => void)[],
  setters: [] as ReturnType<typeof vi.fn>[],
}));
vi.mock("react", () => ({
  useRef: <T,>(v: T) => {
    const i = h.refIdx++;
    h.refs[i] ??= { current: v };
    return h.refs[i] as { current: T };
  },
  useState: <T,>(init: T | (() => T)) => {
    const setter = vi.fn();
    h.setters.push(setter);
    return [typeof init === "function" ? (init as () => T)() : init, setter];
  },
  useCallback: <T,>(f: T) => f,
  useEffect: (f: () => void | (() => void)) => {
    const c = f();
    if (typeof c === "function") h.cleanups.push(c);
  },
}));
const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", async () => ({ api: apiMock, ApiError: (await import("../../lib/apiError")).ApiError }));

import { useSpeechRecognition } from "../useSpeechRecognition";

class FakeRecorder {
  static created: FakeRecorder[] = [];
  static isTypeSupported = (m: string) => FakeRecorder.supported.includes(m);
  static supported: string[] = ["audio/webm"];
  state = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? "";
    FakeRecorder.created.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["x"], { type: this.mimeType }) });
    void this.onstop?.();
  }
}

const fakeStream = () => {
  const stop = vi.fn();
  return { stream: { getTracks: () => [{ stop }] }, stop };
};
const lastCall = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0];
// порядок useState в хуке: isListening, isTranscribing, error, elapsedMs, supported
const setError = () => h.setters[2];

let getUserMedia: ReturnType<typeof vi.fn>;
function useRendered(onResult: (t: string) => void = () => {}) {
  h.refIdx = 0;
  h.setters = [];
  return useSpeechRecognition(onResult);
}
beforeEach(() => {
  vi.useFakeTimers();
  h.refs = [];
  h.cleanups = [];
  FakeRecorder.created = [];
  FakeRecorder.supported = ["audio/webm"];
  apiMock.mockReset();
  getUserMedia = vi.fn();
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useSpeechRecognition: отказ виден человеку", () => {
  it("доступ к микрофону запрещён — понятный текст, а не тишина", async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    const speech = useRendered();
    await speech.start();
    expect(String(lastCall(setError()))).toContain("Разрешите");
  });

  it("браузер без записи: кнопка не молчит, а объясняет", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    const speech = useRendered();
    await speech.start();
    expect(String(lastCall(setError()))).toContain("нельзя записать голос");
  });
});

describe("useSpeechRecognition: уход с экрана", () => {
  it("закрыли окно, пока браузер спрашивал разрешение: рекордер не создаётся, дорожки остановлены", async () => {
    const { stream, stop } = fakeStream();
    let release!: (s: unknown) => void;
    getUserMedia.mockReturnValue(new Promise((r) => (release = r)));
    const speech = useRendered();
    const started = speech.start();
    h.cleanups.forEach((c) => c());
    release(stream);
    await started;
    expect(FakeRecorder.created).toHaveLength(0);
    expect(stop).toHaveBeenCalled();
  });

  it("закрыли окно во время записи: запись не уходит на платную расшифровку", async () => {
    const { stream } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    const speech = useRendered();
    await speech.start();
    await vi.advanceTimersByTimeAsync(1500);
    h.cleanups.forEach((c) => c());
    expect(apiMock).not.toHaveBeenCalled();
  });
});

describe("useSpeechRecognition: запись и отправка", () => {
  it("Safari/iPhone: пишет mp4 и отправляет файл с расширением m4a", async () => {
    FakeRecorder.supported = ["audio/mp4"];
    const { stream } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    apiMock.mockResolvedValue({ text: "привет" });
    const onResult = vi.fn();
    const speech = useRendered(onResult);
    await speech.start();
    await vi.advanceTimersByTimeAsync(1500);
    speech.stop();
    await vi.advanceTimersByTimeAsync(10);
    const form = apiMock.mock.calls[0][1].body as FormData;
    const file = form.get("audio") as File;
    expect(file.name).toBe("voice.m4a");
    expect(file.type).toBe("audio/mp4");
    expect(onResult).toHaveBeenCalledWith("привет");
  });

  it("слишком короткая запись не уходит на сервер, человек получает подсказку", async () => {
    const { stream } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    const speech = useRendered();
    await speech.start();
    speech.stop();
    await vi.advanceTimersByTimeAsync(10);
    expect(apiMock).not.toHaveBeenCalled();
    expect(String(lastCall(setError()))).toContain("Слишком коротко");
  });
});
