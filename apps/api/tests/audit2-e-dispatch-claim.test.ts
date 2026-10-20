import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import pathMod from "node:path";
import { randomUUID } from "node:crypto";

/**
 * АУДИТ CODEX 04.10.2026, PUB05: захват отправки монтажёру допускал двух
 * одновременных отправителей. Захват в dispatchToEditor проверял только состояние
 * держателя, а не отметку живой отправки (videoHandoffDispatchStartedAt); busy-окно
 * resendSourceVideos сверялось по снимку, прочитанному ДО захвата. Два параллельных
 * вызова оба получали count=1 и оба слали недошедшие файлы — монтажёр получал дубли.
 *
 * Telegram подменён с управляемой задержкой (deferred), база и очередь настоящие.
 */

const { sendMessage, sendDocumentFile, sendDocument, logSystemError } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string) => {}),
  sendDocumentFile: vi.fn(),
  sendDocument: vi.fn(),
  logSystemError: vi.fn(async () => {}),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  sendDocumentFile,
  sendDocument,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));

const { prisma } = await import("../src/db.js");
const { dispatchToEditor, setMontajerSendPauseMsForTests, resendSourceVideos } = await import("../src/lib/videoHandoff.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");

const runId = Date.now();
const phone = `+99294${runId.toString().slice(-7)}`;
const MONTAJER_CHAT = `7${runId.toString().slice(-8)}`;
let districtId: string;
let montajerId: string;
const propertyIds: string[] = [];
const rawDirs = new Set<string>();
let originalSettings: { videoHandoffEnabled: boolean; videoMontajerAgentId: string | null } | null = null;

/** Каждое обращение к Telegram: имя файла. Отпускается вручную через release(). */
let sentNames: string[] = [];
let release: () => void = () => {};
let gate: Promise<void> = Promise.resolve();

function holdTelegram() {
  gate = new Promise<void>((resolve) => (release = resolve));
  let callNo = 0;
  sendDocumentFile.mockReset().mockImplementation(async (_chat: string, _file: unknown, name: string) => {
    callNo++;
    sentNames.push(name);
    await gate;
    return { message_id: callNo, document: { file_id: `fid-${name}`, file_unique_id: `u-${name}` } };
  });
  sendDocument.mockReset().mockImplementation(async () => ({}));
}

async function seedHolder(label: string, videos = 3) {
  const p = await prisma.property.create({
    data: {
      title: `Захват отправки-${label}-${runId}`,
      type: "APARTMENT",
      areaSqm: 61,
      price: 410000,
      currency: "TJS",
      districtId,
      address: "Проверочная, 1",
      condition: "GOOD",
      videoHandoffStatus: "SENT_TO_EDITOR",
      videoHandoffSentAt: new Date(),
      videoHandoffDeliveredAt: null,
      videoHandoffDispatchAttempts: 0,
    },
  });
  propertyIds.push(p.id);
  const base = Date.now() - 60 * 60 * 1000;
  for (let i = 0; i < videos; i++) {
    const storageKey = `${p.id}/${randomUUID()}.mp4`;
    const filePath = localVideoFilePath(storageKey)!;
    await fs.mkdir(pathMod.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.alloc(512 + i));
    rawDirs.add(pathMod.dirname(filePath));
    await prisma.propertyVideo.create({
      data: { propertyId: p.id, storageKey, filename: `raw-${i + 1}.mp4`, sizeBytes: 512 + i, uploadedById: montajerId, uploadedAt: new Date(base + i * 1000) },
    });
  }
  return p;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Захват отправки-${runId}` } })).id;
  montajerId = (
    await prisma.agent.create({
      data: { fullName: "Монтажёр захвата", phone, role: "EDITOR", passwordHash: await bcrypt.hash("testpass123", 4), telegramChatId: MONTAJER_CHAT },
    })
  ).id;
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoHandoffEnabled: true, videoMontajerAgentId: true } });
  originalSettings = s ? { videoHandoffEnabled: s.videoHandoffEnabled, videoMontajerAgentId: s.videoMontajerAgentId } : null;
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { videoHandoffEnabled: true, videoMontajerAgentId: montajerId },
    create: { id: "singleton", videoHandoffEnabled: true, videoMontajerAgentId: montajerId },
  });
  setMontajerSendPauseMsForTests(0);
});

beforeEach(async () => {
  await prisma.property.updateMany({
    where: { videoHandoffStatus: "SENT_TO_EDITOR", id: { notIn: propertyIds } },
    data: { videoHandoffStatus: "RECEIVED" },
  });
  sentNames = [];
  sendMessage.mockReset().mockResolvedValue(undefined);
  logSystemError.mockClear();
  holdTelegram();
});

afterEach(async () => {
  release();
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { videoHandoffStatus: "NONE" } });
});

afterAll(async () => {
  setMontajerSendPauseMsForTests();
  await prisma.settings.update({
    where: { id: "singleton" },
    data: originalSettings ?? { videoHandoffEnabled: false, videoMontajerAgentId: null },
  });
  await prisma.montajerMessage.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  for (const d of rawDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  await prisma.agent.deleteMany({ where: { phone } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("захват отправки монтажёру атомарен", () => {
  it("два dispatchToEditor одновременно — каждый файл уходит ровно один раз", async () => {
    const p = await seedHolder("два-вызова");
    const a = dispatchToEditor(p.id, montajerId);
    const b = dispatchToEditor(p.id, montajerId);
    // Пока Telegram «думает», оба вызова уже прошли захват (или проигравший отказался).
    await vi.waitFor(() => expect(sentNames.length).toBeGreaterThan(0), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    release();
    const [first, second] = await Promise.all([a, b]);

    expect(sentNames.sort()).toEqual([`${p.shortId}_1из3.mp4`, `${p.shortId}_2из3.mp4`, `${p.shortId}_3из3.mp4`]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    // Отметка живой отправки погашена победителем.
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffDispatchStartedAt: true, videoHandoffDeliveredAt: true } });
    expect(after.videoHandoffDispatchStartedAt).toBeNull();
    expect(after.videoHandoffDeliveredAt).not.toBeNull();
  });

  it("два «файлы» одновременно (resendSourceVideos) — файлы один раз, второй получает busy", async () => {
    const p = await seedHolder("два-слова");
    const a = resendSourceVideos();
    const b = resendSourceVideos();
    await vi.waitFor(() => expect(sentNames.length).toBeGreaterThan(0), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    release();
    const results = await Promise.all([a, b]);

    expect(sentNames).toHaveLength(3);
    expect(results.filter((r) => r.busy === true)).toHaveLength(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.every((r) => r.shortId === p.shortId)).toBe(true);
  });

  it("отметка живой отправки старше окна (хозяин умер) — захват законный, файлы уходят", async () => {
    const p = await seedHolder("мёртвая-отметка");
    await prisma.property.update({ where: { id: p.id }, data: { videoHandoffDispatchStartedAt: new Date(Date.now() - 20 * 60 * 1000) } });
    release();
    expect(await dispatchToEditor(p.id, montajerId)).toBe(true);
    expect(sentNames).toHaveLength(3);
  });

  it("свежая отметка чужой отправки — захвата нет, файлы не уходят, это не «передачу сняли»", async () => {
    const p = await seedHolder("свежая-отметка");
    await prisma.property.update({ where: { id: p.id }, data: { videoHandoffDispatchStartedAt: new Date() } });
    release();
    expect(await dispatchToEditor(p.id, montajerId)).toBe(false);
    expect(sentNames).toHaveLength(0);
    expect(logSystemError.mock.calls.some((c) => String(c[1]).includes("передачу сняли"))).toBe(false);
  });
});
