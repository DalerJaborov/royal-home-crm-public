import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import pathMod from "node:path";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { waitFor } from "./helpers/waitFor.js";

/**
 * ОЧЕРЕДЬ МОНТАЖА: ОДИН ПОРЯДОК ВЕЗДЕ, ПЕРЕСТАНОВКА, ВСЕ ПУТИ ЧЕРЕЗ ОЧЕРЕДЬ
 * (24.09.2026, владелец: «хочу, чтобы очередь всегда была соблюдена, чтобы
 * монтажёр видел и делал по одному, и кнопку, чтобы передвигать очередь»).
 *
 * Telegram подменён: тест проверяет, КОМУ и КОГДА уходят файлы, а не сам Telegram.
 */

const { sendMessage, sendDocumentFile, logSystemError } = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => {}),
  sendDocumentFile: vi.fn(async (..._args: unknown[]) => {}),
  logSystemError: vi.fn(async () => {}),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  sendDocumentFile,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => {}),
  sendPushToAgents: vi.fn(async () => 0),
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const {
  queueVideoHandoff,
  requeueVideoHandoff,
  cancelVideoHandoffQueueEntry,
  videoHandoffQueuePositions,
  videoHandoffQueueState,
  queueStatusForMontajer,
  montajerCardText,
  settleBackgroundHandoffDispatches,
} = await import("../src/lib/videoHandoff.js");
const { sendBackToMontajer } = await import("../src/lib/publishedVideoFix.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");

const runId = Date.now();
const tail = runId.toString().slice(-7);
const MONTAJER_CHAT = `7${tail}1`;
const password = "testpass123";
let districtId: string;
let montajerId: string;
let directorId: string;
let directorToken: string;
const propertyIds: string[] = [];
const rawDirs = new Set<string>();
let originalSettings: { videoHandoffEnabled: boolean; videoMontajerAgentId: string | null; videoHandoffQueuePaused: boolean } | null = null;

async function seedProperty(data: { status?: "EDITING"; videoHandoffFinalPath?: string; videoHandoffStatus?: "RECEIVED" } = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Порядок очереди-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 300000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 24",
      condition: "GOOD",
      ...data,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function addRawVideo(propertyId: string) {
  const storageKey = `${propertyId}/${randomUUID()}.mp4`;
  const filePath = localVideoFilePath(storageKey);
  if (!filePath) throw new Error("путь хранилища не разрешился");
  await fs.mkdir(pathMod.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.alloc(1024));
  rawDirs.add(pathMod.dirname(filePath));
  return prisma.propertyVideo.create({
    data: { propertyId, storageKey, filename: "raw.mp4", sizeBytes: 1024, uploadedById: montajerId },
  });
}

const status = async (id: string) =>
  (await prisma.property.findUniqueOrThrow({ where: { id }, select: { videoHandoffStatus: true } })).videoHandoffStatus;

/** Файлы ушли монтажёру по объекту? Имя файла несёт номер объекта (montajerFileName).
 *  Сверка по имени файла целиком, а не подстрокой всего вызова: с 25.09.2026
 *  подпись начинается с «файл 1 из 1», а факты несут цену и площадь — номер
 *  вроде «1» или «48» нашёлся бы в чужой подписи. */
function filesSentFor(shortId: number): boolean {
  return sendDocumentFile.mock.calls.some((call) => new RegExp(`^${shortId}(?!\\d)`).test(String(call[2])));
}

async function queueIds(): Promise<string[]> {
  return (await videoHandoffQueueState()).queue.map((p) => p.id);
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Порядок очереди-${runId}` } })).id;
  const hash = await bcrypt.hash(password, 4);
  montajerId = (
    await prisma.agent.create({
      data: { fullName: "Монтажёр порядка очереди", phone: `+99293${tail}`, role: "EDITOR", passwordHash: hash, telegramChatId: MONTAJER_CHAT },
    })
  ).id;
  const director = await prisma.agent.create({
    data: { fullName: "Директор порядка очереди", phone: `+99294${tail}`, role: "DIRECTOR", passwordHash: hash },
  });
  directorId = director.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(login.status).toBe(200);
  directorToken = login.body.accessToken as string;

  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { videoHandoffEnabled: true, videoMontajerAgentId: true, videoHandoffQueuePaused: true },
  });
  originalSettings = s;
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { videoHandoffEnabled: true, videoMontajerAgentId: montajerId, videoHandoffQueuePaused: false },
    create: { id: "singleton", videoHandoffEnabled: true, videoMontajerAgentId: montajerId },
  });
});

beforeEach(async () => {
  // Чужие объекты общей базы из очереди выводим (не удаляем): иначе они стояли бы
  // в той же очереди и путали порядок и счёт.
  await prisma.property.updateMany({
    where: { videoHandoffStatus: { in: ["QUEUED", "SENT_TO_EDITOR"] }, id: { notIn: propertyIds } },
    data: { videoHandoffStatus: "RECEIVED", videoHandoffQueueOrder: null },
  });
  await prisma.settings.update({ where: { id: "singleton" }, data: { videoHandoffQueuePaused: false } });
  sendMessage.mockReset().mockResolvedValue(undefined);
  sendDocumentFile.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await settleBackgroundHandoffDispatches();
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: {
      videoHandoffStatus: "NONE",
      videoHandoffSentAt: null,
      videoHandoffDeliveredAt: null,
      videoHandoffDispatchAttempts: 0,
      videoHandoffManualSince: null,
      videoHandoffQueueOrder: null,
    },
  });
});

afterAll(async () => {
  await settleBackgroundHandoffDispatches();
  await prisma.settings.update({
    where: { id: "singleton" },
    data: originalSettings ?? { videoHandoffEnabled: false, videoMontajerAgentId: null, videoHandoffQueuePaused: false },
  });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: propertyIds }, action: "PROPERTY_VIDEO_HANDOFF_MOVED" } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  for (const d of rawDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: [montajerId, directorId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("перестановка в очереди", () => {
  it("два в очереди, второго «в начало» — место при освобождении уходит ему", async () => {
    const holder = await seedProperty();
    const first = await seedProperty();
    const second = await seedProperty();
    await addRawVideo(second.id);
    await queueVideoHandoff(holder.id);
    await queueVideoHandoff(first.id);
    await queueVideoHandoff(second.id);
    expect(await queueIds()).toEqual([first.id, second.id]);

    const res = await request(app)
      .post(`/api/v1/marketing/video-handoff/${second.id}/move`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ to: "front" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, from: 2, to: 1 });
    expect(await queueIds()).toEqual([second.id, first.id]);

    // Журнал пишется без ожидания (lib/audit.ts) — ждём строку, а не спим.
    await waitFor(
      () => prisma.auditLog.findFirst({ where: { action: "PROPERTY_VIDEO_HANDOFF_MOVED", entityId: second.id }, select: { id: true } }),
      { label: "запись PROPERTY_VIDEO_HANDOFF_MOVED" }
    );

    sendDocumentFile.mockClear();
    expect(await cancelVideoHandoffQueueEntry(holder.id)).toEqual({ ok: true });
    await settleBackgroundHandoffDispatches();
    expect(await status(second.id)).toBe("SENT_TO_EDITOR");
    expect(await status(first.id)).toBe("QUEUED");
    expect(filesSentFor(second.shortId)).toBe(true);
    await prisma.auditLog.deleteMany({ where: { entityId: second.id, action: "PROPERTY_VIDEO_HANDOFF_MOVED" } });
  });

  it("«Выше»/«Ниже»/на позицию — очередь перенумерована без дыр, края прижимаются", async () => {
    const holder = await seedProperty();
    const a = await seedProperty();
    const b = await seedProperty();
    const c = await seedProperty();
    for (const p of [holder, a, b, c]) await queueVideoHandoff(p.id);
    expect(await queueIds()).toEqual([a.id, b.id, c.id]);

    const move = (id: string, body: object) =>
      request(app).post(`/api/v1/marketing/video-handoff/${id}/move`).set("Authorization", `Bearer ${directorToken}`).send(body);

    expect((await move(c.id, { to: "up" })).status).toBe(200);
    expect(await queueIds()).toEqual([a.id, c.id, b.id]);
    expect((await move(a.id, { to: "down" })).status).toBe(200);
    expect(await queueIds()).toEqual([c.id, a.id, b.id]);
    expect((await move(c.id, { to: "position", position: 99 })).body).toMatchObject({ from: 1, to: 3 });
    expect(await queueIds()).toEqual([a.id, b.id, c.id]);
    expect((await move(a.id, { to: "up" })).body).toMatchObject({ from: 1, to: 1 });

    const orders = await prisma.property.findMany({
      where: { id: { in: [a.id, b.id, c.id] } },
      select: { id: true, videoHandoffQueueOrder: true },
    });
    expect(orders.map((o) => o.videoHandoffQueueOrder).sort()).toEqual([1, 2, 3]);

    expect((await move(a.id, { to: "position" })).status).toBe(400);
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [a.id, b.id, c.id] }, action: "PROPERTY_VIDEO_HANDOFF_MOVED" } });
  });

  it("держателя места двигать нельзя — 409 HOLDER_CANNOT_MOVE", async () => {
    const holder = await seedProperty();
    await queueVideoHandoff(holder.id);
    expect(await status(holder.id)).toBe("SENT_TO_EDITOR");

    const res = await request(app)
      .post(`/api/v1/marketing/video-handoff/${holder.id}/move`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ to: "front" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("HOLDER_CANNOT_MOVE");
  });
});

describe("все пути к монтажёру — через очередь", () => {
  it("«Вернуть монтажёру» при занятом месте — в начало очереди, файлы не ушли", async () => {
    const holder = await seedProperty();
    const waiting = await seedProperty();
    const back = await seedProperty({ videoHandoffFinalPath: "/uploads/handoff/old.mp4", videoHandoffStatus: "RECEIVED" });
    await addRawVideo(back.id);
    await queueVideoHandoff(holder.id);
    await queueVideoHandoff(waiting.id);
    sendDocumentFile.mockClear();

    const result = await sendBackToMontajer(back.id, directorId, "POOR_EDIT");
    expect(result).toMatchObject({ ok: true, queued: true });
    expect(await status(back.id)).toBe("QUEUED");
    expect(await queueIds()).toEqual([back.id, waiting.id]);
    expect(filesSentFor(back.shortId)).toBe(false);
    expect(sendDocumentFile).not.toHaveBeenCalled();
  });

  it("«Снова на монтаж» при занятом месте — в конец очереди, файлы не ушли", async () => {
    const holder = await seedProperty();
    const waiting = await seedProperty();
    const again = await seedProperty({ status: "EDITING" });
    await addRawVideo(again.id);
    await queueVideoHandoff(holder.id);
    await queueVideoHandoff(waiting.id);
    sendDocumentFile.mockClear();

    expect(await requeueVideoHandoff(again.id)).toEqual({ ok: true, queued: true });
    expect(await queueIds()).toEqual([waiting.id, again.id]);
    expect(sendDocumentFile).not.toHaveBeenCalled();
  });

  it("место свободно, но в очереди уже ждут — новичок не обходит очередь", async () => {
    const waiting = await seedProperty();
    const newcomer = await seedProperty();
    await addRawVideo(waiting.id);
    // Пауза поставила ждущего в очередь; сняли её мимо «Возобновить» — место
    // свободно, а очередь не пуста (ровно то, что видит сторож после падения).
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoHandoffQueuePaused: true } });
    await queueVideoHandoff(waiting.id);
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoHandoffQueuePaused: false } });
    expect(await status(waiting.id)).toBe("QUEUED");

    await queueVideoHandoff(newcomer.id);
    await settleBackgroundHandoffDispatches();
    expect(await status(waiting.id)).toBe("SENT_TO_EDITOR");
    expect(await status(newcomer.id)).toBe("QUEUED");
    expect(filesSentFor(waiting.shortId)).toBe(true);
    expect(filesSentFor(newcomer.shortId)).toBe(false);
  });

  it("пауза держит и «Вернуть монтажёру»: место свободно, но объект встаёт в очередь", async () => {
    const back = await seedProperty({ videoHandoffFinalPath: "/uploads/handoff/old.mp4", videoHandoffStatus: "RECEIVED" });
    await addRawVideo(back.id);
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoHandoffQueuePaused: true } });

    const result = await sendBackToMontajer(back.id, directorId, "POOR_EDIT");
    expect(result).toMatchObject({ ok: true, queued: true });
    expect(await status(back.id)).toBe("QUEUED");
    expect(sendDocumentFile).not.toHaveBeenCalled();
  });
});

describe("один порядок везде", () => {
  it("позиции у бота монтажёра, у queue-state и на экране совпадают", async () => {
    const holder = await seedProperty();
    const a = await seedProperty();
    const b = await seedProperty();
    const c = await seedProperty();
    for (const p of [holder, a, b, c]) await queueVideoHandoff(p.id);
    await request(app)
      .post(`/api/v1/marketing/video-handoff/${c.id}/move`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ to: "front" })
      .expect(200);

    const stateRes = await request(app).get("/api/v1/marketing/video-handoff/queue-state").set("Authorization", `Bearer ${directorToken}`);
    expect(stateRes.status).toBe(200);
    const stateOrder = (stateRes.body.queue as { shortId: number }[]).map((p) => p.shortId);
    expect(stateOrder).toEqual([c.shortId, a.shortId, b.shortId]);
    expect(stateRes.body.next.shortId).toBe(c.shortId);
    expect(stateRes.body.queuedCount).toBe(3);

    const botText = await queueStatusForMontajer();
    expect(botText).toContain(`Очередь: 1) №${c.shortId}, 2) №${a.shortId}, 3) №${b.shortId}.`);

    const positions = await videoHandoffQueuePositions();
    expect([c.id, a.id, b.id].map((id) => positions.get(id))).toEqual([2, 3, 4]);
    expect(positions.get(holder.id)).toBe(1);

    expect(await montajerCardText(a.shortId)).toContain("Стоит в очереди 2-м");

    // Экран конвейера: «На монтаже» — держатель первым, дальше 2-й, 3-й…, хотя
    // по возрасту стадии держатель самый молодой (владелец видел его четвёртым).
    const day = 24 * 60 * 60 * 1000;
    const ages = new Map([
      [holder.id, 1],
      [a.id, 3],
      [b.id, 4],
      [c.id, 2],
    ]);
    for (const [id, days] of ages) {
      await prisma.property.update({ where: { id }, data: { status: "EDITING", stageEnteredAt: new Date(Date.now() - days * day - 5 * 365 * day) } });
    }
    const board = await request(app).get("/api/v1/marketing/editor-queue").set("Authorization", `Bearer ${directorToken}`);
    expect(board.status).toBe(200);
    const mine = (board.body.inEditing as { id: string; videoHandoffQueuePosition: number | null; photos: unknown[] }[]).filter((r) =>
      ages.has(r.id)
    );
    expect(mine.map((r) => r.id)).toEqual([holder.id, c.id, a.id, b.id]);
    expect(mine.map((r) => r.videoHandoffQueuePosition)).toEqual([1, 2, 3, 4]);
    // Строка — объект той же формы, что в списке объектов (PropertyRow): фото, район.
    expect(Array.isArray(mine[0].photos)).toBe(true);
    expect(mine[0]).toHaveProperty("district");
    await prisma.auditLog.deleteMany({ where: { entityId: c.id, action: "PROPERTY_VIDEO_HANDOFF_MOVED" } });
  });
});
