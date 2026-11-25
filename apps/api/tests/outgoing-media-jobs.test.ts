import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ОЧЕРЕДЬ ОТПРАВКИ ФОТО/ВИДЕО КЛИЕНТУ (25.11.2026, lib/outgoingMediaJobs.ts) на настоящей базе
 * и настоящем ffmpeg; наружу ничего не уходит — транспорт Meta, Telegram и R2 подменены.
 * Проверяем по байтам: что именно ушло бы клиенту (кодек, размер ≤ предела канала).
 */

const shipped = vi.hoisted(() => ({ files: [] as Array<{ key: string; path: string }>, dir: "" }));
const {
  sendVideo, sendImage, sendMessage, sendTelegramVideo, sendTelegramPhoto, uploadOutgoingMedia, logSystemError,
} = vi.hoisted(() => ({
  sendVideo: vi.fn(async (_c: string, _to: string, _url: string) => "wamid.video-1"),
  sendImage: vi.fn(async (_c: string, _to: string, _url: string) => "wamid.image-1"),
  sendMessage: vi.fn(async (_c: string, _to: string, _text: string) => "wamid.text-1"),
  sendTelegramVideo: vi.fn(async () => ({})),
  sendTelegramPhoto: vi.fn(async () => ({})),
  uploadOutgoingMedia: vi.fn(),
  logSystemError: vi.fn(async () => {}),
}));

vi.mock("../src/lib/outgoingMedia.js", () => ({ uploadOutgoingMedia }));
vi.mock("../src/lib/r2Client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/r2Client.js")>()),
  r2PresignDownloadUrl: vi.fn(async (key: string) => `https://r2.test/${key}`),
  isR2Configured: vi.fn(() => true),
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  sendVideo,
  sendImage,
  sendMessage,
  isMetaChannelEnabled: vi.fn(async () => true),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendVideo: sendTelegramVideo,
  sendPhoto: sendTelegramPhoto,
  isTelegramEnabled: () => true,
}));

process.env.CRM_PUBLIC_URL = "https://crm-test.royalhome.tj";

const { prisma } = await import("../src/db.js");
const { META_OUTGOING_MEDIA_LIMITS } = await import("@royal-home/shared");
const jobs = await import("../src/lib/outgoingMediaJobs.js");
const { probeMedia } = await import("../src/lib/outgoingMediaPrepare.js");
const { runCustomerJobsTick } = await import("../src/jobs/runner.js");

let fixture: CustomerMessengerFixture;
let dir: string;
let agentId: string;
const runId = Date.now().toString(36);
const convIds: string[] = [];
const tgIds: string[] = [];
const ff = (args: string[]) => execFileSync(process.env.FFMPEG_BIN || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

/** Копия исходника — очередь забирает (переносит) файл, а тестам он нужен снова. */
function upload(name: string): { path: string; size: number; mimetype: string; originalname: string } {
  const copy = path.join(dir, `${Math.random().toString(36).slice(2)}-${name}`);
  copyFileSync(path.join(dir, name), copy);
  const mimetype = name.endsWith(".mov") ? "video/quicktime" : name.endsWith(".jpg") ? "image/jpeg" : "video/mp4";
  return { path: copy, size: statSync(copy).size, mimetype, originalname: name };
}

async function waConversation(): Promise<string> {
  const c = await prisma.botConversation.create({
    data: {
      channel: "WHATSAPP",
      accountId: fixture.id,
      endpointScopeId: fixture.transport.endpointScopeId,
      subscriberId: `992900${runId.slice(-4)}${convIds.length}`.slice(0, 12),
      // Клиент писал только что — окно 24 часа открыто.
      messages: [{ role: "user", content: "Здравствуйте", at: new Date().toISOString() }],
    },
  });
  convIds.push(c.id);
  return c.id;
}

async function runQueuedJob(jobId: string): Promise<void> {
  // Та же полоса очереди, что на worker (cron «outgoing-media-jobs»), без минутного ожидания.
  for (let i = 0; i < 15; i++) {
    await runCustomerJobsTick("media");
    const row = await prisma.outgoingMediaJob.findUnique({ where: { id: jobId } });
    if (row && ["SENT", "FAILED", "CANCELLED"].includes(row.status)) return;
  }
}

beforeAll(async () => {
  fixture = await createCustomerMessengerFixture("WHATSAPP");
  dir = mkdtempSync(path.join(os.tmpdir(), "rh-outgoing-jobs-"));
  shipped.dir = mkdtempSync(path.join(os.tmpdir(), "rh-outgoing-shipped-"));
  // То, что «ушло бы» в R2: копия подготовленного файла — его кодек и вес проверяем ниже.
  uploadOutgoingMedia.mockImplementation(async (id: string, src: { path: string } | Buffer, ext: string) => {
    const key = `chat-media/${id}/${shipped.files.length}.${ext}`;
    const dest = path.join(shipped.dir, `${shipped.files.length}.${ext}`);
    if (Buffer.isBuffer(src)) throw new Error("ожидали путь, а не буфер");
    copyFileSync(src.path, dest);
    shipped.files.push({ key, path: dest });
    return key;
  });
  const agent = await prisma.agent.findFirst({ select: { id: true } });
  agentId = agent!.id;
  ff([
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60", "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "3", "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le",
    "-x265-params", "log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
    "-color_trc", "arib-std-b67", "-tag:v", "hvc1", "-c:a", "aac", path.join(dir, "iphone.mov"),
  ]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=200",
    "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "3M", "-c:a", "aac", path.join(dir, "long.mp4")]);
}, 120_000);

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await prisma.outgoingMediaJob.deleteMany({ where: { conversationId: { in: [...convIds, ...tgIds.map((id) => `tg_${id}`)] } } });
  await prisma.backgroundJob.deleteMany({ where: { type: jobs.OUTGOING_MEDIA_JOB_TYPE } });
  await prisma.botConversation.deleteMany({ where: { id: { in: convIds } } });
  await prisma.telegramConversation.deleteMany({ where: { id: { in: tgIds } } });
  await fixture?.dispose();
  rmSync(dir, { recursive: true, force: true });
  rmSync(shipped.dir, { recursive: true, force: true });
});

describe("приём: 202 сразу, файл в спуле", () => {
  it("видео с iPhone принято в очередь, задание сжимает его и WhatsApp получает H.264 ≤ 16 МБ, а не ссылку", async () => {
    const conv = await waConversation();
    const file = upload("iphone.mov");
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file, caption: "Квартира" });
    expect(accepted.status).toBe(202);
    const jobId = accepted.body.jobId as string;
    expect(existsSync(file.path)).toBe(false); // файл забран в спул
    const row = await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(existsSync(path.join(jobs.outgoingMediaSpoolDir(), row.inputName))).toBe(true);

    await runQueuedJob(jobId);

    const done = await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(done.status).toBe("SENT");
    expect(sendVideo).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled(); // не ссылкой
    const sent = shipped.files.at(-1)!;
    expect(statSync(sent.path).size).toBeLessThanOrEqual(META_OUTGOING_MEDIA_LIMITS.WHATSAPP.video);
    const probe = await probeMedia(sent.path);
    expect(probe.video).toMatchObject({ codec: "h264", profile: "Main", hdr: false });
    // Исходник после успеха убран из спула.
    expect(existsSync(path.join(jobs.outgoingMediaSpoolDir(), row.inputName))).toBe(false);
    // В переписке — запись с вложением и подписью, как у прежней отправки.
    const conversation = await prisma.botConversation.findUniqueOrThrow({ where: { id: conv }, select: { messages: true } });
    const last = (conversation.messages as Array<{ content?: string; attachments?: unknown[] }>).at(-1)!;
    expect(last.content).toBe("Квартира");
    expect(last.attachments).toHaveLength(1);
  }, 120_000);

  it("окно 24 часа закрыто — отказ сразу, до загрузки в очередь, файл удалён", async () => {
    const conv = await waConversation();
    await prisma.botConversation.update({
      where: { id: conv },
      data: { messages: [{ role: "user", content: "Привет", at: new Date(Date.now() - 30 * 3600_000).toISOString() }] },
    });
    const file = upload("long.mp4");
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file });
    expect(accepted.status).toBe(409);
    expect(accepted.body.code).toBe("window_closed");
    expect(existsSync(file.path)).toBe(false);
    expect(await prisma.outgoingMediaJob.count({ where: { conversationId: conv } })).toBe(0);
  });
});

describe("надёжность", () => {
  it("процесс упал В МОМЕНТ отправки (SENDING) — второй раз клиенту не шлём, сотруднику «проверьте переписку»", async () => {
    const conv = await waConversation();
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
    const jobId = accepted.body.jobId as string;
    await prisma.outgoingMediaJob.update({ where: { id: jobId }, data: { status: "SENDING" } });

    await jobs.runOutgoingMediaJob(jobId);

    const row = await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe("FAILED");
    expect(row.error).toMatch(/Проверьте переписку/);
    expect(sendVideo).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("выкат посреди сжатия: ffmpeg обрывается, задание возвращается в очередь и доезжает в «новом процессе»", async () => {
    const conv = await waConversation();
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
    const jobId = accepted.body.jobId as string;
    const stop = new AbortController();
    const saved = { ...META_OUTGOING_MEDIA_LIMITS.WHATSAPP };
    META_OUTGOING_MEDIA_LIMITS.WHATSAPP.video = 2 * 1024 * 1024; // заставить перекодировать, а не переложить
    try {
      const run = jobs.runOutgoingMediaJob(jobId, stop.signal);
      setTimeout(() => stop.abort(), 200);
      await expect(run).rejects.toThrow(/worker выходит/);
      expect((await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("QUEUED");
      expect(sendVideo).not.toHaveBeenCalled();

      await jobs.runOutgoingMediaJob(jobId);
      const row = await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(row.status).toBe("SENT");
      expect(row.outBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(sendVideo).toHaveBeenCalledTimes(1);
    } finally {
      Object.assign(META_OUTGOING_MEDIA_LIMITS.WHATSAPP, saved);
    }
  }, 120_000);

  it("отмена до начала: ничего не уходит, исходник удалён", async () => {
    const conv = await waConversation();
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
    const jobId = accepted.body.jobId as string;
    const row = await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: jobId } });
    expect((await jobs.cancelOutgoingMediaJob(jobId, agentId)).status).toBe(200);
    await jobs.runOutgoingMediaJob(jobId);
    expect(sendVideo).not.toHaveBeenCalled();
    expect(existsSync(path.join(jobs.outgoingMediaSpoolDir(), row.inputName))).toBe(false);
    // Чужое задание отменить нельзя.
    expect((await jobs.cancelOutgoingMediaJob(jobId, "someone-else")).status).toBe(404);
  });

  it("сбой канала → FAILED с причиной; «Повторить» отправляет без новой загрузки", async () => {
    const conv = await waConversation();
    sendVideo.mockRejectedValueOnce(new Error("socket hang up"));
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
    const jobId = accepted.body.jobId as string;
    await runQueuedJob(jobId);
    const failed = await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toBeTruthy();

    const retried = await jobs.retryOutgoingMediaJob(jobId, agentId);
    expect(retried.status).toBe(202);
    await runQueuedJob(jobId);
    expect((await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("SENT");
    expect(sendVideo).toHaveBeenCalledTimes(2);
  }, 120_000);

  it("видео не помещается даже в нижнем качестве — честная ссылка и пометка сотруднику", async () => {
    const conv = await waConversation();
    const saved = { ...META_OUTGOING_MEDIA_LIMITS.WHATSAPP };
    META_OUTGOING_MEDIA_LIMITS.WHATSAPP.video = 200 * 1024;
    try {
      const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
      await runQueuedJob(accepted.body.jobId as string);
      const row = await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: accepted.body.jobId as string } });
      expect(row.status).toBe("SENT");
      expect(row.note).toMatch(/ссылка на просмотр/);
      expect(sendVideo).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(String(sendMessage.mock.calls[0][2])).toContain("/api/v1/media/chat/");
    } finally {
      Object.assign(META_OUTGOING_MEDIA_LIMITS.WHATSAPP, saved);
    }
  }, 120_000);

  it("рубильник выключен — файл уходит как есть (без сжатия), как до 25.11", async () => {
    const conv = await waConversation();
    await prisma.settings.update({ where: { id: "singleton" }, data: { outgoingMediaCompressEnabled: false } });
    try {
      expect(await jobs.outgoingMediaCompressOn()).toBe(false);
      const file = upload("long.mp4");
      const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file });
      await runQueuedJob(accepted.body.jobId as string);
      expect(statSync(shipped.files.at(-1)!.path).size).toBe(file.size);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { outgoingMediaCompressEnabled: true } });
    }
  }, 60_000);
});

describe("Telegram", () => {
  it("видео уходит оригиналом (перекладка в MP4, HEVC сохранён)", async () => {
    const tg = await prisma.telegramConversation.create({
      data: { chatId: `9${Date.now()}`.slice(0, 12), messages: [{ role: "user", content: "Салом", at: new Date().toISOString() }] },
    });
    tgIds.push(tg.id);
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: `tg_${tg.id}`, file: upload("iphone.mov") });
    expect(accepted.status).toBe(202);
    await runQueuedJob(accepted.body.jobId as string);
    expect((await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: accepted.body.jobId as string } })).status).toBe("SENT");
    expect(sendTelegramVideo).toHaveBeenCalledTimes(1);
    expect((await probeMedia(shipped.files.at(-1)!.path)).video?.codec).toBe("hevc");
  }, 60_000);
});

describe("уборка спула", () => {
  it("исходник упавшего старше суток и брошенный файл убираются", async () => {
    const conv = await waConversation();
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
    const jobId = accepted.body.jobId as string;
    const row = await prisma.outgoingMediaJob.update({
      where: { id: jobId },
      data: { status: "FAILED", finishedAt: new Date(Date.now() - 25 * 3600_000) },
    });
    const result = await jobs.sweepOutgoingMediaSpool();
    expect(result.removedFiles).toBeGreaterThanOrEqual(1);
    expect(existsSync(path.join(jobs.outgoingMediaSpoolDir(), row.inputName))).toBe(false);
    expect((await jobs.retryOutgoingMediaJob(jobId, agentId)).status).toBe(410);
  });
});
