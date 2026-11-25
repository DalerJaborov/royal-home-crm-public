import { EventEmitter } from "node:events";
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import type { Request, Response } from "express";
import { PROXY_SINGLE_REQUEST_MAX_BYTES, REQUEST_TOO_LARGE_CODE, CHUNKED_UPLOAD_PURPOSES } from "@royal-home/shared";

vi.setConfig({ testTimeout: 60_000 });

/**
 * КЛАСС «БОЛЬШОЙ ФАЙЛ ОДНИМ ЗАПРОСОМ → 413 ОТ ПРОКСИ» (17.11.2026, ролик 87 МБ).
 *
 * Cloudflare и прокси перед API режут тело больше ~100 МБ, а на стенде их нет — поэтому
 * здесь проверяется то, что от прокси не зависит:
 *  - дверь приёма (upload.ts::guardedUpload) отказывает по заявленному весу 413 с понятным
 *    текстом и машинным кодом, и ни одна дверь процесса не обещает больше потолка без причины;
 *  - ролик карточки объекта и файл в переписку идут ЧАСТЯМИ через общие сессии
 *    (routes/uploadSessions.ts) и на сборке делают то же, что одиночный маршрут;
 *  - чужая сессия, чужое назначение и лишний вес не проходят.
 */

type FakeSpawnBehavior = { stdout?: string; exitCode: number };
let nextProbeBehavior: FakeSpawnBehavior = { stdout: "5.0", exitCode: 0 };

// ffmpeg/ffprobe на стенде нет — длительность ролика отдаёт подмена (как в property-clip-video-upload.test.ts).
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setImmediate(() => {
      if (nextProbeBehavior.stdout !== undefined) proc.stdout.emit("data", Buffer.from(nextProbeBehavior.stdout));
      proc.emit("close", nextProbeBehavior.exitCode);
    });
    return proc;
  }),
}));

/** Доставка клиенту — внешний мир (Meta/Telegram): подменяем, но запоминаем, что пришло. */
const delivered: Array<{ size: number; mimetype: string; originalname: string; bytes: Buffer; caption?: string }> = [];
vi.mock("../src/lib/conversationDelivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/conversationDelivery.js")>()),
  deliverMediaToConversation: vi.fn(
    async (_target: unknown, file: { path: string; size: number; mimetype: string; originalname: string }, opts: { caption?: string }) => {
      delivered.push({ ...file, bytes: fs.readFileSync(file.path), caption: opts.caption });
      return { ok: true, pausedUntil: new Date().toISOString() };
    }
  ),
  // Очередь отправки (рубильник ВКЛ) проверяет канал и окно до приёма — здесь канала нет, пропускаем.
  mediaDeliveryPrecheck: vi.fn(async () => ({ ok: true, capturedTransport: null, metaChannel: "INSTAGRAM" })),
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { requestCapGuard, uploadDoors } = await import("../src/upload.js");

const runId = `${Date.now()}`.slice(-7);
const password = "testpass123";
let districtId: string;
let agentToken: string;
let otherToken: string;
let adminToken: string;
const agentIds: string[] = [];
const propertyIds: string[] = [];
const conversationIds: string[] = [];

async function makeAgent(suffix: string, role: "AGENT" | "ADMIN") {
  const phone = `+99297${suffix}${runId}`;
  const agent = await prisma.agent.create({
    data: { fullName: `Агент загрузки частями ${suffix}`, phone, role, passwordHash: await bcrypt.hash(password, 10) },
  });
  agentIds.push(agent.id);
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return { id: agent.id, token: res.body.accessToken as string };
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район загрузки частями ${runId}` } })).id;
  const agent = await makeAgent("31", "AGENT");
  agentToken = agent.token;
  otherToken = (await makeAgent("32", "AGENT")).token;
  adminToken = (await makeAgent("33", "ADMIN")).token;
  const p = await prisma.property.create({
    data: {
      title: `Объект загрузки частями ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "EDITING",
      intakeAgentId: agent.id,
      createdById: agent.id,
      assignedAgentId: agent.id,
    },
  });
  propertyIds.push(p.id);
  const conv = await prisma.botConversation.create({
    data: { channel: "INSTAGRAM", subscriberId: `chunked-media-${runId}`, messages: [] as object[] },
  });
  conversationIds.push(conv.id);
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { type: "clip-compress", payload: { path: ["propertyId"], equals: propertyIds[0] } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

const auth = (r: request.Test, token: string) => r.set("Authorization", `Bearer ${token}`);

async function startSession(token: string, body: Record<string, unknown>) {
  return auth(request(app).post("/api/v1/upload-sessions"), token).send(body);
}

/** Старт → все части по плану сервера. Возвращает id сессии. */
async function uploadParts(token: string, purpose: string, file: Buffer, filename: string, contentType: string) {
  const start = await startSession(token, { purpose, filename, sizeBytes: file.length, contentType });
  expect(start.status).toBe(201);
  const { sessionId, partSize, totalParts } = start.body as { sessionId: string; partSize: number; totalParts: number };
  for (let n = 1; n <= totalParts; n++) {
    const part = file.subarray((n - 1) * partSize, n * partSize);
    const res = await auth(request(app).put(`/api/v1/upload-sessions/${sessionId}/parts/${n}`), token)
      .set("Content-Type", "application/octet-stream")
      .send(part);
    expect(res.status).toBe(200);
  }
  return sessionId;
}

describe("дверь одиночного приёма (upload.ts::guardedUpload)", () => {
  function fakeRes() {
    const res = { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string> };
    return Object.assign(res, {
      setHeader: (k: string, v: string) => {
        res.headers[k] = v;
      },
      status(code: number) {
        res.statusCode = code;
        return this;
      },
      json(b: unknown) {
        res.body = b;
        return this;
      },
    });
  }

  it("запрос тяжелее предела — 413 с понятным текстом и кодом, до разбора тела", () => {
    const res = fakeRes();
    const next = vi.fn();
    const req = { headers: { "content-length": String(PROXY_SINGLE_REQUEST_MAX_BYTES + 1) } } as unknown as Request;
    requestCapGuard(PROXY_SINGLE_REQUEST_MAX_BYTES)(req, res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(413);
    expect(res.body).toMatchObject({ code: REQUEST_TOO_LARGE_CODE });
    expect((res.body as { error: string }).error).toMatch(/90 МБ.*Сожмите файл или разделите/);
  });

  it("ровно предел и запрос без заявленного веса — пропускаются дальше", () => {
    for (const headers of [{ "content-length": String(PROXY_SINGLE_REQUEST_MAX_BYTES) }, {}]) {
      const next = vi.fn();
      requestCapGuard(PROXY_SINGLE_REQUEST_MAX_BYTES)({ headers } as unknown as Request, fakeRes() as unknown as Response, next);
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it("ни одна дверь процесса не обещает больше потолка прокси без причины", () => {
    // app.js импортирован выше — все маршруты и их двери уже созданы.
    expect(uploadDoors.length).toBeGreaterThanOrEqual(16);
    const over = uploadDoors.filter((d) => d.maxRequestBytes > PROXY_SINGLE_REQUEST_MAX_BYTES && !d.overProxyCeilingReason);
    expect(over).toEqual([]);
  });

  it("одиночный приём ролика карточки тоже отказывает 413 по весу, а не молча принимает", async () => {
    const res = await auth(request(app).post(`/api/v1/properties/${propertyIds[0]}/clip-video`), agentToken)
      .set("Content-Length", String(PROXY_SINGLE_REQUEST_MAX_BYTES + 1))
      .set("Content-Type", "multipart/form-data; boundary=x")
      .send("x")
      .catch((err: { response?: request.Response }) => err.response);
    // Сервер отвечает по заявленному весу, не дочитывая тело.
    expect(res?.status).toBe(413);
  });
});

describe("общие сессии загрузки частями", () => {
  it("неизвестное назначение, не тот тип и вес выше предела — отказ на старте", async () => {
    expect((await startSession(agentToken, { purpose: "anything", filename: "a.mp4", sizeBytes: 10, contentType: "video/mp4" })).status).toBe(400);
    const wrongType = await startSession(agentToken, { purpose: "clip-video", filename: "a.jpg", sizeBytes: 10, contentType: "image/jpeg" });
    expect(wrongType.status).toBe(400);
    const tooBig = await startSession(agentToken, {
      purpose: "clip-video",
      filename: "big.mp4",
      sizeBytes: CHUNKED_UPLOAD_PURPOSES["clip-video"].maxBytes + 1,
      contentType: "video/mp4",
    });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error).toMatch(/300 МБ/);
  });

  it("чужую сессию не дописать и не собрать", async () => {
    const start = await startSession(agentToken, { purpose: "clip-video", filename: "a.mp4", sizeBytes: 4, contentType: "video/mp4" });
    const { sessionId } = start.body as { sessionId: string };
    const part = await auth(request(app).put(`/api/v1/upload-sessions/${sessionId}/parts/1`), otherToken)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("abcd"));
    expect(part.status).toBe(404);
  });

  it("неполная сессия не собирается (409), часть не по плану — 400", async () => {
    const big = Buffer.alloc(9 * 1024 * 1024, 7);
    const start = await startSession(agentToken, { purpose: "clip-video", filename: "a.mp4", sizeBytes: big.length, contentType: "video/mp4" });
    const { sessionId } = start.body as { sessionId: string };
    const wrongSize = await auth(request(app).put(`/api/v1/upload-sessions/${sessionId}/parts/1`), agentToken)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("short"));
    expect(wrongSize.status).toBe(400);
    const complete = await auth(
      request(app).post(`/api/v1/properties/${propertyIds[0]}/clip-video/upload-sessions/${sessionId}/complete`),
      agentToken
    ).send({});
    expect(complete.status).toBe(409);
  });
});

describe("ролик карточки объекта частями (POST …/clip-video/upload-sessions/:id/complete)", () => {
  it("две части склеиваются, длительность проверяется, ставится сжатие — 202 как у одиночного приёма", async () => {
    nextProbeBehavior = { stdout: "12.0", exitCode: 0 };
    const file = Buffer.concat([Buffer.alloc(8 * 1024 * 1024, 1), Buffer.from("хвост ролика")]);
    const sessionId = await uploadParts(agentToken, "clip-video", file, "tour.mp4", "video/mp4");
    const res = await auth(
      request(app).post(`/api/v1/properties/${propertyIds[0]}/clip-video/upload-sessions/${sessionId}/complete`),
      agentToken
    ).send({});
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ clipVideoStatus: "PROCESSING" });
    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyIds[0] } });
    expect(property.clipVideoStatus).toBe("PROCESSING");
    expect(property.clipVideoPendingInput).toMatch(/^incoming-/);
  });

  it("сессию для переписки нельзя собрать как ролик карточки", async () => {
    const sessionId = await uploadParts(agentToken, "conversation-media", Buffer.from("кадр"), "a.mp4", "video/mp4");
    const res = await auth(
      request(app).post(`/api/v1/properties/${propertyIds[0]}/clip-video/upload-sessions/${sessionId}/complete`),
      agentToken
    ).send({});
    expect(res.status).toBe(404);
  });

  it("чужой объект — 403 до склейки", async () => {
    const sessionId = await uploadParts(otherToken, "clip-video", Buffer.from("abcd"), "a.mp4", "video/mp4");
    const res = await auth(
      request(app).post(`/api/v1/properties/${propertyIds[0]}/clip-video/upload-sessions/${sessionId}/complete`),
      otherToken
    ).send({});
    expect(res.status).toBe(403);
  });
});

describe("фото/видео в переписку частями (POST …/reply-media/upload-sessions/complete)", () => {
  // Прежний путь — синхронная доставка без сжатия — живёт за рубильником «Фото и видео клиенту —
  // как в WhatsApp» (выключен). Путь очереди (ВКЛ) — в отдельном блоке ниже и в outgoing-media-jobs.test.ts.
  beforeAll(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { outgoingMediaCompressEnabled: false } });
  });
  afterAll(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { outgoingMediaCompressEnabled: true } });
  });

  it("файл склеивается без потерь и уходит в ту же доставку с подписью; временный файл убран", async () => {
    delivered.length = 0;
    const file = Buffer.concat([Buffer.alloc(8 * 1024 * 1024, 3), Buffer.from("конец ролика")]);
    const sessionId = await uploadParts(adminToken, "conversation-media", file, "tour.mp4", "video/mp4");
    const res = await auth(request(app).post(`/api/v1/conversations/${conversationIds[0]}/reply-media/upload-sessions/complete`), adminToken).send({
      sessionId,
      caption: "Обход квартиры",
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ size: file.length, mimetype: "video/mp4", originalname: "tour.mp4", caption: "Обход квартиры" });
    expect(delivered[0]!.bytes.equals(file)).toBe(true);
  });

  it("повтор с тем же ключом после новой загрузки отдаёт первый ответ, а не шлёт клиенту дубль", async () => {
    delivered.length = 0;
    const key = `media-retry-${runId}`;
    const send = async () => {
      const sessionId = await uploadParts(adminToken, "conversation-media", Buffer.from("фото"), "a.jpg", "image/jpeg");
      return auth(request(app).post(`/api/v1/conversations/${conversationIds[0]}/reply-media/upload-sessions/complete`), adminToken)
        .set("Idempotency-Key", key)
        .send({ sessionId });
    };
    expect((await send()).status).toBe(200);
    const again = await send();
    expect(again.status).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(delivered).toHaveLength(1);
  });

  it("без id сессии — 400; чужая сессия — 404", async () => {
    const noSession = await auth(request(app).post(`/api/v1/conversations/${conversationIds[0]}/reply-media/upload-sessions/complete`), adminToken).send({});
    expect(noSession.status).toBe(400);
    const foreign = await uploadParts(agentToken, "conversation-media", Buffer.from("фото"), "a.jpg", "image/jpeg");
    const res = await auth(request(app).post(`/api/v1/conversations/${conversationIds[0]}/reply-media/upload-sessions/complete`), adminToken).send({
      sessionId: foreign,
    });
    expect(res.status).toBe(404);
  });
});

describe("рубильник ВКЛ: файл в очередь сжатия, ответ 202 сразу (25.11.2026)", () => {
  afterAll(async () => {
    await prisma.backgroundJob.deleteMany({ where: { type: "outgoing-media-send" } });
    await prisma.outgoingMediaJob.deleteMany({ where: { conversationId: { in: conversationIds } } });
  });

  it("сборка частей → 202 и номер задания; состояние видно; отмена до начала работает; доставка внутри запроса не зовётся", async () => {
    delivered.length = 0;
    const key = `media-queue-${runId}`;
    const send = async () => {
      const sessionId = await uploadParts(adminToken, "conversation-media", Buffer.alloc(1024, 7), "IMG_0001.MOV", "video/quicktime");
      return auth(request(app).post(`/api/v1/conversations/${conversationIds[0]}/reply-media/upload-sessions/complete`), adminToken)
        .set("Idempotency-Key", key)
        .send({ sessionId, caption: "Обход" });
    };
    const res = await send();
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, queued: true, status: "QUEUED" });
    const jobId = res.body.jobId as string;
    expect(delivered).toHaveLength(0);
    // «Повторить» с тем же ключом не ставит второе задание.
    const again = await send();
    expect(again.status).toBe(202);
    expect(again.body.jobId).toBe(jobId);
    expect(await prisma.outgoingMediaJob.count({ where: { conversationId: conversationIds[0] } })).toBe(1);

    const job = await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ mimeType: "video/quicktime", originalName: "IMG_0001.MOV", caption: "Обход", sizeBytes: 1024 });
    const status = await auth(request(app).get(`/api/v1/conversations/${conversationIds[0]}/media-jobs/${jobId}`), adminToken);
    expect(status.status).toBe(200);
    expect(status.body.status).toBe("QUEUED");
    // Чужому сотруднику задание не видно.
    expect((await auth(request(app).get(`/api/v1/conversations/${conversationIds[0]}/media-jobs/${jobId}`), agentToken)).status).toBe(404);
    const list = await auth(request(app).get(`/api/v1/conversations/${conversationIds[0]}/media-jobs`), adminToken);
    expect(list.body.jobs.map((j: { id: string }) => j.id)).toContain(jobId);

    const cancel = await auth(request(app).delete(`/api/v1/conversations/${conversationIds[0]}/media-jobs/${jobId}`), adminToken);
    expect(cancel.status).toBe(200);
    expect((await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("CANCELLED");
  });
});

describe("сессии частями: потолок, срок жизни, докачка, замок сборки (ревью #254)", () => {
  const core = () => import("../src/lib/chunkedUploadSessions.js");
  const storage = () => import("../src/lib/localVideoStorage.js");
  const start = (token: string, sizeBytes = 4) =>
    startSession(token, { purpose: "clip-video", filename: "a.mp4", sizeBytes, contentType: "video/mp4" }).then((r) => {
      expect(r.status).toBe(201);
      return r.body as { sessionId: string; partSize: number; totalParts: number };
    });
  const status = (token: string, sessionId: string) => auth(request(app).get(`/api/v1/upload-sessions/${sessionId}`), token);
  const putPart = (token: string, sessionId: string, n: number, body: Buffer) =>
    auth(request(app).put(`/api/v1/upload-sessions/${sessionId}/parts/${n}`), token).set("Content-Type", "application/octet-stream").send(body);

  it("у сотрудника не больше трёх открытых сессий: четвёртая вытесняет самую давно не двигавшуюся", async () => {
    const { MAX_SESSIONS_PER_AGENT } = await core();
    expect(MAX_SESSIONS_PER_AGENT).toBe(3);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push((await start(otherToken)).sessionId);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await status(otherToken, ids[0]!)).status).toBe(404);
    for (const id of ids.slice(1)) expect((await status(otherToken, id)).status).toBe(200);
  });

  it("докачка: статус называет принятые части; чужой статус — 404", async () => {
    const big = Buffer.alloc(9 * 1024 * 1024, 5);
    const { sessionId } = await start(agentToken, big.length);
    expect((await putPart(agentToken, sessionId, 1, big.subarray(0, 8 * 1024 * 1024))).status).toBe(200);
    const res = await status(agentToken, sessionId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sessionId, totalParts: 2, uploadedPartNumbers: [1], kind: "clip-video" });
    expect((await status(otherToken, sessionId)).status).toBe(404);
    // Сборка без второй части — 409 с машинным кодом и списком, по нему экран докачивает.
    const complete = await auth(request(app).post(`/api/v1/properties/${propertyIds[0]}/clip-video/upload-sessions/${sessionId}/complete`), agentToken).send({});
    expect(complete.status).toBe(409);
    expect(complete.body).toMatchObject({ code: "PARTS_MISSING", uploadedPartNumbers: [1] });
  });

  it("брошенная сессия (без новой части два часа) убирается уборкой; свежая — остаётся", async () => {
    const { sweepStaleChunkedUploads, SESSION_IDLE_TTL_MS } = await core();
    const { readLocalUploadSessionMeta, writeLocalUploadSessionMeta } = await storage();
    const stale = (await start(adminToken)).sessionId;
    const fresh = (await start(adminToken)).sessionId;
    const meta = (await readLocalUploadSessionMeta(stale)) as Record<string, unknown>;
    const old = new Date(Date.now() - SESSION_IDLE_TTL_MS - 60_000).toISOString();
    await writeLocalUploadSessionMeta(stale, { ...meta, createdAt: old, touchedAt: old });
    expect(await sweepStaleChunkedUploads()).toBeGreaterThanOrEqual(1);
    expect((await status(adminToken, stale)).status).toBe(404);
    expect((await status(adminToken, fresh)).status).toBe(200);
  });

  it("новая часть продлевает жизнь сессии", async () => {
    const { sweepStaleChunkedUploads, SESSION_IDLE_TTL_MS } = await core();
    const { readLocalUploadSessionMeta, writeLocalUploadSessionMeta } = await storage();
    const { sessionId } = await start(adminToken);
    const meta = (await readLocalUploadSessionMeta(sessionId)) as Record<string, unknown>;
    const old = new Date(Date.now() - SESSION_IDLE_TTL_MS - 60_000).toISOString();
    await writeLocalUploadSessionMeta(sessionId, { ...meta, createdAt: old, touchedAt: old });
    expect((await putPart(adminToken, sessionId, 1, Buffer.from("abcd"))).status).toBe(200);
    await sweepStaleChunkedUploads();
    expect((await status(adminToken, sessionId)).status).toBe(200);
  });

  it("уборка зарегистрирована в кроне через scheduleTracked", () => {
    const src = fs.readFileSync(new URL("../src/cron.ts", import.meta.url), "utf8");
    expect(src).toMatch(/scheduleTracked\(\s*"chunked-uploads-cleanup",\s*"17 \* \* \* \*"/);
    expect(src).toMatch(/sweepStaleChunkedUploads\(\)/);
  });

  it("вторая одновременная сборка — 409 «уже собирается», а не второй файл", async () => {
    const { localUploadSessionDir } = await storage();
    const sessionId = await uploadParts(agentToken, "clip-video", Buffer.from("abcd"), "a.mp4", "video/mp4");
    // Замок первой сборки: её процесс сейчас склеивает части.
    fs.writeFileSync(`${localUploadSessionDir(sessionId)}/assemble.lock`, "");
    const res = await auth(request(app).post(`/api/v1/properties/${propertyIds[0]}/clip-video/upload-sessions/${sessionId}/complete`), agentToken).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ASSEMBLING");
  });

  it("склейка упала — недосклеенный файл удалён, замок снят, части на месте", async () => {
    const { localUploadSessionDir } = await storage();
    const { videoTmpDir } = await import("../src/upload.js");
    const big = Buffer.alloc(9 * 1024 * 1024, 9);
    const { sessionId } = await start(agentToken, big.length);
    expect((await putPart(agentToken, sessionId, 1, big.subarray(0, 8 * 1024 * 1024))).status).toBe(200);
    // Вторая «часть» — папка: список частей полон, а прочитать её склейка не сможет.
    fs.mkdirSync(`${localUploadSessionDir(sessionId)}/part-2`);
    const before = new Set(fs.readdirSync(videoTmpDir));
    const res = await auth(request(app).post(`/api/v1/properties/${propertyIds[0]}/clip-video/upload-sessions/${sessionId}/complete`), agentToken).send({});
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(fs.readdirSync(videoTmpDir).filter((f) => !before.has(f))).toEqual([]);
    expect(fs.existsSync(`${localUploadSessionDir(sessionId)}/assemble.lock`)).toBe(false);
    expect(fs.existsSync(`${localUploadSessionDir(sessionId)}/part-1`)).toBe(true);
  });
});

describe("дверь сама не даёт обещать больше, чем пропустит", () => {
  it("выше потолка без причины, файл больше запроса, пачка больше запроса без причины — ошибка", async () => {
    const { guardedUpload } = await import("../src/upload.js");
    const MB = 1024 * 1024;
    expect(() => guardedUpload({ name: "t1", maxRequestBytes: 300 * MB, limits: { fileSize: MB, files: 1 } })).toThrow(/потолка прокси/);
    expect(() => guardedUpload({ name: "t2", maxRequestBytes: 10 * MB, limits: { fileSize: 20 * MB, files: 1 } })).toThrow(/fileSize больше/);
    expect(() => guardedUpload({ name: "t3", maxRequestBytes: 90 * MB, limits: { fileSize: 20 * MB, files: 10 } })).toThrow(/batchFitsReason/);
    expect(() =>
      guardedUpload({ name: "t4", maxRequestBytes: 90 * MB, batchFitsReason: "экран сжимает и проверяет вес", limits: { fileSize: 20 * MB, files: 10 } })
    ).not.toThrow();
  });
});
