import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Убранное в мастере фото не попадает в объект (аудит Codex 04.10.2026, WEB-04).
 * Плитку удалили, пока фото ещё летело (mediaId был null): XHR дошёл, сервер хранит
 * READY-файл, при создании объекта он переносится. И проглоченный отказ DELETE
 * оставлял готовое фото на сервере. Теперь: поздний ответ получает DELETE по
 * пришедшему id, отказ повторяется, сброс мастера (clearDraftMedia) ничего не
 * удаляет (после создания объекта файлы уже его фото).
 */
const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ api: apiMock, refreshAccessToken: vi.fn() }));
vi.mock("../../store/auth", () => ({
  useAuthStore: {
    getState: () => ({ hasSession: true, accessToken: "tok", agent: { id: "A" }, sessionEpoch: 1 }),
    subscribe: () => () => {},
  },
}));
vi.mock("../deviceId", () => ({ getOrCreateDeviceId: () => "test-device" }));
vi.mock("../errorReporter", () => ({ reportUploadIssue: vi.fn() }));
vi.mock("../compressImage", () => ({ compressImage: async (f: File) => f }));
vi.mock("../imagePreview", () => ({ createLightPreview: async () => null }));
vi.mock("../mediaGps", () => ({ readGpsFromFile: async () => null }));
vi.mock("../draftUploadStore", () => ({
  clearAllDraftFiles: async () => {},
  deleteDraftFile: async () => {},
  putDraftFile: async () => {},
  readAllDraftFiles: async () => [],
}));

class FakeXHR {
  static sent: FakeXHR[] = [];
  status = 0;
  responseText = "";
  upload: Record<string, unknown> = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  open() {}
  setRequestHeader() {}
  send() {
    FakeXHR.sent.push(this);
  }
  abort() {}
  finish(status: number, text: string) {
    this.status = status;
    this.responseText = text;
    this.onload?.();
  }
}

const photo = new File([new Uint8Array(500)], "a.jpg", { type: "image/jpeg" });
const deletes = () => apiMock.mock.calls.filter((c) => (c[1] as { method?: string })?.method === "DELETE").map((c) => c[0]);

beforeEach(() => {
  vi.resetModules();
  apiMock.mockReset();
  apiMock.mockResolvedValue({});
  FakeXHR.sent = [];
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function startPhoto() {
  const q = await import("../draftUploads");
  q.addDraftPhotos([photo]);
  await vi.waitFor(() => expect(FakeXHR.sent).toHaveLength(1));
  const key = q.getDraftMediaSnapshot()[0].uploadKey;
  return { q, key };
}

describe("убранное фото не остаётся на сервере", () => {
  it("плитку убрали до ответа: пришедший id удаляется на сервере", async () => {
    const { q, key } = await startPhoto();
    await q.removeDraftMedia(key); // mediaId ещё null, DELETE нечем
    expect(deletes()).toEqual([]);
    FakeXHR.sent[0].finish(201, JSON.stringify([{ id: "m1", uploadKey: key, thumbUrl: null }]));
    await vi.waitFor(() => expect(deletes()).toEqual(["/properties/drafts/current/media/m1"]));
  });

  it("отказ DELETE повторяется, а не теряется", async () => {
    vi.useFakeTimers();
    const { ApiError } = await import("../apiError");
    apiMock.mockReset();
    apiMock.mockRejectedValueOnce(new ApiError("сбой", 500, undefined)).mockResolvedValue({});
    const q = await import("../draftUploads");
    q.addDraftPhotos([photo]);
    await vi.advanceTimersByTimeAsync(10);
    const key = q.getDraftMediaSnapshot()[0].uploadKey;
    FakeXHR.sent[0].finish(201, JSON.stringify([{ id: "m2", uploadKey: key, thumbUrl: null }]));
    await vi.advanceTimersByTimeAsync(10);
    const removing = q.removeDraftMedia(key);
    await vi.advanceTimersByTimeAsync(2_500);
    await removing;
    expect(deletes()).toEqual(["/properties/drafts/current/media/m2", "/properties/drafts/current/media/m2"]);
  });

  it("сброс мастера после создания объекта ничего не удаляет на сервере", async () => {
    const { q, key } = await startPhoto();
    q.clearDraftMedia();
    FakeXHR.sent[0].finish(201, JSON.stringify([{ id: "m3", uploadKey: key, thumbUrl: null }]));
    await new Promise((r) => setTimeout(r, 30));
    expect(deletes()).toEqual([]);
  });
});
