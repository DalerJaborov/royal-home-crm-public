import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Видео в объект из Корзины не принимаются (находка №188). Раньше сырое видео,
 * сессия докачки и готовый ролик монтажёра писались в удалённый объект: файлы
 * ложились на диск, а карточка в Корзине их никому не показывает.
 */

const runId = Date.now();
const password = "testpass123";
const phone = `+992940${String(runId).slice(-7)}`;
let agentId: string;
let districtId: string;
let token: string;
let trashedId: string;
let liveId: string;
let sessionId: string;

const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);

beforeAll(async () => {
  agentId = (await prisma.agent.create({ data: { fullName: "Агент корзины видео", phone, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) } })).id;
  districtId = (await prisma.district.create({ data: { name: `Район корзины видео ${runId}` } })).id;
  const base = {
    type: "APARTMENT" as const,
    areaSqm: 50,
    price: 40000,
    currency: "TJS" as const,
    districtId,
    address: "Тестовая, 8",
    condition: "GOOD" as const,
    status: "EDITING" as const,
    intakeAgentId: agentId,
    createdById: agentId,
  };
  trashedId = (await prisma.property.create({ data: { ...base, title: `Корзина видео ${runId}`, deletedAt: new Date() } })).id;
  liveId = (await prisma.property.create({ data: { ...base, title: `Живой видео ${runId}`, address: "Тестовая, 9" } })).id;
  // Сессия докачки, заведённая, пока объект ещё жив, и брошенная в Корзину.
  const session = await prisma.videoUploadSession.create({
    data: {
      propertyId: trashedId,
      uploadKey: `trashed-${runId}`,
      storageKey: `${trashedId}/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.mp4`,
      filename: "raw.mp4",
      sizeBytes: 1000,
      contentType: "video/mp4",
      partSize: 1000,
      totalParts: 1,
      purpose: "RAW",
      createdById: agentId,
    },
  });
  sessionId = session.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.videoUploadSession.deleteMany({ where: { propertyId: { in: [trashedId, liveId] } } });
  await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: [trashedId, liveId] } } });
  await prisma.property.deleteMany({ where: { id: { in: [trashedId, liveId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await deleteAgentsWithTraces([agentId]);
});

describe("объект в Корзине не принимает видео", () => {
  it("POST /:id/videos → 404", async () => {
    const res = await auth(request(app).post(`/api/v1/properties/${trashedId}/videos`)).attach("videos", Buffer.alloc(2048), { filename: "a.mp4", contentType: "video/mp4" });
    expect(res.status).toBe(404);
    expect(await prisma.propertyVideo.count({ where: { propertyId: trashedId } })).toBe(0);
  });

  it("создание сессии докачки → 404, сессия не заводится", async () => {
    const before = await prisma.videoUploadSession.count({ where: { propertyId: trashedId } });
    const res = await auth(request(app).post(`/api/v1/properties/${trashedId}/videos/upload-sessions`)).send({
      uploadKey: `k-${runId}-start`,
      filename: "a.mp4",
      sizeBytes: 2048,
      contentType: "video/mp4",
    });
    expect(res.status).toBe(404);
    expect(await prisma.videoUploadSession.count({ where: { propertyId: trashedId } })).toBe(before);
  });

  it("часть сессии → 404", async () => {
    const res = await auth(request(app).put(`/api/v1/properties/${trashedId}/videos/upload-sessions/${sessionId}/parts/1`))
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.alloc(1000));
    expect(res.status).toBe(404);
  });

  it("завершение сессии → 404", async () => {
    const res = await auth(request(app).post(`/api/v1/properties/${trashedId}/videos/upload-sessions/${sessionId}/complete`)).send({});
    expect(res.status).toBe(404);
  });

  it("сжатый ролик карточки (clip-video) → 404", async () => {
    const res = await auth(request(app).post(`/api/v1/properties/${trashedId}/clip-video`)).attach("video", Buffer.alloc(2048), { filename: "a.mp4", contentType: "video/mp4" });
    expect(res.status).toBe(404);
  });

  it("готовый ролик монтажёра (video-handoff/upload) → 404", async () => {
    const res = await auth(request(app).post(`/api/v1/properties/${trashedId}/video-handoff/upload`)).attach("video", Buffer.alloc(2048), { filename: "a.mp4", contentType: "video/mp4" });
    expect(res.status).toBe(404);
  });

  it("отмена брошенной сессии разрешена — она только убирает мусор с диска", async () => {
    const res = await auth(request(app).delete(`/api/v1/properties/${trashedId}/videos/upload-sessions/${sessionId}`));
    expect(res.status).toBe(204);
    expect(await prisma.videoUploadSession.count({ where: { id: sessionId } })).toBe(0);
  });

  it("живой объект по-прежнему принимает сессию", async () => {
    const res = await auth(request(app).post(`/api/v1/properties/${liveId}/videos/upload-sessions`)).send({
      uploadKey: `k-${runId}-live`,
      filename: "a.mp4",
      sizeBytes: 2048,
      contentType: "video/mp4",
    });
    expect(res.status).toBe(201);
  });
});
