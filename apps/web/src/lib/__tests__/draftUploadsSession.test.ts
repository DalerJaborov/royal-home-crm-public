import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: vi.fn(), records: [] as unknown[], read: vi.fn(),
  put: vi.fn(async (_record: unknown) => {}), remove: vi.fn(async () => {}),
}));
vi.mock("../api", async (original) => ({ ...await original<typeof import("../api")>(), api: mocks.api }));
vi.mock("../compressImage", async (original) => ({ ...await original<typeof import("../compressImage")>(), compressImage: async (file: File) => file }));
vi.mock("../imagePreview", async (original) => ({ ...await original<typeof import("../imagePreview")>(), createLightPreview: async () => null }));
vi.mock("../mediaGps", async (original) => ({ ...await original<typeof import("../mediaGps")>(), readGpsFromFile: async () => null }));
vi.mock("../errorReporter", async (original) => ({ ...await original<typeof import("../errorReporter")>(), reportUploadIssue: vi.fn() }));
vi.mock("../draftUploadStore", async (original) => ({ ...await original<typeof import("../draftUploadStore")>(),
  putDraftFile: mocks.put, readAllDraftFiles: mocks.read, deleteDraftFile: mocks.remove,
  clearAllDraftFiles: async () => {},
}));

class Upload {
  static sent: Upload[] = [];
  headers: Record<string, string> = {};
  upload = {};
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  open() {}
  setRequestHeader(key: string, value: string) { this.headers[key] = value; }
  send() { Upload.sent.push(this); }
  abort() {}
  finish(status: number) { this.status = status; this.responseText = "[]"; this.onload?.(); }
}
const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
const view = (id: string) => ({ id, revision: 1, values: {}, step: 0, media: [], updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() });
const file = () => new File([new Uint8Array(24)], "test-photo.jpg", { type: "image/jpeg" });

beforeEach(() => {
  vi.resetModules(); Upload.sent = []; mocks.records = []; mocks.put.mockClear(); mocks.remove.mockClear();
  mocks.read.mockReset(); mocks.read.mockImplementation(async () => mocks.records);
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal("XMLHttpRequest", Upload);
  mocks.api.mockImplementation(async () => ({ draft: view(first), revision: 1 }));
});
afterEach(async () => {
  const queue = await import("../draftUploads"); queue.clearDraftMedia();
  for (const upload of Upload.sent) upload.finish(201);
  vi.unstubAllGlobals();
});
async function session() {
  const { useAuthStore } = await import("../../store/auth");
  useAuthStore.setState({ agent: { id: "test-agent", fullName: "Тестовый агент", role: "AGENT", phone: "" }, accessToken: "test-local-token", hasSession: true });
  const sessions = await import("../propertyDraftSession");
  sessions.adoptPropertyDraftSession({ draft: view(first), revision: 1 });
  return { sessions, queue: await import("../draftUploads") };
}

describe("media belongs to a draft session", () => {
  it("sends and persists the exact draft identity with a photo", async () => {
    const { queue } = await session(); queue.addDraftPhotos([file()]);
    await vi.waitFor(() => expect(Upload.sent).toHaveLength(1));
    expect(Upload.sent[0].headers["X-Property-Draft-Id"]).toBe(first);
    await vi.waitFor(() => expect(mocks.put).toHaveBeenCalledWith(expect.objectContaining({ draftId: first })));
    Upload.sent[0].finish(201);
  });
  it("does not restore a file from a deleted draft into another draft", async () => {
    const { queue, sessions } = await session();
    sessions.adoptPropertyDraftSession({ draft: view(second), revision: 4 });
    mocks.records = [{ uploadKey: "test-upload-old", kind: "photo", name: "old.jpg", size: 24, agentId: "test-agent", draftId: first, blob: file() }];
    await queue.hydrateDraftMedia([]);
    await vi.waitFor(() => expect(queue.getDraftMediaSnapshot()[0]?.status).toBe("failed"));
    expect(Upload.sent).toHaveLength(0);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("does not restore A's delayed IndexedDB read after B has signed in", async () => {
    const { queue } = await session();
    let resolve!: (records: unknown[]) => void;
    mocks.read.mockReturnValueOnce(new Promise((yes) => { resolve = yes; }));
    const hydration = queue.hydrateDraftMedia([]);
    const { useAuthStore } = await import("../../store/auth");
    useAuthStore.setState({ agent: { id: "other-agent", fullName: "Другой агент", role: "AGENT", phone: "" }, accessToken: "other-local-token", hasSession: true, sessionEpoch: useAuthStore.getState().sessionEpoch + 1 });
    resolve([{ uploadKey: "private-A", kind: "photo", name: "private-A.jpg", size: 24, agentId: "test-agent", draftId: first, blob: file() }]);
    await hydration;
    expect(queue.getDraftMediaSnapshot()).toEqual([]);
    expect(Upload.sent).toHaveLength(0);
  });
  it("does not restore delayed files after the draft generation has closed", async () => {
    const { queue, sessions } = await session();
    let resolve!: (records: unknown[]) => void;
    mocks.read.mockReturnValueOnce(new Promise((yes) => { resolve = yes; }));
    const hydration = queue.hydrateDraftMedia([]);
    sessions.invalidatePropertyDraftSession({ draft: null, revision: 2 });
    sessions.adoptPropertyDraftSession({ draft: view(second), revision: 3 });
    resolve([{ uploadKey: "old-generation", kind: "photo", name: "old.jpg", size: 24, agentId: "test-agent", draftId: first, blob: file() }]);
    await hydration;
    expect(queue.getDraftMediaSnapshot()).toEqual([]);
    expect(Upload.sent).toHaveLength(0);
  });
  it("does not automatically attach a legacy file with unknown draft identity to an active draft", async () => {
    const { queue } = await session();
    mocks.records = [{ uploadKey: "legacy-unowned", kind: "photo", name: "legacy.jpg", size: 24, agentId: "test-agent", draftId: null, blob: file() }];
    await queue.hydrateDraftMedia([]);
    expect(queue.getDraftMediaSnapshot()[0]?.status).toBe("failed");
    expect(Upload.sent).toHaveLength(0);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("recognizes a legacy record when the current server draft owns its upload key", async () => {
    const { queue } = await session();
    mocks.records = [{ uploadKey: "known-legacy", kind: "photo", name: "legacy.jpg", size: 24, agentId: "test-agent", blob: file() }];
    await queue.hydrateDraftMedia([{ id: "media-legacy", uploadKey: "known-legacy", kind: "PHOTO", status: "READY", filename: "legacy.jpg", contentType: "image/jpeg", sizeBytes: 24, order: 0, url: null, thumbUrl: null }]);
    expect(queue.getDraftMediaSnapshot()[0]?.status).toBe("ready");
    expect(Upload.sent).toHaveLength(0);
  });
  it("a stale server media snapshot cannot revive a tile explicitly removed by the user", async () => {
    const { queue } = await session();
    const serverMedia = [{ id: "media-removed", uploadKey: "removed-key", kind: "PHOTO" as const, status: "READY" as const, filename: "removed.jpg", contentType: "image/jpeg", sizeBytes: 24, order: 0, url: null, thumbUrl: null }];
    await queue.hydrateDraftMedia(serverMedia);
    await queue.removeDraftMedia("removed-key");
    expect(queue.getDraftMediaSnapshot()).toEqual([]);
    await queue.hydrateDraftMedia(serverMedia);
    expect(queue.getDraftMediaSnapshot()).toEqual([]);
  });
});
