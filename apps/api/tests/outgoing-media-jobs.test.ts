import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import sharp from "sharp";
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
// Запись в историю после отправки: тест «Meta приняла файл, а история упала» роняет её один раз.
const appendFail = vi.hoisted(() => ({ once: false }));
vi.mock("../src/messengers/appendMessages.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/messengers/appendMessages.js")>();
  return {
    ...real,
    appendConversationMessages: vi.fn(async (...args: Parameters<typeof real.appendConversationMessages>) => {
      if (appendFail.once) {
        appendFail.once = false;
        throw new Error("history write failed");
      }
      return real.appendConversationMessages(...args);
    }),
  };
});
const sendPushToAgent = vi.hoisted(() => vi.fn(async () => 1));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));
const isR2Configured = vi.hoisted(() => vi.fn(() => true));
vi.mock("../src/lib/r2Client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/r2Client.js")>()),
  r2PresignDownloadUrl: vi.fn(async (key: string) => `https://r2.test/${key}`),
  isR2Configured,
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
const { META_OUTGOING_MEDIA_LIMITS, formatChannelLimit } = await import("@royal-home/shared");
const { isDefiniteSendRejection } = await import("../src/lib/conversationDelivery.js");
const { MetaGraphCallError } = await import("../src/lib/metaSendBlock.js");
const { TelegramApiError } = await import("../src/telegram/api.js");
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

  it("хранилище файлов не настроено — отказ сразу, а не после минуты сжатия", async () => {
    const conv = await waConversation();
    isR2Configured.mockReturnValueOnce(false);
    const file = upload("long.mp4");
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file });
    expect(accepted.status).toBe(503);
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

  it("заведомый сбой (хранилище не приняло файл) → FAILED с причиной; «Повторить» отправляет без новой загрузки", async () => {
    const conv = await waConversation();
    uploadOutgoingMedia.mockRejectedValueOnce(new Error("R2 down"));
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
    expect(sendVideo).toHaveBeenCalledTimes(1);
  }, 120_000);

  it("«Повторить», нажатое пока прошлое задание очереди ещё дописывает сбой (RUNNING), не теряется (охота 26.11)", async () => {
    // FAILED появляется в базе посреди обработчика (failDefinitely), а задание очереди остаётся RUNNING,
    // пока уходит пуш сотруднику. Экран уже показал «Повторить» — нажатие в эти секунды ставило задание
    // с тем же ключом повтора: очередь молча считала его дублем, строка висела QUEUED навсегда.
    const conv = await waConversation();
    uploadOutgoingMedia.mockRejectedValueOnce(new Error("R2 down"));
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
    const jobId = accepted.body.jobId as string;
    await runQueuedJob(jobId);
    expect((await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("FAILED");
    // Прошлое задание очереди «ещё не вернулось из обработчика».
    const old = await prisma.backgroundJob.findFirstOrThrow({
      where: { payload: { path: ["mediaJobId"], equals: jobId } },
      orderBy: { createdAt: "desc" },
    });
    await prisma.backgroundJob.update({
      where: { id: old.id },
      data: { status: "RUNNING", dedupeKey: `outgoing-media:${jobId}`, lockedAt: new Date(), lockedBy: "test-still-running" },
    });
    try {
      expect((await jobs.retryOutgoingMediaJob(jobId, agentId)).status).toBe(202);
      const pending = await prisma.backgroundJob.count({
        where: { payload: { path: ["mediaJobId"], equals: jobId }, status: "PENDING" },
      });
      expect(pending).toBe(1);
      await runQueuedJob(jobId);
      expect((await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("SENT");
      expect(sendVideo).toHaveBeenCalledTimes(1);
    } finally {
      await prisma.backgroundJob.update({ where: { id: old.id }, data: { status: "DONE", dedupeKey: null, lockedAt: null, lockedBy: null } });
    }
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
      expect(row.note).toContain(`предел ${formatChannelLimit(200 * 1024)}`);
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

describe("исход неизвестен — повтор не предлагается (ревью 25.11)", () => {
  const paused = async (conv: string) =>
    (await prisma.botConversation.findUniqueOrThrow({ where: { id: conv }, select: { pausedUntil: true } })).pausedUntil;

  it("транспорт оборвался (файл мог дойти): FAILED без «Повторить», пауза бота остаётся, пуш сотруднику", async () => {
    const conv = await waConversation();
    sendVideo.mockRejectedValueOnce(new Error("socket hang up"));
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
    const jobId = accepted.body.jobId as string;
    await runQueuedJob(jobId);
    const row = await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(row).toMatchObject({ status: "FAILED", retryable: false, error: jobs.OUTCOME_UNKNOWN_TEXT });
    expect((await jobs.retryOutgoingMediaJob(jobId, agentId)).status).toBe(409);
    expect(await paused(conv)).not.toBeNull();
    expect(sendPushToAgent).toHaveBeenCalledWith(agentId, expect.objectContaining({ body: jobs.OUTCOME_UNKNOWN_TEXT }));
  }, 60_000);

  it("Meta приняла файл, а запись в историю упала: не «Повторить», а «проверьте переписку»", async () => {
    const conv = await waConversation();
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
    const jobId = accepted.body.jobId as string;
    appendFail.once = true;
    await runQueuedJob(jobId);
    expect(sendVideo).toHaveBeenCalledTimes(1);
    const row = await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(row).toMatchObject({ status: "FAILED", retryable: false });
  }, 60_000);

  it("очередь сдалась на задании в SENDING — тоже «проверьте переписку»", async () => {
    const conv = await waConversation();
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
    const jobId = accepted.body.jobId as string;
    await prisma.outgoingMediaJob.update({ where: { id: jobId }, data: { status: "SENDING" } });
    await jobs.giveUpOutgoingMediaJob(jobId);
    expect(await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "FAILED", retryable: false });
  });
});

describe("пауза бота — с момента «Отправить» (ревью 25.11)", () => {
  const paused = async (conv: string) =>
    (await prisma.botConversation.findUniqueOrThrow({ where: { id: conv }, select: { pausedUntil: true } })).pausedUntil;

  it("в очереди бот уже молчит; отмена снимает паузу", async () => {
    const conv = await waConversation();
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
    expect(await paused(conv)).not.toBeNull();
    await jobs.cancelOutgoingMediaJob(accepted.body.jobId as string, agentId);
    expect(await paused(conv)).toBeNull();
  });

  it("заведомый отказ (окно закрылось, пока сжимали) — пауза снята; успех — пауза одна, не двойная", async () => {
    const conv = await waConversation();
    sendVideo.mockRejectedValueOnce(
      new Error('Graph API HTTP 400: {"error":{"message":"(#131047) Message failed to send because more than 24 hours have passed since the customer last replied to this number.","code":131047}}')
    );
    const failed = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
    await runQueuedJob(failed.body.jobId as string);
    expect(await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: failed.body.jobId as string } })).toMatchObject({ status: "FAILED", retryable: true });
    expect(await paused(conv)).toBeNull();

    const ok = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
    const placed = await paused(conv);
    await runQueuedJob(ok.body.jobId as string);
    expect((await paused(conv))?.getTime()).toBeGreaterThanOrEqual(placed!.getTime());
  }, 60_000);
});

describe("сбой сжатия — как раньше, а не отказ (ревью 25.11)", () => {
  it("нечитаемое для ffmpeg видео уходит оригиналом с пометкой агенту", async () => {
    const conv = await waConversation();
    const broken = path.join(dir, `broken-${Date.now()}.mp4`);
    writeFileSync(broken, Buffer.alloc(200 * 1024, 7));
    const accepted = await jobs.enqueueOutgoingMedia({
      agentId, conversationId: conv, file: { path: broken, size: 200 * 1024, mimetype: "video/mp4", originalname: "broken.mp4" },
    });
    await runQueuedJob(accepted.body.jobId as string);
    const row = await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: accepted.body.jobId as string } });
    expect(row.status).toBe("SENT");
    expect(row.note).toMatch(/не удалось сжать/);
    expect(sendVideo).toHaveBeenCalledTimes(1);
  }, 60_000);
});

describe("фото: своя полоса и предел исходника (ревью 25.11)", () => {
  it("фото больше 50 МБ — отказ сразу с понятным текстом, в память worker не попадает", async () => {
    const conv = await waConversation();
    const big = path.join(dir, `big-${Date.now()}.jpg`);
    writeFileSync(big, Buffer.alloc(51 * 1024 * 1024));
    const res = await jobs.enqueueOutgoingMedia({
      agentId, conversationId: conv, file: { path: big, size: 51 * 1024 * 1024, mimetype: "image/jpeg", originalname: "scan.jpg" },
    });
    expect(res.status).toBe(413);
    expect(String(res.body.error)).toMatch(/50 МБ/);
    expect(existsSync(big)).toBe(false);
  });

  it("фото уходит своей полосой и не ждёт видео в очереди", async () => {
    const conv = await waConversation();
    const video = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
    const jpg = path.join(dir, `photo-${Date.now()}.jpg`);
    await sharp({ create: { width: 64, height: 48, channels: 3, background: "#888" } }).jpeg().toFile(jpg);
    const photo = await jobs.enqueueOutgoingMedia({
      agentId, conversationId: conv, file: { path: jpg, size: statSync(jpg).size, mimetype: "image/jpeg", originalname: "a.jpg" },
    });
    const bg = await prisma.backgroundJob.findFirstOrThrow({ where: { dedupeKey: `outgoing-media:${photo.body.jobId}` } });
    expect(bg.type).toBe(jobs.OUTGOING_MEDIA_PHOTO_JOB_TYPE);
    await runCustomerJobsTick("mediaPhoto");
    expect((await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: photo.body.jobId as string } })).status).toBe("SENT");
    expect((await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: video.body.jobId as string } })).status).toBe("QUEUED");
    await jobs.cancelOutgoingMediaJob(video.body.jobId as string, agentId);
  });
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
    // Второй проход не «убирает» уже убранное снова.
    const again = await jobs.sweepOutgoingMediaSpool();
    expect(again.removedFiles).toBe(0);
  });

  it("тревога считает от начала обработки: давно ждавшее, но только начатое сжатие — не «зависло»", async () => {
    const conv = await waConversation();
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
    await prisma.outgoingMediaJob.update({
      where: { id: accepted.body.jobId as string },
      data: { status: "PREPARING", createdAt: new Date(Date.now() - 40 * 60_000), startedAt: new Date() },
    });
    expect((await jobs.sweepOutgoingMediaSpool()).stuck).toBe(0);
    await prisma.outgoingMediaJob.update({ where: { id: accepted.body.jobId as string }, data: { status: "CANCELLED" } });
  });
});

describe("правки ревью 26.11: пауза, дубль исполнителя, заведомый отказ", () => {
  const pauseRow = async (conv: string) =>
    prisma.botConversation.findUniqueOrThrow({ where: { id: conv }, select: { pausedUntil: true, botPausedAt: true } });
  const graphError = (status: number) =>
    new MetaGraphCallError(`Graph API HTTP ${status}: {"error":{"message":"x"}}`, {
      status, code: null, subcode: null, type: null, fbtraceId: null, message: "x",
    });

  it("пауза приёма истекла, пока сжимали, — перед отправкой её продлевают: бот не отвечает поверх файла", async () => {
    const conv = await waConversation();
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
    // Прошло больше срока короткой паузы (10 минут): в базе она уже в прошлом.
    await prisma.botConversation.update({ where: { id: conv }, data: { pausedUntil: new Date(Date.now() - 60_000) } });
    await runQueuedJob(accepted.body.jobId as string);
    expect((await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: accepted.body.jobId as string } })).status).toBe("SENT");
    const until = (await pauseRow(conv)).pausedUntil;
    expect(until!.getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
  }, 60_000);

  it("продлённая пауза всё равно откатывается при заведомом отказе канала (4xx)", async () => {
    const conv = await waConversation();
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
    const jobId = accepted.body.jobId as string;
    // Пауза приёма почти истекла, но это ТА ЖЕ пауза (снимок задания на неё указывает): продление её сдвигает.
    const soon = new Date(Date.now() + 60_000);
    const row = await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: jobId }, select: { pauseUndo: true } });
    const undo = row.pauseUndo as { placed: string; placedBotPausedAt: string | null };
    await prisma.botConversation.update({ where: { id: conv }, data: { pausedUntil: soon } });
    const botPausedAt = (await pauseRow(conv)).botPausedAt;
    // Любая запись паузы двигает «отпечаток» диалога; снимок задания подгоняем под ручную правку теста.
    const [fence] = await prisma.$queryRaw<Array<{ inquiryId: string; ownershipEpoch: string; bindingRevision: string }>>`
      SELECT "id" AS "inquiryId", "ownershipEpoch"::text, "bindingRevision"::text FROM "CustomerInquiry" WHERE "conversationId" = ${conv} AND "closedAt" IS NULL`;
    await prisma.outgoingMediaJob.update({
      where: { id: jobId },
      data: { pauseUndo: { ...undo, placed: soon.toISOString(), placedBotPausedAt: botPausedAt?.toISOString() ?? null, ownershipFence: fence } },
    });
    sendVideo.mockRejectedValueOnce(graphError(400));
    await runQueuedJob(jobId);
    expect(await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "FAILED", retryable: true });
    expect((await pauseRow(conv)).pausedUntil).toBeNull();
  }, 60_000);

  it("продление не затирает паузу человека, поставленную после приёма", async () => {
    const conv = await waConversation();
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
    const jobId = accepted.body.jobId as string;
    // Директор нажал «Пауза» на два часа, пока файл ждал: это уже не паузу приёма.
    const human = new Date(Date.now() + 2 * 3600_000);
    await prisma.botConversation.update({ where: { id: conv }, data: { pausedUntil: human, botPausedAt: new Date() } });
    sendVideo.mockRejectedValueOnce(graphError(400));
    await runQueuedJob(jobId);
    expect((await pauseRow(conv)).pausedUntil?.getTime()).toBe(human.getTime());
  }, 60_000);

  it("два исполнителя одного задания: проигравший не пишет FAILED и не откатывает паузу — победитель дописывает SENT, файл уходит один раз", async () => {
    const conv = await waConversation();
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
    const jobId = accepted.body.jobId as string;
    let openUpload!: () => void;
    let openSend!: () => void;
    const uploadGate = new Promise<void>((r) => (openUpload = r));
    const sendGate = new Promise<void>((r) => (openSend = r));
    const baseUpload = uploadOutgoingMedia.getMockImplementation()!;
    uploadOutgoingMedia.mockImplementation(async (...args: unknown[]) => {
      await uploadGate;
      return (baseUpload as (...a: unknown[]) => Promise<string>)(...args);
    });
    sendVideo.mockImplementationOnce(async () => {
      await sendGate;
      return "wamid.video-1";
    });
    try {
      const a = jobs.runOutgoingMediaJob(jobId).then(() => "A");
      const b = jobs.runOutgoingMediaJob(jobId).then(() => "B");
      // Оба прочитали PREPARING и стоят в загрузке — как после «зависшего 15 минут».
      await new Promise((r) => setTimeout(r, 500));
      openUpload();
      await Promise.race([a, b]); // вернулся проигравший; победитель ждёт ответа Meta
      const mid = await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(mid.status).toBe("SENDING");
      expect(sendPushToAgent).not.toHaveBeenCalled();
      expect((await pauseRow(conv)).pausedUntil).not.toBeNull();
      openSend();
      await Promise.all([a, b]);
    } finally {
      uploadOutgoingMedia.mockImplementation(baseUpload);
    }
    const done = await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(done).toMatchObject({ status: "SENT", retryable: true, error: null });
    expect(sendVideo).toHaveBeenCalledTimes(1);
    expect(sendPushToAgent).not.toHaveBeenCalled();
  }, 60_000);

  it("заведомый отказ 4xx (формат) — «Повторить» есть, пауза снята; таймаут и 5xx — «проверьте переписку», пауза остаётся", async () => {
    const reject = await waConversation();
    sendVideo.mockRejectedValueOnce(graphError(400));
    const a = await jobs.enqueueOutgoingMedia({ agentId, conversationId: reject, file: upload("long.mp4") });
    await runQueuedJob(a.body.jobId as string);
    expect(await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: a.body.jobId as string } })).toMatchObject({ status: "FAILED", retryable: true });
    expect((await pauseRow(reject)).pausedUntil).toBeNull();

    for (const err of [graphError(503), new Error("The operation was aborted due to timeout"), new TypeError("fetch failed")]) {
      const conv = await waConversation();
      sendVideo.mockRejectedValueOnce(err);
      const b = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
      await runQueuedJob(b.body.jobId as string);
      expect(await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: b.body.jobId as string } })).toMatchObject({ status: "FAILED", retryable: false });
      expect((await pauseRow(conv)).pausedUntil).not.toBeNull();
    }
  }, 120_000);

  it("Telegram: отказ Bot API 400 — повтор доступен; обрыв без ответа — нет", async () => {
    const mk = async () => {
      const tg = await prisma.telegramConversation.create({
        data: { chatId: `8${Date.now()}${tgIds.length}`.slice(0, 13), messages: [{ role: "user", content: "Салом", at: new Date().toISOString() }] },
      });
      tgIds.push(tg.id);
      return `tg_${tg.id}`;
    };
    sendTelegramVideo.mockRejectedValueOnce(new TelegramApiError(400, "sendVideo", "Bad Request: wrong file"));
    const a = await jobs.enqueueOutgoingMedia({ agentId, conversationId: await mk(), file: upload("long.mp4") });
    await runQueuedJob(a.body.jobId as string);
    expect(await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: a.body.jobId as string } })).toMatchObject({ status: "FAILED", retryable: true });
    sendTelegramVideo.mockRejectedValueOnce(new Error("socket hang up"));
    const b = await jobs.enqueueOutgoingMedia({ agentId, conversationId: await mk(), file: upload("long.mp4") });
    await runQueuedJob(b.body.jobId as string);
    expect(await prisma.outgoingMediaJob.findUniqueOrThrow({ where: { id: b.body.jobId as string } })).toMatchObject({ status: "FAILED", retryable: false });
  }, 120_000);

  it("isDefiniteSendRejection: 4xx — да; 5xx, таймаут, обрыв, без ответа — нет", () => {
    expect(isDefiniteSendRejection(graphError(400))).toBe(true);
    expect(isDefiniteSendRejection(graphError(429))).toBe(true);
    expect(isDefiniteSendRejection(graphError(500))).toBe(false);
    expect(isDefiniteSendRejection(new Error("Graph API HTTP 413: too large"))).toBe(true);
    expect(isDefiniteSendRejection(new Error("Graph API HTTP 502: bad gateway"))).toBe(false);
    expect(isDefiniteSendRejection(new TelegramApiError(400, "sendPhoto", "bad"))).toBe(true);
    expect(isDefiniteSendRejection(new TelegramApiError(502, "sendPhoto", "bad"))).toBe(false);
    expect(isDefiniteSendRejection(new TelegramApiError(undefined, "sendPhoto", "bad"))).toBe(false);
    expect(isDefiniteSendRejection(new Error("socket hang up"))).toBe(false);
    expect(isDefiniteSendRejection("boom")).toBe(false);
  });

  it("не создалась строка задания после паузы приёма — пауза снята, файл убран из спула, ответ 503", async () => {
    const conv = await waConversation();
    const before = readdirSync(jobs.outgoingMediaSpoolDir()).length;
    const spy = vi.spyOn(prisma.outgoingMediaJob, "create").mockRejectedValueOnce(new Error("db down"));
    try {
      const res = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
      expect(res.status).toBe(503);
    } finally {
      spy.mockRestore();
    }
    expect((await pauseRow(conv)).pausedUntil).toBeNull();
    expect(readdirSync(jobs.outgoingMediaSpoolDir()).length).toBe(before);
    expect(await prisma.outgoingMediaJob.count({ where: { conversationId: conv } })).toBe(0);
  });

  it("повтор через 23 часа после создания не считается «ждёт дольше часа»; настоящее долгое ожидание — считается", async () => {
    const conv = await waConversation();
    const accepted = await jobs.enqueueOutgoingMedia({ agentId, conversationId: conv, file: upload("long.mp4") });
    const jobId = accepted.body.jobId as string;
    await prisma.outgoingMediaJob.update({
      where: { id: jobId },
      data: { status: "FAILED", retryable: true, finishedAt: new Date(), createdAt: new Date(Date.now() - 23 * 3600_000), updatedAt: new Date(Date.now() - 23 * 3600_000) },
    });
    expect((await jobs.retryOutgoingMediaJob(jobId, agentId)).status).toBe(202);
    expect((await jobs.sweepOutgoingMediaSpool()).stuck).toBe(0);
    await prisma.outgoingMediaJob.update({ where: { id: jobId }, data: { updatedAt: new Date(Date.now() - 2 * 3600_000) } });
    expect((await jobs.sweepOutgoingMediaSpool()).stuck).toBeGreaterThanOrEqual(1);
    await jobs.cancelOutgoingMediaJob(jobId, agentId);
  });

  it("подписи пределов — десятичные МБ, как заданы пределы каналов", () => {
    expect(formatChannelLimit(META_OUTGOING_MEDIA_LIMITS.WHATSAPP.video)).toBe("16 МБ");
    expect(formatChannelLimit(META_OUTGOING_MEDIA_LIMITS.WHATSAPP.image)).toBe("5 МБ");
    expect(formatChannelLimit(META_OUTGOING_MEDIA_LIMITS.INSTAGRAM.video)).toBe("25 МБ");
    expect(formatChannelLimit(15_999_999)).toBe("15,9 МБ");
    expect(formatChannelLimit(2_000_000_000)).toBe("2 ГБ");
  });
});
