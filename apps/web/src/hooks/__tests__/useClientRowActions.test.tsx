import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useClientRowActions } from "../useClientRowActions";
import type { Client } from "../../types";

const mocks = vi.hoisted(() => ({
  agent: { id: "agent-1", role: "AGENT" }, canRestore: false, navigate: vi.fn(),
  restore: vi.fn(), request: vi.fn(), accept: vi.fn(), decline: vi.fn(),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../store/auth", () => ({ useAuthStore: (select: (s: { agent: typeof mocks.agent }) => unknown) => select({ agent: mocks.agent }) }));
vi.mock("../../lib/permissions", () => ({ useCan: () => () => mocks.canRestore }));
vi.mock("../useClients", () => ({
  useRestoreClient: () => ({ mutate: mocks.restore }), useRequestRestoreClient: () => ({ mutate: mocks.request }),
  useAcceptLead: () => ({ mutate: mocks.accept }), useDeclineLead: () => ({ mutate: mocks.decline }),
  isRequiresRelease: (error: unknown) => error === "requires-release",
}));
function fixture(patch: Partial<Client> = {}): Client {
  return { id: "client-1", shortId: 42, kind: "BUYER", assignedAgentId: "agent-1", pendingAcceptance: true, phone: "•••", ...patch } as Client;
}
function read(client = fixture()) {
  let actions!: ReturnType<typeof useClientRowActions>;
  function Probe() {
    actions = useClientRowActions(client);
    return <span>{String(actions.canAcceptRow)}:{String(actions.canCall)}</span>;
  }
  renderToStaticMarkup(<Probe />);
  return actions;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.agent = { id: "agent-1", role: "AGENT" };
  mocks.canRestore = false;
});
describe("shared client row workflow", () => {
  it.each([
    [{}, "AGENT", true, false],
    [{ assignedAgentId: "other-agent" }, "AGENT", false, false],
    [{ escalatedAt: "2026-10-10" }, "AGENT", false, false],
    [{}, "DIRECTOR", false, false],
    [{ kind: "OTHER" }, "AGENT", false, true],
    [{ pendingAcceptance: false }, "AGENT", false, true],
    [{ pendingAcceptance: false, deletedAt: "2026-10-10" }, "AGENT", false, false],
    [{ pendingAcceptance: false, phone: "" }, "AGENT", false, false],
  ])("preserves eligibility %j for %s", (patch, role, accept, call) => {
    mocks.agent.role = role;
    const actions = read(fixture(patch as Partial<Client>));
    expect(actions.canAcceptRow).toBe(accept);
    expect(actions.canCall).toBe(call);
  });
  it("navigates to the selected lead only for the portfolio-release error", () => {
    read().acceptClient();
    const [input, options] = mocks.accept.mock.calls[0];
    expect(input).toBeUndefined();
    options.onError("network-error");
    expect(mocks.navigate).not.toHaveBeenCalled();
    options.onError("requires-release");
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("/clients/42");
  });
  it("restores or requests restoration for this client and preserves the permission", () => {
    expect(read().canRestore).toBe(false);
    mocks.canRestore = true;
    const actions = read();
    expect(actions.canRestore).toBe(true);
    expect(actions.restoreRequested).toBe(false);
    actions.restore();
    actions.requestRestoration();
    expect(mocks.restore).toHaveBeenCalledExactlyOnceWith("client-1");
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith("client-1", { onSuccess: expect.any(Function) });
    expect(mocks.decline).not.toHaveBeenCalled();
  });
  it("starts with no rejection dialog and declines only through confirmation", () => {
    const actions = read();
    expect(actions.confirmDecline).toBe(false);
    expect(mocks.decline).not.toHaveBeenCalled();
    actions.confirmRejection();
    expect(mocks.decline).toHaveBeenCalledExactlyOnceWith();
  });
});
