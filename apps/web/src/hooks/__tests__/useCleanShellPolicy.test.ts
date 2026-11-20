import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ query: vi.fn(), mobile: false, role: "DIRECTOR", search: "", result: { data: undefined as { enabled: boolean; look?: "royal" } | undefined, isPending: true, isError: false } }));
vi.mock("react", () => ({ useEffect: () => {}, useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));
vi.mock("react-router-dom", () => ({ useLocation: () => ({ search: h.search }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: (options: unknown) => { h.query(options); return h.result; } }));
vi.mock("../../store/auth", () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({ agent: { id: "one", role: h.role } }) }));
vi.mock("../useMobileUx", () => ({ useMobileUx: () => h.mobile }));
vi.mock("../../lib/api", () => ({ api: vi.fn() }));
import { resetPhoneLookSessionForTests, useCleanShellSelection } from "../useCleanShell";

beforeEach(() => { resetPhoneLookSessionForTests(); vi.unstubAllGlobals(); h.mobile = false; h.role = "DIRECTOR"; h.search = ""; h.result = { data: undefined, isPending: true, isError: false }; h.query.mockClear(); });
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
    // Телефон агента спрашивает сервер (о «Новом виде»), но следит за откатом
    // только когда вид выдан: без него он в прежнем интерфейсе (пачка B, 20.11).
    h.mobile = true; h.role = "AGENT";
    useCleanShellSelection(true);
    const agentPhone = h.query.mock.calls.at(-1)?.[0];
    expect(agentPhone).toMatchObject({ enabled: true });
    expect(agentPhone.refetchInterval({ state: { data: { enabled: true } } })).toBe(false);
    expect(agentPhone.refetchInterval({ state: { data: { enabled: true, look: "royal" } } })).toBe(30_000);
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
  it("телефон агента без запомненного вида не ждёт сервер, а выданный вид включается со следующего запуска", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { location: { hostname: "crm.example.com" }, localStorage: {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k),
    } });
    h.mobile = true; h.role = "AGENT";
    // Холодный старт: ответа нет — и ждать его незачем.
    expect(useCleanShellSelection()).toEqual({ clean: false, pending: false });
    // Вид пришёл посреди работы — экран не перестраивается до следующего запуска.
    h.result = { data: { enabled: true, look: "royal" }, isPending: false, isError: false };
    expect(useCleanShellSelection()).toEqual({ clean: false, pending: false });
    // Следующий запуск: устройство помнит выданный вид — ждём ответ, затем новый вид.
    store.set("rh-look-granted:one", "1");
    resetPhoneLookSessionForTests();
    h.result = { data: undefined, isPending: true, isError: false };
    expect(useCleanShellSelection()).toEqual({ clean: false, pending: true });
    h.result = { data: { enabled: true, look: "royal" }, isPending: false, isError: false };
    expect(useCleanShellSelection()).toEqual({ clean: true, look: "royal", pending: false });
    // Сбой очередной проверки и снятый в середине сессии вид экран не меняют.
    h.result.isError = true;
    expect(useCleanShellSelection()).toEqual({ clean: true, look: "royal", pending: false });
    h.result = { data: { enabled: true }, isPending: false, isError: false };
    expect(useCleanShellSelection()).toEqual({ clean: true, look: "royal", pending: false });
    // Личный отказ от вида — прежний интерфейс.
    h.search = "?look=legacy";
    expect(useCleanShellSelection()).toEqual({ clean: false, pending: false });
    // Аварийное выключение действует сразу.
    h.search = ""; h.result = { data: { enabled: false }, isPending: false, isError: false };
    expect(useCleanShellSelection()).toEqual({ clean: false, pending: false });
  });
  it("телефон: вид решается на сессию, ПК: вид следует за сервером", () => {
    h.role = "DIRECTOR"; h.mobile = true;
    h.result = { data: { enabled: true, look: "royal" }, isPending: false, isError: false };
    expect(useCleanShellSelection()).toEqual({ clean: true, look: "royal", pending: false });
    h.result = { data: { enabled: true }, isPending: false, isError: false };
    expect(useCleanShellSelection()).toEqual({ clean: true, look: "royal", pending: false });
    h.result = { data: { enabled: false }, isPending: false, isError: false };
    expect(useCleanShellSelection()).toEqual({ clean: false, pending: false });
    h.mobile = false;
    h.result = { data: { enabled: true, look: "royal" }, isPending: false, isError: false };
    expect(useCleanShellSelection()).toEqual({ clean: true, look: "royal", pending: false });
    h.result = { data: { enabled: true }, isPending: false, isError: false };
    expect(useCleanShellSelection()).toEqual({ clean: true, pending: false });
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
