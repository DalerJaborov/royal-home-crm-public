import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Файлы одного сотрудника не уходят токеном другого (аудит Codex 04.10.2026, WEB-02).
 *
 * Общий телефон: А поставил загрузку объекта и вышел, вошёл Б. Раньше очередь
 * брала любое задание из общего IndexedDB и слала его токеном того, кто вошёл.
 * IndexedDB в окружении нет: очередь по задуманному запасному пути держит
 * задания в памяти вкладки, поэтому run() здесь настоящий. Заглушены стор сессии,
 * XMLHttpRequest и соседи по импортам.
 */
const auth = vi.hoisted(() => {
  const subs = new Set<(s: unknown, p: unknown) => void>();
  const api = {
    state: { hasSession: true, accessToken: "tokenA", agent: { id: "A" } as { id: string } | null },
    subs,
    login(id: string) {
      const prev = api.state;
      api.state = { hasSession: true, accessToken: `token${id}`, agent: { id } };
      subs.forEach((f) => f(api.state, prev));
    },
  };
  return api;
});
vi.mock("../../store/auth", () => ({
  useAuthStore: {
    getState: () => auth.state,
    subscribe: (f: (s: unknown, p: unknown) => void) => {
      auth.subs.add(f);
      return () => auth.subs.delete(f);
    },
  },
}));
vi.mock("../api", () => ({ api: vi.fn(), refreshAccessToken: vi.fn() }));
vi.mock("../queryClient", () => ({ queryClient: { invalidateQueries: vi.fn() } }));
vi.mock("../deviceId", () => ({ getOrCreateDeviceId: () => "test-device" }));
vi.mock("../errorReporter", () => ({ reportUploadIssue: vi.fn() }));

class FakeXHR {
  static sent: { url: string; auth: string | undefined }[] = [];
  headers: Record<string, string> = {};
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
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send() {
    FakeXHR.sent.push({ url: this.url, auth: this.headers.Authorization });
    queueMicrotask(() => {
      this.status = 201;
      this.onload?.();
    });
  }
  abort() {}
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const photo = (name: string) => new File([new Uint8Array(1000)], name, { type: "image/jpeg" });
const keep = async (f: File) => f;

beforeEach(() => {
  vi.resetModules();
  FakeXHR.sent = [];
  auth.subs.clear();
  auth.state = { hasSession: true, accessToken: "tokenA", agent: { id: "A" } };
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  vi.stubGlobal("navigator", { onLine: false }); // постановка без сети: задание А лежит
});
afterEach(() => vi.unstubAllGlobals());

describe("очередь загрузок и смена сотрудника", () => {
  it("задание А не уходит токеном Б и дожидается А", async () => {
    const q = await import("../uploadQueue");
    await q.enqueuePhotos("p-A", [photo("a.jpg")], keep);
    expect(FakeXHR.sent).toHaveLength(0);

    auth.login("B");
    vi.stubGlobal("navigator", { onLine: true });
    await q.enqueuePhotos("p-B", [photo("b.jpg")], keep); // постановка Б будит очередь
    await settle();
    expect(FakeXHR.sent).toEqual([{ url: "/api/v1/properties/p-B/photos", auth: "Bearer tokenB" }]);
    expect(q.getSnapshot().tasks).toEqual([]); // Б чужих заданий не видит

    auth.login("A");
    await q.enqueuePhotos("p-A2", [photo("a2.jpg")], keep); // А вернулся: очередь отдаёт и его старое задание
    await settle();
    expect(FakeXHR.sent.slice(1)).toEqual([
      { url: "/api/v1/properties/p-A/photos", auth: "Bearer tokenA" },
      { url: "/api/v1/properties/p-A2/photos", auth: "Bearer tokenA" },
    ]);
  });
});

describe("докачка видео по частям и смена сотрудника", () => {
  it("после смены сотрудника следующая часть чужим токеном не уходит", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const { api } = await import("../api");
    vi.mocked(api).mockResolvedValue({ status: "started", sessionId: "s1", partSize: 100, totalParts: 2, uploadedPartNumbers: [] });
    const { uploadVideoChunked } = await import("../uploadQueue");
    let switched = false;
    const result = await uploadVideoChunked(
      { propertyId: "p-A", file: new Blob([new Uint8Array(150)]), uploadKey: "k", filename: "v.mov", purpose: "raw", expectAgentId: "A" },
      (loaded) => {
        if (loaded > 0 && !switched) {
          switched = true;
          auth.login("B"); // первая часть ушла, дальше вошёл другой сотрудник
        }
      }
    );
    expect(FakeXHR.sent).toHaveLength(1);
    expect(FakeXHR.sent[0].auth).toBe("Bearer tokenA");
    expect(result.status).toBe(0);
    expect(result.error).toMatch(/Сессия сменилась/);
  });
});

describe("pickNextPendingTask по автору", () => {
  const t = (id: string, agentId?: string) =>
    ({ id, kind: "photo", status: "pending", attempts: 0, createdAt: Number(id.slice(1)), agentId }) as never;

  it("берёт свои и старые без автора, чужие пропускает", async () => {
    const { pickNextPendingTask } = await import("../uploadQueue");
    const tasks = [t("t1", "A"), t("t2", "B"), t("t3")];
    expect(pickNextPendingTask(tasks, Date.now(), "B")?.id).toBe("t2");
    expect(pickNextPendingTask([t("t1", "A")], Date.now(), "B")).toBeUndefined();
    expect(pickNextPendingTask([t("t1", "A"), t("t3")], Date.now(), "B")?.id).toBe("t3");
    // без agentId отбора нет, как раньше
    expect(pickNextPendingTask(tasks)?.id).toBe("t1");
  });
});
