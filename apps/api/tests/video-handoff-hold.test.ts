import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import pathMod from "node:path";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { waitFor } from "./helpers/waitFor.js";

/**
 * ПАУЗА ОДНОГО ОБЪЕКТА В ОЧЕРЕДИ, ПОВТОРНАЯ ОТПРАВКА, КАРТОЧКА И СПИСОК
 * (25.09.2026, задания A/B/C/D, владелец: «чтобы была возможность придерживать
 * какой-то монтаж на паузе, повторно отправить монтажёру, чтобы в карточке
 * объекта всё было, и в списке объектов сразу видеть, в каком состоянии»).
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
  holdVideoHandoff,
  releaseVideoHandoffHold,
  cancelVideoHandoffQueueEntry,
  nextInQueue,
  videoHandoffQueueState,
  settleBackgroundHandoffDispatches,
} = await import("../src/lib/videoHandoff.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");
const { montageNotificationRecipients } = await import("../src/lib/montageObservers.js");

const runId = Date.now();
const tail = runId.toString().slice(-7);
const MONTAJER_CHAT = `7${tail}2`;
const password = "testpass123";
let districtId: string;
let montajerId: string;
let directorId: string;
let directorToken: string;
const propertyIds: string[] = [];
const agentIds: string[] = [];
const rawDirs = new Set<string>();
let originalSettings: { videoHandoffEnabled: boolean; videoMontajerAgentId: string | null; videoHandoffQueuePaused: boolean } | null = null;

async function seedProperty(data: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Пауза объекта-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 300000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 25",
      condition: "GOOD",
      ...data,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function addRawVideo(propertyId: string, extra: Record<string, unknown> = {}) {
  const storageKey = `${propertyId}/${randomUUID()}.mp4`;
  const filePath = localVideoFilePath(storageKey);
  if (!filePath) throw new Error("путь хранилища не разрешился");
  await fs.mkdir(pathMod.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.alloc(1024));
  rawDirs.add(pathMod.dirname(filePath));
  return prisma.propertyVideo.create({
    data: { propertyId, storageKey, filename: "raw.mp4", sizeBytes: 1024, uploadedById: montajerId, ...extra },
  });
}

const status = async (id: string) =>
  (await prisma.property.findUniqueOrThrow({ where: { id }, select: { videoHandoffStatus: true } })).videoHandoffStatus;

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Пауза объекта-${runId}` } })).id;
  const hash = await bcrypt.hash(password, 4);
  montajerId = (
    await prisma.agent.create({
      data: { fullName: "Монтажёр паузы", phone: `+99295${tail}`, role: "EDITOR", passwordHash: hash, telegramChatId: MONTAJER_CHAT },
    })
  ).id;
  agentIds.push(montajerId);
  const director = await prisma.agent.create({
    data: { fullName: "Директор паузы", phone: `+99296${tail}`, role: "DIRECTOR", passwordHash: hash },
  });
  directorId = director.id;
  agentIds.push(directorId);
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
  // в той же очереди и путали порядок и счёт (тот же приём, что в
  // video-handoff-queue-order.test.ts).
  await prisma.property.updateMany({
    where: { videoHandoffStatus: { in: ["QUEUED", "SENT_TO_EDITOR"] }, id: { notIn: propertyIds } },
    data: { videoHandoffStatus: "RECEIVED", videoHandoffQueueOrder: null, videoHandoffHeldAt: null },
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
      videoHandoffDispatchStartedAt: null,
      videoHandoffManualSince: null,
      videoHandoffQueueOrder: null,
      videoHandoffHeldAt: null,
      videoHandoffHeldById: null,
      videoHandoffHoldReason: null,
      scheduledPublishAt: null,
      scheduledPublishReason: null,
    },
  });
});

afterAll(async () => {
  await settleBackgroundHandoffDispatches();
  await prisma.settings.update({
    where: { id: "singleton" },
    data: originalSettings ?? { videoHandoffEnabled: false, videoMontajerAgentId: null, videoHandoffQueuePaused: false },
  });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  for (const d of rawDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("A: пауза отдельного объекта", () => {
  it("отложенный пропускается nextInQueue, следующий не отложенный выдан", async () => {
    const holder = await seedProperty();
    const held = await seedProperty();
    const waiting = await seedProperty();
    await queueVideoHandoff(holder.id);
    await queueVideoHandoff(held.id);
    await queueVideoHandoff(waiting.id);

    const holdRes = await holdVideoHandoff(held.id, { byId: directorId, reason: "ждём правки карточки" });
    expect(holdRes).toEqual({ ok: true, shortId: held.shortId });

    // held остаётся в очереди на своём месте (порядок не переставлен) —
    // orderedQueue его видит и помечает, nextInQueue пропускает.
    const state = await videoHandoffQueueState();
    expect(state.queue.map((p) => p.id)).toEqual([held.id, waiting.id]);
    expect(state.queue.find((p) => p.id === held.id)?.heldAt).toBeTruthy();

    const next = await nextInQueue();
    expect(next?.id).toBe(waiting.id);
  });

  it("unhold при свободном месте → выдан", async () => {
    const holder = await seedProperty();
    const only = await seedProperty();
    await addRawVideo(only.id);
    await queueVideoHandoff(holder.id);
    await queueVideoHandoff(only.id);
    expect(await status(only.id)).toBe("QUEUED");

    const holdRes = await holdVideoHandoff(only.id, { byId: directorId });
    expect(holdRes.ok).toBe(true);

    // Место освобождается снятием держателя, но `only` отложен — nextInQueue
    // его пропускает, место остаётся свободным (никого больше в очереди нет).
    sendDocumentFile.mockClear();
    expect(await cancelVideoHandoffQueueEntry(holder.id)).toEqual({ ok: true });
    await settleBackgroundHandoffDispatches();
    expect(await status(only.id)).toBe("QUEUED");
    expect(await nextInQueue()).toBeNull();
    expect(sendDocumentFile).not.toHaveBeenCalled();

    const releaseRes = await releaseVideoHandoffHold(only.id);
    expect(releaseRes).toEqual({ ok: true, shortId: only.shortId });
    await settleBackgroundHandoffDispatches();
    expect(await status(only.id)).toBe("SENT_TO_EDITOR");
    expect(sendDocumentFile).toHaveBeenCalled();
  });

  it("держателя отложить → 409", async () => {
    const holder = await seedProperty();
    await queueVideoHandoff(holder.id);
    expect(await status(holder.id)).toBe("SENT_TO_EDITOR");

    const res = await holdVideoHandoff(holder.id, { byId: directorId });
    expect(res).toEqual({
      ok: false,
      code: "HOLDER_CANNOT_HOLD",
      error: expect.stringContaining("нельзя отложить"),
    });

    const routeRes = await request(app)
      .post(`/api/v1/marketing/video-handoff/${holder.id}/hold`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({});
    expect(routeRes.status).toBe(409);
    expect(routeRes.body.code).toBe("HOLDER_CANNOT_HOLD");
  });
});

describe("B: отправить монтажёру повторно из CRM", () => {
  it("resend при dispatchStartedAt < 15 мин → 409", async () => {
    const holder = await seedProperty();
    await addRawVideo(holder.id);
    await queueVideoHandoff(holder.id);
    await settleBackgroundHandoffDispatches();
    await prisma.property.update({ where: { id: holder.id }, data: { videoHandoffDispatchStartedAt: new Date() } });

    const res = await request(app)
      .post(`/api/v1/marketing/video-handoff/${holder.id}/resend`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BUSY");
  });

  it("resend → dispatchToEditor вызван один раз (мок), ответ приходит быстро", async () => {
    const holder = await seedProperty();
    await addRawVideo(holder.id);
    await queueVideoHandoff(holder.id);
    await settleBackgroundHandoffDispatches();
    sendDocumentFile.mockClear();

    const started = Date.now();
    const res = await request(app)
      .post(`/api/v1/marketing/video-handoff/${holder.id}/resend`)
      .set("Authorization", `Bearer ${directorToken}`);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ started: true });
    // Ответ не ждёт саму отправку (dispatchInBackground) — с моками Telegram
    // это доли секунды, секунда — щедрый запас против шума раннера.
    expect(elapsed).toBeLessThan(1000);

    await settleBackgroundHandoffDispatches();
    expect(sendDocumentFile).toHaveBeenCalledTimes(1);

    await waitFor(
      () => prisma.auditLog.findFirst({ where: { action: "PROPERTY_VIDEO_HANDOFF_RESENT", entityId: holder.id }, select: { id: true } }),
      { label: "запись PROPERTY_VIDEO_HANDOFF_RESENT" }
    );
  });

  it("resend для объекта не у монтажёра → 409 NOT_HOLDER", async () => {
    const waiting = await seedProperty();
    const holder = await seedProperty();
    await queueVideoHandoff(holder.id);
    await queueVideoHandoff(waiting.id);
    expect(await status(waiting.id)).toBe("QUEUED");

    const res = await request(app)
      .post(`/api/v1/marketing/video-handoff/${waiting.id}/resend`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOT_HOLDER");
  });
});

describe("C: карточка объекта отдаёт блок «Монтаж»", () => {
  it("GET /properties/:id отдаёт videoHandoff с delivered по файлам", async () => {
    const holder = await seedProperty();
    await addRawVideo(holder.id, { telegramFileId: "already-delivered" });
    await addRawVideo(holder.id);
    await queueVideoHandoff(holder.id);
    await settleBackgroundHandoffDispatches();

    const res = await request(app).get(`/api/v1/properties/${holder.id}`).set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.videoHandoff).toMatchObject({ status: "SENT_TO_EDITOR", queuePosition: 1 });
    expect(res.body.videoHandoff.montajer).toMatchObject({ id: montajerId });
    expect(res.body.videoHandoff.videos).toHaveLength(2);
    // Оба файла реально ушли монтажёру (отметка montajerDeliveredAt), хотя file_id только у одного:
    // «доставлен» считается и по отметке, иначе большие файлы (ссылкой) вечно «не дошли».
    const delivered = (res.body.videoHandoff.videos as { delivered: boolean }[]).filter((v) => v.delivered);
    expect(delivered).toHaveLength(2);

    // Файл, добавленный ПОСЛЕ отправки, монтажёру не ушёл — он не доставлен.
    await addRawVideo(holder.id);
    const res2 = await request(app).get(`/api/v1/properties/${holder.id}`).set("Authorization", `Bearer ${directorToken}`);
    const after = (res2.body.videoHandoff.videos as { delivered: boolean }[]).filter((v) => v.delivered);
    expect(res2.body.videoHandoff.videos).toHaveLength(3);
    expect(after).toHaveLength(2);
  });

  it("videoHandoff отсутствует (null) для объекта, не проходившего через хендофф", async () => {
    const untouched = await seedProperty();
    const res = await request(app).get(`/api/v1/properties/${untouched.id}`).set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.videoHandoff).toBeNull();
  });
});

describe("D: список — videoHandoffBrief без N+1", () => {
  it("queued/held/editing/received дают правильное состояние, счётчик запросов не растёт со списком", async () => {
    const queued = await seedProperty();
    const held = await seedProperty();
    const editing = await seedProperty();
    const received = await seedProperty();
    await addRawVideo(editing.id, { telegramFileId: "one-of-two" });
    await addRawVideo(editing.id);
    await queueVideoHandoff(editing.id);
    await settleBackgroundHandoffDispatches();
    await queueVideoHandoff(queued.id);
    await queueVideoHandoff(held.id);
    await holdVideoHandoff(held.id, { byId: directorId, reason: "проверка списка" });
    await prisma.property.update({
      where: { id: received.id },
      data: { videoHandoffStatus: "RECEIVED", videoHandoffFinalPath: "/uploads/handoff/x.mp4", videoHandoffReceivedAt: new Date() },
    });

    const findManySpy = vi.spyOn(prisma.propertyVideo, "findMany");
    const res = await request(app)
      .get("/api/v1/properties")
      .query({ q: `Пауза объекта-${runId}` })
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    // Одна выборка доставленных роликов на ВСЮ страницу (WHERE propertyId IN
    // (...)), а не по объекту — иначе счёт запросов растёт со списком (25.09.2026,
    // задание D: «без N+1»).
    expect(findManySpy.mock.calls.length).toBeLessThanOrEqual(1);
    findManySpy.mockRestore();

    const byId = new Map((res.body.items as { id: string; videoHandoffBrief: unknown }[]).map((p) => [p.id, p.videoHandoffBrief]));
    expect(byId.get(queued.id)).toMatchObject({ state: "queued" });
    expect(byId.get(held.id)).toMatchObject({ state: "held" });
    expect(byId.get(editing.id)).toMatchObject({ state: "editing", deliveredOf: [1, 2] });
    expect(byId.get(received.id)).toMatchObject({ state: "received" });
  });
});

describe("G: получатели пушей о монтаже — модераторы, не любой DIRECTOR/ADMIN", () => {
  it("ADMIN, MANAGER без права, MANAGER с правом (выдано вручную), агент объекта — ровно ожидаемый набор, без дублей", async () => {
    const hash = await bcrypt.hash(password, 4);
    const admin = await prisma.agent.create({
      data: { fullName: "Админ получателей", phone: `+99297${tail}0`, role: "ADMIN", passwordHash: hash },
    });
    // MANAGER без права — базовый пресет роли (permissions.ts::ROLE_PRESETS.MANAGER)
    // properties.moderate не содержит, переопределений нет.
    const managerNoRight = await prisma.agent.create({
      data: { fullName: "Менеджер без права получателей", phone: `+99297${tail}1`, role: "MANAGER", passwordHash: hash },
    });
    const managerWithRight = await prisma.agent.create({
      data: {
        fullName: "Менеджер с правом получателей",
        phone: `+99297${tail}2`,
        role: "MANAGER",
        passwordHash: hash,
        permissions: { granted: ["properties.moderate"], revoked: [] },
      },
    });
    const propertyAgent = await prisma.agent.create({
      data: { fullName: "Ответственный агент получателей", phone: `+99297${tail}3`, role: "AGENT", passwordHash: hash },
    });
    agentIds.push(admin.id, managerNoRight.id, managerWithRight.id, propertyAgent.id);

    const recipients = await montageNotificationRecipients(propertyAgent.id);
    const set = new Set(recipients);
    expect(set.has(admin.id)).toBe(true);
    expect(set.has(managerWithRight.id)).toBe(true);
    expect(set.has(propertyAgent.id)).toBe(true);
    expect(set.has(managerNoRight.id)).toBe(false);
    // Без дублей — размер набора совпадает с числом уникальных id.
    expect(recipients.length).toBe(set.size);
  });

  /**
   * НАЙДЕНО ПРИ НАПИСАНИИ ЭТОГО ТЕСТА: задание G просило проверить «DIRECTOR
   * без права» как отдельный случай, но `resolvePermissions` (permissions.ts)
   * жёстко возвращает ДИРЕКТОРУ полный набор прав и намеренно не даёт его
   * урезать («владелец — получает всё и не может быть урезан, иначе компанию
   * можно запереть снаружи»). Такого агента в этой системе не существует —
   * тест ниже фиксирует инвариант вместо несуществующего сценария.
   */
  it("DIRECTOR всегда получатель, даже если в его записи стоит попытка снять право", async () => {
    const hash = await bcrypt.hash(password, 4);
    const director = await prisma.agent.create({
      data: {
        fullName: "Директор получателей",
        phone: `+99297${tail}4`,
        role: "DIRECTOR",
        passwordHash: hash,
        permissions: { granted: [], revoked: ["properties.moderate"] },
      },
    });
    agentIds.push(director.id);
    const recipients = await montageNotificationRecipients();
    expect(new Set(recipients).has(director.id)).toBe(true);
  });
});
