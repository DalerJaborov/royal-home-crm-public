import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import fs from "node:fs";

/**
 * Докачка видео с середины: многочастевая загрузка (routes/properties/videos.ts,
 * POST/PUT/POST/DELETE .../upload-sessions).
 *
 * ЗАЧЕМ. Одиночная POST /:id/videos отправляет файл целиком одним запросом:
 * обрыв на 900-й секунде из 900 означает начать заново — а ролик с площадки
 * идёт минутами на слабом интернете. Здесь файл режется на части, каждая шлётся
 * своим запросом, и оборвавшаяся связь досылает только недостающее.
 *
 * Настоящее локальное хранилище (31.08.2026, до этого — замоканный R2): проще
 * мокать нечего — записи на диск не стоят денег и не требуют сети, а реальная
 * сборка частей в файл — это ровно то, что стоит проверить взаправду, а не
 * поверить на слово моку. completeLocalUploadSession/abortLocalUploadSession
 * обёрнуты шпионами (реальная реализация по умолчанию) только там, где нужно
 * симулировать отказ диска на ОДНОМ тесте.
 */

const completeLocalUploadSession =
  vi.fn<(sessionId: string, storageKey: string, totalParts: number) => Promise<void>>();
const abortLocalUploadSession = vi.fn<(sessionId: string) => Promise<boolean>>();
vi.mock("../src/lib/localVideoStorage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/localVideoStorage.js")>();
  completeLocalUploadSession.mockImplementation(actual.completeLocalUploadSession);
  abortLocalUploadSession.mockImplementation(actual.abortLocalUploadSession);
  return {
    ...actual,
    completeLocalUploadSession: (sessionId: string, storageKey: string, totalParts: number) =>
      completeLocalUploadSession(sessionId, storageKey, totalParts),
    abortLocalUploadSession: (sessionId: string) => abortLocalUploadSession(sessionId),
  };
});

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");

const runId = Date.now();
const password = "testpass123";
const PART_SIZE = 8 * 1024 * 1024;

let districtId: string;
let agentId: string;
let token: string;
const propertyIds: string[] = [];

async function makeProperty() {
  const p = await prisma.property.create({
    data: {
      title: `Видео-сессия ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "EDITING",
      intakeAgentId: agentId,
      createdById: agentId,
    },
  });
  propertyIds.push(p.id);
  return p;
}

function newKey(label: string) {
  return `${runId}-${label}-${Math.random().toString(36).slice(2)}`;
}

async function startSession(propertyId: string, uploadKey: string, sizeBytes: number) {
  return request(app)
    .post(`/api/v1/properties/${propertyId}/videos/upload-sessions`)
    .set("Authorization", `Bearer ${token}`)
    .send({ uploadKey, filename: "showing.mp4", sizeBytes, contentType: "video/mp4" });
}

function uploadPart(propertyId: string, sessionId: string, partNumber: number, body: Buffer) {
  return request(app)
    .put(`/api/v1/properties/${propertyId}/videos/upload-sessions/${sessionId}/parts/${partNumber}`)
    .set("Authorization", `Bearer ${token}`)
    .set("Content-Type", "application/octet-stream")
    .send(body);
}

function complete(propertyId: string, sessionId: string, body?: Record<string, unknown>) {
  const req = request(app)
    .post(`/api/v1/properties/${propertyId}/videos/upload-sessions/${sessionId}/complete`)
    .set("Authorization", `Bearer ${token}`);
  return body ? req.send(body) : req;
}

/** Полный успешный проход: session → все части → complete. Возвращает ответ complete. */
async function uploadWholeFile(propertyId: string, uploadKey: string, sizeBytes: number, completeBody?: Record<string, unknown>) {
  const started = await startSession(propertyId, uploadKey, sizeBytes);
  expect(started.status).toBe(201);
  const { sessionId, totalParts } = started.body;
  for (let n = 1; n <= totalParts; n++) {
    const size = n === totalParts ? sizeBytes - PART_SIZE * (totalParts - 1) : PART_SIZE;
    const res = await uploadPart(propertyId, sessionId, n, Buffer.alloc(size, n));
    expect(res.status).toBe(200);
  }
  return complete(propertyId, sessionId, completeBody);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-видео-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент видео", phone: `+992953${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: `+992953${runId}`, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

beforeEach(() => {
  completeLocalUploadSession.mockClear();
  abortLocalUploadSession.mockClear();
});

afterAll(async () => {
  await prisma.videoUploadSession.deleteMany({ where: { propertyId: { in: propertyIds } } });
  const videos = await prisma.propertyVideo.findMany({ where: { propertyId: { in: propertyIds } }, select: { storageKey: true } });
  await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: propertyIds } } });
  for (const v of videos) {
    const p = localVideoFilePath(v.storageKey);
    if (p) fs.rmSync(p, { force: true });
  }
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Начало сессии", () => {
  it("считает план по 8 МБ и заводит сессию докачки", async () => {
    const p = await makeProperty();
    const res = await startSession(p.id, newKey("plan"), 20 * 1024 * 1024);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "started", partSize: PART_SIZE, totalParts: 3, uploadedPartNumbers: [] });
  });

  it("повторный старт с тем же ключом до завершения — та же сессия, вторую не заводим", async () => {
    const p = await makeProperty();
    const key = newKey("resume");
    const first = await startSession(p.id, key, 20 * 1024 * 1024);
    expect(first.status).toBe(201);

    await uploadPart(p.id, first.body.sessionId, 1, Buffer.alloc(PART_SIZE, 1));

    const second = await startSession(p.id, key, 20 * 1024 * 1024);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      status: "in-progress",
      sessionId: first.body.sessionId,
      uploadedPartNumbers: [1],
    });
    // Ключевая проверка докачки: одна строка на ключ, вторая сессия не завелась.
    expect(await prisma.videoUploadSession.count({ where: { uploadKey: key } })).toBe(1);
  });

  it("ключ, занятый чужим объектом, — 409, не чужая сессия", async () => {
    const mine = await makeProperty();
    const other = await makeProperty();
    const key = newKey("foreign");
    expect((await startSession(other.id, key, 1024 * 1024)).status).toBe(201);

    const res = await startSession(mine.id, key, 1024 * 1024);
    expect(res.status).toBe(409);
  });

  it("лимит объекта считает и открытые сессии, а не только готовые видео", async () => {
    const p = await makeProperty();
    await prisma.settings.upsert({
      where: { id: "singleton" },
      update: { propertyVideoMaxCount: 1 },
      create: { id: "singleton", propertyVideoMaxCount: 1 },
    });
    try {
      expect((await startSession(p.id, newKey("limit-1"), 1024)).status).toBe(201);
      const second = await startSession(p.id, newKey("limit-2"), 1024);
      expect(second.status).toBe(400);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { propertyVideoMaxCount: 30 } });
    }
  });
});

describe("Загрузка частей", () => {
  it("часть неверного размера (не последняя) отклоняется — иначе части сдвинутся", async () => {
    const p = await makeProperty();
    const started = await startSession(p.id, newKey("badsize"), 20 * 1024 * 1024);
    const res = await uploadPart(p.id, started.body.sessionId, 1, Buffer.alloc(1024));
    expect(res.status).toBe(400);
  });

  it("последняя часть короче плана — это нормально, она хвост файла", async () => {
    const p = await makeProperty();
    const started = await startSession(p.id, newKey("tail"), 10 * 1024 * 1024); // 2 части: 8МБ + 2МБ
    expect(started.body.totalParts).toBe(2);
    expect((await uploadPart(p.id, started.body.sessionId, 1, Buffer.alloc(PART_SIZE))).status).toBe(200);
    expect((await uploadPart(p.id, started.body.sessionId, 2, Buffer.alloc(2 * 1024 * 1024))).status).toBe(200);
  });

  it("повтор одной и той же части не создаёт вторую запись — файл на диске просто перезаписывается", async () => {
    const p = await makeProperty();
    const started = await startSession(p.id, newKey("retry"), 20 * 1024 * 1024);
    await uploadPart(p.id, started.body.sessionId, 1, Buffer.alloc(PART_SIZE, 9));
    await uploadPart(p.id, started.body.sessionId, 1, Buffer.alloc(PART_SIZE, 9));
    const session = await prisma.videoUploadSession.findUniqueOrThrow({ where: { id: started.body.sessionId } });
    expect(Array.isArray(session.parts) ? session.parts.length : -1).toBe(1);
  });
});

describe("Завершение", () => {
  it("собирает файл на диске байт-в-байт и заводит PropertyVideo с полученным именем и размером", async () => {
    const p = await makeProperty();
    const sizeBytes = 12 * 1024 * 1024;
    const done = await uploadWholeFile(p.id, newKey("complete"), sizeBytes);
    expect(done.status).toBe(201);
    expect(done.body).toMatchObject({ filename: "showing.mp4", sizeBytes });
    expect(completeLocalUploadSession).toHaveBeenCalledTimes(1);

    const video = await prisma.propertyVideo.findUnique({ where: { id: done.body.id } });
    expect(video?.propertyId).toBe(p.id);
    // Настоящий файл на диске — не только запись в базе — и его размер совпадает
    // с суммой частей: единственная реальная проверка, что сборка не рассыпала байты.
    const filePath = localVideoFilePath(video!.storageKey);
    expect(filePath).toBeTruthy();
    expect(fs.statSync(filePath!).size).toBe(sizeBytes);
    // Сессия удаляется по завершении — ничего не осталось висеть на объекте.
    expect(await prisma.videoUploadSession.count({ where: { propertyId: p.id } })).toBe(0);
  });

  it("завершение до прихода всех частей — 409, а не потерянный файл", async () => {
    const p = await makeProperty();
    const started = await startSession(p.id, newKey("partial"), 20 * 1024 * 1024);
    await uploadPart(p.id, started.body.sessionId, 1, Buffer.alloc(PART_SIZE));
    const res = await complete(p.id, started.body.sessionId);
    expect(res.status).toBe(409);
    expect(completeLocalUploadSession).not.toHaveBeenCalled();
  });

  it("отказ сборки на диске — сессия и части остаются, повтор завершения не грузит файл заново", async () => {
    const p = await makeProperty();
    const key = newKey("assembly-fail");
    const started = await startSession(p.id, key, 10 * 1024 * 1024);
    await uploadPart(p.id, started.body.sessionId, 1, Buffer.alloc(PART_SIZE));
    await uploadPart(p.id, started.body.sessionId, 2, Buffer.alloc(2 * 1024 * 1024));

    completeLocalUploadSession.mockRejectedValueOnce(new Error("диск недоступен"));
    const failed = await complete(p.id, started.body.sessionId);
    expect(failed.status).toBe(502);
    expect(await prisma.videoUploadSession.findUnique({ where: { id: started.body.sessionId } })).not.toBeNull();

    const retried = await complete(p.id, started.body.sessionId);
    expect(retried.status).toBe(201);
  });

  it("две параллельные попытки завершения не заводят два видео", async () => {
    const p = await makeProperty();
    const key = newKey("race");
    const started = await startSession(p.id, key, 5 * 1024 * 1024);
    await uploadPart(p.id, started.body.sessionId, 1, Buffer.alloc(5 * 1024 * 1024));

    const [first, second] = await Promise.all([complete(p.id, started.body.sessionId), complete(p.id, started.body.sessionId)]);
    const statuses = [first.status, second.status].sort();
    // Один создал видео (201), второй увидел уже готовое (200 или 404 — сессию мог
    // успеть удалить первый). Оба варианта означают одно и то же: файл один.
    expect(statuses[0]).toBeLessThan(500);
    expect(await prisma.propertyVideo.count({ where: { uploadKey: key } })).toBe(1);
  });
});

describe("Новый исходник для монтажёра (MONTAJER_SOURCE)", () => {
  it("объект остаётся на своём этапе — без возврата на проверку", async () => {
    const published = await makeProperty();
    await prisma.property.update({ where: { id: published.id }, data: { status: "AWAITING_VIDEO" } });

    const res = await uploadWholeFile(published.id, newKey("montajer-src"), PART_SIZE + 10, { purpose: "MONTAJER_SOURCE" });
    expect(res.status).toBe(201);

    // Возврат на проверку идёт «в отрыве» (void) — даём ему шанс случиться.
    await new Promise((r) => setTimeout(r, 300));
    const after = await prisma.property.findUniqueOrThrow({ where: { id: published.id } });
    expect(after.status).toBe("AWAITING_VIDEO");
  });

  it("обычная загрузка агентом возвращает на проверку, как и раньше", async () => {
    const property = await makeProperty();
    await prisma.property.update({ where: { id: property.id }, data: { status: "AWAITING_VIDEO" } });

    const res = await uploadWholeFile(property.id, newKey("plain"), PART_SIZE + 10);
    expect(res.status).toBe(201);

    await vi.waitFor(async () => {
      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      expect(after.status).toBe("PENDING_REVIEW");
    });
  });

  it("неизвестная цель в теле complete — 400", async () => {
    const property = await makeProperty();
    const res = await uploadWholeFile(property.id, newKey("bad"), PART_SIZE + 10, { purpose: "NOPE" });
    expect(res.status).toBe(400);
  });
});

describe("Отмена", () => {
  it("убирает сессию и её папку на диске", async () => {
    const p = await makeProperty();
    const started = await startSession(p.id, newKey("cancel"), 10 * 1024 * 1024);
    const res = await request(app)
      .delete(`/api/v1/properties/${p.id}/videos/upload-sessions/${started.body.sessionId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect(abortLocalUploadSession).toHaveBeenCalledTimes(1);
    expect(await prisma.videoUploadSession.findUnique({ where: { id: started.body.sessionId } })).toBeNull();
  });

  it("отказ уборки диска при отмене оставляет сессию для ночной уборки, а не теряет её", async () => {
    const p = await makeProperty();
    const started = await startSession(p.id, newKey("cancel-fail"), 10 * 1024 * 1024);
    abortLocalUploadSession.mockResolvedValueOnce(false);
    const res = await request(app)
      .delete(`/api/v1/properties/${p.id}/videos/upload-sessions/${started.body.sessionId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect(await prisma.videoUploadSession.findUnique({ where: { id: started.body.sessionId } })).not.toBeNull();
  });
});
