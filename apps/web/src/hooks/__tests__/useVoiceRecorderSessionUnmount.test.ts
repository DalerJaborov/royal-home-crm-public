import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Голосовое «как в WhatsApp» (ревью 27.11.2026): палец отпущен («Отправить»), и сразу же уход с экрана —
 * запись должна доехать, а не потеряться молча. Уход ДО отпускания — по-прежнему отмена без отправки.
 * React подменён минимальной обвязкой, как в useVoiceMessageRecorder.test.ts.
 */
const h = vi.hoisted(() => ({ refs: [] as { current: unknown }[], refIdx: 0, cleanups: [] as (() => void)[] }));
vi.mock("react", () => ({
  useRef: <T,>(v: T) => {
    const i = h.refIdx++;
    h.refs[i] ??= { current: v };
    return h.refs[i] as { current: T };
  },
  useState: <T,>(init: T | (() => T)) => [typeof init === "function" ? (init as () => T)() : init, vi.fn()],
  useReducer: <S,>(_r: unknown, init: S) => [init, vi.fn()],
  useCallback: <T,>(f: T) => f,
  useEffect: (f: () => void | (() => void)) => {
    const c = f();
    if (typeof c === "function") h.cleanups.push(c);
  },
}));
vi.mock("../../lib/api", async () => ({ ApiError: (await import("../../lib/apiError")).ApiError }));

import { useVoiceRecorderSession } from "../useVoiceRecorderSession";

/** Остановка как в браузере: onstop приходит не сразу, а следующим событием. */
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
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob(["voice"]) });
      this.onstop?.();
    }, 0);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  h.refs = [];
  h.refIdx = 0;
  h.cleanups = [];
  FakeRecorder.created = [];
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) } });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function recording(send: (blob: Blob) => Promise<unknown>) {
  const hook = useVoiceRecorderSession(send);
  hook.handlers.onClick();
  await vi.advanceTimersByTimeAsync(0);
  expect(FakeRecorder.created).toHaveLength(1);
  return hook;
}

describe("голосовое и уход с экрана", () => {
  it("«Отправить» и сразу уход с экрана: голосовое всё равно уходит", async () => {
    const send = vi.fn(async () => {});
    const hook = await recording(send);
    hook.send();
    h.cleanups.forEach((c) => c()); // размонтирование до прихода onstop
    await vi.advanceTimersByTimeAsync(10);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("уход с экрана во время записи (палец не отпущен) — отмена, ничего не уходит", async () => {
    const send = vi.fn(async () => {});
    await recording(send);
    h.cleanups.forEach((c) => c());
    await vi.advanceTimersByTimeAsync(10);
    expect(send).not.toHaveBeenCalled();
  });
});
