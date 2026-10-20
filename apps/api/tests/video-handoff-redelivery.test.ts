import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import pathMod from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Застревание очереди монтажа (объект №121, 22.09.2026): место монтажёра
 * занято (SENT_TO_EDITOR), а исходники так и не ушли — процесс убило OOM
 * посреди отправки. Проверяем, что:
 *  — доставка отмечается отдельно (videoHandoffDeliveredAt) и только по факту;
 *  — сторож досылает недоставленное с паузой и сдаётся с тревогой в журнал;
 *  — объект без видео не держит место навсегда;
 *  — свободное место при стоящей очереди выдаётся следующему.
 */

const { sendMessage, sendDocumentFile, sendDocument, sendPushToAgent, logSystemError } = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => {}),
  sendDocumentFile: vi.fn(async () => {}),
  // Досылка по file_id (задание B, 24.09.2026) — замокана отдельно, иначе
  // фактический код падает на "TELEGRAM_BOT_TOKEN не настроен" и сам молча
  // откатывается к полной загрузке, пряча то, что тест как раз проверяет.
  sendDocument: vi.fn(async () => ({})),
  sendPushToAgent: vi.fn(async () => {}),
  logSystemError: vi.fn(async () => {}),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  sendDocumentFile,
  sendDocument,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

const { prisma } = await import("../src/db.js");
const { queueVideoHandoff, settleBackgroundHandoffDispatches } = await import("../src/lib/videoHandoff.js");
const { runVideoHandoffRedeliveryTick, redeliveryDelayMs, REDELIVERY_MAX_ATTEMPTS } = await import(
  "../src/lib/videoHandoffRedelivery.js"
);
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");

const runId = Date.now();
const phone = `+99296${runId.toString().slice(-7)}`;
let districtId: string;
let montajerId: string;
const propertyIds: string[] = [];
const rawDirs = new Set<string>();
let originalSettings: { videoHandoffEnabled: boolean; videoMontajerAgentId: string | null } | null = null;

async function seedProperty() {
  const p = await prisma.property.create({
    data: {
      title: `Доставка монтажёру-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 300000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 12",
      condition: "GOOD",
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

const state = (id: string) =>
  prisma.property.findUniqueOrThrow({
    where: { id },
    select: {
      videoHandoffStatus: true,
      videoHandoffDeliveredAt: true,
      videoHandoffDispatchAttempts: true,
      videoHandoffSentAt: true,
    },
  });

/** Чужие висящие передачи в общей базе мешали бы «строго по одному». */
async function clearForeignQueue() {
  await prisma.property.updateMany({
    where: { videoHandoffStatus: { in: ["QUEUED", "SENT_TO_EDITOR"] }, id: { notIn: propertyIds } },
    data: { videoHandoffStatus: "RECEIVED" },
  });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Доставка монтажёру-${runId}` } })).id;
  montajerId = (
    await prisma.agent.create({
      data: {
        fullName: "Монтажёр доставки",
        phone,
        role: "AGENT",
        passwordHash: await bcrypt.hash("testpass123", 4),
        telegramChatId: `9${runId.toString().slice(-8)}`,
      },
    })
  ).id;
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { videoHandoffEnabled: true, videoMontajerAgentId: true },
  });
  originalSettings = s ? { videoHandoffEnabled: s.videoHandoffEnabled, videoMontajerAgentId: s.videoMontajerAgentId } : null;
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { videoHandoffEnabled: true, videoMontajerAgentId: montajerId },
    create: { id: "singleton", videoHandoffEnabled: true, videoMontajerAgentId: montajerId },
  });
});

beforeEach(async () => {
  await clearForeignQueue();
  sendMessage.mockReset().mockResolvedValue(undefined);
  sendDocumentFile.mockReset().mockResolvedValue(undefined);
  sendDocument.mockReset().mockResolvedValue(undefined);
  logSystemError.mockClear();
});

afterEach(async () => {
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { videoHandoffStatus: "NONE", videoHandoffSentAt: null, videoHandoffDeliveredAt: null, videoHandoffDispatchAttempts: 0 },
  });
});

afterAll(async () => {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: originalSettings ?? { videoHandoffEnabled: false, videoMontajerAgentId: null },
  });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  for (const d of rawDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  await prisma.agent.deleteMany({ where: { phone } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("доставка исходников монтажёру", () => {
  it("успешная отправка отмечает доставку и сбрасывает счётчик попыток", async () => {
    const p = await seedProperty();
    await addRawVideo(p.id);
    await queueVideoHandoff(p.id);
    const s = await state(p.id);
    expect(s.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(s.videoHandoffDeliveredAt).not.toBeNull();
    expect(s.videoHandoffDispatchAttempts).toBe(0);
    // Файл уходит потоком с диска (Blob), а не Buffer в памяти — причина OOM №121.
    expect(sendDocumentFile.mock.calls[0]?.[1]).toBeInstanceOf(Blob);
  });

  it("файл и ссылка не ушли — доставка не отмечена, место занято, попытка посчитана", async () => {
    sendDocumentFile.mockRejectedValue(new Error("timeout"));
    sendMessage.mockRejectedValue(new Error("timeout"));
    const p = await seedProperty();
    await addRawVideo(p.id);
    await queueVideoHandoff(p.id);
    const s = await state(p.id);
    expect(s.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(s.videoHandoffDeliveredAt).toBeNull();
    expect(s.videoHandoffDispatchAttempts).toBe(1);
  });

  /**
   * ЗАДАНИЕ D (24.09.2026, аудит «монтажёр ↔ CRM ↔ соцсети»): раньше неудачная
   * попытка файлом сразу же слала запасную ссылку — а Bot API нередко всё-таки
   * успевал дослать файл, и монтажёр получал дубль. Теперь неудавшийся ролик
   * просто остаётся недоставленным, ссылку шлёт только сторож и только когда
   * попытки исчерпаны (см. отдельный тест на sendGiveUpFallbackLinks).
   *
   * ЗАДАНИЕ B: ролики, которые дошли, получают file_id — повтор сторожа шлёт
   * ИХ по этой строке (sendDocument), а не грузит заново с диска; недошедший
   * — единственный, кого действительно грузят повторно.
   */
  it("3 файла, второй упал по таймауту — file_id у 1 и 3, ссылки нет, сторож дослал только второй", async () => {
    const p = await seedProperty();
    await addRawVideo(p.id);
    await addRawVideo(p.id);
    await addRawVideo(p.id);

    let call = 0;
    sendDocumentFile.mockReset().mockImplementation(async (_chatId: string, _file: unknown, filename: string) => {
      call++;
      if (call === 2) throw new Error("timeout");
      return { message_id: call, document: { file_id: `fid-${filename}`, file_unique_id: `fuid-${filename}` } };
    });

    await queueVideoHandoff(p.id);

    const videosAfterFirstPass = await prisma.propertyVideo.findMany({ where: { propertyId: p.id }, orderBy: { uploadedAt: "asc" } });
    expect(videosAfterFirstPass.map((v) => v.telegramFileId !== null)).toEqual([true, false, true]);
    // Ссылка НЕ уходит вдогонку неудаче (задание D) — текстом уходит только
    // контрольное «дошло 2 из 3, остальное дошлю» (25.09.2026), без ссылок.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]![1])).toContain(`дошло 2 из 3 файлов, остальное дошлю автоматически`);
    expect(String(sendMessage.mock.calls[0]![1])).not.toContain("download-file");

    const s = await state(p.id);
    expect(s.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(s.videoHandoffDeliveredAt).toBeNull(); // 2 из 3 — не «доставлено целиком»
    expect(s.videoHandoffDispatchAttempts).toBe(1);

    // Пауза истекла — сторож дошлёт недостающее.
    sendDocumentFile.mockClear();
    sendDocument.mockClear();
    const tick = await runVideoHandoffRedeliveryTick(new Date(s.videoHandoffSentAt!.getTime() + redeliveryDelayMs(1) + 1000));
    expect(tick.redelivered).toBe(1);

    // Только недошедший ролик грузится заново файлом, а дошедшие монтажёру
    // повторно НЕ шлются вовсе (25.09.2026, отметка «файл у монтажёра»): раньше
    // они уходили вторым разом по file_id, и монтажёр получал дубли.
    expect(sendDocumentFile).toHaveBeenCalledTimes(1);
    expect(String(sendDocumentFile.mock.calls[0]![2])).toBe(`${p.shortId}_2из3.mp4`);
    expect(sendDocument).not.toHaveBeenCalled();

    const videosAfter = await prisma.propertyVideo.findMany({ where: { propertyId: p.id }, orderBy: { uploadedAt: "asc" } });
    expect(videosAfter.every((v) => v.telegramFileId !== null)).toBe(true);
    expect((await state(p.id)).videoHandoffDeliveredAt).not.toBeNull();
  });

  it("сторож досылает недоставленное после паузы и не трогает до неё", async () => {
    const p = await seedProperty();
    await addRawVideo(p.id);
    // Как у №121: место занято, процесс умер до отправки.
    const sentAt = new Date();
    await prisma.property.update({
      where: { id: p.id },
      data: { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: sentAt, videoHandoffDispatchAttempts: 1 },
    });

    const early = await runVideoHandoffRedeliveryTick(new Date(sentAt.getTime() + 60_000));
    expect(early.redelivered).toBe(0);
    expect(sendDocumentFile).not.toHaveBeenCalled();

    const later = await runVideoHandoffRedeliveryTick(new Date(sentAt.getTime() + redeliveryDelayMs(1) + 1000));
    expect(later.redelivered).toBe(1);
    expect(sendDocumentFile).toHaveBeenCalledTimes(1);
    expect((await state(p.id)).videoHandoffDeliveredAt).not.toBeNull();
    expect(logSystemError).toHaveBeenCalledWith("video-handoff", expect.stringContaining("досылаю заново"));
  });

  it("исчерпав попытки, сторож больше не шлёт и пишет тревогу в журнал", async () => {
    const p = await seedProperty();
    await addRawVideo(p.id);
    await prisma.property.update({
      where: { id: p.id },
      data: {
        videoHandoffStatus: "SENT_TO_EDITOR",
        videoHandoffSentAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
        videoHandoffDispatchAttempts: REDELIVERY_MAX_ATTEMPTS,
      },
    });
    const r = await runVideoHandoffRedeliveryTick();
    expect(r.gaveUp).toBe(1);
    expect(sendDocumentFile).not.toHaveBeenCalled();
    expect(logSystemError).toHaveBeenCalledWith("video-handoff", expect.stringContaining("так и не дошли"));
  });

  it("пауза растёт экспоненциально и упирается в потолок", () => {
    expect(redeliveryDelayMs(2)).toBe(2 * redeliveryDelayMs(1));
    expect(redeliveryDelayMs(50)).toBe(6 * 60 * 60 * 1000);
  });

  it("объект без видео — доставка не отмечена, попытка посчитана (сторож доведёт до тревоги)", async () => {
    const empty = await seedProperty();
    await queueVideoHandoff(empty.id);
    const s = await state(empty.id);
    expect(s.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(s.videoHandoffDeliveredAt).toBeNull();
    expect(s.videoHandoffDispatchAttempts).toBe(1);
  });

  it("место свободно, а очередь стоит — сторож выдаёт следующего", async () => {
    const waiting = await seedProperty();
    await addRawVideo(waiting.id);
    await prisma.property.update({
      where: { id: waiting.id },
      data: { videoHandoffStatus: "QUEUED", videoHandoffSentAt: new Date() },
    });
    const r = await runVideoHandoffRedeliveryTick();
    expect(r.released).toBe(true);
    // Следующий уходит монтажёру в фоне (24.09.2026) — дожидаемся отправки.
    await settleBackgroundHandoffDispatches();
    const s = await state(waiting.id);
    expect(s.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(s.videoHandoffDeliveredAt).not.toBeNull();
  });
});
