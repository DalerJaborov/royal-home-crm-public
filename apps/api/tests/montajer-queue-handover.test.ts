import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import pathMod from "node:path";
import { randomUUID } from "node:crypto";

/**
 * ОЧЕРЕДЬ МОНТАЖА ПЕРЕХОДИТ К ТЕКУЩЕМУ МОНТАЖЁРУ (решение владельца 10–11.11.2026:
 * «когда мы удаляем монтажёра, всё идёт к новому монтажёру»).
 *
 * Живой случай 10.11: Сади заменили на Бону, Сади отключили. Держатель места
 * был доставлен Сади (videoHandoffDeliveredAt стоит), сторож досылки считал его
 * доставленным, и Бона не получила ничего. Здесь проверяем:
 *  1. смена монтажёра (как угодно — здесь прямой записью в базу, как 10.11) →
 *     сторож досылает держателя новому, старому (если работает) — «передан»;
 *  2. повторный тик ничего не шлёт второй раз;
 *  3. прежний монтажёр отключён — ему ничего не пишем;
 *  4. монтажёра нет вовсе (увольнение снимает его из Настроек) — тревога,
 *     а не тишина, и только если что-то ждёт;
 *  5. удалённый объект на монтаж не встаёт (хвост №194).
 */

const { sendMessage, sendDocumentFile, sendDocument, alertMontageStuck } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string) => ({})),
  sendDocumentFile: vi.fn(async (_chatId: string) => ({ message_id: 1, document: { file_id: "f", file_unique_id: "u" } })),
  sendDocument: vi.fn(async () => ({})),
  alertMontageStuck: vi.fn(async (_input: { title: string; body: string; tag: string }) => true),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  sendDocumentFile,
  sendDocument,
}));
vi.mock("../src/lib/videoHandoffStaleAlarm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/videoHandoffStaleAlarm.js")>()),
  alertMontageStuck,
}));

const { prisma } = await import("../src/db.js");
const { setMontajerSendPauseMsForTests, queueVideoHandoff } = await import("../src/lib/videoHandoff.js");
const { runVideoHandoffRedeliveryTick } = await import("../src/lib/videoHandoffRedelivery.js");
const { clearAgentFromSettingsReferences } = await import("../src/lib/agentSettingsCleanup.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");

const runId = String(Date.now()).slice(-7);
const OLD_CHAT = `8${runId}1`;
const NEW_CHAT = `8${runId}2`;
let districtId: string;
let oldId: string;
let newId: string;
let propertyId: string;
let videoId: string;
let rawDir: string | null = null;
let saved: { videoMontajerAgentId: string | null; videoHandoffEnabled: boolean; videoHandoffQueuePaused: boolean } | null = null;

const chatCalls = (fn: { mock: { calls: unknown[][] } }, chat: string) => fn.mock.calls.filter((c) => c[0] === chat);
/** Файл уходит либо загрузкой (первый раз), либо по сохранённому file_id Telegram (повторно). */
const filesTo = (chat: string) => chatCalls(sendDocumentFile, chat).length + chatCalls(sendDocument, chat).length;

/** Держатель места, доставленный СТАРОМУ монтажёру, — состояние прода 10.11. */
async function holderDeliveredToOld(): Promise<void> {
  const now = new Date(Date.now() - 60 * 60 * 1000);
  await prisma.property.update({
    where: { id: propertyId },
    data: {
      deletedAt: null,
      videoHandoffStatus: "SENT_TO_EDITOR",
      videoHandoffSentAt: now,
      videoHandoffDeliveredAt: now,
      videoHandoffDispatchAttempts: 0,
      videoHandoffDispatchStartedAt: null,
      videoHandoffManualSince: null,
    },
  });
  await prisma.propertyVideo.update({ where: { id: videoId }, data: { montajerDeliveredAt: now, montajerDeliveredToId: oldId } });
}

beforeAll(async () => {
  setMontajerSendPauseMsForTests(0);
  await prisma.agent.deleteMany({ where: { telegramChatId: { in: [OLD_CHAT, NEW_CHAT] } } });
  districtId = (await prisma.district.create({ data: { name: `Передача очереди монтажа-${runId}` } })).id;
  oldId = (
    await prisma.agent.create({
      data: { fullName: "Сади тестовый", phone: `+99293${runId}1`, role: "EDITOR", passwordHash: "x", telegramChatId: OLD_CHAT },
    })
  ).id;
  newId = (
    await prisma.agent.create({
      data: { fullName: "Бону тестовая", phone: `+99293${runId}2`, role: "EDITOR", passwordHash: "x", telegramChatId: NEW_CHAT },
    })
  ).id;
  saved = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { videoMontajerAgentId: true, videoHandoffEnabled: true, videoHandoffQueuePaused: true },
  });
  // Чужие держатели места из других файлов не должны мешать (место одно на всю базу).
  await prisma.property.updateMany({
    where: { videoHandoffStatus: { in: ["SENT_TO_EDITOR", "QUEUED"] } },
    data: { videoHandoffStatus: "NONE" },
  });
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Передача очереди монтажа-${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 300000,
        currency: "TJS",
        districtId,
        address: "Проверочная, 7",
        condition: "GOOD",
        status: "EDITING",
      },
    })
  ).id;
  const storageKey = `${propertyId}/${randomUUID()}.mp4`;
  const filePath = localVideoFilePath(storageKey)!;
  await fs.mkdir(pathMod.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.alloc(512));
  rawDir = pathMod.dirname(filePath);
  videoId = (
    await prisma.propertyVideo.create({ data: { propertyId, storageKey, filename: "raw-1.mp4", sizeBytes: 512, uploadedById: oldId } })
  ).id;
});

beforeEach(async () => {
  sendMessage.mockClear();
  sendDocumentFile.mockClear();
  sendDocument.mockClear();
  alertMontageStuck.mockClear();
  await prisma.agent.updateMany({ where: { id: { in: [oldId, newId] } }, data: { isActive: true } });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { videoHandoffEnabled: true, videoHandoffQueuePaused: false, videoMontajerAgentId: newId },
  });
});

afterAll(async () => {
  setMontajerSendPauseMsForTests();
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  if (propertyId) await prisma.property.deleteMany({ where: { id: propertyId } });
  if (rawDir) await fs.rm(rawDir, { recursive: true, force: true }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: [oldId, newId].filter(Boolean) } } });
  if (districtId) await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("смена монтажёра: держатель места уходит новому", () => {
  it("сторож досылает исходники новому, старому пишет «передан», повтор не шлёт второй раз", async () => {
    await holderDeliveredToOld();

    await runVideoHandoffRedeliveryTick();

    expect(chatCalls(sendDocumentFile, NEW_CHAT).length).toBe(1);
    expect(chatCalls(sendDocumentFile, OLD_CHAT).length).toBe(0);
    expect(chatCalls(sendMessage, OLD_CHAT).some((c) => String(c[1]).includes("передан другому монтажёру"))).toBe(true);
    const video = await prisma.propertyVideo.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.montajerDeliveredToId).toBe(newId);
    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(property.videoHandoffDeliveredAt).not.toBeNull();

    sendMessage.mockClear();
    sendDocumentFile.mockClear();
    await runVideoHandoffRedeliveryTick();
    await runVideoHandoffRedeliveryTick();
    expect(filesTo(NEW_CHAT)).toBe(0);
    expect(chatCalls(sendMessage, NEW_CHAT).length).toBe(0);
    expect(chatCalls(sendMessage, OLD_CHAT).length).toBe(0);
  });

  it("прежний монтажёр отключён — ему ничего, новому всё", async () => {
    await holderDeliveredToOld();
    await prisma.agent.update({ where: { id: oldId }, data: { isActive: false } });

    await runVideoHandoffRedeliveryTick();

    expect(filesTo(NEW_CHAT)).toBe(1);
    expect(chatCalls(sendMessage, OLD_CHAT).length).toBe(0);
    expect(filesTo(OLD_CHAT)).toBe(0);
  });

  it("тот же монтажёр, что получил, — ничего не досылаем", async () => {
    await holderDeliveredToOld();
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: oldId } });

    await runVideoHandoffRedeliveryTick();

    expect(sendDocumentFile).not.toHaveBeenCalled();
  });
});

describe("монтажёра нет — тревога, а не тишина", () => {
  it("увольнение снимает монтажёра из Настроек и сообщает об этом вызывающему", async () => {
    const cleared = await clearAgentFromSettingsReferences(prisma, newId, "Бону тестовая", "deactivate");
    expect(cleared).toContain("videoMontajerAgentId");
    const s = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } });
    expect(s.videoMontajerAgentId).toBeNull();
  });

  it("держатель ждёт, монтажёра нет — сторож поднимает тревогу и ничего никому не шлёт", async () => {
    await holderDeliveredToOld();
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: null } });

    const result = await runVideoHandoffRedeliveryTick();

    expect(result.alerted).toBe(1);
    expect(alertMontageStuck).toHaveBeenCalledTimes(1);
    expect(alertMontageStuck.mock.calls[0]![0].tag).toBe("video-handoff-no-montajer");
    expect(alertMontageStuck.mock.calls[0]![0].title).toContain("Монтажёр не назначен");
    expect(sendDocumentFile).not.toHaveBeenCalled();
  });

  it("монтажёр в Настройках отключён — та же тревога", async () => {
    await holderDeliveredToOld();
    await prisma.agent.update({ where: { id: newId }, data: { isActive: false } });

    await runVideoHandoffRedeliveryTick();

    expect(alertMontageStuck).toHaveBeenCalledTimes(1);
    expect(sendDocumentFile).not.toHaveBeenCalled();
  });

  it("ничего не ждёт — тревоги нет", async () => {
    await prisma.property.update({ where: { id: propertyId }, data: { videoHandoffStatus: "NONE" } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: null } });

    await runVideoHandoffRedeliveryTick();

    expect(alertMontageStuck).not.toHaveBeenCalled();
  });
});

describe("удалённый объект на монтаж не встаёт (хвост №194)", () => {
  it("постановка в очередь после удаления ничего не меняет", async () => {
    await prisma.property.update({
      where: { id: propertyId },
      data: { videoHandoffStatus: "RECEIVED", deletedAt: new Date() },
    });

    await queueVideoHandoff(propertyId);

    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.videoHandoffStatus).toBe("RECEIVED");
    expect(sendDocumentFile).not.toHaveBeenCalled();
  });
});
