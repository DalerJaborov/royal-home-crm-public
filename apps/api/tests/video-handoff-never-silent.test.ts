import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import pathMod from "node:path";
import { randomUUID } from "node:crypto";
import { waitFor } from "./helpers/waitFor.js";

/**
 * МОНТАЖ НЕ СТОИТ МОЛЧА (23.09.2026, жалоба владельца: объект «у монтажёра»,
 * монтажёр ничего не получил, очередь стояла, пока объект не сняли руками).
 * Каждый тест — одна дыра, через которую очередь вставала без единого сигнала:
 *  — ручное ожидание готового ролика занимало место монтажёра;
 *  — отметка доставки прошлого круга выдавала недоставленное за доставленное;
 *  — отправка возвращала на место монтажёра уже снятый объект;
 *  — доставка отмечалась только после копий наблюдателям;
 *  — пересылка монтажёра занимала место при занятой очереди;
 *  — сторож досылки сдавался строкой в журнал вместо тревоги руководителю.
 */

const { sendMessage, sendDocumentFile, sendPushToAgent, logSystemError } = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => {}),
  sendDocumentFile: vi.fn(async (..._args: unknown[]) => {}),
  sendPushToAgent: vi.fn(async () => {}),
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
  sendPushToAgents: vi.fn(async () => {}),
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

const { prisma } = await import("../src/db.js");
const { queueVideoHandoff, dispatchToEditor, reopenForResend, videoHandoffQueuePositions, cancelVideoHandoffQueueEntry, requeueVideoHandoff } = await import(
  "../src/lib/videoHandoff.js"
);
const { openForManualFinalVideo } = await import("../src/lib/publishedVideoFix.js");
const { runVideoHandoffRedeliveryTick, MANUAL_WAIT_MAX_MS, REDELIVERY_LOUD_AFTER_ATTEMPTS } = await import(
  "../src/lib/videoHandoffRedelivery.js"
);
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");

// 12:00 по Душанбе — внутри часов тревог.
const NOW = new Date("2026-09-01T07:00:00Z");
const runId = Date.now();
const tail = runId.toString().slice(-7);
const MONTAJER_CHAT = `8${tail}1`;
const OBSERVER_CHAT = `8${tail}2`;
let districtId: string;
let montajerId: string;
let directorId: string;
let observerId: string;
const propertyIds: string[] = [];
const rawDirs = new Set<string>();
let originalSettings: { videoHandoffEnabled: boolean; videoMontajerAgentId: string | null } | null = null;

async function seedProperty() {
  const p = await prisma.property.create({
    data: {
      title: `Монтаж без молчания-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 300000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 14",
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
      videoHandoffManualSince: true,
    },
  });

async function clearForeignQueue() {
  await prisma.property.updateMany({
    where: { videoHandoffStatus: { in: ["QUEUED", "SENT_TO_EDITOR"] }, id: { notIn: propertyIds } },
    data: { videoHandoffStatus: "RECEIVED" },
  });
  // Чужие наблюдатели в общей базе получали бы копии и мешали счёту вызовов.
  await prisma.agent.updateMany({
    where: { montageCopiesTelegram: true, id: { not: observerId } },
    data: { montageCopiesTelegram: false },
  });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Монтаж без молчания-${runId}` } })).id;
  const hash = await bcrypt.hash("testpass123", 4);
  montajerId = (
    await prisma.agent.create({
      data: { fullName: "Монтажёр без молчания", phone: `+99290${tail}`, role: "AGENT", passwordHash: hash, telegramChatId: MONTAJER_CHAT },
    })
  ).id;
  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор без молчания", phone: `+99291${tail}`, role: "DIRECTOR", passwordHash: hash },
    })
  ).id;
  observerId = (
    await prisma.agent.create({
      data: {
        fullName: "Наблюдатель без молчания",
        phone: `+99292${tail}`,
        role: "ADMIN",
        passwordHash: hash,
        telegramChatId: OBSERVER_CHAT,
        montageCopiesTelegram: false,
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
  logSystemError.mockClear();
});

afterEach(async () => {
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: {
      videoHandoffStatus: "NONE",
      videoHandoffSentAt: null,
      videoHandoffDeliveredAt: null,
      videoHandoffDispatchAttempts: 0,
      videoHandoffManualSince: null,
    },
  });
  await prisma.agent.update({ where: { id: observerId }, data: { montageCopiesTelegram: false } });
});

afterAll(async () => {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: originalSettings ?? { videoHandoffEnabled: false, videoMontajerAgentId: null },
  });
  await prisma.notification.deleteMany({ where: { agentId: { in: [directorId, observerId] } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  for (const d of rawDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: [montajerId, directorId, observerId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("ручное ожидание готового ролика не держит место монтажёра", () => {
  it("объект, открытый для ручной загрузки, не ставит следующий в очередь", async () => {
    const manual = await seedProperty();
    await openForManualFinalVideo(manual.id);
    expect((await state(manual.id)).videoHandoffManualSince).not.toBeNull();

    const next = await seedProperty();
    await addRawVideo(next.id);
    await queueVideoHandoff(next.id);
    const s = await state(next.id);
    expect(s.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(s.videoHandoffDeliveredAt).not.toBeNull();
    // В очереди на экране первым стоит настоящая передача, а не ручное ожидание.
    const positions = await videoHandoffQueuePositions();
    expect(positions.get(next.id)).toBe(1);
    expect(positions.has(manual.id)).toBe(false);
  });

  it("сторож не шлёт монтажёру исходники ручного ожидания", async () => {
    const manual = await seedProperty();
    await addRawVideo(manual.id);
    await openForManualFinalVideo(manual.id);
    await prisma.property.update({
      where: { id: manual.id },
      data: { videoHandoffSentAt: new Date(NOW.getTime() - 60 * 60 * 1000), videoHandoffDeliveredAt: null },
    });
    const r = await runVideoHandoffRedeliveryTick(NOW);
    expect(r.redelivered).toBe(0);
    expect(sendDocumentFile).not.toHaveBeenCalled();
  });

  it("брошенное больше суток ожидание снимается: без готового ролика — NONE", async () => {
    const manual = await seedProperty();
    await prisma.property.update({
      where: { id: manual.id },
      data: {
        videoHandoffStatus: "SENT_TO_EDITOR",
        videoHandoffSentAt: new Date(NOW.getTime() - MANUAL_WAIT_MAX_MS - 60_000),
        videoHandoffManualSince: new Date(NOW.getTime() - MANUAL_WAIT_MAX_MS - 60_000),
      },
    });
    const r = await runVideoHandoffRedeliveryTick(NOW);
    expect(r.manualExpired).toBe(1);
    const s = await state(manual.id);
    expect(s.videoHandoffStatus).toBe("NONE");
    expect(s.videoHandoffManualSince).toBeNull();
    expect(logSystemError).toHaveBeenCalledWith("video-handoff", expect.stringContaining("ожидание снято"));
  });

  it("свежее ручное ожидание сторож не трогает", async () => {
    const manual = await seedProperty();
    await prisma.property.update({
      where: { id: manual.id },
      data: {
        videoHandoffStatus: "SENT_TO_EDITOR",
        videoHandoffSentAt: new Date(NOW.getTime() - 60_000),
        videoHandoffManualSince: new Date(NOW.getTime() - 60_000),
      },
    });
    const r = await runVideoHandoffRedeliveryTick(NOW);
    expect(r.manualExpired).toBe(0);
    expect((await state(manual.id)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
  });
});

describe("доставка прошлого круга не считается доставкой", () => {
  it("место занято, отметка доставки старше занятия — сторож досылает", async () => {
    const p = await seedProperty();
    await addRawVideo(p.id);
    // Перемонтаж: прошлый круг доставлен двое суток назад, новый занял место час
    // назад, и процесс умер до отправки — отметка осталась от прошлого круга.
    await prisma.property.update({
      where: { id: p.id },
      data: {
        videoHandoffStatus: "SENT_TO_EDITOR",
        videoHandoffSentAt: new Date(NOW.getTime() - 60 * 60 * 1000),
        videoHandoffDeliveredAt: new Date(NOW.getTime() - 48 * 60 * 60 * 1000),
        videoHandoffDispatchAttempts: 0,
      },
    });
    const r = await runVideoHandoffRedeliveryTick(NOW);
    expect(r.redelivered).toBe(1);
    expect(sendDocumentFile).toHaveBeenCalledTimes(1);
  });

  it("доставленное в этом круге сторож не трогает", async () => {
    const p = await seedProperty();
    await addRawVideo(p.id);
    await prisma.property.update({
      where: { id: p.id },
      data: {
        videoHandoffStatus: "SENT_TO_EDITOR",
        videoHandoffSentAt: new Date(NOW.getTime() - 60 * 60 * 1000),
        videoHandoffDeliveredAt: new Date(NOW.getTime() - 59 * 60 * 1000),
      },
    });
    const r = await runVideoHandoffRedeliveryTick(NOW);
    expect(r.redelivered).toBe(0);
    expect(sendDocumentFile).not.toHaveBeenCalled();
  });
});

describe("отправка не воскрешает снятую передачу", () => {
  it("объект сняли с монтажа до отправки — место не занимается, монтажёру ничего", async () => {
    const p = await seedProperty();
    await addRawVideo(p.id);
    await prisma.property.update({ where: { id: p.id }, data: { videoHandoffStatus: "RECEIVED" } });
    const ok = await dispatchToEditor(p.id, montajerId);
    expect(ok).toBe(false);
    expect((await state(p.id)).videoHandoffStatus).toBe("RECEIVED");
    expect(sendDocumentFile).not.toHaveBeenCalled();
  });
});

describe("доставка отмечается до копий наблюдателям", () => {
  it("копия наблюдателю висит — доставка монтажёру уже отмечена", async () => {
    await prisma.agent.update({ where: { id: observerId }, data: { montageCopiesTelegram: true } });
    // Наблюдателю файл уходит «вечно» (как при перезапуске контейнера посреди копии).
    sendDocumentFile.mockImplementation(async (chatId: unknown) => {
      if (chatId === OBSERVER_CHAT) await new Promise(() => {});
    });
    const p = await seedProperty();
    await addRawVideo(p.id);
    await prisma.property.update({ where: { id: p.id }, data: { videoHandoffStatus: "SENT_TO_EDITOR" } });
    void dispatchToEditor(p.id, montajerId);
    const s = await waitFor(async () => {
      const cur = await state(p.id);
      return cur.videoHandoffDeliveredAt ? cur : null;
    });
    expect(s.videoHandoffDeliveredAt).not.toBeNull();
  });
});

describe("пересылка монтажёра", () => {
  it("не занимает место, если его уже держит другой объект", async () => {
    const holder = await seedProperty();
    await addRawVideo(holder.id);
    await queueVideoHandoff(holder.id);
    const old = await seedProperty();
    await prisma.property.update({ where: { id: old.id }, data: { videoHandoffStatus: "RECEIVED", videoHandoffSentAt: new Date() } });
    expect(await reopenForResend(old.id)).toBeNull();
    expect((await state(old.id)).videoHandoffStatus).toBe("RECEIVED");
  });
});

describe("тревога руководителю, а не строка в журнале", () => {
  it(`после ${REDELIVERY_LOUD_AFTER_ATTEMPTS} неудачных попыток директор получает тревогу`, async () => {
    const p = await seedProperty();
    await addRawVideo(p.id);
    await prisma.property.update({
      where: { id: p.id },
      data: {
        videoHandoffStatus: "SENT_TO_EDITOR",
        videoHandoffSentAt: new Date(NOW.getTime() - 60_000),
        videoHandoffDeliveredAt: null,
        videoHandoffDispatchAttempts: REDELIVERY_LOUD_AFTER_ATTEMPTS,
      },
    });
    const r = await runVideoHandoffRedeliveryTick(NOW);
    expect(r.alerted).toBe(1);
    const n = await prisma.notification.findFirst({
      where: { agentId: directorId, tag: `video-handoff-undelivered-${p.id}` },
      select: { title: true },
    });
    expect(n?.title).toContain("не получил");
    // Повтор тика в пределах шести часов не дублирует.
    await runVideoHandoffRedeliveryTick(new Date(NOW.getTime() + 5 * 60_000));
    expect(
      await prisma.notification.count({ where: { agentId: directorId, tag: `video-handoff-undelivered-${p.id}` } })
    ).toBe(1);
  });

  it("первая неудача ещё не тревога — сторож просто досылает", async () => {
    const p = await seedProperty();
    await addRawVideo(p.id);
    await prisma.property.update({
      where: { id: p.id },
      data: {
        videoHandoffStatus: "SENT_TO_EDITOR",
        videoHandoffSentAt: new Date(NOW.getTime() - 60_000),
        videoHandoffDeliveredAt: null,
        videoHandoffDispatchAttempts: 1,
      },
    });
    const r = await runVideoHandoffRedeliveryTick(NOW);
    expect(r.alerted).toBe(0);
  });
});

describe("снятый с монтажа объект можно отправить снова (№121)", () => {
  it("снять с монтажа, затем «Отправить на монтаж» — объект снова у монтажёра", async () => {
    const p = await seedProperty();
    await addRawVideo(p.id);
    await prisma.property.update({ where: { id: p.id }, data: { status: "EDITING" } });
    await queueVideoHandoff(p.id);
    expect((await cancelVideoHandoffQueueEntry(p.id)).ok).toBe(true);
    expect((await state(p.id)).videoHandoffStatus).toBe("RECEIVED");

    sendDocumentFile.mockClear();
    const r = await requeueVideoHandoff(p.id);
    expect(r).toEqual({ ok: true, queued: false });
    const s = await state(p.id);
    expect(s.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(s.videoHandoffDeliveredAt).not.toBeNull();
    expect(sendDocumentFile).toHaveBeenCalled();
  });

  it("место занято — встаёт в очередь", async () => {
    const holder = await seedProperty();
    await addRawVideo(holder.id);
    await queueVideoHandoff(holder.id);
    const p = await seedProperty();
    await addRawVideo(p.id);
    await prisma.property.update({ where: { id: p.id }, data: { status: "EDITING", videoHandoffStatus: "RECEIVED" } });
    expect(await requeueVideoHandoff(p.id)).toEqual({ ok: true, queued: true });
  });

  it("отказывает объекту без сырого видео, с готовым роликом или уже в очереди", async () => {
    const empty = await seedProperty();
    await prisma.property.update({ where: { id: empty.id }, data: { status: "EDITING", videoHandoffStatus: "RECEIVED" } });
    expect(await requeueVideoHandoff(empty.id)).toMatchObject({ ok: false, error: expect.stringContaining("нет сырого видео") });

    const finished = await seedProperty();
    await addRawVideo(finished.id);
    await prisma.property.update({
      where: { id: finished.id },
      data: { status: "EDITING", videoHandoffStatus: "RECEIVED", videoHandoffFinalPath: "/uploads/handoff/x.mp4" },
    });
    expect(await requeueVideoHandoff(finished.id)).toMatchObject({ ok: false, error: expect.stringContaining("Вернуть монтажёру") });

    const queued = await seedProperty();
    await addRawVideo(queued.id);
    await prisma.property.update({ where: { id: queued.id }, data: { status: "EDITING", videoHandoffStatus: "QUEUED" } });
    expect(await requeueVideoHandoff(queued.id)).toMatchObject({ ok: false });
  });
});
