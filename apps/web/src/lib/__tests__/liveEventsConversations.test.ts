import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * «Чаты» при потоке входящих (17.11.2026, аудит скорости P1): открытый диалог
 * обновляется через секунду, как раньше, а списки собирают события и уходят
 * одним запросом не чаще раза в 5 секунд.
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

import { isConversationListKey, startLiveEvents, stopLiveEvents } from "../liveEvents";

type Filters = { queryKey: unknown[]; predicate?: (q: { queryKey: unknown[] }) => boolean };
const invalidate = vi.fn();
const LIST_KEY = ["conversations", { needsHuman: true }];
const PULT_KEY = ["conversations", "pult-inbox", "waiting"];
const DIALOG_KEY = ["conversations", "conv-1"];
const GROUP_DIALOG_KEY = ["conversations", "groups", "g-1"];

/** Сколько раз волны задели бы данный ключ (с учётом префикса и предиката). */
const hits = (key: unknown[]) =>
  invalidate.mock.calls.filter(([f]) => {
    const filters = f as Filters;
    if (filters.queryKey[0] !== key[0]) return false;
    return filters.predicate ? filters.predicate({ queryKey: key }) : true;
  }).length;
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

describe("какой ключ — список, какой — открытый диалог", () => {
  it("списки: фильтры-объект и очереди пульта", () => {
    expect(isConversationListKey(LIST_KEY)).toBe(true);
    expect(isConversationListKey(["conversations", {}])).toBe(true);
    expect(isConversationListKey(PULT_KEY)).toBe(true);
  });
  it("открытый диалог и незнакомые формы — не список", () => {
    expect(isConversationListKey(DIALOG_KEY)).toBe(false);
    expect(isConversationListKey(GROUP_DIALOG_KEY)).toBe(false);
    expect(isConversationListKey(["conversations"])).toBe(false);
    expect(isConversationListKey(["clients", {}])).toBe(false);
  });
});

describe("волны «Чатов» при потоке сообщений", () => {
  it("волна списков не обрывает запрос, который ещё идёт (cancelRefetch: false)", async () => {
    last().emit("message.new", 1);
    await vi.advanceTimersByTimeAsync(1000);
    const listCalls = invalidate.mock.calls.filter(([f]) => (f as Filters).predicate?.({ queryKey: LIST_KEY }));
    expect(listCalls.length).toBeGreaterThan(0);
    for (const call of listCalls) expect(call[1]).toEqual({ cancelRefetch: false });
  });

  it("одно сообщение после затишья: и диалог, и список — через секунду, как раньше", async () => {
    last().emit("message.new", 1);
    await vi.advanceTimersByTimeAsync(999);
    expect(hits(DIALOG_KEY)).toBe(0);
    expect(hits(LIST_KEY)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(hits(DIALOG_KEY)).toBe(1);
    expect(hits(GROUP_DIALOG_KEY)).toBe(1);
    expect(hits(LIST_KEY)).toBe(1);
    expect(hits(PULT_KEY)).toBe(1);
  });

  it("сообщение каждую секунду: диалог гаснет каждую секунду, списки — не чаще раза в 5 с, и хвост не теряется", async () => {
    const es = last();
    for (let i = 1; i <= 10; i++) {
      es.emit(i % 2 ? "message.new" : "conversation.updated", i);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    // 10 событий за 10 секунд: открытый диалог — 10 волн, список — первая через 1 с и потом раз в 5 с.
    expect(hits(DIALOG_KEY)).toBe(10);
    expect(hits(LIST_KEY)).toBe(2);
    // Поток кончился — заднее событие всё равно доезжает до списка.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hits(LIST_KEY)).toBe(3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(hits(LIST_KEY)).toBe(3);
  });

  it("волна списков — один вызов на всё накопленное, корень ключа прежний", async () => {
    const es = last();
    es.emit("message.new", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    invalidate.mockReset();
    for (let i = 2; i <= 6; i++) es.emit("message.new", i);
    await vi.advanceTimersByTimeAsync(5_000);
    const listCalls = invalidate.mock.calls.filter(([f]) => (f as Filters).predicate?.({ queryKey: LIST_KEY }));
    expect(listCalls).toHaveLength(1);
    expect((listCalls[0][0] as Filters).queryKey).toEqual(["conversations"]);
  });
});
