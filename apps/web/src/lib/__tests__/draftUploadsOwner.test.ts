import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptTestDraftSession } from "./draftSessionFixture";

/**
 * Файлы мастера одного сотрудника не уходят в черновик другого (аудит Codex
 * 04.10.2026, WEB-03). Живая очередь мастера (draftUploads.ts) — модульная Map,
 * переживающая выход: после А/Б в той же вкладке её файлы уходили токеном Б в
 * drafts/current Б, а мастер Б получал «продолжить» с чужими плитками.
 *
 * Стор сессии настоящий (на нём и держится защита), XHR управляется вручную:
 * первая отправка висит, пока вкладка меняет сотрудника.
 */
const lsStore = vi.hoisted(() => {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
  return m;
});
const store = vi.hoisted(() => ({
  clearAllDraftFiles: vi.fn(async () => {}),
  deleteDraftFile: vi.fn(async () => {}),
  putDraftFile: vi.fn(async () => {}),
  readAllDraftFiles: vi.fn(async () => []),
}));
vi.mock("../queryClient", () => ({ queryClient: { clear: vi.fn(), invalidateQueries: vi.fn() } }));
vi.mock("../queryPersist", () => ({ clearPersistedQueryCache: vi.fn(async () => {}) }));
vi.mock("../pendingMapPin", () => ({ clearPendingMapPin: vi.fn() }));
vi.mock("../deviceId", () => ({ getOrCreateDeviceId: () => "test-device" }));
vi.mock("../errorReporter", () => ({ reportUploadIssue: vi.fn() }));
vi.mock("../api", () => ({ api: vi.fn(async () => ({})), refreshAccessToken: vi.fn() }));
vi.mock("../compressImage", () => ({ compressImage: async (f: File) => f }));
vi.mock("../imagePreview", () => ({ createLightPreview: async () => null }));
vi.mock("../mediaGps", () => ({ readGpsFromFile: async () => null }));
vi.mock("../draftUploadStore", () => store);

class FakeXHR {
  static sent: FakeXHR[] = [];
  headers: Record<string, string> = {};
  body: unknown;
  status = 0;
  responseText = "";
  upload: Record<string, unknown> = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  open() {}
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: unknown) {
    this.body = body;
    FakeXHR.sent.push(this);
  }
  abort() {}
  finish(status: number, text: string) {
    this.status = status;
    this.responseText = text;
    this.onload?.();
  }
  get sentFile(): string {
    return ((this.body as FormData).get("photos") as File).name;
  }
}

const A = { id: "A", fullName: "А", phone: "+992900000001", role: "AGENT" as const };
const B = { id: "B", fullName: "Б", phone: "+992900000002", role: "AGENT" as const };
const photo = (name: string) => new File([new Uint8Array(500)], name, { type: "image/jpeg" });
const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  vi.resetModules();
  lsStore.clear();
  FakeXHR.sent = [];
  Object.values(store).forEach((f) => f.mockClear());
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("очередь мастера и смена сотрудника", () => {
  it("файлы А не уходят токеном Б, плитки Б чистые, дисковые копии А целы", async () => {
    const { useAuthStore } = await import("../../store/auth");
    const q = await import("../draftUploads");
    useAuthStore.getState().setSession(A, "tokenA");
    await adoptTestDraftSession();

    q.addDraftPhotos([photo("a1.jpg"), photo("a2.jpg")]);
    await settle();
    expect(FakeXHR.sent).toHaveLength(1); // a1 в полёте, a2 ждёт очереди

    useAuthStore.getState().logout();
    useAuthStore.getState().setSession(B, "tokenB");
    await adoptTestDraftSession("00000000-0000-4000-8000-000000000002");
    expect(q.getDraftMediaSnapshot()).toEqual([]);
    expect(q.hasLiveDraftMedia()).toBe(false);

    FakeXHR.sent[0].finish(201, "[]"); // отправка А доехала уже в сессии Б
    await settle();
    expect(FakeXHR.sent).toHaveLength(1); // a2 под токеном Б не ушёл
    expect(store.clearAllDraftFiles).not.toHaveBeenCalled();
    expect(store.deleteDraftFile).not.toHaveBeenCalled();

    q.addDraftPhotos([photo("b1.jpg")]);
    await settle();
    expect(FakeXHR.sent).toHaveLength(2);
    expect(FakeXHR.sent[1].sentFile).toBe("b1.jpg");
    expect(FakeXHR.sent[1].headers.Authorization).toBe("Bearer tokenB");
  });

  it("тот же сотрудник вошёл снова (без выхода): его очередь не теряется", async () => {
    const { useAuthStore } = await import("../../store/auth");
    const q = await import("../draftUploads");
    useAuthStore.getState().setSession(A, "tokenA");
    await adoptTestDraftSession();
    q.addDraftPhotos([photo("a1.jpg"), photo("a2.jpg")]);
    await settle();
    useAuthStore.getState().setSession(A, "tokenA2");
    expect(q.getDraftMediaSnapshot().map((i) => i.name)).toContain("a2.jpg");
  });
});
