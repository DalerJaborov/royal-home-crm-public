import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Живое обновление пульта (пачка B, 23.10.2026): чат-события гасят пульт,
 * волна пульта — раз в ~3 с (счётчики остаются на 10 с), а после обрыва поток
 * просит доиграть пропущенное и догоняет инвалидацией.
 */
vi.mock("../api", () => ({ api: vi.fn(async () => ({ ticket: "t" })) }));

type Listener = (ev: { data: string }) => void;
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Listener[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, l: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  close() {}
  emit(type: string, id: number) {
    for (const l of this.listeners.get(type) ?? []) l({ data: JSON.stringify({ type, id }) });
  }
}

import { INVALIDATION, startLiveEvents, stopLiveEvents } from "../liveEvents";

const invalidate = vi.fn();
const roots = () => invalidate.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
const last = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

beforeEach(async () => {
  vi.useFakeTimers();
  invalidate.mockReset();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("document", { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("navigator", { onLine: true });
  startLiveEvents({ invalidateQueries: invalidate } as never);
  await vi.advanceTimersByTimeAsync(0);
});
afterEach(() => {
  stopLiveEvents();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("пульт: инвалидация по событиям", () => {
  it("message.new и conversation.updated гасят mission-control", () => {
    expect(INVALIDATION["message.new"]).toContainEqual(["mission-control"]);
    expect(INVALIDATION["conversation.updated"]).toContainEqual(["mission-control"]);
  });

  it("волна пульта не чаще раза в 3 секунды, а не 10", async () => {
    const es = last();
    es.emit("pult.snapshot", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(roots().filter((r) => r === "mission-control")).toHaveLength(1);

    es.emit("pult.snapshot", 2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(roots().filter((r) => r === "mission-control")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(roots().filter((r) => r === "mission-control")).toHaveLength(2);
  });

  it("счётчики по-прежнему держат 10 секунд", async () => {
    const es = last();
    es.emit("notification.new", 1);
    await vi.advanceTimersByTimeAsync(1_100);
    const first = roots().filter((r) => r === "counters").length;
    es.emit("notification.new", 2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(roots().filter((r) => r === "counters").length).toBe(first);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(roots().filter((r) => r === "counters").length).toBe(first + 1);
  });
});

describe("пульт: переподключение", () => {
  it("после обрыва просит доиграть с последнего id и догоняет инвалидацией", async () => {
    const es = last();
    es.onopen?.();
    es.emit("deal.updated", 7);
    await vi.advanceTimersByTimeAsync(1_100);
    invalidate.mockReset();

    es.onerror?.();
    await vi.advanceTimersByTimeAsync(2_000);
    const second = last();
    expect(second).not.toBe(es);
    expect(second.url).toContain("lastEventId=7");

    second.onopen?.();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(roots()).toContain("clients");
    expect(roots()).toContain("mission-control");
  });
});
