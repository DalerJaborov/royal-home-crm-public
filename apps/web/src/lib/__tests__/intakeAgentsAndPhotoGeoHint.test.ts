import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptTestDraftSession } from "./draftSessionFixture";
import { intakeAgentCandidates, type IntakeAgentLike } from "../intakeAgents";
import { photoGeoHint } from "../photoGeoHint";

/**
 * Две жалобы владельца с одного кадра iPhone (27.11.2026):
 * 1) в «Кто принял объект» мастера стояли директор и учредитель;
 * 2) фото добавили, «геолокация не была определена» — и мастер молчал.
 */
const gps = vi.hoisted(() => ({ next: null as { lat: number; lng: number } | null }));
const lsStore = vi.hoisted(() => {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
  return m;
});
vi.mock("../queryClient", () => ({ queryClient: { clear: vi.fn(), invalidateQueries: vi.fn() } }));
vi.mock("../queryPersist", () => ({ clearPersistedQueryCache: vi.fn(async () => {}) }));
vi.mock("../pendingMapPin", () => ({ clearPendingMapPin: vi.fn() }));
vi.mock("../deviceId", () => ({ getOrCreateDeviceId: () => "test-device" }));
vi.mock("../errorReporter", () => ({ reportUploadIssue: vi.fn() }));
vi.mock("../api", () => ({ api: vi.fn(async () => ({})), refreshAccessToken: vi.fn() }));
vi.mock("../compressImage", () => ({ compressImage: async (f: File) => f }));
vi.mock("../imagePreview", () => ({ createLightPreview: async () => null }));
vi.mock("../mediaGps", () => ({ readGpsFromFile: async () => gps.next }));
vi.mock("../draftUploadStore", () => ({
  clearAllDraftFiles: vi.fn(async () => {}),
  deleteDraftFile: vi.fn(async () => {}),
  putDraftFile: vi.fn(async () => {}),
  readAllDraftFiles: vi.fn(async () => []),
}));

class HangingXHR {
  upload: Record<string, unknown> = {};
  open() {}
  setRequestHeader() {}
  send() {}
  abort() {}
}

const agent = (over: Partial<IntakeAgentLike> & { id: string }) => ({
  role: "AGENT",
  isActive: true,
  frozenAt: null,
  fullName: over.id,
  ...over,
});

describe("кто может быть «Кто принял объект»", () => {
  it("только действующие агенты: директор, учредитель, РОП, уволенные и замороженные не попадают", () => {
    const list = [
      agent({ id: "director", role: "DIRECTOR" }),
      agent({ id: "shareholder", role: "SHAREHOLDER" }),
      agent({ id: "marketing", role: "MARKETING" }),
      agent({ id: "fired", isActive: false }),
      agent({ id: "vacation", frozenAt: "2026-11-20T00:00:00Z" }),
      agent({ id: "ok-1" }),
      agent({ id: "ok-2" }),
    ];
    expect(intakeAgentCandidates(list).map((a) => a.id)).toEqual(["ok-1", "ok-2"]);
  });

  it("список ещё не загружен — пусто, а не падение", () => {
    expect(intakeAgentCandidates(undefined)).toEqual([]);
  });
});

describe("подсказка «почему точки по фото нет»", () => {
  it("молчит, пока ничего не разобрано, идёт разбор или точка найдена", () => {
    expect(photoGeoHint({ pending: 0, checked: 0, found: 0, outside: 0 })).toBeNull();
    expect(photoGeoHint({ pending: 1, checked: 1, found: 0, outside: 0 })).toBeNull();
    expect(photoGeoHint({ pending: 0, checked: 2, found: 1, outside: 0 })).toBeNull();
  });

  it("фото без геометки — говорит про телефон и что делать", () => {
    const text = photoGeoHint({ pending: 0, checked: 1, found: 0, outside: 0 });
    expect(text).toMatch(/нет геометки/);
    expect(text).toMatch(/Определить мою позицию/);
  });

  it("геометка вне Душанбе — говорит именно это, а не «нет геометки»", () => {
    const text = photoGeoHint({ pending: 0, checked: 1, found: 0, outside: 1 });
    expect(text).toMatch(/не в Душанбе/);
    expect(text).not.toMatch(/нет геометки/);
  });
});

describe("счётчик разбора снимков в очереди мастера", () => {
  beforeEach(() => {
    vi.resetModules();
    lsStore.clear();
    gps.next = null;
    vi.stubGlobal("XMLHttpRequest", HangingXHR);
    vi.stubGlobal("navigator", { onLine: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  const photo = (name: string) => new File([new Uint8Array(500)], name, { type: "image/jpeg" });
  const settle = () => new Promise((r) => setTimeout(r, 30));

  async function setup() {
    const { useAuthStore } = await import("../../store/auth");
    const q = await import("../draftUploads");
    useAuthStore.getState().setSession({ id: "A", fullName: "А", phone: "+992900000001", role: "AGENT" as const }, "tokenA");
    await adoptTestDraftSession();
    return q;
  }

  it("фото без геометки: разобрано 1, найдено 0 — подсказка появляется", async () => {
    const q = await setup();
    q.addDraftPhotos([photo("a.jpg")]);
    await settle();
    const status = q.getDraftPhotoGeoStatusSnapshot();
    expect(status).toEqual({ pending: 0, checked: 1, found: 0, outside: 0 });
    expect(photoGeoHint(status)).not.toBeNull();
    expect(q.getDraftPhotoLocationSnapshot()).toBeNull();
  });

  it("геометка вне Душанбе считается отдельно и точку не ставит", async () => {
    const q = await setup();
    gps.next = { lat: 40.28, lng: 69.62 }; // Худжанд
    q.addDraftPhotos([photo("a.jpg")]);
    await settle();
    expect(q.getDraftPhotoGeoStatusSnapshot()).toEqual({ pending: 0, checked: 1, found: 0, outside: 1 });
    expect(q.getDraftPhotoLocationSnapshot()).toBeNull();
  });

  it("геометка в Душанбе: точка есть, подсказки нет", async () => {
    const q = await setup();
    gps.next = { lat: 38.56, lng: 68.79 };
    q.addDraftPhotos([photo("a.jpg")]);
    await settle();
    const status = q.getDraftPhotoGeoStatusSnapshot();
    expect(status).toEqual({ pending: 0, checked: 1, found: 1, outside: 0 });
    expect(photoGeoHint(status)).toBeNull();
    expect(q.getDraftPhotoLocationSnapshot()).not.toBeNull();
  });

  it("сброс мастера обнуляет счётчик", async () => {
    const q = await setup();
    q.addDraftPhotos([photo("a.jpg")]);
    await settle();
    q.clearDraftMedia();
    expect(q.getDraftPhotoGeoStatusSnapshot()).toEqual({ pending: 0, checked: 0, found: 0, outside: 0 });
  });
});
