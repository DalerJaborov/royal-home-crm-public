import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * СТОРОЖ НЕДОВЕДЁННЫХ ПУБЛИКАЦИЙ + ЗАДАНИЕ ПУБЛИКАЦИИ (21.09.2026, случай №114).
 *
 * Объект №114: монтажёр прислал ролик, бот ответил приёмом, файл лёг на диск —
 * и на этом всё оборвалось. Рестарт контейнеров посреди публикации убил работу
 * молча: ни одного исключения, `videoHandoffStatus` остался RECEIVED,
 * `publishedChannels` пуст, объект завис в EDITING навсегда.
 *
 * ГЛАВНАЯ ЗАЩИТА теперь — сама очередь фоновых заданий (jobs/runner.ts,
 * подбор зависших RUNNING) — покрыта существующим background-jobs.test.ts.
 * Этот файл проверяет ДВЕ вещи, специфичные для случая №114:
 *  1. `jobs/videoHandoffPublish.ts::run/onGiveUp` — адаптер к очереди, вызывает
 *     publishHandoffResult (не копия), уведомляет, освобождает очередь монтажа.
 *  2. `lib/videoHandoffUnfinishedPublishWatchdog.ts` — узкая страховка на
 *     случай, если само задание не встало в очередь вовсе.
 *
 * Telegram, push и публикация в соцсети — подменены, как и в video-handoff.test.ts.
 */

const { sendMessage, sendDocumentFile, sendPushToAgents, publishApprovedPost, publishAfterEditingComplete, logSystemError } =
  vi.hoisted(() => ({
    sendMessage: vi.fn(async () => {}),
    sendDocumentFile: vi.fn(async () => {}),
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
// Ворота приёма (checkEditedClip, 23.09.2026): в песочнице ffprobe нет, и без
// мока приём пишет строку «принят без проверки» в журнал — тест onGiveUp ждёт
// ровно одно уведомление, поэтому подменяем probe нормальным роликом со звуком.
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

const { prisma } = await import("../src/db.js");
const { videoHandoffDir } = await import("../src/upload.js");
const { receiveEditedVideo, videoHandoffPublishDedupeKey, VIDEO_HANDOFF_PUBLISH_JOB_TYPE } = await import(
  "../src/lib/videoHandoff.js"
);
const { videoHandoffPublishJob } = await import("../src/jobs/videoHandoffPublish.js");
const { runVideoHandoffUnfinishedPublishWatchdogTick } = await import(
  "../src/lib/videoHandoffUnfinishedPublishWatchdog.js"
);

const runId = Date.now();
let districtId: string;
let montajerId: string;
let directorId: string;
const propertyIds: string[] = [];

async function seedProperty(): Promise<{ id: string; shortId: number }> {
  const property = await prisma.property.create({
    data: {
      title: `Недоведённая публикация-${runId}-${propertyIds.length}`,
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

/** Готовый ролик от монтажёра — реально принят (тот же путь, что и в проде),
 *  но задание публикации сразу СНИМАЕМ, чтобы смоделировать «не встало в
 *  очередь» — ровно тот узкий случай, который ловит сторож. */
async function receiveWithoutPublishJob(propertyId: string): Promise<void> {
  await prisma.property.update({ where: { id: propertyId }, data: { videoHandoffStatus: "SENT_TO_EDITOR" } });
  await receiveEditedVideo(propertyId, Buffer.from("готовый ролик"), "final.mp4");
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: videoHandoffPublishDedupeKey(propertyId) } });
}

async function ageReceivedAt(propertyId: string, minutesAgo: number): Promise<void> {
  await prisma.property.update({
    where: { id: propertyId },
    data: { videoHandoffReceivedAt: new Date(Date.now() - minutesAgo * 60_000) },
  });
}

beforeEach(async () => {
  if (!districtId) {
    const district = await prisma.district.create({ data: { name: `Недоведённая публикация-${runId}` } });
    districtId = district.id;
  }
  if (!montajerId) {
    const agent = await prisma.agent.create({
      data: { fullName: "Монтажёр теста-114", phone: `+99297${runId}`, role: "AGENT", passwordHash: await bcrypt.hash("x", 10) },
    });
    montajerId = agent.id;
    await prisma.settings.upsert({
      where: { id: "singleton" },
      update: { videoHandoffEnabled: true, videoMontajerAgentId: montajerId, autoPublishEnabled: true },
      create: { id: "singleton", videoHandoffEnabled: true, videoMontajerAgentId: montajerId, autoPublishEnabled: true },
    });
  }
  if (!directorId) {
    const director = await prisma.agent.create({
      data: { fullName: "Директор теста-114", phone: `+99299${runId}`, role: "DIRECTOR", passwordHash: await bcrypt.hash("x", 10) },
    });
    directorId = director.id;
  }
  await prisma.backgroundJob.deleteMany({ where: { type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE } });
  sendMessage.mockClear();
  sendDocumentFile.mockClear();
  sendPushToAgents.mockClear();
  publishApprovedPost.mockClear();
  publishAfterEditingComplete.mockClear();
  logSystemError.mockClear();
});

afterEach(async () => {
  if (propertyIds.length) {
    await prisma.property.updateMany({
      where: { id: { in: propertyIds } },
      data: { videoHandoffStatus: "NONE", videoHandoffSentAt: null },
    });
  }
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [montajerId, directorId].filter(Boolean) } } });
  if (districtId) await prisma.district.deleteMany({ where: { id: districtId } });
  const files = await fs.readdir(videoHandoffDir).catch(() => [] as string[]);
  await Promise.all(
    files.filter((f) => propertyIds.some((id) => f.startsWith(id))).map((f) => fs.unlink(path.join(videoHandoffDir, f)).catch(() => {}))
  );
  await prisma.settings.update({ where: { id: "singleton" }, data: { videoHandoffEnabled: false, videoMontajerAgentId: null, autoPublishEnabled: false } });
  await prisma.$disconnect();
});

describe("Сторож недоведённых публикаций (videoHandoffUnfinishedPublishWatchdog)", () => {
  it("RECEIVED, файл есть, каналов нет, старше порога, задания нет — сторож ставит задание и пишет в журнал", async () => {
    const property = await seedProperty();
    await receiveWithoutPublishJob(property.id);
    await ageReceivedAt(property.id, 30);

    const { recovered } = await runVideoHandoffUnfinishedPublishWatchdogTick();

    expect(recovered).toBe(1);
    const job = await prisma.backgroundJob.findFirst({ where: { dedupeKey: videoHandoffPublishDedupeKey(property.id) } });
    expect(job).not.toBeNull();
    expect(job?.status).toBe("PENDING");
    expect(logSystemError).toHaveBeenCalledWith("video-handoff", expect.stringContaining("сторож поставил её заново"));
  });

  it("у объекта выбрано время публикации — сторож ставит задание НА ЭТОТ СЛОТ, а не «прямо сейчас»", async () => {
    const property = await seedProperty();
    await receiveWithoutPublishJob(property.id);
    await ageReceivedAt(property.id, 30);
    // Слот пишется той же записью, что и статус RECEIVED, то есть ДО постановки
    // задания — в том самом разрыве, который сторож и закрывает.
    const slot = new Date(Date.now() + 3 * 60 * 60 * 1000);
    await prisma.property.update({ where: { id: property.id }, data: { scheduledPublishAt: slot } });

    const { recovered } = await runVideoHandoffUnfinishedPublishWatchdogTick();

    expect(recovered).toBe(1);
    const job = await prisma.backgroundJob.findFirstOrThrow({ where: { dedupeKey: videoHandoffPublishDedupeKey(property.id) } });
    expect(job.runAt.getTime()).toBe(slot.getTime());
  });

  it("принят только что — сторож не трогает (публикация может идти прямо сейчас)", async () => {
    const property = await seedProperty();
    await receiveWithoutPublishJob(property.id);
    // videoHandoffReceivedAt уже "только что" (receiveEditedVideo пишет new Date()).

    const { recovered } = await runVideoHandoffUnfinishedPublishWatchdogTick();

    expect(recovered).toBe(0);
    const job = await prisma.backgroundJob.findFirst({ where: { dedupeKey: videoHandoffPublishDedupeKey(property.id) } });
    expect(job).toBeNull();
  });

  it("часть каналов уже опубликована — сторож не трогает (узкий случай — только полностью пустые каналы)", async () => {
    const property = await seedProperty();
    await receiveWithoutPublishJob(property.id);
    await ageReceivedAt(property.id, 30);
    await prisma.property.update({ where: { id: property.id }, data: { publishedChannels: ["TELEGRAM"] } });

    const { recovered } = await runVideoHandoffUnfinishedPublishWatchdogTick();

    expect(recovered).toBe(0);
    const job = await prisma.backgroundJob.findFirst({ where: { dedupeKey: videoHandoffPublishDedupeKey(property.id) } });
    expect(job).toBeNull();
  });

  it("уже есть задание (любого статуса) — сторож не ставит второе, дубля нет", async () => {
    const property = await seedProperty();
    await receiveWithoutPublishJob(property.id);
    await ageReceivedAt(property.id, 30);
    await prisma.backgroundJob.create({
      data: {
        type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE,
        payload: { propertyId: property.id },
        status: "GIVEN_UP",
        maxAttempts: 6,
        attempts: 6,
      },
    });

    const { recovered } = await runVideoHandoffUnfinishedPublishWatchdogTick();

    expect(recovered).toBe(0);
    const jobs = await prisma.backgroundJob.findMany({ where: { type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE } });
    expect(jobs.length).toBe(1);
  });

  /**
   * №192 (ночная проверка 24.09): у объекта уже был круг монтажа, его задание
   * публикации давно DONE. Новый ролик принят, а постановка задания этого круга
   * сорвалась — сторож видел старую строку DONE и пропускал объект навсегда.
   * Задание прошлого круга (закончено ДО приёма текущего ролика) не в счёт.
   */
  it("задание прошлого круга (DONE до приёма нового ролика) — не в счёт, сторож ставит задание этого круга", async () => {
    const property = await seedProperty();
    await receiveWithoutPublishJob(property.id);
    await ageReceivedAt(property.id, 30);
    const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    await prisma.backgroundJob.create({
      data: {
        type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE,
        payload: { propertyId: property.id },
        status: "DONE",
        maxAttempts: 6,
        attempts: 1,
        runAt: longAgo,
        createdAt: longAgo,
        updatedAt: longAgo,
      },
    });

    const { recovered } = await runVideoHandoffUnfinishedPublishWatchdogTick();

    expect(recovered).toBe(1);
    const job = await prisma.backgroundJob.findFirst({ where: { dedupeKey: videoHandoffPublishDedupeKey(property.id) } });
    expect(job?.status).toBe("PENDING");
  });

  it("объект без готового ролика на диске (videoHandoffFinalPath пуст) — не падаем, вообще не выбираем как кандидата", async () => {
    const property = await seedProperty();
    // RECEIVED без файла — тот самый "синтетический" путь (skip/cancel/trash),
    // videoHandoffFinalPath и videoHandoffReceivedAt остаются null.
    await prisma.property.update({ where: { id: property.id }, data: { videoHandoffStatus: "RECEIVED" } });

    const { recovered } = await runVideoHandoffUnfinishedPublishWatchdogTick();

    expect(recovered).toBe(0);
  });
});

describe("Задание публикации (jobs/videoHandoffPublish.ts)", () => {
  it("успех — публикует через publishHandoffResult, уведомляет, освобождает очередь", async () => {
    const property = await seedProperty();
    await receiveWithoutPublishJob(property.id);
    publishApprovedPost.mockResolvedValueOnce([{ channel: "TELEGRAM", ok: true, postId: "tg-1" }]);

    await videoHandoffPublishJob.run({ propertyId: property.id });

    expect(publishApprovedPost).toHaveBeenCalledTimes(1);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id }, select: { publishedChannels: true } });
    expect(after.publishedChannels).toEqual(["TELEGRAM"]);
    expect(sendPushToAgents).toHaveBeenCalledTimes(1);
    const [recipients, payload] = sendPushToAgents.mock.calls[0] as [string[], { title: string; body: string }];
    expect(recipients).toEqual(expect.arrayContaining([montajerId, directorId]));
    expect(payload.body).toContain("Ушло: TELEGRAM");
  });

  it("файл принят, но на диске его нет — честная запись в журнал, не падаем, уведомляем", async () => {
    const property = await seedProperty();
    await receiveWithoutPublishJob(property.id);
    const state = await prisma.property.findUniqueOrThrow({ where: { id: property.id }, select: { videoHandoffFinalPath: true } });
    await fs.unlink(path.join(videoHandoffDir, path.basename(state.videoHandoffFinalPath!))).catch(() => {});

    await expect(videoHandoffPublishJob.run({ propertyId: property.id })).resolves.toBeUndefined();

    expect(publishApprovedPost).not.toHaveBeenCalled();
    expect(logSystemError).toHaveBeenCalledWith("video-handoff", expect.stringContaining("файла ролика на диске нет"), expect.objectContaining({ dedupKey: expect.any(String) }));
    expect(sendPushToAgents).toHaveBeenCalledTimes(1);
  });

  it("статус сдвинули между постановкой и исполнением (пересылка/отмена) — тихий no-op, без publishApprovedPost", async () => {
    const property = await seedProperty();
    await receiveWithoutPublishJob(property.id);
    // Пересылка после ошибки открывает объект заново на приём — устаревшее
    // задание больше не должно публиковать по старому payload.
    await prisma.property.update({ where: { id: property.id }, data: { videoHandoffStatus: "SENT_TO_EDITOR" } });

    await videoHandoffPublishJob.run({ propertyId: property.id });

    expect(publishApprovedPost).not.toHaveBeenCalled();
    expect(sendPushToAgents).not.toHaveBeenCalled();
  });

  it("объект удалили, пока задание ждало очереди — no-op, публиковать нечего", async () => {
    const property = await seedProperty();
    await receiveWithoutPublishJob(property.id);
    await prisma.property.update({ where: { id: property.id }, data: { deletedAt: new Date() } });

    await videoHandoffPublishJob.run({ propertyId: property.id });

    expect(publishApprovedPost).not.toHaveBeenCalled();
    await prisma.property.update({ where: { id: property.id }, data: { deletedAt: null } });
  });

  /**
   * ОБЪЕКТ СНЯЛИ С ПРОДАЖИ, ПОКА РОЛИК ЖДАЛ СЛОТА (24.09.2026, ночная проверка).
   * Задание смотрело только deletedAt/videoHandoffStatus/файл — снятый объект
   * уходил в пять сетей, а finalizePropertyAvailability возвращал его в
   * «В продаже» и на сайт. Фото и ссылка на обзор здесь для того, чтобы у
   * выхода в продажу не было блокеров — без починки статус реально
   * переворачивается в AVAILABLE, а не «случайно» держится на блокерах.
   */
  it("объект сняли с продажи (WITHDRAWN), пока задание ждало — не публикуем, статус не трогаем, пишем в журнал", async () => {
    const property = await seedProperty();
    await receiveWithoutPublishJob(property.id);
    await prisma.propertyPhoto.create({
      data: { propertyId: property.id, url: "/uploads/p0.webp", thumbUrl: "/uploads/thumbs/p0.webp", order: 0 },
    });
    await prisma.property.update({
      where: { id: property.id },
      data: { status: "WITHDRAWN", instagramUrl: "https://www.instagram.com/reel/AbCdEf/" },
    });
    publishApprovedPost.mockResolvedValueOnce([{ channel: "TELEGRAM", ok: true, postId: "tg-withdrawn" }]);

    await expect(videoHandoffPublishJob.run({ propertyId: property.id })).resolves.toBeUndefined();

    expect(publishApprovedPost).not.toHaveBeenCalled();
    expect(publishAfterEditingComplete).not.toHaveBeenCalled();
    const after = await prisma.property.findUniqueOrThrow({
      where: { id: property.id },
      select: { status: true, publishedChannels: true, videoHandoffStatus: true },
    });
    expect(after.status).toBe("WITHDRAWN");
    expect(after.publishedChannels).toEqual([]);
    expect(after.videoHandoffStatus).toBe("RECEIVED"); // принятый ролик не теряем — вернут в продажу, опубликуют руками
    expect(logSystemError).toHaveBeenCalledWith("video-handoff", expect.stringContaining("публикация пропущена"), expect.objectContaining({ dedupKey: expect.any(String) }));
    expect(sendPushToAgents).not.toHaveBeenCalled(); // пуш «не удалось проверить» — про сбой, а это не сбой
  });

  /**
   * УВЕДОМЛЕНИЕ И ЖУРНАЛ ЗДЕСЬ НЕ ОТ НАС (после слияния с PR #627 «Что не
   * доехало», 21.09.2026): `jobs/runner.ts` уже логирует и зовёт
   * `notifyStuckWorkGivenUp` для ЛЮБОГО GIVEN_UP ДО вызова этого хука —
   * дублировать своей строкой значило бы нарушить «одно событие — одно
   * уведомление». Единственное, что наш `onGiveUp` обязан сделать сам, —
   * освободить место монтажёра, о котором генерик знать не может.
   */
  it("onGiveUp — освобождает очередь монтажа, но не дублирует общее уведомление «Что не доехало»", async () => {
    const property = await seedProperty();
    await receiveWithoutPublishJob(property.id);
    // property уже RECEIVED (реальный порядок: onGiveUp наступает уже ПОСЛЕ
    // того, как объект покинул SENT_TO_EDITOR) — место монтажёра свободно, и
    // ждущий своей очереди должен получить его прямо сейчас.
    const queued = await seedProperty();
    await prisma.property.update({
      where: { id: queued.id },
      data: { videoHandoffStatus: "QUEUED", videoHandoffSentAt: new Date() },
    });
    await prisma.propertyVideo.create({
      data: { propertyId: queued.id, storageKey: `${queued.id}/raw.mp4`, filename: "raw.mp4", sizeBytes: 100, uploadedById: montajerId },
    });

    await videoHandoffPublishJob.onGiveUp({ propertyId: property.id });

    expect((await prisma.property.findUniqueOrThrow({ where: { id: queued.id }, select: { videoHandoffStatus: true } })).videoHandoffStatus).toBe(
      "SENT_TO_EDITOR"
    );
    // Единственная допустимая строка журнала — «монтажёр не привязал Telegram»
    // от выдачи следующего (у тестового монтажёра нет chatId, с 22.09.2026 это
    // не молчаливый пуш, а недоставка). Про сам отказ публикации — ни строки.
    const messages = logSystemError.mock.calls.map((c) => String(c[1] ?? ""));
    expect(messages.filter((m) => !m.includes("не привязал Telegram"))).toEqual([]);
    expect(sendPushToAgents).not.toHaveBeenCalled();

    await prisma.propertyVideo.deleteMany({ where: { propertyId: queued.id } });
  });
});
