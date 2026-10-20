import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  state: { hasSession: false, accessToken: null as string | null, agent: null as { id: string } | null, sessionEpoch: 0 },
  listeners: new Set<() => void>(),
}));
const mocks = vi.hoisted(() => ({
  api: vi.fn(), files: vi.fn(), reminder: vi.fn(), hydrate: vi.fn(), importStarted: vi.fn(),
  importGate: undefined as Promise<void> | undefined,
}));
vi.mock("../../store/auth", () => ({ useAuthStore: {
  getState: () => auth.state,
  subscribe: (listener: () => void) => { auth.listeners.add(listener); return () => auth.listeners.delete(listener); },
} }));
vi.mock("../api", () => ({ api: mocks.api }));
vi.mock("../draftUploadStore", () => ({ readAllDraftFiles: mocks.files }));
vi.mock("../draftReminder", () => ({ setDraftReminder: mocks.reminder }));

function update(patch: Partial<typeof auth.state>) {
  Object.assign(auth.state, patch);
  for (const listener of auth.listeners) listener();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const worthDraft = { draft: { media: [], values: { address: "Draft" } } };

beforeEach(() => {
  vi.resetModules();
  auth.listeners.clear();
  Object.assign(auth.state, { hasSession: false, accessToken: null, agent: null, sessionEpoch: 0 });
  Object.values(mocks).forEach((value) => { if (typeof value === "function" && "mockReset" in value) value.mockReset(); });
  mocks.api.mockResolvedValue({ draft: null });
  mocks.files.mockResolvedValue([]);
  mocks.hydrate.mockResolvedValue(undefined);
  mocks.importGate = undefined;
  vi.doMock("../draftUploads", async () => {
    mocks.importStarted();
    await mocks.importGate;
    return { hydrateDraftMedia: mocks.hydrate };
  });
});

describe("draft startup waits for authentication and keeps ownership", () => {
  it("sends no request until a persisted session has restored its access token", async () => {
    Object.assign(auth.state, { hasSession: true, agent: { id: "A" } });
    const { resumeDraftUploadsOnStart } = await import("../draftUploadsResume");
    resumeDraftUploadsOnStart();
    expect(mocks.api).not.toHaveBeenCalled();
    expect(mocks.files).not.toHaveBeenCalled();
    update({ accessToken: "test-token" });
    await vi.waitFor(() => expect(mocks.files).toHaveBeenCalledWith("A"));
    expect(mocks.api).toHaveBeenCalledExactlyOnceWith("/properties/drafts/current", { expectAgentId: "A" });
  });

  it("checks a fresh login once and does not restart after ordinary token renewal", async () => {
    const { resumeDraftUploadsOnStart } = await import("../draftUploadsResume");
    resumeDraftUploadsOnStart();
    update({ hasSession: true, agent: { id: "A" }, accessToken: "test-token", sessionEpoch: 1 });
    await vi.waitFor(() => expect(mocks.files).toHaveBeenCalledOnce());
    update({ accessToken: "renewed-test-token" });
    expect(mocks.api).toHaveBeenCalledOnce();
  });

  it("ignores an old server draft arriving after logout and a different login", async () => {
    const old = deferred<unknown>();
    mocks.api.mockImplementation((_path, options) => options.expectAgentId === "A" ? old.promise : Promise.resolve({ draft: null }));
    Object.assign(auth.state, { hasSession: true, agent: { id: "A" }, accessToken: "test-token", sessionEpoch: 1 });
    const { resumeDraftUploadsOnStart } = await import("../draftUploadsResume");
    resumeDraftUploadsOnStart();
    update({ hasSession: false, agent: null, accessToken: null, sessionEpoch: 2 });
    update({ hasSession: true, agent: { id: "B" }, accessToken: "test-token-B", sessionEpoch: 3 });
    await vi.waitFor(() => expect(mocks.files).toHaveBeenCalledWith("B"));
    old.resolve(worthDraft);
    await old.promise;
    expect(mocks.reminder).not.toHaveBeenCalledWith(true);
    expect(mocks.files).not.toHaveBeenCalledWith("A");
    expect(mocks.hydrate).not.toHaveBeenCalled();
  });

  it("rejects the previous epoch even when the same employee logs in again", async () => {
    const old = deferred<unknown>();
    mocks.api.mockReturnValueOnce(old.promise).mockResolvedValue({ draft: null });
    Object.assign(auth.state, { hasSession: true, agent: { id: "A" }, accessToken: "test-token", sessionEpoch: 1 });
    const { resumeDraftUploadsOnStart } = await import("../draftUploadsResume");
    resumeDraftUploadsOnStart();
    update({ accessToken: "new-test-token", sessionEpoch: 2 });
    await vi.waitFor(() => expect(mocks.files).toHaveBeenCalledOnce());
    old.resolve(worthDraft); await old.promise;
    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(mocks.reminder).not.toHaveBeenCalledWith(true);
    expect(mocks.files).toHaveBeenCalledOnce();
  });

  it("does not raise a reminder or hydrate after logout during IndexedDB reading", async () => {
    const local = deferred<unknown[]>();
    mocks.files.mockReturnValue(local.promise);
    Object.assign(auth.state, { hasSession: true, agent: { id: "A" }, accessToken: "test-token", sessionEpoch: 1 });
    const { resumeDraftUploadsOnStart } = await import("../draftUploadsResume");
    resumeDraftUploadsOnStart();
    await vi.waitFor(() => expect(mocks.files).toHaveBeenCalledOnce());
    update({ hasSession: false, agent: null, accessToken: null, sessionEpoch: 2 });
    local.resolve([{ uploadKey: "local-file" }]); await local.promise;
    expect(mocks.reminder).not.toHaveBeenCalledWith(true);
    expect(mocks.hydrate).not.toHaveBeenCalled();
  });

  it("continues restoring local files when the server is offline under the same session", async () => {
    mocks.api.mockRejectedValue(new Error("offline"));
    mocks.files.mockResolvedValue([{ uploadKey: "local-file" }]);
    Object.assign(auth.state, { hasSession: true, agent: { id: "A" }, accessToken: "test-token", sessionEpoch: 1 });
    const { resumeDraftUploadsOnStart } = await import("../draftUploadsResume");
    resumeDraftUploadsOnStart();
    await vi.waitFor(() => expect(mocks.hydrate).toHaveBeenCalledExactlyOnceWith([], undefined));
    expect(mocks.reminder).toHaveBeenCalledWith(true);
    expect(mocks.files).toHaveBeenCalledWith("A");
  });

  it("checks ownership again after the lazy media module finishes loading", async () => {
    const lazy = deferred<void>();
    mocks.importGate = lazy.promise;
    mocks.files.mockResolvedValue([{ uploadKey: "local-file" }]);
    Object.assign(auth.state, { hasSession: true, agent: { id: "A" }, accessToken: "test-token", sessionEpoch: 1 });
    const { resumeDraftUploadsOnStart } = await import("../draftUploadsResume");
    resumeDraftUploadsOnStart();
    await vi.waitFor(() => expect(mocks.importStarted).toHaveBeenCalledOnce());
    update({ hasSession: false, agent: null, accessToken: null, sessionEpoch: 2 });
    lazy.resolve(); await lazy.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.hydrate).not.toHaveBeenCalled();
    expect(mocks.reminder).toHaveBeenLastCalledWith(false);
  });
});
