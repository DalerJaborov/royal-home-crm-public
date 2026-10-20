import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptTestDraftSession } from "./draftSessionFixture";
import type { PropertyDraftMediaView } from "@royal-home/shared";

/**
 * Очередь мастера и «файлы всегда дозагружаются» (07.10.2026): отказ по существу
 * (лимит/тип) не даёт «Повторить», потерянный файл не молчит, очередь будится
 * возвратом в приложение и стоит в реестре работы.
 *
 * Тот же приём, что в draftUploadsOwner.test.ts: настоящий стор сессии, XHR
 * управляется вручную, всё остальное — заглушки.
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
const apiMock = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../queryClient", () => ({ queryClient: { clear: vi.fn(), invalidateQueries: vi.fn() } }));
vi.mock("../queryPersist", () => ({ clearPersistedQueryCache: vi.fn(async () => {}) }));
vi.mock("../pendingMapPin", () => ({ clearPendingMapPin: vi.fn() }));
vi.mock("../deviceId", () => ({ getOrCreateDeviceId: () => "test-device" }));
vi.mock("../errorReporter", () => ({ reportUploadIssue: vi.fn() }));
vi.mock("../api", () => ({ api: apiMock, refreshAccessToken: vi.fn() }));
vi.mock("../compressImage", () => ({ compressImage: async (f: File) => f }));
vi.mock("../imagePreview", () => ({ createLightPreview: async () => null }));
vi.mock("../mediaGps", () => ({ readGpsFromFile: async () => null }));
vi.mock("../draftUploadStore", () => store);

class FakeXHR {
  static sent: FakeXHR[] = [];
  body: unknown;
  status = 0;
  responseText = "";
  upload: Record<string, unknown> = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  open() {}
  setRequestHeader() {}
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
  fail() {
    this.onerror?.();
  }
}

const A = { id: "A", fullName: "А", phone: "+992900000001", role: "AGENT" as const };
const photo = (name: string) => new File([new Uint8Array(500)], name, { type: "image/jpeg" });
const settle = () => new Promise((r) => setTimeout(r, 30));

const lostVideo: PropertyDraftMediaView = {
  id: "m1",
  kind: "VIDEO",
  status: "UPLOADING",
  uploadKey: "k-video",
  filename: "tour.mp4",
  contentType: "video/mp4",
  sizeBytes: 1000,
  order: 0,
  url: null,
  thumbUrl: null,
};

async function setup() {
  const { useAuthStore } = await import("../../store/auth");
  const q = await import("../draftUploads");
  const guard = await import("../workGuard");
  useAuthStore.getState().setSession(A, "tokenA");
  await adoptTestDraftSession();
  return { q, guard };
}

beforeEach(() => {
  vi.resetModules();
  lsStore.clear();
  FakeXHR.sent = [];
  apiMock.mockClear();
  Object.values(store).forEach((f) => f.mockClear());
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("classifyDraftError", () => {
  it("делит отказы на лечащиеся повтором и нет", async () => {
    const { q } = await setup();
    expect(q.classifyDraftError(0, null)).toBe("net");
    expect(q.classifyDraftError(503, null)).toBe("server");
    expect(q.classifyDraftError(429, null)).toBe("server");
    expect(q.classifyDraftError(413, null)).toBe("limit");
    expect(q.classifyDraftError(400, "В черновик помещается 30 снимков, сейчас уже 30")).toBe("limit");
    expect(q.classifyDraftError(400, "Файл «a.mov» больше лимита 2048 МБ")).toBe("limit");
    expect(q.classifyDraftError(400, "Допустимо только видео")).toBe("type");
    expect(q.classifyDraftError(415, null)).toBe("type");
    expect(q.classifyDraftError(403, "Недостаточно прав")).toBe("other");
  });
});

describe("«Повторить» только там, где повтор поможет", () => {
  it("отказ по лимиту (4xx): errorKind limit, повтор ничего не делает", async () => {
    const { q } = await setup();
    q.addDraftPhotos([photo("a.jpg")]);
    await settle();
    FakeXHR.sent[0].finish(400, JSON.stringify({ error: "В черновик помещается 30 снимков, сейчас уже 30" }));
    await settle();

    const item = q.getDraftMediaSnapshot()[0];
    expect(item.status).toBe("failed");
    expect(item.errorKind).toBe("limit");
    expect(q.canRetryDraftItem(item)).toBe(false);

    q.retryDraftMedia(item.uploadKey);
    await settle();
    expect(q.getDraftMediaSnapshot()[0].status).toBe("failed");
    expect(FakeXHR.sent).toHaveLength(1);
  });
});

describe("потерянный файл не молчит", () => {
  it("lost без файла: «Повторить» нельзя, выбор файла заново ставит ролик на докачку", async () => {
    const { q } = await setup();
    await q.hydrateDraftMedia([lostVideo]);
    const lost = q.getDraftMediaSnapshot()[0];
    expect(lost.status).toBe("lost");
    expect(q.canRetryDraftItem(lost)).toBe(false);
    expect(q.draftUploadsBlocking()).toBe(true);

    // тот же файл (имя и размер) — продолжаем под прежним ключом
    const same = new File([new Uint8Array(1000)], "tour.mp4", { type: "video/mp4" });
    q.replaceLostDraftFile("k-video", same);
    await settle();
    const after = q.getDraftMediaSnapshot();
    expect(after).toHaveLength(1);
    expect(after[0].uploadKey).toBe("k-video");
    expect(after[0].status).not.toBe("lost");
    expect(apiMock).toHaveBeenCalledWith(
      "/properties/drafts/current/videos/sessions",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("другой файл вместо потерянного — новая запись, старая строка убирается", async () => {
    const { q } = await setup();
    await q.hydrateDraftMedia([lostVideo]);
    q.replaceLostDraftFile("k-video", new File([new Uint8Array(77)], "other.mp4", { type: "video/mp4" }));
    await settle();
    const items = q.getDraftMediaSnapshot();
    expect(items.map((i) => i.name)).toEqual(["other.mp4"]);
    expect(items[0].uploadKey).not.toBe("k-video");
  });
});

describe("очередь просыпается и стоит в реестре работы", () => {
  it("обрыв связи → пауза 60 с; resumeUploads пробует сразу", async () => {
    const { q } = await setup();
    q.addDraftPhotos([photo("a.jpg")]);
    await settle();
    FakeXHR.sent[0].fail();
    await settle();
    expect(q.getDraftMediaSnapshot()[0].status).toBe("queued");
    expect(q.getDraftMediaSnapshot()[0].errorKind).toBe("net");
    expect(FakeXHR.sent).toHaveLength(1); // ждёт заморозку бэкоффа

    q.resumeUploads(); // вернулись в приложение
    await settle();
    expect(FakeXHR.sent).toHaveLength(2);
    q.clearDraftMedia();
  });

  it("isBusy в workGuard, пока файл едет, и снимается, когда доехал", async () => {
    const { q, guard } = await setup();
    expect(guard.isBusy()).toBe(false);
    q.addDraftPhotos([photo("a.jpg")]);
    await settle();
    expect(guard.isBusy()).toBe(true);

    FakeXHR.sent[0].finish(201, JSON.stringify([]));
    await settle();
    expect(q.getDraftMediaSnapshot()[0].status).toBe("ready");
    expect(guard.isBusy()).toBe(false);
  });
});

describe("waitForDraftUploads", () => {
  it("возвращает счётчики упавших; без едущих выходит сразу", async () => {
    const { q } = await setup();
    q.addDraftPhotos([photo("a.jpg")]);
    await settle();
    const waiting = q.waitForDraftUploads();
    FakeXHR.sent[0].finish(400, JSON.stringify({ error: "Допустимо только видео" }));
    const res = await waiting;
    expect(res).toEqual({ ok: false, failed: 1, lost: 0, aborted: false });
  });

  it("при abort подписка снимается и результат помечен aborted", async () => {
    const { q } = await setup();
    q.addDraftPhotos([photo("a.jpg")]);
    await settle();
    const abort = new AbortController();
    const waiting = q.waitForDraftUploads({ signal: abort.signal });
    abort.abort();
    const res = await waiting;
    expect(res.aborted).toBe(true);
    expect(res.ok).toBe(false);
    q.clearDraftMedia();
  });
});

describe("закрыли мастер, пока файлы едут, и вернулись", () => {
  it("закрытие не отменяет едущие файлы; возврат (hydrate) подхватывает ту же очередь, а не стартует вторую", async () => {
    const { q } = await setup();
    const reminder = await import("../draftReminder");
    expect(reminder.getDraftReminder()).toBe(false);

    q.addDraftPhotos([photo("a.jpg"), photo("b.jpg")]);
    await settle();
    expect(FakeXHR.sent).toHaveLength(1); // a.jpg в полёте
    expect(reminder.getDraftReminder()).toBe(true); // плашка «Черновик объекта · Продолжить»

    q.detachDraftMediaView(); // крестик мастера
    expect(q.hasLiveDraftMedia()).toBe(true);
    expect(q.draftUploadsPending()).toBe(true);

    // мастер открыт снова: сервер отдал черновик без этих ключей (ещё не доехали)
    await q.hydrateDraftMedia([]);
    await settle();
    expect(q.getDraftMediaSnapshot().map((i) => i.name)).toEqual(["a.jpg", "b.jpg"]);
    expect(FakeXHR.sent).toHaveLength(1); // вторая очередь не заводилась

    FakeXHR.sent[0].finish(201, JSON.stringify([]));
    await settle();
    expect(FakeXHR.sent).toHaveLength(2); // b.jpg поехал в той же очереди
    q.clearDraftMedia();
  });
});
