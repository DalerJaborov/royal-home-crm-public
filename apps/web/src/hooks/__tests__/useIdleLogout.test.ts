import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIdleLogout } from "../useIdleLogout";
import { idleActivityKey, LEGACY_LAST_ACTIVITY_KEY } from "../../lib/idleActivity";

const state = vi.hoisted(() => ({ minutes: 30 as number | null, actorId: "A", busy: false,
  cleanup: undefined as (() => void) | undefined, logout: vi.fn(), navigate: vi.fn(),
  hydrated: true, ref: undefined as { current: unknown } | undefined }));
vi.mock("react", () => ({
  useEffect: (effect: () => (() => void) | undefined) => { state.cleanup?.(); state.cleanup = effect(); },
  useRef: (initial: unknown) => (state.ref ??= { current: initial }),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../lib/signOut", () => ({ signOut: () => { state.logout(); return Promise.resolve(); } }));
vi.mock("../../lib/workGuard", () => ({ isBusy: () => state.busy }));
vi.mock("../../store/auth", () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({ agent: { id: state.actorId } }) }));
vi.mock("../../store/uiPrefs", () => ({ useUiPrefs: (select: (s: unknown) => unknown) => select({ autoLogoutMinutes: state.minutes, serverHydrated: state.hydrated }) }));

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
  state.minutes = 30; state.hydrated = true; state.ref = undefined; state.actorId = "A"; state.busy = false; state.logout.mockClear(); state.navigate.mockClear();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
  vi.stubGlobal("window", new EventTarget());
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", document);
});
afterEach(() => { state.cleanup?.(); state.cleanup = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("persisted inactivity deadline", () => {
  it("switching the limit back on starts a fresh deadline instead of signing out", () => {
    localStorage.setItem(idleActivityKey("A"), String(Date.now() - 120 * 60_000));
    state.minutes = null; useIdleLogout();
    state.minutes = 30; useIdleLogout();
    expect(state.logout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(29 * 60_000); expect(state.logout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2 * 60_000); expect(state.logout).toHaveBeenCalledTimes(1);
  });
  it("a limit arriving with server hydration keeps the persisted deadline", () => {
    localStorage.setItem(idleActivityKey("A"), String(Date.now() - 120 * 60_000));
    state.minutes = null; state.hydrated = false; useIdleLogout();
    state.minutes = 30; state.hydrated = true; useIdleLogout();
    expect(state.logout).toHaveBeenCalledTimes(1);
  });
  it.each([idleActivityKey("A"), LEGACY_LAST_ACTIVITY_KEY])("expired %s exits before any initial touch", key => {
    const before = Date.now() - 120 * 60_000;
    localStorage.setItem(key, String(before)); useIdleLogout();
    expect(state.logout).toHaveBeenCalledTimes(1);
    expect(state.navigate).toHaveBeenCalledWith("/login");
    expect(localStorage.getItem(idleActivityKey("A"))).toBe(String(before));
  });
  it("remounting a recent session preserves its remaining deadline", () => {
    localStorage.setItem(idleActivityKey("A"), String(Date.now() - 29 * 60_000)); useIdleLogout();
    expect(state.logout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000); expect(state.logout).toHaveBeenCalledTimes(1);
  });
  it("real activity extends a valid deadline", () => {
    localStorage.setItem(idleActivityKey("A"), String(Date.now() - 29 * 60_000)); useIdleLogout();
    window.dispatchEvent(new Event("keydown")); vi.advanceTimersByTime(29 * 60_000);
    expect(state.logout).not.toHaveBeenCalled(); vi.advanceTimersByTime(60_000);
    expect(state.logout).toHaveBeenCalledTimes(1);
  });
  it("does not adopt another actor's deadline and initializes missing history", () => {
    localStorage.setItem(idleActivityKey("B"), String(Date.now() - 120 * 60_000)); useIdleLogout();
    expect(state.logout).not.toHaveBeenCalled();
    expect(localStorage.getItem(idleActivityKey("A"))).toBe(String(Date.now()));
  });
  it("another tab's valid activity extends this actor's deadline", () => {
    localStorage.setItem(idleActivityKey("A"), String(Date.now() - 29 * 60_000)); useIdleLogout();
    vi.advanceTimersByTime(30_000); localStorage.setItem(idleActivityKey("A"), String(Date.now()));
    vi.advanceTimersByTime(60_000); expect(state.logout).not.toHaveBeenCalled();
  });
  it("busy work prevents expiry until work finishes without resetting the deadline", () => {
    localStorage.setItem(idleActivityKey("A"), String(Date.now() - 120 * 60_000)); state.busy = true; useIdleLogout();
    expect(state.logout).not.toHaveBeenCalled(); state.busy = false;
    document.dispatchEvent(new Event("visibilitychange")); expect(state.logout).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000); expect(state.logout).toHaveBeenCalledTimes(1);
  });
  it("keeps the default never-logout preference", () => {
    state.minutes = null; useIdleLogout(); vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(state.logout).not.toHaveBeenCalled();
  });
});
