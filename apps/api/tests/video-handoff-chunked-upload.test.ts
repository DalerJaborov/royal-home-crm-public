import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import request from "supertest";

/**
 * ДОКАЧКА ГОТОВОГО РОЛИКА ОТ МОНТАЖЁРА С СЕРЕДИНЫ (23.09.2026) — та же докачка
 * с частями, что у сырых видео (video-upload-multipart.test.ts), с
 * `purpose: "handoff"` в START. Покрывает то, что отличает её от purpose=raw:
 *  - право заводить/докачивать/завершать сессию — canManageProperty ИЛИ
 *    назначенный монтажёр (как у одиночного POST /:id/video-handoff/upload),
 *    а не только canManageProperty;
 *  - COMPLETE не заводит PropertyVideo — вызывает ту же цепочку, что и
 *    одиночная загрузка (receiveEditedVideoFromFile → videoHandoffStatus
 *    RECEIVED, публикация фоновым заданием);
 *  - состояние объекта (SENT_TO_EDITOR) проверяется на СТАРТЕ сессии, с тем же
 *    реоткрытием для canManageProperty, что и у одиночной загрузки.
 *
 * Telegram/пуши/публикация подменены — тест не ходит в реальные каналы.
 */

const { sendMessage, sendDocumentFile, sendPushToAgent, sendPushToAgents, publishApprovedPost, publishAfterEditingComplete, logSystemError } =
  vi.hoisted(() => ({
    sendMessage: vi.fn(async () => {}),
    sendDocumentFile: vi.fn(async () => {}),
    sendPushToAgent: vi.fn(async () => {}),
    sendPushToAgents: vi.fn(async () => 0),
    publishApprovedPost: vi.fn(async () => []),
    publishAfterEditingComplete: vi.fn(async () => ({ updated: {} })),
    logSystemError: vi.fn(async () => {}),
  }));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  sendDocumentFile,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents,
}));
vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  publishApprovedPost,
}));
vi.mock("../src/lib/propertyPipeline.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/propertyPipeline.js")>()),
  publishAfterEditingComplete,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { videoHandoffDir } = await import("../src/upload.js");
const { VIDEO_HANDOFF_PUBLISH_JOB_TYPE, videoHandoffPublishDedupeKey } = await import("../src/lib/videoHandoff.js");

const runId = Date.now();
const password = "testpass123";
const PART_SIZE = 8 * 1024 * 1024;

let districtId: string;
let ownerAgentId: string;
let ownerToken: string;
let montajerId: string;
let montajerToken: string;
let strangerId: string;
let strangerToken: string;
const propertyIds: string[] = [];

async function setHandoffSettings(montajerAgentId: string | null) {
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { videoMontajerAgentId: montajerAgentId },
    create: { id: "singleton", videoMontajerAgentId: montajerAgentId },
  });
}

async function makeProperty(
  status: "SENT_TO_EDITOR" | "NONE" | "RECEIVED" = "SENT_TO_EDITOR",
  extra: { type?: "APARTMENT" | "HOUSE"; publishedChannels?: string[]; videoHandoffFinalPath?: string } = {}
) {
  const p = await prisma.property.create({
    data: {
      title: `Докачка хендоффа ${runId}-${propertyIds.length}`,
      type: extra.type ?? "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "EDITING",
      intakeAgentId: ownerAgentId,
      createdById: ownerAgentId,
      videoHandoffStatus: status,
      videoHandoffSentAt: status === "SENT_TO_EDITOR" ? new Date() : null,
      publishedChannels: extra.publishedChannels ?? [],
      videoHandoffFinalPath: extra.videoHandoffFinalPath ?? null,
    },
  });
  propertyIds.push(p.id);
  return p;
}

function newKey(label: string) {
  return `${runId}-${label}-${Math.random().toString(36).slice(2)}`;
}

function startSession(propertyId: string, token: string, uploadKey: string, sizeBytes: number, purpose?: "raw" | "handoff") {
  return request(app)
    .post(`/api/v1/properties/${propertyId}/videos/upload-sessions`)
    .set("Authorization", `Bearer ${token}`)
    .send({ uploadKey, filename: "final.mp4", sizeBytes, contentType: "video/mp4", ...(purpose ? { purpose } : {}) });
}

function uploadPart(propertyId: string, token: string, sessionId: string, partNumber: number, body: Buffer) {
  return request(app)
    .put(`/api/v1/properties/${propertyId}/videos/upload-sessions/${sessionId}/parts/${partNumber}`)
    .set("Authorization", `Bearer ${token}`)
    .set("Content-Type", "application/octet-stream")
    .send(body);
}

function complete(propertyId: string, token: string, sessionId: string) {
  return request(app)
    .post(`/api/v1/properties/${propertyId}/videos/upload-sessions/${sessionId}/complete`)
    .set("Authorization", `Bearer ${token}`);
}

async function uploadWholeHandoffFile(propertyId: string, token: string, uploadKey: string, sizeBytes: number) {
  const started = await startSession(propertyId, token, uploadKey, sizeBytes, "handoff");
  expect(started.status).toBe(201);
  const { sessionId, totalParts } = started.body;
  for (let n = 1; n <= totalParts; n++) {
    const size = n === totalParts ? sizeBytes - PART_SIZE * (totalParts - 1) : PART_SIZE;
    const res = await uploadPart(propertyId, token, sessionId, n, Buffer.alloc(size, n));
    expect(res.status).toBe(200);
  }
  return complete(propertyId, token, sessionId);
}

beforeEach(async () => {
  if (!districtId) {
    districtId = (await prisma.district.create({ data: { name: `Докачка хендоффа-${runId}` } })).id;
  }
  sendMessage.mockClear();
  sendDocumentFile.mockClear();
  sendPushToAgent.mockClear();
  sendPushToAgents.mockClear();
  publishApprovedPost.mockClear();
  publishAfterEditingComplete.mockClear();
  logSystemError.mockClear();

  if (!ownerAgentId) {
    const passwordHash = await bcrypt.hash(password, 10);
    const owner = await prisma.agent.create({
      data: { fullName: "Ведущий агент", phone: `+992951${runId}`, role: "AGENT", passwordHash },
    });
    ownerAgentId = owner.id;
    const montajer = await prisma.agent.create({
      data: { fullName: "Монтажёр докачки", phone: `+992952${runId}`, role: "AGENT", passwordHash },
    });
    montajerId = montajer.id;
    const stranger = await prisma.agent.create({
      data: { fullName: "Посторонний агент", phone: `+992953${runId}`, role: "AGENT", passwordHash },
    });
    strangerId = stranger.id;

    ownerToken = (await request(app).post("/api/v1/auth/login").send({ phone: `+992951${runId}`, password })).body.accessToken;
    montajerToken = (await request(app).post("/api/v1/auth/login").send({ phone: `+992952${runId}`, password })).body.accessToken;
    strangerToken = (await request(app).post("/api/v1/auth/login").send({ phone: `+992953${runId}`, password })).body.accessToken;

    await setHandoffSettings(montajerId);
    await prisma.backgroundJob.deleteMany({ where: { type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE } });
  }
});

afterEach(async () => {
  if (propertyIds.length) {
    await prisma.videoUploadSession.deleteMany({ where: { propertyId: { in: propertyIds } } });
  }
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [ownerAgentId, montajerId, strangerId] } } });
  if (districtId) await prisma.district.deleteMany({ where: { id: districtId } });
  const files = await fs.readdir(videoHandoffDir).catch(() => [] as string[]);
  await Promise.all(
    files.filter((f) => propertyIds.some((id) => f.startsWith(id))).map((f) => fs.unlink(`${videoHandoffDir}/${f}`).catch(() => {}))
  );
  await prisma.$disconnect();
});

describe("Право заводить сессию purpose=handoff", () => {
  it("посторонний агент (не ведёт объект, не монтажёр) — 403", async () => {
    const p = await makeProperty();
    const res = await startSession(p.id, strangerToken, newKey("perm-stranger"), 1024, "handoff");
    expect(res.status).toBe(403);
  });

  it("назначенный монтажёр — пускает на purpose=handoff (в отличие от purpose=raw)", async () => {
    const p = await makeProperty();
    const handoff = await startSession(p.id, montajerToken, newKey("perm-montajer-handoff"), 1024, "handoff");
    expect(handoff.status).toBe(201);

    const raw = await startSession(p.id, montajerToken, newKey("perm-montajer-raw"), 1024, "raw");
    expect(raw.status).toBe(403);
  });

  it("ведущий агент (canManageProperty) — пускает всегда", async () => {
    const p = await makeProperty();
    const res = await startSession(p.id, ownerToken, newKey("perm-owner"), 1024, "handoff");
    expect(res.status).toBe(201);
  });
});

describe("Состояние объекта проверяется на СТАРТЕ сессии purpose=handoff", () => {
  it("объект не ждёт файл (не SENT_TO_EDITOR) — монтажёру 409, реоткрыть сам не может", async () => {
    const p = await makeProperty("NONE");
    const res = await startSession(p.id, montajerToken, newKey("state-montajer"), 1024, "handoff");
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("не ждёт готовый ролик");
  });

  it("объект не ждёт файл — ведущий агент реоткрывает приём сам (та же ЗАМЕНА РОЛИКА ВРУЧНУЮ, что у одиночной загрузки)", async () => {
    const p = await makeProperty("NONE");
    const res = await startSession(p.id, ownerToken, newKey("state-owner"), 1024, "handoff");
    expect(res.status).toBe(201);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffStatus: true } });
    expect(after.videoHandoffStatus).toBe("SENT_TO_EDITOR");
  });
});

describe("COMPLETE purpose=handoff — та же цепочка приёма, что у одиночной загрузки, без PropertyVideo", () => {
  it("собирает файл, объект уходит в RECEIVED, publishSummary в ответе, PropertyVideo не создаётся", async () => {
    const p = await makeProperty();
    const sizeBytes = 12 * 1024 * 1024;
    const done = await uploadWholeHandoffFile(p.id, montajerToken, newKey("complete-handoff"), sizeBytes);

    expect(done.status).toBe(200);
    expect(done.body.videoHandoffStatus).toBe("RECEIVED");
    // Поле есть в ответе (сама публикация — фоновое задание, см. videoHandoff.ts) —
    // важно, что форма ответа совпадает с одиночной загрузкой, а не молчит.
    expect(done.body).toHaveProperty("publishSummary");

    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffStatus: true, videoHandoffFinalPath: true } });
    expect(after.videoHandoffStatus).toBe("RECEIVED");
    expect(after.videoHandoffFinalPath).toMatch(/^\/uploads\/handoff\//);

    // НЕ PropertyVideo: докачка purpose=handoff не заводит сырое видео объекта.
    expect(await prisma.propertyVideo.count({ where: { propertyId: p.id } })).toBe(0);
    // Сессия убрана по завершении, независимо от исхода приёма.
    expect(await prisma.videoUploadSession.count({ where: { propertyId: p.id } })).toBe(0);
  });

  it("ролик на замену в уже вышедший дом: ответ называет час выхода — тот же, что у объекта и у задания публикации", async () => {
    // Случай владельца 24.09.2026 (ОБ-000132, дом, уже на YouTube и TikTok):
    // «Загрузить готовый ролик» принимал файл, но ставил его в расписание
    // молча — ни времени в ответе, ни строки в карточке, и выглядело так, будто
    // файл «куда-то в другое место уходит».
    const p = await makeProperty("RECEIVED", {
      type: "HOUSE",
      publishedChannels: ["YOUTUBE", "TIKTOK"],
      videoHandoffFinalPath: "/uploads/handoff/old-final.mp4",
    });
    // Час выхода называется, только когда ролик правда уйдёт сам: при
    // выключенной автопубликации ответ несёт причину вместо часа (24.09.2026).
    const saved = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { autoPublishEnabled: true } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: true } });
    const done = await uploadWholeHandoffFile(p.id, ownerToken, newKey("replace-published"), 2 * 1024 * 1024).finally(() =>
      prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: saved?.autoPublishEnabled ?? false } })
    );

    expect(done.status).toBe(200);
    expect(done.body.videoHandoffStatus).toBe("RECEIVED");
    expect(typeof done.body.scheduledPublishAt).toBe("string");

    const after = await prisma.property.findUniqueOrThrow({
      where: { id: p.id },
      select: { scheduledPublishAt: true, publishedChannels: true, videoHandoffFinalPath: true },
    });
    expect(new Date(done.body.scheduledPublishAt).getTime()).toBe(after.scheduledPublishAt!.getTime());
    // Вышедшие площадки не стёрты — новый ролик уйдёт туда, где объекта ещё нет.
    expect(after.publishedChannels).toEqual(["YOUTUBE", "TIKTOK"]);
    expect(after.videoHandoffFinalPath).not.toBe("/uploads/handoff/old-final.mp4");

    const job = await prisma.backgroundJob.findUnique({
      where: { dedupeKey: videoHandoffPublishDedupeKey(p.id) },
      select: { type: true, status: true, runAt: true },
    });
    expect(job?.type).toBe(VIDEO_HANDOFF_PUBLISH_JOB_TYPE);
    expect(job?.status).toBe("PENDING");
    expect(job?.runAt.getTime()).toBe(after.scheduledPublishAt!.getTime());
  });

  it("монтажёр может докачать и завершить сессию, начатую как handoff (permission у part/complete тоже расширена)", async () => {
    const p = await makeProperty();
    const done = await uploadWholeHandoffFile(p.id, montajerToken, newKey("montajer-full-cycle"), 5 * 1024 * 1024);
    expect(done.status).toBe(200);
  });
});
