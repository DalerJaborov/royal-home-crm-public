import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { waitFor } from "./helpers/waitFor.js";

/**
 * ОДИН И ТОТ ЖЕ РОЛИК У ДВУХ КВАРТИР И ЧУЖОЙ ИСХОДНИК ВМЕСТО РОЛИКА (25.09.2026,
 * А2/А4; история: 19.09 подпись одного объекта у ролика другого, 23.09 №127 —
 * вместо ролика вернулся исходник).
 *
 *  — перед публикацией готовый ролик сверяется по md5 с готовыми роликами
 *    других объектов за 30 дней: совпал — не публикуем, запись в журнал ошибок
 *    (настоящий logSystemError → ErrorLog), пуш маркетингу, причина на объекте;
 *  — тот же ролик на приёме отвергается сразу, с номером объекта-двойника;
 *  — исходник ЛЮБОГО объекта (не только своего) вместо ролика — отказ.
 * Соцсети, пуш и ffprobe подменены; база и файлы — настоящие.
 */

const { publishApprovedPost, sendPushToAgents } = vi.hoisted(() => ({
  publishApprovedPost: vi.fn(async () => [] as unknown[]),
  sendPushToAgents: vi.fn(async () => 0),
}));

vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  publishApprovedPost,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents,
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage: vi.fn(async () => {}),
  sendDocumentFile: vi.fn(async () => ({})),
  sendDocument: vi.fn(async () => ({})),
}));
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
    durationSec: 20,
    sizeBytes: 400 * 1024,
  })),
}));

const { prisma } = await import("../src/db.js");
const { videoHandoffDir } = await import("../src/upload.js");
const { receiveEditedVideo, videoHandoffPublishDedupeKey, SAME_FINAL_MIN_BYTES } = await import("../src/lib/videoHandoff.js");
const { videoHandoffPublishJob } = await import("../src/jobs/videoHandoffPublish.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");

const runId = Date.now();
const phone = `+99292${runId.toString().slice(-7)}`;
// Получатель пуша «публикация остановлена» (маркетинг, директор, админ) —
// свой, а не тот, что случайно лежит в базе: в чистой базе и в части шардов
// полного прогона руководства нет, и пуш не уходит вовсе (24.09.2026).
const directorPhone = `+99291${runId.toString().slice(-7)}`;
let districtId: string;
let agentId: string;
const propertyIds: string[] = [];
const createdFiles: string[] = [];
const rawDirs = new Set<string>();

/** Смонтированный ролик «настоящего» размера — больше порога сравнения. */
const FINAL_BYTES = randomBytes(SAME_FINAL_MIN_BYTES + 4096);

async function seedProperty(label: string, data: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Двойник ролика-${label}-${runId}`,
      type: "APARTMENT",
      areaSqm: 52,
      price: 380000,
      currency: "TJS",
      districtId,
      address: "Двойная, 2",
      condition: "GOOD",
      status: "EDITING",
      ...data,
    },
  });
  propertyIds.push(p.id);
  return p;
}

/** Готовый ролик объекта уже лежит на диске и принят (RECEIVED). */
async function withFinal(propertyId: string, bytes: Buffer) {
  const name = `${propertyId}-${randomUUID()}.mp4`;
  const diskPath = path.join(videoHandoffDir, name);
  await fs.mkdir(videoHandoffDir, { recursive: true });
  await fs.writeFile(diskPath, bytes);
  createdFiles.push(diskPath);
  await prisma.property.update({
    where: { id: propertyId },
    data: { videoHandoffStatus: "RECEIVED", videoHandoffFinalPath: `/uploads/handoff/${name}`, videoHandoffReceivedAt: new Date() },
  });
}

async function addRawSource(propertyId: string, bytes: Buffer) {
  const storageKey = `${propertyId}/${randomUUID()}.mp4`;
  const filePath = localVideoFilePath(storageKey);
  if (!filePath) throw new Error("путь хранилища не разрешился");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
  rawDirs.add(path.dirname(filePath));
  await prisma.propertyVideo.create({ data: { propertyId, storageKey, filename: "IMG_7777.MOV", sizeBytes: bytes.length, uploadedById: agentId } });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Двойник ролика-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({ data: { fullName: "Агент двойника", phone, role: "AGENT", passwordHash: await bcrypt.hash("testpass123", 4) } })
  ).id;
  await prisma.agent.deleteMany({ where: { phone: directorPhone } });
  await prisma.agent.create({ data: { fullName: "Директор двойника", phone: directorPhone, role: "DIRECTOR", passwordHash: await bcrypt.hash("testpass123", 4) } });
});

beforeEach(() => {
  publishApprovedPost.mockClear();
  sendPushToAgents.mockClear();
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: propertyIds.map(videoHandoffPublishDedupeKey) } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  for (const f of createdFiles) await fs.rm(f, { force: true }).catch(() => {});
  for (const d of rawDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  await prisma.agent.deleteMany({ where: { phone: { in: [phone, directorPhone] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("готовый ролик совпал с роликом другого объекта (А4)", () => {
  it("перед публикацией — не публикуем, ErrorLog с обоими номерами, пуш маркетингу, причина на объекте", async () => {
    const a = await seedProperty("А");
    const b = await seedProperty("Б");
    await withFinal(a.id, FINAL_BYTES);
    await withFinal(b.id, Buffer.from(FINAL_BYTES)); // та же последовательность байт, другой файл

    await videoHandoffPublishJob.run({ propertyId: b.id });

    expect(publishApprovedPost).not.toHaveBeenCalled();
    const row = await waitFor(() =>
      prisma.errorLog.findFirst({ where: { source: "video-handoff", message: { contains: `ролик объекта №${b.shortId} совпадает с роликом №${a.shortId}` } } })
    );
    expect(row.message).toContain("Публикация остановлена");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: b.id }, select: { scheduledPublishReason: true, publishedChannels: true } });
    expect(after.scheduledPublishReason).toContain(`совпадает с роликом №${a.shortId}`);
    expect(after.publishedChannels).toEqual([]);
    expect(sendPushToAgents).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ title: `⛔ Объект №${b.shortId}: публикация остановлена` })
    );
  });

  it("свой, ни с кем не совпавший ролик — публикация идёт как обычно", async () => {
    const c = await seedProperty("В");
    await withFinal(c.id, randomBytes(SAME_FINAL_MIN_BYTES + 1024));
    const before = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { autoPublishEnabled: true } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: true } });
    try {
      await videoHandoffPublishJob.run({ propertyId: c.id });
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: before?.autoPublishEnabled ?? false } });
    }

    expect(publishApprovedPost).toHaveBeenCalledTimes(1);
  });

  it("на приёме — тот же ролик второму объекту не принимается, называется двойник", async () => {
    const holder = await seedProperty("держатель-1", { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() });
    const first = await seedProperty("уже сдан");
    const same = randomBytes(SAME_FINAL_MIN_BYTES + 2048);
    await withFinal(first.id, same);

    const result = await receiveEditedVideo(holder.id, Buffer.from(same), "final.mp4");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(`уже сдан по объекту №${first.shortId}`);
    const state = await prisma.property.findUniqueOrThrow({ where: { id: holder.id }, select: { videoHandoffStatus: true, videoHandoffFinalPath: true } });
    expect(state.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(state.videoHandoffFinalPath).toBeNull();
  });
});

describe("исходник вместо ролика (А2)", () => {
  it("исходник ДРУГОГО объекта — отказ с его номером, объект по-прежнему ждёт", async () => {
    const holder = await seedProperty("держатель-2", { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() });
    const other = await seedProperty("чужие исходники");
    const raw = randomBytes(64 * 1024);
    await addRawSource(other.id, raw);

    const result = await receiveEditedVideo(holder.id, Buffer.from(raw), "133.mp4");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(`исходник ДРУГОГО объекта — №${other.shortId}`);
    const state = await prisma.property.findUniqueOrThrow({ where: { id: holder.id }, select: { videoHandoffStatus: true } });
    expect(state.videoHandoffStatus).toBe("SENT_TO_EDITOR");
  });

  it("исходник своего объекта — прежний отказ", async () => {
    const holder = await seedProperty("держатель-3", { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() });
    const raw = randomBytes(32 * 1024);
    await addRawSource(holder.id, raw);

    const result = await receiveEditedVideo(holder.id, Buffer.from(raw), "final.mp4");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Это исходник объекта (IMG_7777.MOV)");
  });

  it("настоящий смонтированный ролик — принимается", async () => {
    const holder = await seedProperty("держатель-4", { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() });

    const result = await receiveEditedVideo(holder.id, randomBytes(48 * 1024), "final.mp4");

    expect(result.ok).toBe(true);
    const state = await prisma.property.findUniqueOrThrow({ where: { id: holder.id }, select: { videoHandoffStatus: true, videoHandoffFinalPath: true } });
    expect(state.videoHandoffStatus).toBe("RECEIVED");
    if (state.videoHandoffFinalPath) createdFiles.push(path.join(videoHandoffDir, path.basename(state.videoHandoffFinalPath)));
  });
});
