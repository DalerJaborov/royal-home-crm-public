import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn(), auth: { hasSession: true, agent: { id: "agent-a" }, sessionEpoch: 1 } }));
vi.mock("../api", () => ({ api: (...args: unknown[]) => mocks.api(...args) }));
vi.mock("../../store/auth", () => ({ useAuthStore: { getState: () => mocks.auth } }));
const view = { id: "draft-1", revision: 7, step: 0, updatedAt: "2026-10-20T12:00:00Z", expiresAt: "2026-10-27T12:00:00Z", values: {}, media: [] };
beforeEach(() => { vi.resetModules(); mocks.api.mockReset(); mocks.auth = { hasSession: true, agent: { id: "agent-a" }, sessionEpoch: 1 }; });

describe("property draft session CAS and ownership", () => {
  it("loads an existing identity without starting or replacing it", async () => {
    mocks.api.mockResolvedValue({ draft: view, revision: 7 });
    const session = await import("../propertyDraftSession");
    expect(await session.ensurePropertyDraftSession()).toEqual(view);
    expect(await session.ensurePropertyDraftSession()).toEqual(view);
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.api).toHaveBeenCalledWith("/properties/drafts/current", { expectAgentId: "agent-a" });
  });
  it("deduplicates concurrent start and sends the tombstone revision", async () => {
    mocks.api.mockResolvedValueOnce({ draft: null, revision: 12 }).mockResolvedValueOnce({ draft: { ...view, revision: 13 }, revision: 13 });
    const session = await import("../propertyDraftSession");
    const [a, b] = await Promise.all([session.ensurePropertyDraftSession(), session.ensurePropertyDraftSession()]);
    expect(a).toEqual(b); expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(mocks.api.mock.calls[1]).toEqual(["/properties/drafts/current/start", { method: "POST", body: { sessionId: expect.any(String), revision: 12 }, expectAgentId: "agent-a" }]);
  });
  it("a late GET cannot replace a newer PUT acknowledgement", async () => {
    let resolve!: (value: unknown) => void;
    mocks.api.mockReturnValue(new Promise((yes) => { resolve = yes; }));
    const session = await import("../propertyDraftSession");
    const loading = session.loadPropertyDraftSession();
    session.adoptPropertyDraftSession({ draft: { ...view, revision: 8 }, revision: 8 });
    resolve({ draft: view, revision: 7 });
    expect((await loading).revision).toBe(8);
    expect(session.getPropertyDraftSession()?.draft?.revision).toBe(8);
  });
  it("rejects a late reply after reset and never adopts it for another session", async () => {
    let resolve!: (value: unknown) => void;
    mocks.api.mockReturnValue(new Promise((yes) => { resolve = yes; }));
    const session = await import("../propertyDraftSession");
    const loading = session.loadPropertyDraftSession();
    session.invalidatePropertyDraftSession();
    resolve({ draft: view, revision: 7 });
    await expect(loading).rejects.toThrow("Сессия черновика изменилась");
    expect(session.getPropertyDraftSession()).toBeNull();
    session.adoptPropertyDraftSession({ draft: view, revision: 7 });
    mocks.auth = { hasSession: true, agent: { id: "agent-b" }, sessionEpoch: 2 };
    expect(session.getPropertyDraftSession()).toBeNull();
  });
});
