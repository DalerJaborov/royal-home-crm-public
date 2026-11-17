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
