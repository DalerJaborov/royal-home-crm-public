import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeIndexedDb, type FakeIdb } from "./fakeIndexedDb";

/**
 * ДОРАБОТКА ВОЛНЫ A ПО НЕЗАВИСИМОМУ РЕВЬЮ (26.11.2026). По тесту на пункт; каждый красный,
 * если убрать соответствующую правку:
 *  1 — IndexedDB v1 → v2: вкладка со старой схемой блокирует открытие, очередь не виснет;
 *  2 — Wake Lock снимается на паузах повтора и ожидании сети;
 *  3 — «Отмена» рвёт старт, но не сборку; сборка не объявляется «отменённой», пока не вернулась;
 *  4 — перенос заданий v1 → v2 пишет по свежей строке, а не по устаревшей;
 *  5 — промежуточные отчёты загрузки не едят общий предел журнала;
 *  6 — текст отказа 5xx ничего не обещает про «мы уже знаем»;
 *  7 — вкладку нельзя тихо закрыть на всё время повторов, включая паузы.
 */

const mocks = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({})) }));
vi.mock("../api", async (original) => ({ ...(await original<typeof import("../api")>()), api: mocks.api }));
vi.mock("../deviceId", async (original) => ({ ...(await original<typeof import("../deviceId")>()), getOrCreateDeviceId: () => "test-device" }));

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => void values.set(k, v),
    removeItem: (k: string) => void values.delete(k),
    clear: () => values.clear(),
    key: (i: number) => [...values.keys()][i] ?? null,
    get length() {
      return values.size;
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  mocks.api.mockReset();
  mocks.api.mockImplementation(async () => ({}));
  vi.stubGlobal("localStorage", memoryStorage());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

class FakeXhr {
  static all: FakeXhr[] = [];
  method = "";
  url = "";
  body: unknown;
  status = 0;
  responseText = "";
  headers: Record<string, string> = {};
  responseHeaders: Record<string, string> = {};
  withCredentials = false;
  upload: { onprogress?: (e: { loaded: number }) => void; onload?: () => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  constructor() {
    FakeXhr.all.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  getResponseHeader(k: string) {
    return this.responseHeaders[k] ?? null;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
  respond(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.upload.onload?.();
    this.status = status;
    this.responseHeaders = headers;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}
const last = () => FakeXhr.all[FakeXhr.all.length - 1]!;
const puts = () => FakeXhr.all.filter((x) => x.method === "PUT");

// ───────────────────────── пункт 1: IndexedDB заблокирована старой вкладкой ─────────────────────────

describe("пункт 1: старая вкладка со схемой v1 не вешает очередь навсегда", () => {
  let fake: FakeIdb;
  beforeEach(() => {
    fake = createFakeIndexedDb();
    vi.stubGlobal("indexedDB", fake.indexedDB);
    vi.stubGlobal("navigator", { onLine: false });
  });

  const legacyRow = (id: string) => ({ id, kind: "video", propertyId: "p1", label: id, files: [new Blob(["b"])], filenames: [id], uploadKeys: ["k"], totalBytes: 1, status: "pending", attempts: 0, error: null, createdAt: 1 });

  it("очередь карточки: открытие заблокировано — отказ вместо вечного ожидания; закрыли вкладку — работает", async () => {
    fake.seed("royal-home-uploads", 1, { tasks: { keyPath: "id", rows: [["old-1", legacyRow("old-1")]] } });
    const closeOldTab = fake.holdOpen("royal-home-uploads"); // v1 не закрывается по versionchange
    const q = await import("../uploadQueue");
    const outcome = await Promise.race([q.migrateLegacyUploadTasks().then(() => "done"), new Promise((r) => setTimeout(() => r("hang"), 300))]);
    expect(outcome).toBe("done"); // не повисло

    closeOldTab();
    await new Promise((r) => setTimeout(r, 0));
    // Отложенное открытие дошло до конца само, но его соединение закрыто (никого не держит).
    expect(fake.openConnections("royal-home-uploads")).toBe(0);
    // Следующий вызов пробует заново и работает.
    expect(await q.migrateLegacyUploadTasks()).toBe(1);
  });

  it("очередь карточки: другая вкладка просит версию выше — наша отпускает базу, а не блокирует её", async () => {
    const q = await import("../uploadQueue");
    await q.migrateLegacyUploadTasks(); // открыли v2, соединение живёт
    expect(fake.openConnections("royal-home-uploads")).toBe(1);
    const blocked = vi.fn();
    const req = fake.indexedDB.open("royal-home-uploads", 3) as { onblocked: (() => void) | null; onsuccess: (() => void) | null };
    req.onblocked = blocked;
    const opened = new Promise<void>((r) => (req.onsuccess = () => r()));
    await opened;
    expect(blocked).not.toHaveBeenCalled();
    // И наша вкладка потом открывает базу заново, а не держит мёртвое соединение.
    expect(await q.migrateLegacyUploadTasks()).toBe(0);
  });

  it("склад черновика: то же самое", async () => {
    const closeOldTab = fake.holdOpen("royal-home-draft-media");
    const store = await import("../draftUploadStore");
    const outcome = await Promise.race([
      store.readAllDraftFiles("A").then(
        () => "done",
        () => "done"
      ),
      new Promise((r) => setTimeout(() => r("hang"), 300)),
    ]);
    expect(outcome).toBe("done");
    closeOldTab();
    await new Promise((r) => setTimeout(r, 0));
    expect(await store.readAllDraftFiles("A")).toEqual([]);

    const blocked = vi.fn();
    const req = fake.indexedDB.open("royal-home-draft-media", 3) as { onblocked: (() => void) | null; onsuccess: (() => void) | null };
    req.onblocked = blocked;
    await new Promise<void>((r) => (req.onsuccess = () => r()));
    expect(blocked).not.toHaveBeenCalled();
  });
});

// ───────────────────────── пункт 2: экран не держим на паузах ─────────────────────────

describe("пункт 2: Wake Lock снимается на ожидании сети и паузах повтора", () => {
  beforeEach(() => {
    FakeXhr.all = [];
    vi.useFakeTimers();
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
  });

  it("пауза после 429 — экран свободен, следующая отправка — снова держим", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const { screenAwakeHolders } = await import("../upload/wakeLock");
    const { uploadClipVideo } = await import("../clipVideoUpload");
    const p = uploadClipVideo("p1", new File([new Uint8Array(2)], "a.mp4", { type: "video/mp4" }));
    await vi.advanceTimersByTimeAsync(0);
    last().respond(201, { sessionId: "s1", partSize: 2, totalParts: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(screenAwakeHolders()).toBe(1); // часть уходит
    last().respond(429, {}, { "Retry-After": "30" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(screenAwakeHolders()).toBe(0); // пауза — экран не держим
    await vi.advanceTimersByTimeAsync(20_000);
    expect(puts()).toHaveLength(2);
    expect(screenAwakeHolders()).toBe(1); // снова отправка
    last().respond(200, {});
    await vi.advanceTimersByTimeAsync(0);
    last().respond(202, { clipVideoStatus: "PROCESSING" });
    await p;
    expect(screenAwakeHolders()).toBe(0);
  });

  it("ожидание сети — экран свободен, вернулась сеть — держим", async () => {
    const nav = { onLine: true };
    vi.stubGlobal("navigator", nav);
    const win = new EventTarget();
    vi.stubGlobal("window", win);
    const { screenAwakeHolders } = await import("../upload/wakeLock");
    const { uploadClipVideo } = await import("../clipVideoUpload");
    const p = uploadClipVideo("p1", new File([new Uint8Array(2)], "a.mp4", { type: "video/mp4" }));
    await vi.advanceTimersByTimeAsync(0);
    last().respond(201, { sessionId: "s1", partSize: 2, totalParts: 1 });
    await vi.advanceTimersByTimeAsync(0);
    nav.onLine = false;
    last().onerror?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screenAwakeHolders()).toBe(0);
    nav.onLine = true;
    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(screenAwakeHolders()).toBe(1);
    last().respond(200, {});
    await vi.advanceTimersByTimeAsync(0);
    last().respond(202, { clipVideoStatus: "PROCESSING" });
    await p;
    expect(screenAwakeHolders()).toBe(0);
  });
});

// ───────────────────────── пункт 3: «Отмена» и сборка ─────────────────────────

describe("пункт 3: отмена рвёт старт, но не сборку", () => {
  beforeEach(() => {
    FakeXhr.all = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    vi.stubGlobal("navigator", { onLine: true });
  });

  const START = { sessionId: "s1", partSize: 4, totalParts: 1, uploadedPartNumbers: [] };
  const file = () => new File([new Uint8Array(4)], "a.mp4", { type: "video/mp4" });
  const input = (extra: Record<string, unknown> = {}) => ({ propertyId: "p1", file: file(), uploadKey: "k1", filename: "a.mp4", purpose: "raw" as const, ...extra });

  it("api(): сигнал рвёт запрос и отдаёт AbortError, а не «связь прервалась»", async () => {
    const ctrl = new AbortController();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))));
    vi.stubGlobal("fetch", fetchMock);
    const real = await vi.importActual<typeof import("../api")>("../api");
    const p = real.api("/x", { signal: ctrl.signal });
    const settled = p.then(
      () => "ok",
      (e: unknown) => (e instanceof DOMException && e.name === "AbortError" ? "abort" : `other:${String(e)}`)
    );
    ctrl.abort();
    expect(await settled).toBe("abort");
  });

  it("отмена на старте сессии — загрузка отменена, сигнал уходит в api()", async () => {
    const { uploadVideoChunked, CANCELLED_STATUS } = await import("../uploadQueue");
    const ctrl = new AbortController();
    mocks.api.mockImplementation(
      (_path: unknown, options: unknown) =>
        new Promise((_res, rej) => {
          const s = (options as { signal?: AbortSignal }).signal;
          s?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        })
    );
    const p = uploadVideoChunked(input({ signal: ctrl.signal }), () => {});
    ctrl.abort();
    const result = await Promise.race([p, new Promise<"hang">((r) => setTimeout(() => r("hang"), 300))]);
    expect(result).toMatchObject({ status: CANCELLED_STATUS });
  });

  it("отмена посреди сборки: запрос НЕ рвётся, итог — настоящий ответ; uploadVideoNow отдаёт собранный ролик, а не «отменено»", async () => {
    const { uploadVideoNow } = await import("../uploadQueue");
    const ctrl = new AbortController();
    let finishComplete!: (v: unknown) => void;
    const completeOptions: unknown[] = [];
    mocks.api.mockImplementation((path: unknown, options: unknown) => {
      if (String(path).endsWith("/complete")) {
        completeOptions.push(options);
        return new Promise((r) => (finishComplete = r));
      }
      return Promise.resolve(START);
    });
    const completing = vi.fn();
    const p = uploadVideoNow("p1", file(), () => {}, ctrl.signal, undefined, completing);
    await vi.waitFor(() => expect(puts()).toHaveLength(1));
    puts()[0]!.respond(200, {});
    await vi.waitFor(() => expect(completeOptions).toHaveLength(1));
    expect(completing).toHaveBeenCalledTimes(1);
    ctrl.abort(); // человек нажал «Отменить» во время сборки
    expect((completeOptions[0] as { signal?: AbortSignal }).signal).toBeUndefined(); // сборку не рвём
    let settled = false;
    void p.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false); // «отменено» не показываем, пока запрос не вернулся
    finishComplete({ id: "v1" });
    expect(await p).toEqual({ ok: true, videoId: "v1" }); // ролик создан — не прячем это
  });
});

// ───────────────────────── пункт 4: перенос v1 → v2 по свежей строке ─────────────────────────

describe("пункт 4: перенос заданий пишет по свежей строке", () => {
  let fake: FakeIdb;
  beforeEach(() => {
    fake = createFakeIndexedDb();
    vi.stubGlobal("indexedDB", fake.indexedDB);
    vi.stubGlobal("navigator", { onLine: false });
  });
  const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "video", propertyId: "p1", label: id, files: [new Blob([id])], filenames: [id], uploadKeys: ["k-" + id], totalBytes: 1, status: "pending", attempts: 0, error: null, createdAt: 1, ...extra });

  /** Между чтением списка и записью второго задания «run()» вмешивается в него. */
  function interfereOnSecondWrite(fn: () => void) {
    let writes = 0;
    fake.onTx = (mode, stores) => {
      if (mode === "readwrite" && stores.includes("blobs") && ++writes === 2) fn();
    };
  }

  it("задание убрали между чтением и записью — не воскресает", async () => {
    fake.seed("royal-home-uploads", 1, { tasks: { keyPath: "id", rows: [["a", row("a")], ["b", row("b")]] } });
    interfereOnSecondWrite(() => fake.mutate("royal-home-uploads", "tasks", (rows) => void rows.delete("b")));
    const q = await import("../uploadQueue");
    expect(await q.migrateLegacyUploadTasks()).toBe(1);
    expect(fake.dump("royal-home-uploads", "tasks").has("b")).toBe(false);
    expect(fake.dump("royal-home-uploads", "blobs").has("b:0")).toBe(false);
  });

  it("статус сменился между чтением и записью — остаётся свежий", async () => {
    fake.seed("royal-home-uploads", 1, { tasks: { keyPath: "id", rows: [["a", row("a")], ["b", row("b")]] } });
    interfereOnSecondWrite(() =>
      fake.mutate("royal-home-uploads", "tasks", (rows) => rows.set("b", { ...(rows.get("b") as object), status: "failed", attempts: 7 }))
    );
    const q = await import("../uploadQueue");
    expect(await q.migrateLegacyUploadTasks()).toBe(2);
    const b = fake.dump("royal-home-uploads", "tasks").get("b") as { status: string; attempts: number; files?: unknown; fileCount: number };
    expect(b.status).toBe("failed");
    expect(b.attempts).toBe(7);
    expect(b.files).toBeUndefined();
    expect(b.fileCount).toBe(1);
    expect(fake.dump("royal-home-uploads", "blobs").has("b:0")).toBe(true);
  });
});

// ───────────────────────── пункт 5: пределы журнала ─────────────────────────

describe("пункт 5: промежуточные отчёты загрузки не съедают общий предел журнала", () => {
  const base = { kind: "video" as const, sizeBytes: 1, propertyLabel: "объект", maxAttempts: 10, status: 0, error: "x", online: true, userAgent: "Android" };
  beforeEach(async () => {
    vi.stubGlobal("navigator", { onLine: true, userAgent: "Android Chrome" });
    vi.stubGlobal("location", { pathname: "/properties/1" });
    const { useAuthStore } = await import("../../store/auth");
    useAuthStore.setState({ hasSession: true });
  });
  const bodies = () => mocks.api.mock.calls.map((c) => (c[1] as { body: { message: string } }).body.message);

  it("промежуточных не больше десяти; обычные ошибки скрипта после них идут все 20; финальный — всегда", async () => {
    const { reportUploadIssue, reportEmptyListGuard } = await import("../errorReporter");
    for (let i = 0; i < 30; i++) reportUploadIssue({ ...base, name: `v${i}.mp4`, attempts: i });
    expect(bodies()).toHaveLength(10);
    for (let i = 0; i < 20; i++) reportEmptyListGuard(`обычная ошибка ${i}`);
    expect(bodies()).toHaveLength(30); // общий предел цел
    reportUploadIssue({ ...base, name: "last.mp4", attempts: 10, final: true });
    expect(bodies()).toHaveLength(31);
    expect(bodies().at(-1)).toMatch(/last\.mp4/);
  });
});

// ───────────────────────── пункт 6: текст отказа 5xx ─────────────────────────

describe("пункт 6: текст отказа сервера без обещаний", () => {
  it("5xx не говорит, что о сбое «мы уже знаем»", async () => {
    const { giveUpMessage } = await import("../upload/progressText");
    for (const status of [500, 502, 503]) {
      const text = giveUpMessage(status, 10);
      expect(text).not.toMatch(/уже знаем/);
      expect(text).toMatch(/Сервер/);
      expect(text).toMatch(/Повторить/);
    }
  });
});

// ───────────────────────── пункт 7: вкладку нельзя закрыть и в паузах повтора ─────────────────────────

describe("пункт 7: запись «идёт работа» живёт весь цикл повторов", () => {
  it("в паузе между повторами вкладка по-прежнему спрашивает при закрытии; после итога — запись снята", async () => {
    vi.useFakeTimers();
    FakeXhr.all = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    vi.stubGlobal("navigator", { onLine: true });
    const { uploadVideoNow } = await import("../uploadQueue");
    const { isBlockingUnload } = await import("../workGuard");
    // Старт сессии отказывает 503 — попытка кончается, начинается пауза повтора.
    let starts = 0;
    const { ApiError } = await import("../api");
    mocks.api.mockImplementation(async (path: unknown) => {
      if (String(path).endsWith("/upload-sessions")) {
        starts++;
        if (starts === 1) throw new ApiError("Сервер недоступен", 503, undefined);
        return { sessionId: "s1", partSize: 4, totalParts: 1, uploadedPartNumbers: [] };
      }
      return { id: "v1" };
    });
    const p = uploadVideoNow("p1", new File([new Uint8Array(4)], "a.mp4", { type: "video/mp4" }), () => {});
    await vi.advanceTimersByTimeAsync(100);
    expect(starts).toBe(1);
    expect(isBlockingUnload()).toBe(true); // пауза идёт, вкладку закрыть без вопроса нельзя
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(puts()).toHaveLength(1));
    puts()[0]!.respond(200, {});
    await vi.advanceTimersByTimeAsync(0);
    expect(await p).toEqual({ ok: true, videoId: "v1" });
    expect(isBlockingUnload()).toBe(false);
  });
});
