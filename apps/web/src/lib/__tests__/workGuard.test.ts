import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Реестр долгой работы (lib/workGuard.ts, 07.10.2026). jsdom в проекте нет —
 * `window`/`document` подменяются маленькой моделью с addEventListener/dispatch,
 * этого достаточно: модуль знает только про сами события.
 */
class FakeTarget {
  private listeners = new Map<string, Set<(e: unknown) => void>>();
  addEventListener(type: string, fn: (e: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
  dispatch(type: string, event: unknown = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
}

let win: FakeTarget;
let doc: FakeTarget & { visibilityState: string };

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  win = new FakeTarget();
  doc = Object.assign(new FakeTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("workGuard", () => {
  it("isBusy: пока есть регистрация, и снимается её функцией", async () => {
    const g = await import("../workGuard");
    expect(g.isBusy()).toBe(false);
    const off = g.registerWork({ id: "a", label: "A", blocksUnload: false });
    expect(g.isBusy()).toBe(true);
    off();
    expect(g.isBusy()).toBe(false);
  });

  it("beforeunload ставится только если есть работа с blocksUnload", async () => {
    const g = await import("../workGuard");
    const offSoft = g.registerWork({ id: "soft", label: "S", blocksUnload: false });
    expect(win.count("beforeunload")).toBe(0);
    const offHard = g.registerWork({ id: "hard", label: "H", blocksUnload: true });
    expect(win.count("beforeunload")).toBe(1);

    const event = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    win.dispatch("beforeunload", event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.returnValue).toBe("");

    offHard();
    expect(win.count("beforeunload")).toBe(0);
    offSoft();
  });

  it("hidden → flush всех, visible → resume всех", async () => {
    const g = await import("../workGuard");
    const a = { resume: vi.fn(), flush: vi.fn() };
    const b = { resume: vi.fn(), flush: vi.fn() };
    g.registerWork({ id: "a", label: "A", blocksUnload: false, ...a });
    g.registerWork({ id: "b", label: "B", blocksUnload: false, ...b });

    doc.visibilityState = "hidden";
    doc.dispatch("visibilitychange");
    expect(a.flush).toHaveBeenCalledTimes(1);
    expect(b.flush).toHaveBeenCalledTimes(1);
    expect(a.resume).not.toHaveBeenCalled();

    doc.visibilityState = "visible";
    doc.dispatch("visibilitychange");
    expect(a.resume).toHaveBeenCalledTimes(1);
    expect(b.resume).toHaveBeenCalledTimes(1);
  });

  it("pagehide → flush, pageshow и online → resume", async () => {
    const g = await import("../workGuard");
    const w = { resume: vi.fn(), flush: vi.fn() };
    g.registerWork({ id: "w", label: "W", blocksUnload: false, ...w });
    win.dispatch("pagehide");
    expect(w.flush).toHaveBeenCalledTimes(1);
    win.dispatch("pageshow");
    win.dispatch("online");
    expect(w.resume).toHaveBeenCalledTimes(2);
  });

  it("сердцебиение 30 с идёт, только пока в реестре что-то есть", async () => {
    const g = await import("../workGuard");
    const resume = vi.fn();
    const off = g.registerWork({ id: "hb", label: "HB", blocksUnload: false, resume });
    vi.advanceTimersByTime(g.WORK_HEARTBEAT_MS * 2);
    expect(resume).toHaveBeenCalledTimes(2);
    off();
    vi.advanceTimersByTime(g.WORK_HEARTBEAT_MS * 3);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(doc.count("visibilitychange")).toBe(0);
    expect(win.count("online")).toBe(0);
  });

  it("устаревшая функция снятия не убирает заново зарегистрированную работу", async () => {
    const g = await import("../workGuard");
    const offOld = g.registerWork({ id: "x", label: "old", blocksUnload: false });
    g.registerWork({ id: "x", label: "new", blocksUnload: false });
    offOld();
    expect(g.isBusy()).toBe(true);
    expect(g.listWork()).toEqual(["new"]);
  });

  it("сбой в resume одной работы не мешает остальным", async () => {
    const g = await import("../workGuard");
    const ok = vi.fn();
    g.registerWork({
      id: "bad",
      label: "bad",
      blocksUnload: false,
      resume: () => {
        throw new Error("boom");
      },
    });
    g.registerWork({ id: "ok", label: "ok", blocksUnload: false, resume: ok });
    win.dispatch("online");
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
