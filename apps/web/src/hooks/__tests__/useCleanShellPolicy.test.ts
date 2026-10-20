import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ query: vi.fn(), mobile: false, role: "DIRECTOR", search: "", result: { data: undefined as { enabled: boolean } | undefined, isPending: true, isError: false } }));
vi.mock("react", () => ({ useEffect: () => {}, useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));
vi.mock("react-router-dom", () => ({ useLocation: () => ({ search: h.search }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: (options: unknown) => { h.query(options); return h.result; } }));
vi.mock("../../store/auth", () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({ agent: { id: "one", role: h.role } }) }));
vi.mock("../useMobileUx", () => ({ useMobileUx: () => h.mobile }));
vi.mock("../../lib/api", () => ({ api: vi.fn() }));
import { useCleanShellSelection } from "../useCleanShell";

beforeEach(() => { vi.unstubAllGlobals(); h.mobile = false; h.role = "DIRECTOR"; h.search = ""; h.result = { data: undefined, isPending: true, isError: false }; h.query.mockClear(); });
describe("shell policy network failure", () => {
  it("checks an emergency rollback through one layout observer and leaves agent phones untouched", () => {
    useCleanShellSelection(true);
    const options = h.query.mock.calls.at(-1)?.[0];
    expect(options).toMatchObject({ refetchIntervalInBackground: false });
    expect(options.refetchInterval({ state: { data: { enabled: true } } })).toBe(30_000);
    expect(options.refetchInterval({ state: { data: undefined } })).toBe(false);
    expect(options.refetchInterval({ state: { data: { enabled: false } } })).toBe(false);
    useCleanShellSelection();
    expect(h.query.mock.calls.at(-1)?.[0]).toMatchObject({ refetchInterval: false });
    h.mobile = true; h.role = "AGENT";
    useCleanShellSelection(true);
    expect(h.query.mock.calls.at(-1)?.[0]).toMatchObject({ refetchInterval: false, enabled: false });
  });
  it("defaults to Clean only after an affirmative server policy", () => {
    h.result = { data: { enabled: true }, isPending: false, isError: false };
    expect(useCleanShellSelection()).toEqual({ clean: true, pending: false });
    h.search = "?shell=legacy";
    expect(useCleanShellSelection()).toEqual({ clean: false, pending: false });
  });
  it("attempts offline instead of leaving the entire layout in a paused query", () => {
    expect(useCleanShellSelection()).toEqual({ clean: false, pending: true });
    expect(h.query.mock.calls[0][0]).toMatchObject({ networkMode: "always", retry: false, retryOnMount: false });
    h.result.isPending = false;
    expect(useCleanShellSelection()).toEqual({ clean: false, pending: false });
  });
  it("never bypasses the server switch with a URL, and agent mobile defaults to legacy", () => {
    h.search = "?shell=clean"; h.result = { data: { enabled: false }, isPending: false, isError: false };
    expect(useCleanShellSelection()).toEqual({ clean: false, pending: false });
    h.mobile = true; h.role = "AGENT"; h.result = { data: { enabled: true }, isPending: true, isError: false };
    expect(useCleanShellSelection()).toEqual({ clean: false, pending: false });
  });
  it.each(["DIRECTOR", "ADMIN", "MANAGER", "SHAREHOLDER"])("requests the mandatory server policy on %s phones", (role) => {
    h.role = role; h.mobile = true;
    expect(useCleanShellSelection()).toEqual({ clean: false, pending: true });
    expect(h.query.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: true });
    h.result = { data: { enabled: true }, isPending: false, isError: false };
    expect(useCleanShellSelection()).toEqual({ clean: true, pending: false });
    h.result.isError = true;
    expect(useCleanShellSelection()).toEqual({ clean: true, pending: false });
    h.result = { data: { enabled: false }, isPending: false, isError: false };
    expect(useCleanShellSelection()).toEqual({ clean: false, pending: false });
  });
  it("cold mobile policy failures remain legacy while cached successes preserve working shells", () => {
    h.role = "DIRECTOR"; h.mobile = true;
    h.result = { data: undefined, isPending: false, isError: true };
    expect(useCleanShellSelection()).toEqual({ clean: false, pending: false, unavailable: true });
    h.result.data = { enabled: true };
    expect(useCleanShellSelection()).toEqual({ clean: true, pending: false });
  });
  it("agent preview requires a local opt-in and an affirmative server policy", () => {
    vi.stubGlobal("window", { location: { hostname: "localhost" } });
    h.role = "AGENT"; h.mobile = true; h.search = "?shell=clean&agentMobilePreview=1";
    expect(useCleanShellSelection()).toEqual({ clean: false, pending: true });
    h.result = { data: { enabled: true }, isPending: false, isError: false };
    expect(useCleanShellSelection()).toEqual({ clean: true, pending: false });
    h.result.isError = true;
    expect(useCleanShellSelection()).toEqual({ clean: false, pending: false, unavailable: true });
    vi.stubGlobal("window", { location: { hostname: "crm.example.com" } });
    h.result.isError = false;
    expect(useCleanShellSelection()).toEqual({ clean: false, pending: false });
  });
  it("keeps an actor's local preview after navigation without carrying query parameters", () => {
    vi.stubGlobal("window", {
      location: { hostname: "localhost" },
      sessionStorage: { getItem: (key: string) => key === "rh-agent-mobile-preview:one" ? "1" : null },
      localStorage: { getItem: () => "legacy" },
    });
    h.role = "AGENT"; h.mobile = true; h.search = "";
    h.result = { data: { enabled: true }, isPending: false, isError: false };
    expect(useCleanShellSelection()).toEqual({ clean: true, pending: false });
    h.search = "?agentMobilePreview=0";
    expect(useCleanShellSelection()).toEqual({ clean: false, pending: false });
  });
});
