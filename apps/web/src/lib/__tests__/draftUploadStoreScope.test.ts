import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredDraftFile } from "../draftUploadStore";

const records = new Map<string, StoredDraftFile>();
function request<T>(action: () => T, transaction?: { pending: number; oncomplete?: (() => void) | null }) {
  const result = { result: undefined as T | undefined, onsuccess: null as (() => void) | null, onerror: null };
  if (transaction) transaction.pending++;
  queueMicrotask(() => {
    result.result = action(); result.onsuccess?.();
    if (transaction) {
      transaction.pending--;
      queueMicrotask(() => { if (!transaction.pending) transaction.oncomplete?.(); });
    }
  });
  return result;
}
beforeEach(() => {
  vi.resetModules(); records.clear();
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const transaction = { pending: 0, oncomplete: null as (() => void) | null, objectStore: () => ({
        getAll: () => request(() => [...records.values()], transaction),
        put: (rec: StoredDraftFile) => request(() => { records.set(rec.uploadKey, rec); return rec.uploadKey; }, transaction),
        delete: (key: string) => request(() => { records.delete(key); }, transaction),
        clear: () => request(() => { records.clear(); }, transaction),
        openCursor: () => {
          const keys = [...records.keys()];
          let index = 0;
          const cursorRequest = { result: null as unknown, onsuccess: null as (() => void) | null, onerror: null };
          const next = () => queueMicrotask(() => {
            const key = keys[index++];
            cursorRequest.result = key ? { value: records.get(key),
              delete: () => request(() => { records.delete(key); }), continue: next,
            } : null;
            cursorRequest.onsuccess?.();
            if (!key) queueMicrotask(() => transaction.oncomplete?.());
          });
          next();
          return cursorRequest;
        },
      }) };
      return transaction;
    },
  };
  vi.stubGlobal("indexedDB", { open: () => request(() => db) });
});
afterEach(() => vi.unstubAllGlobals());
const add = (uploadKey: string, agentId: string, draftId?: string | null) => records.set(uploadKey, {
  uploadKey, agentId, draftId, kind: "photo", name: "photo.jpg", size: 24, blob: new Blob(["image"]),
});

describe("draft media storage deletion is scoped", () => {
  it("deletes only one actor's exact draft, preserving another actor and another generation", async () => {
    add("A-old", "A", "draft-old"); add("A-new", "A", "draft-new"); add("B-old", "B", "draft-old"); add("A-unbound", "A", null);
    const store = await import("../draftUploadStore");
    await store.clearAllDraftFiles("A", "draft-old");
    expect([...records.keys()].sort()).toEqual(["A-new", "A-unbound", "B-old"]);
  });
  it("null deletes only that actor's unbound legacy records", async () => {
    add("A-null", "A", null); add("A-legacy", "A"); add("A-owned", "A", "draft-A"); add("B-null", "B", null);
    const store = await import("../draftUploadStore");
    await store.clearAllDraftFiles("A", null);
    expect([...records.keys()].sort()).toEqual(["A-owned", "B-null"]);
  });
});

describe("local draft files expire with the server draft (4 hours)", () => {
  const HOUR = 3_600_000;
  it("drops files older than 4 h, keeps fresher ones, stamps legacy records", async () => {
    const now = Date.now();
    add("old", "A", "d"); records.get("old")!.savedAt = now - 4 * HOUR - 5 * 60_000;
    add("fresh", "A", "d"); records.get("fresh")!.savedAt = now - 3 * HOUR - 55 * 60_000;
    add("legacy", "A", "d");
    add("other", "B", "d"); records.get("other")!.savedAt = now - 9 * HOUR;
    const store = await import("../draftUploadStore");
    const live = await store.readAllDraftFiles("A", now);
    expect(live.map((f) => f.uploadKey).sort()).toEqual(["fresh", "legacy"]);
    expect([...records.keys()].sort()).toEqual(["fresh", "legacy", "other"]);
    expect(records.get("legacy")!.savedAt).toBe(now);
    // second pass is idempotent
    expect((await store.readAllDraftFiles("A", now)).length).toBe(2);
  });
});


describe("срок локальных файлов считается от последнего сохранения черновика", () => {
  const HOUR = 3600_000;
  const addAt = (key: string, agentId: string, draftId: string | null, savedAt: number) =>
    records.set(key, { uploadKey: key, agentId, draftId, kind: "photo", name: "p.jpg", size: 1, blob: new Blob(["i"]), savedAt });

  it("файл пятичасовой давности стирается, а после сохранения черновика живёт", async () => {
    const now = Date.now();
    addAt("old", "A", "d1", now - 5 * HOUR);
    const store = await import("../draftUploadStore");
    await store.touchDraftFiles("A", "d1", now);
    expect((await store.readAllDraftFiles("A", now + HOUR)).map((f) => f.uploadKey)).toEqual(["old"]);
    expect((await store.readAllDraftFiles("A", now + 5 * HOUR)).length).toBe(0);
  });

  it("продлевает только своего агента и свой черновик", async () => {
    const now = Date.now();
    addAt("mine", "A", "d1", now - 5 * HOUR); addAt("other-draft", "A", "d2", now - 5 * HOUR); addAt("other-agent", "B", "d1", now - 5 * HOUR);
    const store = await import("../draftUploadStore");
    await store.touchDraftFiles("A", "d1", now);
    expect(records.get("mine")?.savedAt).toBe(now);
    expect(records.get("other-draft")?.savedAt).toBe(now - 5 * HOUR);
    expect(records.get("other-agent")?.savedAt).toBe(now - 5 * HOUR);
  });
});
