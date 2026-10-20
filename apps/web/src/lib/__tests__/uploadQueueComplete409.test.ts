import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Отказ приёма готового ролика на COMPLETE — не повод заливать файл заново
 * (09.10.2026, объект №153). Сервер отвечает 409 с текстом («этот же ролик
 * уже сдан по №154», «нет звука») и сессию удаляет; до правки клиент принимал
 * любой 409 за «не все части дошли», заводил новую сессию и заливал 746 МБ с
 * нуля, потом отдавал status 0, и вызывающий цикл повторял всё до десяти раз.
 * Докачка по второму кругу — только когда 409 несёт `uploadedPartNumbers`.
 */
vi.mock("../../store/auth", () => ({
  useAuthStore: {
    getState: () => ({ hasSession: true, accessToken: "tokenA", agent: { id: "A" } }),
    subscribe: () => () => {},
  },
}));
vi.mock("../api", () => ({ api: vi.fn(), refreshAccessToken: vi.fn() }));
vi.mock("../queryClient", () => ({ queryClient: { invalidateQueries: vi.fn() } }));
vi.mock("../deviceId", () => ({ getOrCreateDeviceId: () => "test-device" }));
vi.mock("../errorReporter", () => ({ reportUploadIssue: vi.fn() }));

class FakeXHR {
  static sent: string[] = [];
  url = "";
  status = 0;
  responseText = "";
  upload: Record<string, unknown> = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  timeout = 0;
  withCredentials = false;
  open(_m: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  send() {
    FakeXHR.sent.push(this.url);
    queueMicrotask(() => {
      this.status = 201;
      this.onload?.();
    });
  }
  abort() {}
}

const started = (uploadedPartNumbers: number[] = []) => ({
  status: "started",
  sessionId: "s1",
  partSize: 100,
  totalParts: 1,
  uploadedPartNumbers,
});
const input = { propertyId: "p-153", file: new Blob([new Uint8Array(80)]), uploadKey: "k", filename: "153.mov", purpose: "handoff" as const };
const isStart = (url: string, opts?: { method?: string }) => url.endsWith("/videos/upload-sessions") && opts?.method === "POST";
const isComplete = (url: string) => url.endsWith("/complete");

beforeEach(() => {
  vi.resetModules();
  FakeXHR.sent = [];
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("409 на завершении загрузки ролика", () => {
  it("отказ приёма (409 без списка частей) отдаётся как есть, файл заново не заливается", async () => {
    const { api } = await import("../api");
    const { ApiError } = await import("../apiError");
    const message = "Этот же ролик уже сдан по объекту №154 — у двух квартир один ролик быть не может.";
    let starts = 0;
    vi.mocked(api).mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (isStart(url, opts)) {
        starts++;
        return started();
      }
      if (isComplete(url)) throw new ApiError(message, 409, { error: message });
      throw new Error(`неожиданный вызов ${url}`);
    });
    const { uploadVideoChunked } = await import("../uploadQueue");

    const result = await uploadVideoChunked(input, () => {});

    expect(result.status).toBe(409);
    expect(result.error).toBe(message);
    expect(FakeXHR.sent).toHaveLength(1); // одна часть, один раз
    expect(starts).toBe(1); // новую сессию не заводили
  });

  it("409 «не все части получены» (со списком частей) докачивает вторым кругом", async () => {
    const { api } = await import("../api");
    const { ApiError } = await import("../apiError");
    let completes = 0;
    let starts = 0;
    vi.mocked(api).mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (isStart(url, opts)) {
        starts++;
        return completes === 0 ? started() : started([1]);
      }
      if (isComplete(url)) {
        completes++;
        if (completes === 1) throw new ApiError("Не все части получены", 409, { error: "Не все части получены", uploadedPartNumbers: [] });
        return { id: "v1" };
      }
      throw new Error(`неожиданный вызов ${url}`);
    });
    const { uploadVideoChunked } = await import("../uploadQueue");

    const result = await uploadVideoChunked(input, () => {});

    expect(result.status).toBe(201);
    expect(completes).toBe(2);
    expect(starts).toBe(2);
  });
});
