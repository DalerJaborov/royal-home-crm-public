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
