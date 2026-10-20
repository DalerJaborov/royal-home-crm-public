import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Запоздавшее событие с меньшим id не теряется (аудит Codex 04.10.2026, WEB-09).
 * Сервер раздаёт события своего процесса сразу, чужие (воркера) обходом хвоста
 * раз в секунду, поэтому message.new id101 может прийти после property.updated
 * id102. Монотонный lastEventId выбрасывал его вместе с обновлением переписки.
 */
vi.mock("../api", () => ({ api: vi.fn(async () => ({ ticket: "t" })) }));

type Listener = (ev: { data: string }) => void;
class FakeEventSource {
  static last: FakeEventSource | null = null;
  listeners = new Map<string, Listener[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, l: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  close() {}
  emit(type: string, id: number) {
    for (const l of this.listeners.get(type) ?? []) l({ data: JSON.stringify({ type, id }) });
  }
}

import { startLiveEvents, stopLiveEvents } from "../liveEvents";

const invalidated = () => invalidate.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
const invalidate = vi.fn();

beforeEach(async () => {
  vi.useFakeTimers();
  invalidate.mockReset();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("document", { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("navigator", { onLine: true });
  startLiveEvents({ invalidateQueries: invalidate } as never);
  await vi.advanceTimersByTimeAsync(0); // получение билета и открытие потока
});
afterEach(() => {
  stopLiveEvents();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("поток событий: порядок доставки", () => {
  it("message.new id101 после property.updated id102 всё равно гасит переписку", async () => {
    const es = FakeEventSource.last!;
    es.emit("property.updated", 102);
    es.emit("message.new", 101);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(invalidated()).toContain("conversations");
    expect(invalidated()).toContain("properties");
  });

  it("точный повтор id игнорируется", async () => {
    const es = FakeEventSource.last!;
    es.emit("message.new", 7);
    await vi.advanceTimersByTimeAsync(2_000);
    invalidate.mockClear();
    es.emit("message.new", 7);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("память повторов ограничена: самый старый id забывается после 500 новых", async () => {
    const es = FakeEventSource.last!;
    for (let id = 1; id <= 501; id++) es.emit("deal.updated", id);
    await vi.advanceTimersByTimeAsync(2_000);
    invalidate.mockClear();
    es.emit("message.new", 1); // вытеснен
    await vi.advanceTimersByTimeAsync(2_000);
    expect(invalidated()).toContain("conversations");
  });
});
