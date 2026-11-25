import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeIndexedDb, type FakeIdb } from "./fakeIndexedDb";

/**
 * УСТОЙЧИВАЯ КЛИЕНТСКАЯ ЗАГРУЗКА (25.11.2026, волна A). По тесту на каждый класс находок:
 *  1 — чтение файла: три попытки, вторая по исходнику, причина словами;
 *  2 — склад очереди карточки v2: файл кладётся один раз, перенос v1 → v2 без потерь;
 *  6 — общий помощник частями: без сети ждёт `online`, на 429 уважает Retry-After,
 *      сессия переживает перезагрузку по отпечатку файла;
 *  7 — окончательный отказ пишется в журнал всегда, даже после предела записей;
 *  8 — Wake Lock: нет API — не падаем; есть — держим, отпускаем, берём снова;
 * 11 — короткий ролик: размер и длительность до отправки, число совпадает с сервером;
 * 13 — окончательный отказ по сети не говорит «файл мог повредиться».
 * (3 и 4 — в draftUploadsServerRetry.test.ts, рядом с очередью мастера.)
 */

const mocks = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({})) }));
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

/** Blob, чтение которого бросает ошибку браузера с данным именем. */
function brokenBlob(name: string, size = 10): Blob {
  const err = Object.assign(new Error(`${name} test`), { name });
  return {
    size,
    type: "video/mp4",
    slice: () => ({ arrayBuffer: () => Promise.reject(err) }),
  } as unknown as Blob;
}

/** Blob, который не читается первые `failTimes` раз, потом читается. */
function flakyBlob(failTimes: number): Blob & { reads: number } {
  const b = {
    reads: 0,
    size: 10,
    type: "video/mp4",
    slice: () => ({
      arrayBuffer: () => {
        b.reads++;
        return b.reads <= failTimes ? Promise.reject(Object.assign(new Error("x"), { name: "NotReadableError" })) : Promise.resolve(new ArrayBuffer(1));
      },
    }),
  };
  return b as unknown as Blob & { reads: number };
}

const noSleep = async () => {};

describe("находка 1: чтение файла — три попытки, исходник, причина словами", () => {
  it("1-я и 2-я попытки падают, 3-я читается — файл уходит", async () => {
    const { probeReadable } = await import("../upload/readProbe");
    const blob = flakyBlob(2);
    const r = await probeReadable([{ blob, source: "idb" }], { sleep: noSleep });
    expect(r).toMatchObject({ ok: true, attempts: 3 });
  });

  it("копия в IndexedDB не читается — вторая попытка берёт исходник, его и шлём", async () => {
    const { probeReadable } = await import("../upload/readProbe");
    const original = new Blob(["ok"]);
    const r = await probeReadable([{ blob: brokenBlob("NotReadableError"), source: "idb" }, { blob: original, source: "original" }], { sleep: noSleep });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.blob).toBe(original);
      expect(r.source).toBe("original");
      expect(r.attempts).toBe(2);
    }
  });

  it("паузы между попытками — 0,5 и 1,5 с", async () => {
    const { probeReadable } = await import("../upload/readProbe");
    const waits: number[] = [];
    await probeReadable([{ blob: brokenBlob("NotReadableError"), source: "idb" }], { sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([500, 1500]);
  });

  it("причина по имени ошибки, тексты разные; Android — совет про «Файлы»", async () => {
    const { probeReadable, readFailureMessage } = await import("../upload/readProbe");
    const r = await probeReadable([{ blob: brokenBlob("NotFoundError"), source: "idb" }], { sleep: noSleep });
    expect(r).toMatchObject({ ok: false, reason: "not-found", errorName: "NotFoundError", attempts: 3 });
    const texts = new Set((["not-found", "not-readable", "quota", "security"] as const).map((x) => readFailureMessage(x, "android")));
    expect(texts.size).toBe(4);
    expect(readFailureMessage("not-readable", "android")).toMatch(/«Файлы»/);
    expect(readFailureMessage("quota", "ios")).toMatch(/место/);
  });

  it("очередь карточки: битая копия + исходник в памяти → шлём исходник", async () => {
    vi.stubGlobal("navigator", { onLine: false, userAgent: "test" });
    const { probeTaskFiles } = await import("../uploadQueue");
    const { probeReadable } = await import("../upload/readProbe");
    const original = new File(["ok"], "v.mp4", { type: "video/mp4" });
    const r = await probeTaskFiles({ id: "t", files: [brokenBlob("NotReadableError")], filenames: ["v.mp4"] }, [original], true, (c) =>
      probeReadable(c, { sleep: noSleep })
    );
    expect(r).toEqual({ ok: true, files: [original] });
  });
});

describe("находка 13: окончательный отказ — текст по причине", () => {
  it("сеть и 502 не называют файл повреждённым; 0 — про связь, 5xx — про сервер", async () => {
    const { giveUpMessage } = await import("../upload/progressText");
    expect(giveUpMessage(0, 10)).not.toMatch(/повред/);
    expect(giveUpMessage(0, 10)).toMatch(/Связь/);
    expect(giveUpMessage(502, 10)).toMatch(/Сервер/);
    expect(giveUpMessage(502, 10)).not.toMatch(/повред/);
  });
});

describe("находка 12: строка прогресса — МБ из МБ, скорость, осталось, ожидание", () => {
  it("всё, что владелец просил видеть, в одной строке", async () => {
    const { formatUploadLive } = await import("../upload/progressText");
    const MB = 1024 * 1024;
    const line = formatUploadLive({ phase: "uploading", loaded: 42 * MB, total: 271 * MB }, MB, 0);
    expect(line).toMatch(/42\.0 МБ из 271\.0 МБ/);
    expect(line).toMatch(/1\.0 МБ\/с/);
    expect(line).toMatch(/осталось ~4 мин/);
    expect(formatUploadLive({ phase: "waiting-online", loaded: MB, total: 2 * MB }, null)).toMatch(/Нет интернета/);
    expect(formatUploadLive({ phase: "waiting-retry", loaded: 0, total: MB, error: "Сервер временно недоступен", nextAttemptAt: 10_000 }, null, 0)).toMatch(
      /Сервер временно недоступен · повтор через 10 с/
    );
  });
});

describe("находка 8: экран не гаснет, пока идёт загрузка", () => {
  it("нет Wake Lock API — без падения", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const { holdScreenAwake } = await import("../upload/wakeLock");
    const release = holdScreenAwake();
    expect(() => release()).not.toThrow();
  });

  it("два держателя — одна блокировка; отпустили оба — снята; вернулись в приложение — взята снова", async () => {
    const released = vi.fn(async () => {});
    const request = vi.fn(async () => ({ release: released, addEventListener: () => {} }));
    vi.stubGlobal("navigator", { onLine: true, wakeLock: { request } });
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    vi.stubGlobal("document", doc);
    const { holdScreenAwake } = await import("../upload/wakeLock");
    const a = holdScreenAwake();
    const b = holdScreenAwake();
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);

    // Браузер сам снял блокировку при уходе в фон; вернулись — берём снова.
    const { resetScreenAwakeForTests: _reset } = await import("../upload/wakeLock");
    void _reset;
    a();
    expect(released).not.toHaveBeenCalled();
    b();
    expect(released).toHaveBeenCalledTimes(1);

    const c = holdScreenAwake();
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    c();
  });

  it("отказ браузера (низкий заряд) — без падения", async () => {
    vi.stubGlobal("navigator", { onLine: true, wakeLock: { request: () => Promise.reject(new Error("NotAllowedError")) } });
    const { holdScreenAwake } = await import("../upload/wakeLock");
    const release = holdScreenAwake();
    await Promise.resolve();
    expect(() => release()).not.toThrow();
  });
});

describe("находка 6: ожидание сети", () => {
  it("без сети ждёт события online, с сетью — сразу", async () => {
    const nav = { onLine: false };
    vi.stubGlobal("navigator", nav);
    const win = new EventTarget();
    vi.stubGlobal("window", win);
    const { waitForOnline } = await import("../upload/network");
    let done = false;
    const p = waitForOnline().then(() => (done = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    nav.onLine = true;
    win.dispatchEvent(new Event("online"));
    await p;
    expect(done).toBe(true);
    nav.onLine = true;
    await expect(waitForOnline()).resolves.toBeUndefined();
  });

  it("Retry-After: секунды и дата; не дольше 5 минут", async () => {
    const { parseRetryAfterMs } = await import("../upload/network");
    expect(parseRetryAfterMs("30")).toBe(30_000);
    expect(parseRetryAfterMs(new Date(60_000).toUTCString(), null, 0)).toBe(60_000);
    expect(parseRetryAfterMs("100000")).toBe(5 * 60_000);
    expect(parseRetryAfterMs(null, "7")).toBe(7_000);
    expect(parseRetryAfterMs(null)).toBeNull();
  });
});

// ─────────────── общий помощник частями: сеть, Retry-After, сессия по отпечатку ───────────────

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

describe("находка 6: загрузка частями переживает сеть и «подождите» сервера", () => {
  beforeEach(() => {
    FakeXhr.all = [];
    vi.useFakeTimers();
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
  });

  it("429 с Retry-After: 30 — повтор не раньше 30 с, а не через 5", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const { uploadClipVideo } = await import("../clipVideoUpload");
    const p = uploadClipVideo("p1", new File([new Uint8Array(2)], "a.mp4", { type: "video/mp4" }));
    await vi.advanceTimersByTimeAsync(0);
    last().respond(201, { sessionId: "s1", partSize: 2, totalParts: 1 });
    await vi.advanceTimersByTimeAsync(0);
    last().respond(429, {}, { "Retry-After": "30" });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(puts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(puts()).toHaveLength(2);
    last().respond(200, {});
    await vi.advanceTimersByTimeAsync(0);
    last().respond(202, { clipVideoStatus: "PROCESSING" });
    await expect(p).resolves.toMatchObject({ clipVideoStatus: "PROCESSING" });
  });

  it("нет сети — ждём `online` хоть час, попытки не сгорают; сеть есть — докачиваем", async () => {
    const nav = { onLine: true };
    vi.stubGlobal("navigator", nav);
    const win = new EventTarget();
    vi.stubGlobal("window", win);
    const { uploadClipVideo } = await import("../clipVideoUpload");
    const p = uploadClipVideo("p1", new File([new Uint8Array(2)], "a.mp4", { type: "video/mp4" }));
    let settled = false;
    void p.then(
      () => (settled = true),
      () => (settled = true)
    );
    await vi.advanceTimersByTimeAsync(0);
    last().respond(201, { sessionId: "s1", partSize: 2, totalParts: 1 });
    await vi.advanceTimersByTimeAsync(0);
    nav.onLine = false;
    last().onerror?.();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(settled).toBe(false);
    expect(puts()).toHaveLength(1);
    nav.onLine = true;
    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(2);
    last().respond(200, {});
    await vi.advanceTimersByTimeAsync(0);
    last().respond(202, { clipVideoStatus: "PROCESSING" });
    await expect(p).resolves.toMatchObject({ clipVideoStatus: "PROCESSING" });
  });

  it("сессия переживает перезагрузку: тот же файл снова — сразу сборка, части заново не грузятся", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const file = new File([new Uint8Array(4)], "tour.mp4", { type: "video/mp4", lastModified: 1_700_000_000_000 });
    const first = (await import("../clipVideoUpload")).uploadClipVideo("p1", file);
    const failed = expect(first).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    last().respond(201, { sessionId: "s7", partSize: 2, totalParts: 2 });
    await vi.advanceTimersByTimeAsync(0);
    last().respond(200, {});
    await vi.advanceTimersByTimeAsync(0);
    last().respond(400, { error: "отказ части" }); // отказ по смыслу — без повтора
    await failed;

    // «Перезагрузка вкладки»: модуль заново, памяти о сессии нет — только localStorage.
    vi.resetModules();
    FakeXhr.all = [];
    const second = (await import("../clipVideoUpload")).uploadClipVideo("p1", file);
    await vi.advanceTimersByTimeAsync(0);
    expect(last().url).toBe("/api/v1/properties/p1/clip-video/upload-sessions/s7/complete");
    last().respond(409, { code: "PARTS_MISSING" });
    await vi.advanceTimersByTimeAsync(0);
    expect(last().url).toBe("/api/v1/upload-sessions/s7");
    last().respond(200, { sessionId: "s7", partSize: 2, totalParts: 2, uploadedPartNumbers: [1] });
    await vi.advanceTimersByTimeAsync(0);
    expect(last().url).toBe("/api/v1/upload-sessions/s7/parts/2"); // только недостающая часть
    last().respond(200, {});
    await vi.advanceTimersByTimeAsync(0);
    last().respond(202, { clipVideoStatus: "PROCESSING" });
    await expect(second).resolves.toMatchObject({ clipVideoStatus: "PROCESSING" });
    expect(puts()).toHaveLength(1);
  });
});

describe("находка 7: окончательный отказ пишется всегда", () => {
  it("после 20 промежуточных записей «сдалась» всё равно уходит в журнал", async () => {
    vi.stubGlobal("navigator", { onLine: true, userAgent: "Android Chrome" });
    vi.stubGlobal("location", { pathname: "/properties/1" });
    const { useAuthStore } = await import("../../store/auth");
    useAuthStore.setState({ hasSession: true });
    const { reportUploadIssue } = await import("../errorReporter");
    const base = { kind: "video" as const, sizeBytes: 1, propertyLabel: "объект", maxAttempts: 10, status: 0, error: "x", online: true, userAgent: "Android" };
    for (let i = 0; i < 25; i++) reportUploadIssue({ ...base, name: `v${i}.mp4`, attempts: i });
    reportUploadIssue({ ...base, name: "last.mp4", attempts: 10, final: true, cause: "тишина в канале", partNumber: 3, partSentBytes: 0 });
    const bodies = mocks.api.mock.calls.map((c) => (c[1] as { body: { message: string } }).body.message);
    expect(bodies.length).toBe(21);
    const final = bodies[bodies.length - 1];
    expect(final).toMatch(/last\.mp4/);
    expect(final).toMatch(/сдалась/);
    expect(final).toMatch(/причина тишина в канале/);
    expect(final).toMatch(/ни одного байта части/);
  });
});

describe("находка 11: короткий ролик проверяется до отправки", () => {
  it("тяжелее предела и длиннее 5 минут — отказ сразу, словами", async () => {
    const { checkClipVideoBeforeUpload } = await import("../upload/videoMeta");
    const MB = 1024 * 1024;
    const ok = { size: 10 * MB, type: "video/mp4" } as Blob;
    expect(await checkClipVideoBeforeUpload(ok, 300 * MB, async () => 120)).toBeNull();
    expect(await checkClipVideoBeforeUpload({ size: 301 * MB, type: "video/mp4" } as Blob, 300 * MB, async () => 10)).toMatch(/слишком большой/);
    expect(await checkClipVideoBeforeUpload(ok, 300 * MB, async () => 301)).toMatch(/до 5 минут/);
    // Длительность не прочиталась — не мешаем, решит сервер.
    expect(await checkClipVideoBeforeUpload(ok, 300 * MB, async () => null)).toBeNull();
  });

  it("предел длительности на экране совпадает с сервером", async () => {
    const { CLIP_VIDEO_MAX_DURATION_SEC } = await import("../upload/videoMeta");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const server = fs.readFileSync(path.join(here, "../../../../api/src/lib/propertyClipVideo.ts"), "utf8");
    const m = /MAX_CLIP_VIDEO_DURATION_SEC\s*=\s*(\d+)/.exec(server);
    expect(Number(m?.[1])).toBe(CLIP_VIDEO_MAX_DURATION_SEC);
  });
});

// ─────────────── находка 2: склад очереди карточки v2 и перенос v1 → v2 ───────────────

describe("находка 2: очередь карточки — файл кладётся один раз, статусы его не перекладывают", () => {
  let fake: FakeIdb;
  beforeEach(() => {
    fake = createFakeIndexedDb();
    vi.stubGlobal("indexedDB", fake.indexedDB);
    vi.stubGlobal("navigator", { onLine: false }); // очередь не шлёт — проверяем только склад
  });

  it("постановка: файл — в `blobs` один раз; повторы статуса — только метаданные", async () => {
    const q = await import("../uploadQueue");
    await q.enqueueVideos("p1", [new File([new Uint8Array(8)], "big.mov", { type: "video/quicktime" })]);
    const [id] = [...fake.dump("royal-home-uploads", "tasks").keys()];
    for (let i = 0; i < 3; i++) await q.retryTask(String(id));
    expect(fake.putCount.get("blobs")).toBe(1);
    const meta = fake.dump("royal-home-uploads", "tasks").get(id) as Record<string, unknown>;
    expect(meta.files).toBeUndefined();
    expect(meta.fileCount).toBe(1);
  });

  it("задание версии 1 (файлы внутри записи) переезжает без потери и читается дальше", async () => {
    const legacy = {
      id: "old-1",
      kind: "video",
      propertyId: "p1",
      label: "old.mov",
      files: [new Blob(["legacy-bytes"])],
      filenames: ["old.mov"],
      uploadKeys: ["k-old"],
      totalBytes: 12,
      status: "pending",
      attempts: 2,
      error: null,
      createdAt: 1,
    };
    fake.seed("royal-home-uploads", 1, { tasks: { keyPath: "id", rows: [["old-1", legacy]] } });
    const q = await import("../uploadQueue");
    expect(await q.migrateLegacyUploadTasks()).toBe(1);
    expect(await q.migrateLegacyUploadTasks()).toBe(0); // повторный запуск ничего не трогает
    const meta = fake.dump("royal-home-uploads", "tasks").get("old-1") as Record<string, unknown>;
    expect(meta.files).toBeUndefined();
    expect(meta.attempts).toBe(2); // незавершённое задание цело
    const blob = fake.dump("royal-home-uploads", "blobs").get("old-1:0") as Blob;
    expect(await blob.text()).toBe("legacy-bytes");
    // И очередь его видит.
    await q.retryTask("old-1");
    expect((fake.dump("royal-home-uploads", "tasks").get("old-1") as { attempts: number }).attempts).toBe(0);
  });

  it("перенос не влез (квота) — задание остаётся версии 1 и не теряется", async () => {
    const legacy = { id: "old-2", kind: "video", propertyId: "p1", label: "x", files: [new Blob(["b"])], filenames: ["x"], uploadKeys: ["k"], totalBytes: 1, status: "pending", attempts: 0, error: null, createdAt: 1 };
    fake.seed("royal-home-uploads", 1, { tasks: { keyPath: "id", rows: [["old-2", legacy]] } });
    fake.failPut = (store) => store === "blobs";
    const q = await import("../uploadQueue");
    expect(await q.migrateLegacyUploadTasks()).toBe(0);
    const row = fake.dump("royal-home-uploads", "tasks").get("old-2") as { files?: Blob[] };
    expect(row.files).toHaveLength(1);
  });
});
