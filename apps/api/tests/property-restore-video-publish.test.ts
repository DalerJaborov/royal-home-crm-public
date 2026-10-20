import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import path from "node:path";
import request from "supertest";

/**
 * ВОССТАНОВЛЕНИЕ ИЗ КОРЗИНЫ ПЕРЕОТКРЫВАЕТ ПУБЛИКАЦИЮ ПРИНЯТОГО РОЛИКА (24.09.2026,
 * находка №130 ночной проверки).
 *
 * Объект с принятым роликом (RECEIVED, файл на диске, publishedChannels пуст)
 * побывал в Корзине: пока он там лежал, задание публикации, дошедшее до своего
 * часа, увидело `deletedAt` и закрылось молча — DONE, без единой ошибки
 * (jobs/videoHandoffPublish.ts: «объект удалили, пока задание ждало своей
 * очереди»). После восстановления строка BackgroundJob уже есть — сторож
 * недоведённых публикаций (videoHandoffUnfinishedPublishWatchdog.ts) видит её
 * и пропускает объект, «Опубликовать сейчас» смотрит на ту же строку. Ролик
 * не публикуется никогда, пока кто-то не заметит и не разберётся руками.
 *
 * Здесь закрытие задания при удалении не прогоняется через крон — оно
 * воспроизведено прямой записью статуса DONE, ровно тем состоянием, в котором
 * реальный сбой оставляет BackgroundJob.
 *
 * Telegram, push и публикация в соцсети — подменены, как и в
 * video-handoff-unfinished-publish.test.ts.
 */

const { sendMessage, sendDocumentFile, sendPushToAgent, sendPushToAgents, publishApprovedPost, publishAfterEditingComplete, logSystemError } =
  vi.hoisted(() => ({
    sendMessage: vi.fn(async () => {}),
    sendDocumentFile: vi.fn(async (_chatId: string, _file: unknown, filename: string) => ({
      message_id: 1,
      document: { file_id: `fid-${filename}`, file_unique_id: `fuid-${filename}` },
    })),
    sendPushToAgent: vi.fn(async () => 1),
    sendPushToAgents: vi.fn(async () => 0),
    publishApprovedPost: vi.fn(async () => [] as unknown[]),
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
// Ворота приёма (checkEditedClip): без ffprobe в песочнице приём пишет «принят
// без проверки» в журнал — подменяем нормальным роликом со звуком.
vi.mock("../src/lib/ffmpeg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ffmpeg.js")>()),
  probeMediaInfo: vi.fn(async () => ({
    hasVideo: true,
    hasAudio: true,
    videoCodec: "h264",
    audioCodec: "aac",
    width: 1080,
    height: 1920,
    rotation: 0,
    durationSec: 12,
    sizeBytes: 1024,
  })),
}));

process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { videoHandoffDir } = await import("../src/upload.js");
const { receiveEditedVideo, videoHandoffPublishDedupeKey, VIDEO_HANDOFF_PUBLISH_JOB_TYPE } = await import("../src/lib/videoHandoff.js");
const { trashProperty } = await import("../src/lib/trashProperty.js");

const runId = Date.now();
let districtId: string;
let montajerId: string;
let adminId: string;
let adminToken: string;
const propertyIds: string[] = [];

async function seedProperty(): Promise<{ id: string; shortId: number }> {
  const property = await prisma.property.create({
    data: {
      title: `Восстановление ролика-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 48,
      price: 300000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 11",
      condition: "GOOD",
      assignedAgentId: montajerId,
      status: "EDITING",
    },
  });
  propertyIds.push(property.id);
  return property;
}

/** Ролик реально принят от монтажёра — тот же путь, что и в проде: файл на
 *  диске, videoHandoffStatus=RECEIVED, задание публикации поставлено PENDING. */
async function receiveAcceptedVideo(propertyId: string): Promise<void> {
  await prisma.property.update({ where: { id: propertyId }, data: { videoHandoffStatus: "SENT_TO_EDITOR" } });
  const result = await receiveEditedVideo(propertyId, Buffer.from("готовый ролик"), "final.mp4");
  if (!result.ok) throw new Error(`приём ролика не удался в тесте: ${result.error}`);
}

beforeEach(async () => {
  if (!districtId) {
    districtId = (await prisma.district.create({ data: { name: `Восстановление ролика-${runId}` } })).id;
  }
  if (!montajerId) {
    montajerId = (
      await prisma.agent.create({
        data: { fullName: "Монтажёр теста-130", phone: `+99297${runId}`, role: "AGENT", passwordHash: await bcrypt.hash("x", 10) },
      })
    ).id;
    await prisma.settings.upsert({
      where: { id: "singleton" },
      update: { videoHandoffEnabled: true, videoMontajerAgentId: montajerId, autoPublishEnabled: true },
      create: { id: "singleton", videoHandoffEnabled: true, videoMontajerAgentId: montajerId, autoPublishEnabled: true },
    });
  }
  if (!adminId) {
    adminId = (
      await prisma.agent.create({
        data: { fullName: "Админ теста-130", phone: `+99298${runId}`, role: "ADMIN", passwordHash: await bcrypt.hash("x", 10) },
      })
    ).id;
    adminToken = signAccessToken({ sub: adminId, role: "ADMIN" });
  }
  await prisma.backgroundJob.deleteMany({ where: { type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE } });
  sendMessage.mockClear();
  sendDocumentFile.mockClear();
  sendPushToAgent.mockClear();
  sendPushToAgents.mockClear();
  publishApprovedPost.mockClear();
  publishAfterEditingComplete.mockClear();
  logSystemError.mockClear();
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [montajerId, adminId].filter(Boolean) } } });
  if (districtId) await prisma.district.deleteMany({ where: { id: districtId } });
  const files = await fs.readdir(videoHandoffDir).catch(() => [] as string[]);
  await Promise.all(
    files.filter((f) => propertyIds.some((id) => f.startsWith(id))).map((f) => fs.unlink(path.join(videoHandoffDir, f)).catch(() => {}))
  );
  await prisma.settings.update({ where: { id: "singleton" }, data: { videoHandoffEnabled: false, videoMontajerAgentId: null, autoPublishEnabled: false } });
  await prisma.$disconnect();
});

describe("Восстановление объекта из Корзины переоткрывает публикацию принятого ролика (находка №130)", () => {
  it("RECEIVED + файл, задание закрылось DONE в Корзине → restore → PENDING-задание существует (одно, не два)", async () => {
    const property = await seedProperty();
    await receiveAcceptedVideo(property.id);

    const before = await prisma.backgroundJob.findFirstOrThrow({ where: { dedupeKey: videoHandoffPublishDedupeKey(property.id) } });
    expect(before.status).toBe("PENDING");

    await trashProperty(property.id, adminId);
    // Пока объект лежал в Корзине, задание дошло до своего часа, увидело
    // deletedAt (jobs/videoHandoffPublish.ts) и закрылось молча — воспроизведено
    // прямой записью статуса, без прогона крона.
    await prisma.backgroundJob.update({ where: { id: before.id }, data: { status: "DONE" } });

    const res = await request(app).post(`/api/v1/properties/${property.id}/restore`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBeLessThan(300);

    const jobs = await prisma.backgroundJob.findMany({ where: { dedupeKey: videoHandoffPublishDedupeKey(property.id) } });
    expect(jobs.length).toBe(1);
    expect(jobs[0].status).toBe("PENDING");
  });

  it("ролик уже частично вышел — restore НЕ переоткрывает задание (повтор по каналам — вручную, как у «Опубликовать сейчас»)", async () => {
    const property = await seedProperty();
    await receiveAcceptedVideo(property.id);
    const before = await prisma.backgroundJob.findFirstOrThrow({ where: { dedupeKey: videoHandoffPublishDedupeKey(property.id) } });
    await prisma.property.update({ where: { id: property.id }, data: { publishedChannels: ["TELEGRAM"] } });

    await trashProperty(property.id, adminId);
    await prisma.backgroundJob.update({ where: { id: before.id }, data: { status: "DONE" } });

    const res = await request(app).post(`/api/v1/properties/${property.id}/restore`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBeLessThan(300);

    const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: before.id } });
    expect(job.status).toBe("DONE"); // не тронуто
  });

  it("объект удалили из очереди/от монтажёра (без готового ролика) — restore не заводит задание публикации", async () => {
    const property = await seedProperty();
    await prisma.property.update({
      where: { id: property.id },
      data: { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() },
    });

    await trashProperty(property.id, adminId);
    // releaseVideoHandoffForTrashed уже перевела его в «синтетический» RECEIVED
    // без файла — то же состояние, что и после снятия с монтажа.
    const trashed = await prisma.property.findUniqueOrThrow({
      where: { id: property.id },
      select: { videoHandoffStatus: true, videoHandoffFinalPath: true },
    });
    expect(trashed.videoHandoffStatus).toBe("RECEIVED");
    expect(trashed.videoHandoffFinalPath).toBeNull();

    const res = await request(app).post(`/api/v1/properties/${property.id}/restore`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBeLessThan(300);

    const job = await prisma.backgroundJob.findFirst({ where: { dedupeKey: videoHandoffPublishDedupeKey(property.id) } });
    expect(job).toBeNull(); // без файла публиковать нечего
  });
});
