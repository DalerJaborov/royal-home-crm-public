import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Разрешение микрофона, пришедшее ПОСЛЕ ухода с экрана или отмены, не запускает
 * запись и не отправляет её клиенту (аудит Codex 04.10.2026, WEB-07).
 *
 * React подменён минимальной обвязкой (один «рендер», ссылки живут между вызовами),
 * getUserMedia отложен вручную: так между нажатием и ответом браузера можно
 * размонтировать экран.
 */
const h = vi.hoisted(() => {
  const state = { refs: [] as { current: unknown }[], refIdx: 0, cleanups: [] as (() => void)[] };
  return state;
});
vi.mock("react", () => ({
  useRef: <T,>(v: T) => {
    const i = h.refIdx++;
    h.refs[i] ??= { current: v };
    return h.refs[i] as { current: T };
  },
  useState: <T,>(init: T | (() => T)) => [typeof init === "function" ? (init as () => T)() : init, vi.fn()],
  useCallback: <T,>(f: T) => f,
  useEffect: (f: () => void | (() => void)) => {
    const c = f();
    if (typeof c === "function") h.cleanups.push(c);
  },
}));
vi.mock("../../lib/api", async () => ({ ApiError: (await import("../../lib/apiError")).ApiError }));

import { useVoiceMessageRecorder } from "../useVoiceMessageRecorder";

class FakeRecorder {
  static created: FakeRecorder[] = [];
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: unknown) {
    FakeRecorder.created.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["x"]) });
    void this.onstop?.();
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}
const fakeStream = () => {
  const stop = vi.fn();
  return { stream: { getTracks: () => [{ stop }] }, stop };
};

let getUserMedia: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  h.refs = [];
  h.refIdx = 0;
  h.cleanups = [];
  FakeRecorder.created = [];
  getUserMedia = vi.fn();
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useVoiceMessageRecorder: ожидание разрешения микрофона", () => {
  it("уход с экрана до разрешения: рекордер не создаётся, дорожки останавливаются, ничего не уходит", async () => {
    const send = vi.fn(async () => {});
    const hook = useVoiceMessageRecorder(send);
    const perm = deferred<unknown>();
    getUserMedia.mockReturnValue(perm.promise);
    const started = hook.start();
    h.cleanups.forEach((c) => c()); // размонтирование
    const { stream, stop } = fakeStream();
    perm.resolve(stream);
    await started;
    expect(FakeRecorder.created).toHaveLength(0);
    expect(stop).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(130_000);
    expect(send).not.toHaveBeenCalled();
  });

  it("отмена до разрешения действует так же", async () => {
    const send = vi.fn(async () => {});
    const hook = useVoiceMessageRecorder(send);
    const perm = deferred<unknown>();
    getUserMedia.mockReturnValue(perm.promise);
    const started = hook.start();
    hook.cancel();
    const { stream, stop } = fakeStream();
    perm.resolve(stream);
    await started;
    expect(FakeRecorder.created).toHaveLength(0);
    expect(stop).toHaveBeenCalled();
  });

  it("второй start, пока ждём разрешения, не открывает второй микрофон", async () => {
    const hook = useVoiceMessageRecorder(vi.fn(async () => {}));
    const perm = deferred<unknown>();
    getUserMedia.mockReturnValue(perm.promise);
    const first = hook.start();
    await hook.start();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    perm.resolve(fakeStream().stream);
    await first;
    expect(FakeRecorder.created).toHaveLength(1);
  });

  it("контрольный: без ухода с экрана запись стартует и уходит по остановке", async () => {
    const send = vi.fn(async () => {});
    const hook = useVoiceMessageRecorder(send);
    getUserMedia.mockResolvedValue(fakeStream().stream);
    await hook.start();
    expect(FakeRecorder.created).toHaveLength(1);
    hook.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
