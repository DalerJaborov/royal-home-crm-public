import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredDraftFile } from "../draftUploadStore";
import { createFakeIndexedDb, type FakeIdb } from "./fakeIndexedDb";

const DB = "royal-home-draft-media";
/** Записи прежней версии (файл внутри записи) — до первого открытия базы; после — то, что в базе. */
const seedRows = new Map<string, StoredDraftFile>();
let fake: FakeIdb;
let opened = false;
const records = {
  set: (key: string, rec: StoredDraftFile) => seedRows.set(key, rec),
  get: (key: string) => (opened ? (fake.dump(DB, "files").get(key) as StoredDraftFile | undefined) : seedRows.get(key)),
  keys: () => (opened ? (fake.dump(DB, "files").keys() as IterableIterator<string>) : seedRows.keys()),
};
beforeEach(() => {
  vi.resetModules(); seedRows.clear(); opened = false;
  fake = createFakeIndexedDb();
  vi.stubGlobal("indexedDB", {
    open: (name: string, version?: number) => {
      // Первое открытие: база версии 1 с записями прежней сборки — проверяем и перенос.
      if (!opened) fake.seed(DB, 1, { files: { keyPath: "uploadKey", rows: [...seedRows.entries()] } });
      opened = true;
      return fake.indexedDB.open(name, version);
    },
  });
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

/**
 * Находка 2 (25.11.2026): каждое продление срока перекладывало запись ВМЕСТЕ с файлом, а
 * Chromium на каждую запись блоба копирует его заново (ролик 271 МБ — на каждую отметку).
 * Версия 2: файл кладётся один раз, отметки правят только метаданные; запись версии 1
 * переезжает при первой правке, без потери.
 */
describe("склад мастера v2: файл кладётся один раз, отметки — без перекладки файла", () => {
  it("новый файл: три продления срока — файл записан один раз", async () => {
    const store = await import("../draftUploadStore");
    await store.putDraftFile({ uploadKey: "v1", agentId: "A", draftId: "d", kind: "video", name: "v.mov", size: 5, blob: new Blob(["video"]) });
    for (let i = 0; i < 3; i++) await store.touchDraftFiles("A", "d", Date.now() + i);
    await store.updateDraftFileMeta("v1", { draftId: "d" });
    expect(fake.putCount.get("blobs")).toBe(1);
    expect((records.get("v1") as unknown as { blob?: Blob }).blob).toBeUndefined();
    const live = await store.readAllDraftFiles("A");
    expect(live).toHaveLength(1);
    expect(await live[0].blob.text()).toBe("video");
  });

  it("запись версии 1 (файл внутри) переезжает при первой правке и читается дальше", async () => {
    add("legacy-v1", "A", "d");
    const store = await import("../draftUploadStore");
    await store.touchDraftFiles("A", "d", Date.now());
    expect((records.get("legacy-v1") as unknown as { blob?: Blob }).blob).toBeUndefined();
    expect(fake.dump(DB, "blobs").has("legacy-v1")).toBe(true);
    await store.touchDraftFiles("A", "d", Date.now() + 1);
    expect(fake.putCount.get("blobs")).toBe(1); // второй раз файл не перекладывается
    const live = await store.readAllDraftFiles("A");
    expect(await live[0].blob.text()).toBe("image");
  });

  it("удаление убирает и метаданные, и файл", async () => {
    const store = await import("../draftUploadStore");
    await store.putDraftFile({ uploadKey: "x", agentId: "A", draftId: "d", kind: "photo", name: "p.jpg", size: 1, blob: new Blob(["p"]) });
    await store.deleteDraftFile("x");
    expect(fake.dump(DB, "files").has("x")).toBe(false);
    expect(fake.dump(DB, "blobs").has("x")).toBe(false);
  });
});
