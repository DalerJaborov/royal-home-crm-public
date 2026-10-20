import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import path from "node:path";
import request from "supertest";

/**
 * ГОТОВЫЙ РОЛИК НА ЗАМЕНУ — ПРОВЕРКА ПО КЛАССАМ (24.09.2026, владелец: «Проверь
 * баги и по классам и по всему» после правки #869). Каждый блок — одна дыра
 * пути «загрузить готовый ролик → расписание → выход», найденная разбором:
 *  - уже продающийся или проданный объект заново «выходил в продажу»;
 *  - замена во время публикации прошлого ролика терялась, а у прошлого
 *    отваливались сети (файл удалялся из-под задания);
 *  - замена до слота оставляла заданию прежний час;
 *  - недоделанный Reels прошлого ролика публиковался рядом с новым;
 *  - ролик, который сам никуда не уйдёт, обещал час выхода;
 *  - неудачная или отменённая замена тихо отменяла выход прежнего ролика.
 *
 * Сети, пуши и Telegram подменены — тест не ходит наружу.
 */

const { sendMessage, sendPushToAgent, sendPushToAgents, publishApprovedPost, publishAfterEditingComplete, logSystemError } = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => {}),
  sendPushToAgent: vi.fn(async () => {}),
  sendPushToAgents: vi.fn(async () => 0),
  publishApprovedPost: vi.fn(async () => []),
  publishAfterEditingComplete: vi.fn(async () => ({ updated: {} })),
  logSystemError: vi.fn(async () => {}),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
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
const {
  VIDEO_HANDOFF_PUBLISH_JOB_TYPE,
  videoHandoffPublishDedupeKey,
  finalizePropertyAvailability,
  receiveEditedVideo,
  publishHandoffNow,
  closeManualFinalVideoWait,
  reopenForResend,
  undoReopenForResend,
} = await import("../src/lib/videoHandoff.js");
const { videoHandoffPublishJob } = await import("../src/jobs/videoHandoffPublish.js");
const { tiktokPublishRetryDedupeKey, TIKTOK_PUBLISH_RETRY_JOB_TYPE } = await import("../src/jobs/tiktokPublishRetryPolicy.js");

const runId = Date.now();
const password = "testpass123";
const PART_SIZE = 8 * 1024 * 1024;

let districtId: string;
let ownerAgentId: string;
let ownerToken: string;
let marketingAgentId: string;
let marketingToken: string;
let savedAutoPublish = false;
const propertyIds: string[] = [];

type PropertyStatusName = "EDITING" | "AVAILABLE" | "SOLD" | "RESERVED" | "WITHDRAWN";

async function makeProperty(opts: {
  status?: PropertyStatusName;
  handoff?: "SENT_TO_EDITOR" | "RECEIVED" | "NONE";
  publishedChannels?: string[];
  finalPath?: string | null;
  manualSince?: Date | null;
  instagramUrl?: string | null;
  scheduledPublishAt?: Date | null;
} = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Замена ролика ${runId}-${propertyIds.length}`,
      type: "HOUSE",
      areaSqm: 120,
      price: 90000,
      currency: "USD",
      districtId,
      address: "Тестовая, 132",
      condition: "GOOD",
      status: opts.status ?? "AVAILABLE",
      intakeAgentId: ownerAgentId,
      createdById: ownerAgentId,
      videoHandoffStatus: opts.handoff ?? "RECEIVED",
      videoHandoffSentAt: new Date(),
      videoHandoffManualSince: opts.manualSince ?? null,
      publishedChannels: opts.publishedChannels ?? [],
      videoHandoffFinalPath: opts.finalPath === undefined ? "/uploads/handoff/old-final.mp4" : opts.finalPath,
      instagramUrl: opts.instagramUrl ?? null,
      scheduledPublishAt: opts.scheduledPublishAt ?? null,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function setJob(propertyId: string, status: "PENDING" | "RUNNING" | "DONE", runAt = new Date(Date.now() + 3 * 3600_000), attempts = 0) {
  const dedupeKey = videoHandoffPublishDedupeKey(propertyId);
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey } });
  return prisma.backgroundJob.create({
    data: { type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE, payload: { propertyId }, status, runAt, attempts, maxAttempts: 6, dedupeKey },
  });
}

function jobOf(propertyId: string) {
  return prisma.backgroundJob.findUnique({ where: { dedupeKey: videoHandoffPublishDedupeKey(propertyId) } });
}

function startSession(propertyId: string, uploadKey: string, sizeBytes: number) {
  return request(app)
    .post(`/api/v1/properties/${propertyId}/videos/upload-sessions`)
    .set("Authorization", `Bearer ${marketingToken}`)
    .send({ uploadKey, filename: "final.mp4", sizeBytes, contentType: "video/mp4", purpose: "handoff" });
}

async function uploadParts(propertyId: string, sessionId: string, totalParts: number, sizeBytes: number) {
  for (let n = 1; n <= totalParts; n++) {
    const size = n === totalParts ? sizeBytes - PART_SIZE * (totalParts - 1) : PART_SIZE;
    const res = await request(app)
      .put(`/api/v1/properties/${propertyId}/videos/upload-sessions/${sessionId}/parts/${n}`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.alloc(size, n));
    expect(res.status).toBe(200);
  }
}

function complete(propertyId: string, sessionId: string) {
  return request(app)
    .post(`/api/v1/properties/${propertyId}/videos/upload-sessions/${sessionId}/complete`)
    .set("Authorization", `Bearer ${marketingToken}`);
}

async function uploadWhole(propertyId: string, label: string, sizeBytes = 1024 * 1024) {
  const started = await startSession(propertyId, `${runId}-${label}-${Math.random().toString(36).slice(2)}`, sizeBytes);
  expect(started.status).toBe(201);
  await uploadParts(propertyId, started.body.sessionId, started.body.totalParts, sizeBytes);
  return complete(propertyId, started.body.sessionId);
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Замена ролика-${runId}` } })).id;
  const passwordHash = await bcrypt.hash(password, 10);
  const owner = await prisma.agent.create({
    data: { fullName: "Ведущий замены", phone: `+992957${runId}`, role: "AGENT", passwordHash },
  });
  ownerAgentId = owner.id;
  ownerToken = (await request(app).post("/api/v1/auth/login").send({ phone: `+992957${runId}`, password })).body.accessToken;
  const marketer = await prisma.agent.create({
    data: { fullName: "Маркетинг замены", phone: `+992958${runId}`, role: "MARKETING", passwordHash },
  });
  marketingAgentId = marketer.id;
  marketingToken = (await request(app).post("/api/v1/auth/login").send({ phone: `+992958${runId}`, password })).body.accessToken;
  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { autoPublishEnabled: true },
  });
  savedAutoPublish = settings.autoPublishEnabled;
  await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: true } });
});

beforeEach(() => {
  sendMessage.mockClear();
  sendPushToAgent.mockClear();
  sendPushToAgents.mockClear();
  publishApprovedPost.mockClear();
  publishAfterEditingComplete.mockClear();
  logSystemError.mockClear();
});

// Задания этого файла не должны оставаться в общей базе между тестами: соседний
// процесс гоняет прогоны очереди заданий, и ждущее «сейчас» он подобрал бы сам.
afterEach(async () => {
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: propertyIds.map(videoHandoffPublishDedupeKey) } } });
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: savedAutoPublish } });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: propertyIds.map(videoHandoffPublishDedupeKey) } } });
  await prisma.pendingInstagramContainer.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.videoUploadSession.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [ownerAgentId, marketingAgentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  const files = await fs.readdir(videoHandoffDir).catch(() => [] as string[]);
  await Promise.all(
    files.filter((f) => propertyIds.some((id) => f.startsWith(id))).map((f) => fs.unlink(path.join(videoHandoffDir, f)).catch(() => {}))
  );
  await prisma.$disconnect();
});

describe("Выход в продажу — только из конвейера", () => {
  it("уже продающийся объект не «выходит» заново: ни истории, ни пуша, ни сброса срока", async () => {
    const stageEnteredAt = new Date(Date.now() - 10 * 86400_000);
    const p = await makeProperty({ status: "AVAILABLE", instagramUrl: "https://www.instagram.com/reel/Old/" });
    await prisma.property.update({ where: { id: p.id }, data: { stageEnteredAt } });

    const result = await finalizePropertyAvailability(p.id);

    expect(result.wentAvailable).toBe(false);
    expect(publishAfterEditingComplete).not.toHaveBeenCalled();
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { stageEnteredAt: true } });
    expect(after.stageEnteredAt?.getTime()).toBe(stageEnteredAt.getTime());
  });

  it.each(["SOLD", "RESERVED", "WITHDRAWN"] as const)("поздний успех публикации не возвращает %s в продажу", async (status) => {
    const p = await makeProperty({ status, instagramUrl: "https://www.instagram.com/reel/Late/" });

    const result = await finalizePropertyAvailability(p.id);

    expect(result.wentAvailable).toBe(false);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { status: true } });
    expect(after.status).toBe(status);
    expect(publishAfterEditingComplete).not.toHaveBeenCalled();
  });

  it("два одновременных вызова выводят объект в продажу один раз (без дубля «монтаж завершён»)", async () => {
    const p = await makeProperty({ status: "EDITING", instagramUrl: "https://www.instagram.com/reel/Race/" });
    await prisma.propertyPhoto.create({ data: { propertyId: p.id, url: "/x.jpg", thumbUrl: "/x-t.jpg", order: 0 } });

    const [a, b] = await Promise.all([finalizePropertyAvailability(p.id), finalizePropertyAvailability(p.id)]);

    expect([a.wentAvailable, b.wentAvailable].filter(Boolean)).toHaveLength(1);
    expect(publishAfterEditingComplete).toHaveBeenCalledTimes(1);
  });

  it("удалённый объект не возвращается в продажу", async () => {
    const p = await makeProperty({ status: "EDITING", instagramUrl: "https://www.instagram.com/reel/Del/" });
    await prisma.property.update({ where: { id: p.id }, data: { deletedAt: new Date() } });

    const result = await finalizePropertyAvailability(p.id);

    expect(result.wentAvailable).toBe(false);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { status: true } });
    expect(after.status).toBe("EDITING");
  });
});

describe("Замена во время публикации прошлого ролика", () => {
  it("открыть замену нельзя, пока прошлый ролик уходит в сети: 409, прежний файл и статус целы", async () => {
    const p = await makeProperty({ publishedChannels: ["YOUTUBE"] });
    await setJob(p.id, "RUNNING", new Date());

    const res = await startSession(p.id, `${runId}-running-${Math.random()}`, 1024);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/уходит в сети/);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffStatus: true, videoHandoffFinalPath: true } });
    expect(after.videoHandoffStatus).toBe("RECEIVED");
    expect(after.videoHandoffFinalPath).toBe("/uploads/handoff/old-final.mp4");
  });

  it("файл, пришедший мимо открытия (бот, уже открытая сессия), тоже не принимается: объект ждёт дальше, новый файл убран", async () => {
    const p = await makeProperty({ handoff: "SENT_TO_EDITOR" });
    await setJob(p.id, "RUNNING", new Date());

    const result = await receiveEditedVideo(p.id, Buffer.from("новый ролик"), "new.mp4");

    expect(result.ok).toBe(false);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffStatus: true, videoHandoffFinalPath: true } });
    expect(after.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(after.videoHandoffFinalPath).toBe("/uploads/handoff/old-final.mp4");
    const leftovers = (await fs.readdir(videoHandoffDir).catch(() => [] as string[])).filter((f) => f.startsWith(p.id));
    expect(leftovers).toEqual([]);
  });
});

describe("Замена до своего часа", () => {
  it("ждущее задание прошлого ролика получает новый час и чистую лестницу повторов", async () => {
    const p = await makeProperty({ publishedChannels: ["YOUTUBE", "TIKTOK"] });
    await setJob(p.id, "PENDING", new Date(Date.now() + 20 * 3600_000), 3);

    const res = await uploadWhole(p.id, "pending-runat");

    expect(res.status).toBe(200);
    expect(typeof res.body.scheduledPublishAt).toBe("string");
    const [after, job] = await Promise.all([
      prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { scheduledPublishAt: true } }),
      jobOf(p.id),
    ]);
    expect(job?.status).toBe("PENDING");
    expect(job?.runAt.getTime()).toBe(after.scheduledPublishAt!.getTime());
    expect(job?.attempts).toBe(0);
  });

  it("недоделанный Reels прошлого ролика отменяется — старый ролик не выйдет рядом с новым", async () => {
    const p = await makeProperty({ publishedChannels: ["YOUTUBE"] });
    const container = await prisma.pendingInstagramContainer.create({
      data: { propertyId: p.id, containerId: `c-${runId}-${Math.random().toString(36).slice(2)}`, kind: "REEL" },
    });

    const res = await uploadWhole(p.id, "cancel-reel");

    expect(res.status).toBe(200);
    const after = await prisma.pendingInstagramContainer.findUniqueOrThrow({ where: { id: container.id } });
    expect(after.status).toBe("CANCELLED");
  });
});

describe("Ролик, который сам никуда не уйдёт, не обещает час", () => {
  it("объект уже во всех пяти сетях: причина вместо часа, слот не занят, пустое задание прошлого ролика убрано", async () => {
    const p = await makeProperty({
      publishedChannels: ["INSTAGRAM", "FACEBOOK", "TELEGRAM", "YOUTUBE", "TIKTOK"],
      scheduledPublishAt: new Date(Date.now() + 5 * 3600_000),
    });
    await setJob(p.id, "PENDING");

    const res = await uploadWhole(p.id, "all-five");

    expect(res.status).toBe(200);
    expect(res.body.scheduledPublishAt).toBeNull();
    expect(res.body.notPublishingReason).toMatch(/Убрать из соцсетей/);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { scheduledPublishAt: true, videoHandoffStatus: true } });
    expect(after.videoHandoffStatus).toBe("RECEIVED");
    expect(after.scheduledPublishAt).toBeNull();
    expect(await jobOf(p.id)).toBeNull();
  });

  it("проданный объект: причина вместо часа, и «Опубликовать сейчас» честно отказывает", async () => {
    const p = await makeProperty({ status: "SOLD" });

    const res = await uploadWhole(p.id, "sold");

    expect(res.status).toBe(200);
    expect(res.body.notPublishingReason).toMatch(/продан/);
    expect(await jobOf(p.id)).toBeNull();
    const now = await publishHandoffNow(p.id);
    expect(now.ok).toBe(false);
  });

  it("автопубликация выключена: причина вместо часа", async () => {
    const p = await makeProperty();
    await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: false } });
    try {
      const res = await uploadWhole(p.id, "autopublish-off");
      expect(res.status).toBe(200);
      expect(res.body.notPublishingReason).toMatch(/Автопубликация выключена/);
      expect(res.body.scheduledPublishAt).toBeNull();
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: true } });
    }
  });
});

describe("Неудачная или отменённая замена не отменяет прежний ролик", () => {
  it("отменили загрузку — объект сразу снова с прежним роликом, а не «у монтажёра» на сутки", async () => {
    const at = new Date(Date.now() + 4 * 3600_000);
    const p = await makeProperty({ scheduledPublishAt: at });
    await setJob(p.id, "PENDING", at);

    const started = await startSession(p.id, `${runId}-abort-${Math.random()}`, 1024);
    expect(started.status).toBe(201);
    const opened = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffStatus: true } });
    expect(opened.videoHandoffStatus).toBe("SENT_TO_EDITOR");

    const aborted = await request(app)
      .delete(`/api/v1/properties/${p.id}/videos/upload-sessions/${started.body.sessionId}`)
      .set("Authorization", `Bearer ${marketingToken}`);
    expect(aborted.status).toBe(204);

    const after = await prisma.property.findUniqueOrThrow({
      where: { id: p.id },
      select: { videoHandoffStatus: true, videoHandoffManualSince: true, videoHandoffFinalPath: true },
    });
    expect(after.videoHandoffStatus).toBe("RECEIVED");
    expect(after.videoHandoffManualSince).toBeNull();
    expect(after.videoHandoffFinalPath).toBe("/uploads/handoff/old-final.mp4");
    const job = await jobOf(p.id);
    expect(job?.status).toBe("PENDING");
    expect(job?.runAt.getTime()).toBe(at.getTime());
  });

  it("приём не удался на завершении — объект возвращается к прежнему ролику", async () => {
    const p = await makeProperty();
    const sizeBytes = 1024;
    const started = await startSession(p.id, `${runId}-fail-${Math.random()}`, sizeBytes);
    expect(started.status).toBe(201);
    await uploadParts(p.id, started.body.sessionId, started.body.totalParts, sizeBytes);
    // Пока файл докачивался, прошлый ролик ушёл в публикацию — приём откажет.
    await setJob(p.id, "RUNNING", new Date());

    const res = await complete(p.id, started.body.sessionId);

    expect(res.status).toBe(409);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffStatus: true, videoHandoffManualSince: true } });
    expect(after.videoHandoffStatus).toBe("RECEIVED");
    expect(after.videoHandoffManualSince).toBeNull();
  });

  it("задание прежнего ролика, отработавшее вхолостую во время ожидания, ставится заново", async () => {
    const manualSince = new Date(Date.now() - 3600_000);
    const p = await makeProperty({ handoff: "SENT_TO_EDITOR", manualSince, scheduledPublishAt: new Date(Date.now() - 1800_000) });
    // Час пришёл, пока объект стоял открытым под замену: задание увидело «не
    // RECEIVED» и завершилось, ничего не опубликовав.
    await setJob(p.id, "DONE", new Date(Date.now() - 1800_000));

    expect(await closeManualFinalVideoWait(p.id)).toBe(true);

    const job = await jobOf(p.id);
    expect(job?.status).toBe("PENDING");
    expect(job!.runAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("настоящая передача монтажёру (без ручного ожидания) не трогается", async () => {
    const p = await makeProperty({ handoff: "SENT_TO_EDITOR", manualSince: null });

    expect(await closeManualFinalVideoWait(p.id)).toBe(false);

    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffStatus: true } });
    expect(after.videoHandoffStatus).toBe("SENT_TO_EDITOR");
  });
});

/* Пересылка файла с номером объекта, пока место монтажёра держит другой
   (24.09.2026, telegram/bot.ts): объект открывается рядом с держателем, но
   места не занимает — иначе следующий файл без номера лёг бы на него. */
describe("Пересылка рядом с держателем места", () => {
  it("открывает объект, не делая его держателем; приём закрывает ожидание", async () => {
    const p = await makeProperty({ publishedChannels: [] });

    expect(await reopenForResend(p.id, { besideHolder: true })).toBeInstanceOf(Date);
    const opened = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffStatus: true, videoHandoffManualSince: true } });
    expect(opened.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(opened.videoHandoffManualSince).not.toBeNull();

    const result = await receiveEditedVideo(p.id, Buffer.from("исправленный ролик"), "fixed.mp4");
    expect(result.ok).toBe(true);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffStatus: true, videoHandoffManualSince: true } });
    expect(after.videoHandoffStatus).toBe("RECEIVED");
    expect(after.videoHandoffManualSince).toBeNull();
  });

  it("файл не принят — откат возвращает объект к прежнему ролику без отметки ожидания", async () => {
    const p = await makeProperty();
    const reopenedAt = await reopenForResend(p.id, { besideHolder: true });
    expect(reopenedAt).toBeInstanceOf(Date);

    await undoReopenForResend(p.id, reopenedAt ?? undefined);

    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffStatus: true, videoHandoffManualSince: true } });
    expect(after.videoHandoffStatus).toBe("RECEIVED");
    expect(after.videoHandoffManualSince).toBeNull();
  });
});

/* ПАЧКА «ПЕРЕЗАЛИВ ЧЕСТНО» (25.09.2026, docs/handoff-2026-09-25-montage-control-spec.md,
   Б1/Б3/Б4 + раздел 6). */
describe("Б4: правда о старых постах при замене", () => {
  it("приём замены при уже вышедшем Instagram — в ответе сказано, что там остался старый ролик", async () => {
    const p = await makeProperty({ publishedChannels: ["INSTAGRAM"] });

    const res = await uploadWhole(p.id, "old-left");

    expect(res.status).toBe(200);
    expect(res.body.oldVideoLeftIn).toEqual(["INSTAGRAM"]);
  });

  it("объект ещё нигде не вышел — старого ролика нет нигде", async () => {
    const p = await makeProperty({ publishedChannels: [] });

    const res = await uploadWhole(p.id, "old-none");

    expect(res.status).toBe(200);
    expect(res.body.oldVideoLeftIn).toEqual([]);
  });

  it("тот же список в результате приёма из бота (квитанция монтажёру)", async () => {
    const p = await makeProperty({ handoff: "SENT_TO_EDITOR", publishedChannels: ["YOUTUBE", "FACEBOOK"] });

    const result = await receiveEditedVideo(p.id, Buffer.from("новый ролик"), "new.mp4");

    expect(result.ok).toBe(true);
    expect(result.ok && result.oldVideoLeftIn).toEqual(["YOUTUBE", "FACEBOOK"]);
  });
});

describe("Б1: проданное не публикуем — ручные кнопки", () => {
  it("«Опубликовать в TikTok» для проданного объекта — 409 с причиной", async () => {
    const p = await makeProperty({ status: "SOLD" });

    const res = await request(app).post(`/api/v1/properties/${p.id}/tiktok-publish`).set("Authorization", `Bearer ${marketingToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/продан/);
    expect(publishApprovedPost).not.toHaveBeenCalled();
  });

  it("«Выложить в истории» для снятого объекта — 409 с причиной", async () => {
    const p = await makeProperty({ status: "WITHDRAWN" });

    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/instagram-stories-publish`)
      .set("Authorization", `Bearer ${marketingToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/снят с продажи/);
  });

  it("задание публикации пропустило проданный объект — причина записана на объект", async () => {
    const at = new Date(Date.now() - 60_000);
    const p = await makeProperty({ status: "SOLD", scheduledPublishAt: at });

    await videoHandoffPublishJob.run({ propertyId: p.id }, { attempt: 1 } as never);

    expect(publishApprovedPost).not.toHaveBeenCalled();
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { scheduledPublishReason: true, scheduledPublishAt: true } });
    expect(after.scheduledPublishReason).toBe("Не вышло: объект продан.");
    expect(after.scheduledPublishAt?.getTime()).toBe(at.getTime());
  });
});

describe("Б3: «Убрать из соцсетей» против идущей публикации", () => {
  it("RUNNING-задание публикации — 409, посты не тронуты", async () => {
    const p = await makeProperty({ publishedChannels: ["YOUTUBE"] });
    await setJob(p.id, "RUNNING", new Date());

    const res = await request(app).post(`/api/v1/properties/${p.id}/social-unpublish`).set("Authorization", `Bearer ${marketingToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/идёт публикация/);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { publishedChannels: true } });
    expect(after.publishedChannels).toEqual(["YOUTUBE"]);
  });

  it("RUNNING-повтор TikTok — тоже 409", async () => {
    const p = await makeProperty({ publishedChannels: ["YOUTUBE"] });
    const dedupeKey = tiktokPublishRetryDedupeKey(p.id);
    await prisma.backgroundJob.create({
      data: { type: TIKTOK_PUBLISH_RETRY_JOB_TYPE, payload: { propertyId: p.id }, status: "RUNNING", runAt: new Date(), maxAttempts: 8, dedupeKey },
    });
    try {
      const res = await request(app).post(`/api/v1/properties/${p.id}/social-unpublish`).set("Authorization", `Bearer ${marketingToken}`);
      expect(res.status).toBe(409);
    } finally {
      await prisma.backgroundJob.deleteMany({ where: { dedupeKey } });
    }
  });

  it("удалённый объект — 404, снимать нечего", async () => {
    const p = await makeProperty({ publishedChannels: ["YOUTUBE"] });
    await prisma.property.update({ where: { id: p.id }, data: { deletedAt: new Date() } });

    const res = await request(app).post(`/api/v1/properties/${p.id}/social-unpublish`).set("Authorization", `Bearer ${marketingToken}`);

    expect(res.status).toBe(404);
  });
});
