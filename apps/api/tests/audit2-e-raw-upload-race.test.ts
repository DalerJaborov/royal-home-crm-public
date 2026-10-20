import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { randomUUID } from "node:crypto";

/**
 * АУДИТ CODEX 04.10.2026, PUB12: конкурентное завершение RAW-загрузки удаляло файл
 * победившей записи. Два complete одной сессии собирают части в ОДИН и тот же файл
 * session.storageKey; победитель создаёт PropertyVideo с этим storageKey, проигравший
 * ловит P2002, находит запись победителя и безусловно делал localVideoDelete(
 * session.storageKey) — то есть стирал файл победителя, а отвечал 200 «видео есть».
 *
 * Хранилище подменено (сборка частей и удаление), база и роут настоящие. Победитель
 * заранее лежит в базе с тем же uploadKey: create() проигравшего гарантированно даёт P2002.
 */

const { completeLocalUploadSession, localVideoDelete } = vi.hoisted(() => ({
  completeLocalUploadSession: vi.fn(async () => {}),
  localVideoDelete: vi.fn(async () => true),
}));
vi.mock("../src/lib/localVideoStorage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/localVideoStorage.js")>()),
  completeLocalUploadSession,
  localVideoDelete,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

const runId = Date.now();
const password = "testpass123";
let districtId: string;
let agentId: string;
let token: string;
const propertyIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** Сессия с принятыми частями и запись-«победитель» с тем же uploadKey. */
async function seed(winnerSameKey: boolean) {
  const property = await prisma.property.create({
    data: {
      title: `Гонка complete ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "AVAILABLE",
      intakeAgentId: agentId,
      createdById: agentId,
    },
  });
  propertyIds.push(property.id);
  const uploadKey = `race-${runId}-${propertyIds.length}`;
  const sessionKey = `${property.id}/${randomUUID()}.mp4`;
  const session = await prisma.videoUploadSession.create({
    data: {
      propertyId: property.id,
      uploadKey,
      storageKey: sessionKey,
      filename: "obhod.mp4",
      sizeBytes: 2048,
      contentType: "video/mp4",
      partSize: 1024,
      totalParts: 2,
      parts: [{ partNumber: 1 }, { partNumber: 2 }],
      createdById: agentId,
    },
  });
  await prisma.propertyVideo.create({
    data: {
      propertyId: property.id,
      storageKey: winnerSameKey ? sessionKey : `${property.id}/${randomUUID()}.mp4`,
      filename: "obhod.mp4",
      sizeBytes: 2048,
      uploadedById: agentId,
      uploadKey,
    },
  });
  return { property, session, sessionKey };
}

const complete = (propertyId: string, sessionId: string) =>
  request(app).post(`/api/v1/properties/${propertyId}/videos/upload-sessions/${sessionId}/complete`).set("Authorization", `Bearer ${token}`);

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-гонка-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Маркетолог гонки", phone: `+992953${runId.toString().slice(-8)}`, role: "MARKETING", passwordHash: await bcrypt.hash(password, 4) },
    })
  ).id;
  token = await login(`+992953${runId.toString().slice(-8)}`);
});

beforeEach(() => {
  completeLocalUploadSession.mockClear();
  localVideoDelete.mockClear();
});

afterAll(async () => {
  await prisma.videoUploadSession.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("complete RAW-загрузки: проигравший гонку не стирает файл победителя", () => {
  it("победитель держит тот же storageKey — файл НЕ удаляется, ответ 200 с записью победителя", async () => {
    const { property, session } = await seed(true);

    const res = await complete(property.id, session.id);

    expect(res.status).toBe(200);
    expect(completeLocalUploadSession).toHaveBeenCalledTimes(1);
    expect(localVideoDelete).not.toHaveBeenCalled();
    // Сессия подчищена, видео на месте.
    expect(await prisma.videoUploadSession.count({ where: { id: session.id } })).toBe(0);
    expect(await prisma.propertyVideo.count({ where: { propertyId: property.id } })).toBe(1);
  });

  it("у победителя другой storageKey (другая сессия с тем же uploadKey) — наш файл настоящая сирота, удаляется", async () => {
    const { property, session, sessionKey } = await seed(false);

    const res = await complete(property.id, session.id);

    expect(res.status).toBe(200);
    expect(localVideoDelete).toHaveBeenCalledTimes(1);
    expect(localVideoDelete).toHaveBeenCalledWith(sessionKey);
  });
});
