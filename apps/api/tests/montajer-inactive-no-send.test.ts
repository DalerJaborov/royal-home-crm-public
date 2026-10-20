import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import pathMod from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Отключённый монтажёр не получает сырые ролики в Telegram (G4, 02.10.2026).
 *
 * Так было: dispatchToEditor брал монтажёра по id из Настроек и слал в его
 * Telegram без проверки isActive. Настройка может указать на уволенного (точка
 * возврата, гонка с увольнением) — тогда ролики с адресом объекта уходили
 * бывшему сотруднику.
 */

const { sendMessage, sendDocumentFile, sendDocument, logSystemError } = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => {}),
  sendDocumentFile: vi.fn(async () => ({ message_id: 1, document: { file_id: "f", file_unique_id: "u" } })),
  sendDocument: vi.fn(async () => ({})),
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
const { dispatchToEditor, setMontajerSendPauseMsForTests } = await import("../src/lib/videoHandoff.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");

const runId = String(Date.now()).slice(-7);
const phone = `+99296${runId}`;
const CHAT = `9${runId}1`;
let districtId: string;
let montajerId: string;
let propertyId: string;
let rawDir: string | null = null;
let originalMontajer: string | null = null;

beforeAll(async () => {
  setMontajerSendPauseMsForTests(0);
  await prisma.agent.deleteMany({ where: { OR: [{ phone }, { telegramChatId: CHAT }] } });
  districtId = (await prisma.district.create({ data: { name: `Отключённый монтажёр-${runId}` } })).id;
  montajerId = (
    await prisma.agent.create({
      data: {
        fullName: "Монтажёр уволенный",
        phone,
        role: "EDITOR",
        isActive: false,
        passwordHash: await bcrypt.hash("testpass123", 4),
        telegramChatId: CHAT,
      },
    })
  ).id;
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
  originalMontajer = s?.videoMontajerAgentId ?? null;
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { videoMontajerAgentId: montajerId },
    create: { id: "singleton", videoMontajerAgentId: montajerId },
  });
  const p = await prisma.property.create({
    data: {
      title: `Отключённый монтажёр-${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 300000,
      currency: "TJS",
      districtId,
      address: "Проверочная, 1",
      condition: "GOOD",
      videoHandoffStatus: "SENT_TO_EDITOR",
      videoHandoffSentAt: new Date(),
    },
  });
  propertyId = p.id;
  const storageKey = `${propertyId}/${randomUUID()}.mp4`;
  const filePath = localVideoFilePath(storageKey)!;
  await fs.mkdir(pathMod.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.alloc(512));
  rawDir = pathMod.dirname(filePath);
  await prisma.propertyVideo.create({
    data: { propertyId, storageKey, filename: "raw-1.mp4", sizeBytes: 512, uploadedById: montajerId },
  });
});

afterAll(async () => {
  setMontajerSendPauseMsForTests();
  await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: originalMontajer } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  if (rawDir) await fs.rm(rawDir, { recursive: true, force: true }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: montajerId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("dispatchToEditor и отключённый монтажёр", () => {
  it("ничего не шлёт в Telegram и пишет понятную причину в журнал ошибок", async () => {
    const ok = await dispatchToEditor(propertyId, montajerId);
    expect(ok).toBe(false);
    expect(sendDocumentFile).not.toHaveBeenCalled();
    expect(sendDocument).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.filter((c) => (c as unknown[])[0] === CHAT)).toHaveLength(0);
    expect(logSystemError.mock.calls.some((c) => String((c as unknown[])[1]).includes("отключён"))).toBe(true);
  });
});
