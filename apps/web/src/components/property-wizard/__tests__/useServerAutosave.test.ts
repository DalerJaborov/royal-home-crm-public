import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_WIZARD_VALUES } from "../types";

type Slot = { deps?: unknown[]; cleanup?: void | (() => void); value?: unknown; callback?: unknown };
const rt = vi.hoisted(() => ({ slots: [] as Slot[], index: 0, effects: [] as (() => void)[], api: vi.fn(), reminder: vi.fn(), adopt: vi.fn(), work: new Map<string, unknown>(), subscribers: new Set<() => void>(), token: "agent-1:1:0" }));
vi.mock("react", () => {
  const same = (a?: unknown[], b?: unknown[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return {
    useRef: (initial: unknown) => { const i = rt.index++; return rt.slots[i] ??= { current: initial } as Slot; },
    useState: (initial: unknown) => { const i = rt.index++; const slot = rt.slots[i] ??= { value: initial }; return [slot.value, (v: unknown) => { slot.value = v; }]; },
    useCallback: (callback: unknown, deps: unknown[]) => { const i = rt.index++; const old = rt.slots[i]; if (old && same(old.deps, deps)) return old.callback; rt.slots[i] = { deps, callback }; return callback; },
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const i = rt.index++; const old = rt.slots[i]; if (old && same(old.deps, deps)) return;
      rt.effects.push(() => { old?.cleanup?.(); rt.slots[i] = { deps, cleanup: effect() }; });
    },
  };
});
vi.mock("../../../lib/api", () => ({ api: (...args: unknown[]) => rt.api(...args) }));
vi.mock("../../../lib/draftReminder", () => ({ setDraftReminder: (...args: unknown[]) => rt.reminder(...args) }));
vi.mock("../../../store/auth", () => ({ useAuthStore: { getState: () => ({ agent: { id: "agent-1" } }), subscribe: (fn: () => void) => { rt.subscribers.add(fn); return () => rt.subscribers.delete(fn); } } }));
vi.mock("../../../lib/workGuard", () => ({ registerWork: (item: { id: string }) => { rt.work.set(item.id, item); return () => rt.work.delete(item.id); } }));
vi.mock("../../../lib/propertyDraftSession", () => ({
  propertyDraftSessionToken: () => rt.token,
  isPropertyDraftSessionCurrent: (token: string) => token === rt.token,
  ensurePropertyDraftSession: async () => ({ id: "draft-1", revision: 7 }),
  getPropertyDraftSession: () => ({ draft: { id: "draft-1", revision: 7 } }),
  adoptPropertyDraftSession: (...args: unknown[]) => rt.adopt(...args),
}));
import { useServerAutosave } from "../useServerAutosave";

const snapshot = { ...EMPTY_WIZARD_VALUES, address: "ул. Тестовая 1" };
const draft = { id: "draft-1", revision: 8, updatedAt: "2026-10-20T12:00:00Z", media: [], values: snapshot };
const micro = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
const draftRef = { current: null as string | null };
function RenderHarness(enabled = true, values = snapshot, step = 0) {
  rt.index = 0;
  const result = useServerAutosave(enabled, values, step, draftRef);
  while (rt.effects.length) rt.effects.shift()!();
  return result;
}
beforeEach(() => {
  vi.useFakeTimers(); rt.slots = []; rt.effects = []; rt.index = 0;
  rt.api.mockReset(); rt.reminder.mockReset(); rt.adopt.mockReset(); rt.work.clear(); rt.subscribers.clear(); rt.token = "agent-1:1:0"; draftRef.current = null;
});
afterEach(() => { for (const slot of rt.slots) slot.cleanup?.(); vi.clearAllTimers(); vi.useRealTimers(); });

describe("server draft hook render/effect/cleanup lifecycle", () => {
  it("sends draft identity and revision; owns dirty work until server acknowledgement", async () => {
    const pending = deferred(); rt.api.mockReturnValue(pending.promise);
    RenderHarness(); await vi.advanceTimersByTimeAsync(6000);
    expect(rt.api).toHaveBeenCalledWith("/properties/drafts/current", expect.objectContaining({ method: "PUT", body: { values: snapshot, step: 0, draftId: "draft-1", revision: 7 }, expectAgentId: "agent-1" }));
    expect(rt.work.size).toBe(1);
    pending.resolve({ draft }); await micro();
    expect(rt.work.size).toBe(0);
    expect(RenderHarness().status).toEqual({ state: "server", savedAt: draft.updatedAt });
  });
  it("retries a failed write without requiring another form edit", async () => {
    rt.api.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ draft });
    RenderHarness(); await vi.advanceTimersByTimeAsync(6000);
    expect(RenderHarness().status).toEqual({ state: "local", message: "offline" });
    expect(rt.work.size).toBe(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(rt.api).toHaveBeenCalledTimes(2);
    expect(RenderHarness().status.state).toBe("server");
  });
  it("cancel suppresses all late response effects after creation/deletion", async () => {
    const pending = deferred(); rt.api.mockReturnValue(pending.promise);
    const state = RenderHarness(); await vi.advanceTimersByTimeAsync(6000);
    state.cancel(); pending.resolve({ draft }); await micro();
    expect(rt.adopt).not.toHaveBeenCalled(); expect(rt.reminder).not.toHaveBeenCalled();
    expect(draftRef.current).toBeNull(); expect(rt.work.size).toBe(0);
  });
  it("a session transition invalidates a pending request before it can affect the new user", async () => {
    const pending = deferred(); rt.api.mockReturnValue(pending.promise);
    RenderHarness(); await vi.advanceTimersByTimeAsync(6000);
    rt.token = "agent-2:2:0"; rt.subscribers.forEach((fn) => fn());
    pending.resolve({ draft }); await micro();
    expect(rt.adopt).not.toHaveBeenCalled(); expect(rt.reminder).not.toHaveBeenCalled();
    expect(rt.work.size).toBe(0);
  });
  it("clearing all fields clears their server snapshot instead of resurrecting the previous values", async () => {
    rt.api.mockResolvedValue({ draft: { ...draft, values: {} } });
    RenderHarness(true, { ...EMPTY_WIZARD_VALUES });
    await vi.advanceTimersByTimeAsync(6000);
    expect(rt.api.mock.calls[0][1].body.values).toEqual({});
    expect(rt.reminder).toHaveBeenLastCalledWith(false);
  });
});
