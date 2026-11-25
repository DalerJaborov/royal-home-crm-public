import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * ПОРЯДОК СБОРКИ (lib/uploadCompletion.ts) И СТОРОЖА ОДНОЙ ДВЕРИ ДЛЯ ЧАСТЕЙ (25.11.2026, волна B).
 *
 * Порядок сборки один на три вида загрузки частями: части убираются только после того, как
 * результат закреплён; повтор «собрать» отдаёт тот же итог (а не 404 и не второй пост);
 * асинхронный режим отвечает 202 сразу. База не нужна — db.js подменён.
 */
vi.mock("../src/db.js", () => ({ prisma: { $disconnect: async () => {} } }));
const pushSpy = vi.hoisted(() => vi.fn(async (_agentId: string, _payload: { tag?: string }) => 1));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: pushSpy,
}));
const logged: string[] = [];
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: async (_source: string, message: string) => {
    logged.push(message);
  },
}));

const storage = await import("../src/lib/localVideoStorage.js");
const { runUploadCompletion, readUploadState } = await import("../src/lib/uploadCompletion.js");
const { UploadError } = await import("../src/lib/uploadErrors.js");
const http = await import("../src/lib/uploadHttp.js");
const timeouts = await import("../src/lib/httpServerTimeouts.js");

const created: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of created.splice(0)) await storage.abortLocalUploadSession(id);
});

async function sessionWithParts(n = 3): Promise<string> {
  const id = randomUUID();
  await storage.createLocalUploadSession(id);
  created.push(id);
  for (let i = 1; i <= n; i++) await storage.writeLocalUploadPart(id, i, Buffer.alloc(10, i));
  return id;
}

function fakeReq(headers: Record<string, string> = {}) {
  return {
    get: (name: string) => headers[name.toLowerCase()],
    query: {},
  } as unknown as Parameters<typeof runUploadCompletion>[0]["req"];
}

function fakeRes() {
  const out = { statusCode: 0, body: undefined as unknown, headers: {} as Record<string, string>, headersSent: false };
  const res = {
    get headersSent() {
      return out.headersSent;
    },
    setHeader: (k: string, v: string) => {
      out.headers[k] = v;
    },
    status(code: number) {
      out.statusCode = code;
      return res;
    },
    json(b: unknown) {
      out.body = b;
      out.headersSent = true;
      return res;
    },
  };
  return { res: res as unknown as Parameters<typeof runUploadCompletion>[0]["res"], out };
}

const owner = "agent:tester";

describe("сборка: части убираются только после закрепления результата (№2)", () => {
  it("успех — части убраны, итог помнится; повтор отдаёт тот же ответ, работа второй раз не идёт", async () => {
    const id = await sessionWithParts();
    const work = vi.fn(async () => ({ status: 201, body: { id: "video-1" } }));
    const first = fakeRes();
    await runUploadCompletion({ req: fakeReq(), res: first.res, sessionId: id, owner, what: "тест", work });
    expect(first.out).toMatchObject({ statusCode: 201, body: { id: "video-1" } });
    expect(await storage.listLocalUploadParts(id)).toEqual([]);

    const again = fakeRes();
    await runUploadCompletion({ req: fakeReq(), res: again.res, sessionId: id, owner, what: "тест", work });
    expect(again.out).toMatchObject({ statusCode: 201, body: { id: "video-1" } });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("закрепление упало (запись в базу) — части на месте, замок снят, повтор доводит дело", async () => {
    const id = await sessionWithParts();
    const failing = vi.fn(async () => {
      throw new Error("база недоступна");
    });
    await expect(runUploadCompletion({ req: fakeReq(), res: fakeRes().res, sessionId: id, owner, what: "тест", work: failing })).rejects.toThrow(
      "база недоступна"
    );
    expect(await storage.listLocalUploadParts(id)).toEqual([1, 2, 3]);
    expect(fs.existsSync(path.join(storage.localUploadSessionDir(id)!, "assemble.lock"))).toBe(false);
    expect((await readUploadState(id, owner))?.state).toBe("failed");

    const retry = fakeRes();
    await runUploadCompletion({ req: fakeReq(), res: retry.res, sessionId: id, owner, what: "тест", work: async () => ({ status: 201, body: { ok: 1 } }) });
    expect(retry.out.statusCode).toBe(201);
  });

  it("отказ по содержимому (не видео) — части убраны, повтор получает тот же 422, а не «дошлите части»", async () => {
    const id = await sessionWithParts();
    const work = vi.fn(async () => ({ status: 422, body: { error: "не видео", code: "NOT_VIDEO" }, finalize: true }));
    const first = fakeRes();
    await runUploadCompletion({ req: fakeReq(), res: first.res, sessionId: id, owner, what: "тест", work });
    expect(first.out.statusCode).toBe(422);
    expect(await storage.listLocalUploadParts(id)).toEqual([]);
    const again = fakeRes();
    await runUploadCompletion({ req: fakeReq(), res: again.res, sessionId: id, owner, what: "тест", work });
    expect(again.out).toMatchObject({ statusCode: 422, body: { code: "NOT_VIDEO" } });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("отказ с кодом (не все части) — 409 с кодом и списком, части на месте", async () => {
    const id = await sessionWithParts();
    const out = fakeRes();
    await runUploadCompletion({
      req: fakeReq(),
      res: out.res,
      sessionId: id,
      owner,
      what: "тест",
      work: async () => {
        throw new UploadError("PARTS_MISSING", { extra: { uploadedPartNumbers: [1, 2, 3] } });
      },
    });
    expect(out.out.statusCode).toBe(409);
    expect(out.out.body).toMatchObject({ code: "PARTS_MISSING", retryable: true, uploadedPartNumbers: [1, 2, 3] });
    expect(await storage.listLocalUploadParts(id)).toEqual([1, 2, 3]);
  });

  it("нехватка места при сборке — 507 DISK_FULL и тревога в журнал", async () => {
    const id = await sessionWithParts();
    logged.length = 0;
    const out = fakeRes();
    await runUploadCompletion({
      req: fakeReq(),
      res: out.res,
      sessionId: id,
      owner,
      what: "тест",
      work: async () => {
        throw new UploadError("DISK_FULL");
      },
    });
    expect(out.out.statusCode).toBe(507);
    expect(out.out.body).toMatchObject({ code: "DISK_FULL", retryable: false });
    expect(logged.some((m) => m.includes("не хватает места"))).toBe(true);
  });
});

describe("асинхронная сборка и чужой итог (№3)", () => {
  it("X-Upload-Async: 1 — 202 сразу, итог в состоянии; повтор отдаёт 200 с итогом", async () => {
    const id = await sessionWithParts();
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const out = fakeRes();
    await runUploadCompletion({
      req: fakeReq({ "x-upload-async": "1" }),
      res: out.res,
      sessionId: id,
      owner,
      what: "тест",
      work: async (setPhase) => {
        setPhase("processing");
        await gate;
        return { status: 201, body: { id: "post-1" } };
      },
    });
    expect(out.out).toMatchObject({ statusCode: 202, body: { sessionId: id, state: "assembling" } });
    await vi.waitFor(async () => expect((await readUploadState(id, owner))?.state).toBe("processing"), { timeout: 15_000 });
    finish();
    await vi.waitFor(async () => expect((await readUploadState(id, owner))?.state).toBe("done"), { timeout: 15_000 });
    const again = fakeRes();
    await runUploadCompletion({ req: fakeReq({ "x-upload-async": "1" }), res: again.res, sessionId: id, owner, what: "тест", work: vi.fn() });
    expect(again.out).toMatchObject({ statusCode: 200, body: { state: "done", result: { status: 201, body: { id: "post-1" } } } });
  });

  it("итог чужой сессии не отдаётся", async () => {
    const id = await sessionWithParts();
    await runUploadCompletion({ req: fakeReq(), res: fakeRes().res, sessionId: id, owner, what: "тест", work: async () => ({ status: 201, body: {} }) });
    expect(await readUploadState(id, "agent:someone-else")).toBeNull();
  });

  it("«собирается» без пульса дольше предела — отдаётся как сбой с повтором, а не вечное ожидание", async () => {
    const id = await sessionWithParts();
    const old = new Date(Date.now() - storage.ASSEMBLY_LOCK_STALE_MS - 10_000).toISOString();
    await storage.writeLocalUploadSessionState(id, { state: "assembling", owner, updatedAt: old });
    const s = await readUploadState(id, owner);
    expect(s?.state).toBe("failed");
    expect(s?.error).toMatchObject({ retryable: true });
  });

  it("сборка уже идёт (замок держит другой запрос) — 409 ASSEMBLING со списком частей, вторая склейка не начинается", async () => {
    const id = await sessionWithParts();
    const lock = await storage.lockLocalUploadAssembly(id);
    const work = vi.fn();
    const out = fakeRes();
    await runUploadCompletion({ req: fakeReq(), res: out.res, sessionId: id, owner, what: "тест", work });
    await lock!.release();
    expect(out.out.statusCode).toBe(409);
    expect(out.out.body).toMatchObject({ code: "ASSEMBLING", uploadedPartNumbers: [1, 2, 3] });
    expect(work).not.toHaveBeenCalled();
  });
});

describe("сторожа одной двери: часть пишется только через слой хранения (№4, №9)", () => {
  const srcRoot = path.resolve(__dirname, "../src");
  function sources(): Array<{ file: string; text: string }> {
    const out: Array<{ file: string; text: string }> = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (name === "generated") continue;
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".ts")) out.push({ file: path.relative(srcRoot, full).replace(/\\/g, "/"), text: fs.readFileSync(full, "utf8") });
      }
    };
    walk(srcRoot);
    return out;
  }

  it("имя файла части (part-N) собирает только lib/localVideoStorage.ts", () => {
    const offenders = sources()
      .filter((s) => s.file !== "lib/localVideoStorage.ts")
      .filter((s) => /["'`]part-(?:\$\{|\d|["'`])/.test(s.text))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it("каждый маршрут части (…/parts/:partNumber) берёт тело через partBodySource, без express.raw", () => {
    const routes = sources().filter((s) => /["'`][^"'`]*\/parts\/:partNumber["'`]/.test(s.text));
    expect(routes.map((r) => r.file).sort()).toEqual(
      ["routes/properties/drafts.ts", "routes/properties/videos.ts", "routes/socialVideos.ts", "routes/uploadSessions.ts"].sort()
    );
    for (const r of routes) {
      expect(r.text, r.file).toMatch(/partBodySource\(req\)/);
      expect(r.text, r.file).not.toMatch(/express\.raw\(/);
    }
  });

  it("парсер сырого тела, если появится, — только с пределом из общего числа, не строкой", () => {
    const offenders = sources()
      .filter((s) => /(?:express|bodyParser)\.raw\(\s*\{[^}]*limit:\s*["'`\d]/.test(s.text))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it("адреса частей всех трёх видов — под своим потолком частоты, остальное — под общим", () => {
    const yes = [
      "/api/v1/upload-sessions/abc/parts/3",
      "/api/v1/social-videos/upload-sessions/abc/parts/1",
      "/api/v1/properties/p1/videos/upload-sessions/s1/parts/12",
      "/api/v1/properties/drafts/current/videos/m1/parts/2?x=1",
    ];
    for (const url of yes) expect(http.isUploadPartRequest({ method: "PUT", originalUrl: url }), url).toBe(true);
    expect(http.isUploadPartRequest({ method: "POST", originalUrl: yes[0]! })).toBe(false);
    expect(http.isUploadPartRequest({ method: "PUT", originalUrl: "/api/v1/properties/p1" })).toBe(false);
    expect(http.isUploadPartRequest({ method: "PUT", originalUrl: "/api/v1/upload-sessions/abc/parts/3/../../x" })).toBe(false);
  });

  it("заявленный Content-Length больше предела части — отказ до чтения тела", async () => {
    const { UPLOAD_PART_MAX_BYTES } = await import("@royal-home/shared");
    expect(() => http.partBodySource({ body: undefined, headers: { "content-length": String(UPLOAD_PART_MAX_BYTES + 1) } } as never)).toThrow(UploadError);
  });
});

describe("таймауты сервера и сводка частей (№7, №13)", () => {
  it("тело части успевает на 300 Кбит/с; keep-alive дольше прокси; заголовки — дольше keep-alive", async () => {
    const server = { requestTimeout: 0, headersTimeout: 0, keepAliveTimeout: 0 };
    timeouts.applyHttpServerTimeouts(server);
    const { UPLOAD_PART_MAX_BYTES } = await import("@royal-home/shared");
    expect(server.requestTimeout).toBeGreaterThanOrEqual(15 * 60_000);
    expect(server.requestTimeout).toBeGreaterThan(((UPLOAD_PART_MAX_BYTES * 8) / 300_000) * 1000);
    expect(server.keepAliveTimeout).toBeGreaterThan(60_000);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    expect(server.headersTimeout).toBeLessThanOrEqual(120_000);
    const index = fs.readFileSync(path.resolve(__dirname, "../src/index.ts"), "utf8");
    expect(index).toMatch(/applyHttpServerTimeouts\(server\)/);
  });

  it("доля неудачных частей за сутки > 5 % — тревога; меньше — тишина; счётчики обнуляются", () => {
    http.flushUploadPartStats();
    const req = { headers: {}, ip: "1.2.3.4" } as never;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 90; i++) http.logUploadPart(req, { kind: "t", sessionId: "s", partNumber: i, startedAt: Date.now() });
    for (let i = 0; i < 10; i++) http.logUploadPart(req, { kind: "t", sessionId: "s", partNumber: i, startedAt: Date.now(), code: "PART_INCOMPLETE" });
    expect(warn).toHaveBeenCalledTimes(10);
    logged.length = 0;
    expect(http.flushUploadPartStats()).toMatchObject({ ok: 90, failed: 10, alarmed: true });
    expect(logged.some((m) => m.includes("PART_INCOMPLETE×10"))).toBe(true);

    for (let i = 0; i < 99; i++) http.logUploadPart(req, { kind: "t", sessionId: "s", partNumber: i, startedAt: Date.now() });
    http.logUploadPart(req, { kind: "t", sessionId: "s", partNumber: 1, startedAt: Date.now(), code: "PART_INCOMPLETE" });
    expect(http.flushUploadPartStats()).toMatchObject({ ok: 99, failed: 1, alarmed: false });
  });
});

describe("ревью волны B: гонки, повтор после выката, пуш (26.11.2026)", () => {
  it("гонка «готово → второй complete»: итог появился между первым чтением и замком — работа второй раз не идёт", async () => {
    const id = await sessionWithParts();
    // Первая сборка закончилась ровно в момент, когда второй запрос брал замок.
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementation(async (p, flags, mode) => {
      if (String(p).endsWith("assemble.lock")) {
        await storage.writeLocalUploadSessionState(id, {
          state: "done",
          owner,
          updatedAt: new Date().toISOString(),
          result: { status: 201, body: { id: "first" } },
        });
      }
      return realOpen(p, flags, mode);
    });
    const work = vi.fn(async () => ({ status: 201, body: { id: "second" } }));
    const out = fakeRes();
    await runUploadCompletion({ req: fakeReq(), res: out.res, sessionId: id, owner, what: "тест", work });
    expect(out.out).toMatchObject({ statusCode: 201, body: { id: "first" } });
    expect(work).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(storage.localUploadSessionDir(id)!, "assemble.lock"))).toBe(false);
  });

  it("итог закрепили — замок снимает только тот, кто его держал (finish его не трогает)", async () => {
    const id = await sessionWithParts();
    const lock = await storage.lockLocalUploadAssembly(id);
    await storage.finishLocalUploadSession(id, { state: "done", owner, updatedAt: new Date().toISOString() });
    expect(await storage.lockLocalUploadAssembly(id)).toBeNull();
    await lock!.release();
    const next = await storage.lockLocalUploadAssembly(id);
    expect(next).not.toBeNull();
    await next!.release();
  });

  it("прошлую попытку оборвал перезапуск посреди обработки — работа узнаёт об этом (защита от второго поста)", async () => {
    const id = await sessionWithParts();
    const old = new Date(Date.now() - storage.ASSEMBLY_LOCK_STALE_MS - 10_000).toISOString();
    await storage.writeLocalUploadSessionState(id, { state: "processing", owner, updatedAt: old, processingStartedAt: old });
    const seen: boolean[] = [];
    await runUploadCompletion({
      req: fakeReq(),
      res: fakeRes().res,
      sessionId: id,
      owner,
      what: "тест",
      work: async (_set, ctx) => {
        seen.push(ctx.interruptedInProcessing);
        return { status: 409, body: { error: "проверьте переписку" }, finalize: true };
      },
    });
    expect(seen).toEqual([true]);
    // Оборванная в сборке (до обработки) попытка — повторять можно.
    const id2 = await sessionWithParts();
    await storage.writeLocalUploadSessionState(id2, { state: "assembling", owner, updatedAt: old });
    await runUploadCompletion({
      req: fakeReq(),
      res: fakeRes().res,
      sessionId: id2,
      owner,
      what: "тест",
      work: async (_set, ctx) => {
        seen.push(ctx.interruptedInProcessing);
        return { status: 201, body: {} };
      },
    });
    expect(seen).toEqual([true, false]);
  });

  it("часть в собранную или собираемую сессию общего ядра не пишется", async () => {
    const core = await import("../src/lib/chunkedUploadSessions.js");
    const agentId = `agent-${randomUUID()}`;
    const s = await core.startChunkedUpload({ kind: "clip-video", agentId, filename: "a.mp4", sizeBytes: 10, maxBytes: 100, tooLargeMessage: "x" });
    created.push(s.sessionId);
    const coreOwner = core.chunkedUploadOwner(agentId);
    const part = () => core.writeChunkedUploadPart({ kind: "clip-video", sessionId: s.sessionId, agentId, partNumber: 1, body: Buffer.alloc(10) });
    await storage.writeLocalUploadSessionState(s.sessionId, { state: "assembling", owner: coreOwner, updatedAt: new Date().toISOString() });
    await expect(part()).rejects.toMatchObject({ code: "ASSEMBLING" });
    await storage.writeLocalUploadSessionState(s.sessionId, { state: "done", owner: coreOwner, updatedAt: new Date().toISOString() });
    await expect(part()).rejects.toMatchObject({ code: "ALREADY_ASSEMBLED" });
    expect(await storage.listLocalUploadParts(s.sessionId)).toEqual([]);
  });

  it("пуш «загрузка отменена» — только для файлов от 50 МБ", async () => {
    pushSpy.mockClear();
    const cleanup = await import("../src/lib/videoUploadCleanup.js");
    const meta = { kind: "conversation-media", agentId: "a1", filename: "photo.jpg", contentType: null, partSize: 1, totalParts: 1, createdAt: "" };
    await cleanup.notifyAbandonedChunkedUpload({ id: "s1", meta: { ...meta, sizeBytes: 3 * 1024 * 1024 } });
    await cleanup.notifyAbandonedChunkedUpload({ id: "s2", meta: { ...meta, sizeBytes: cleanup.ABANDONED_UPLOAD_PUSH_MIN_BYTES } });
    expect(pushSpy.mock.calls.map((c) => c[1].tag)).toEqual(["chunked-upload-cancelled-s2"]);
  });

  it("свой потолок частоты — только для частей с действующим токеном", () => {
    const app = fs.readFileSync(path.resolve(__dirname, "../src/app.ts"), "utf8");
    expect(app).toMatch(/skip: \(req\) => !isAuthedUploadPart\(req\)/);
    expect(app).toMatch(/if \(isAuthedUploadPart\(req\)\) return true;/);
    expect(app).not.toMatch(/if \(isUploadPartRequest\(req\)\) return true;/);
  });
});
