import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import pathMod from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { waitFor } from "./helpers/waitFor.js";

/**
 * КОПИИ МОНТАЖА — ВСЕ СООБЩЕНИЯ, А НЕ ТОЛЬКО ФАЙЛЫ (25.09.2026, задание А-Д,
 * владелец: «сделай, чтобы я получал те же сообщения, что и монтажёр»).
 *
 * До этой правки sendMontageCopies собирали вручную только в двух местах
 * (deliverSourceVideos — файлы исходников, videoHandoffStaleAlarm — тревога
 * зависшего монтажа); контрольное «отправлено N из N», снятие с монтажа,
 * продан/удалён, квитанция о приёме, вопрос «чей ролик» и смена монтажёра
 * уходили мимо наблюдателя. Теперь единая точка — sendToMontajer
 * (lib/montageObservers.ts) — и это её сквозная проверка: для каждого типа
 * сообщения монтажёр получает текст как раньше, наблюдатель — тот же текст с
 * префиксом «Копия. Монтажёр: …» и БЕЗ кнопок, ответы на команды меню
 * («очередь», «меню» и т.п.) наблюдателю не идут вовсе, а отказ Telegram у
 * одного наблюдателя не роняет ни монтажёра, ни второго наблюдателя.
 *
 * Запуск (см. CLAUDE.md, «Исполнителю одной задачи достаточно»):
 *   cd apps/api && npx vitest run tests/montage tests/video-handoff tests/montajer tests/telegram-agent-link
 */

const {
  sendMessage,
  sendMessageWithButtons,
  sendDocumentFile,
  sendDocument,
  resolveTelegramFileMaterialization,
  logSystemError,
  dispatchInBackground,
} = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string) => ({})),
  sendMessageWithButtons: vi.fn(async (_chatId: string, _text: string, _buttons: unknown) => ({ message_id: 1 })),
  sendDocumentFile: vi.fn(async (_c: string, _f: unknown, name: string) => ({
    message_id: 1,
    document: { file_id: `fid-${name}`, file_unique_id: `fuid-${name}` },
  })),
  sendDocument: vi.fn(async () => ({})),
  resolveTelegramFileMaterialization: vi.fn(async () => ({ kind: "buffer", buffer: randomBytes(4096) })),
  logSystemError: vi.fn(async () => {}),
  dispatchInBackground: vi.fn(() => {}),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  sendMessageWithButtons,
  sendDocumentFile,
  sendDocument,
  resolveTelegramFileMaterialization,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => {}),
  sendPushToAgents: vi.fn(async () => 0),
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
    durationSec: 10,
    sizeBytes: 1024,
  })),
}));

delete process.env.TELEGRAM_BOT_TOKEN;
process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");
const { sendToMontajer } = await import("../src/lib/montageObservers.js");
const {
  queueVideoHandoff,
  dispatchToEditor,
  cancelVideoHandoffQueueEntry,
  releaseVideoHandoffForTrashed,
  setMontajerSendPauseMsForTests,
  settleBackgroundHandoffDispatches,
} = await import("../src/lib/videoHandoff.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");
const { grantElevation } = await import("../src/lib/stepUp.js");

const runId = Date.now();
const phone = `+99294${runId.toString().slice(-7)}`;
const adminPhone = `+99298${runId.toString().slice(-7)}`;
const otherMontajerPhone = `+99297${runId.toString().slice(-7)}`;
const MONTAJER_CHAT = `mj-chat-${runId}`;
const OBSERVER_CHAT = `observer-${runId}`;
const OBSERVER2_CHAT = `observer2-${runId}`;
let nextUpdateId = runId % 1_000_000_000;

let districtId: string;
let montajerId: string;
let observerId: string;
let observer2Id: string;
let adminId: string;
let adminToken: string;
const propertyIds: string[] = [];
const rawDirs = new Set<string>();
let originalSettings: { videoHandoffEnabled: boolean; videoMontajerAgentId: string | null } | null = null;

async function seedProperty(label: string, data: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Копии монтажа-${label}-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 55,
      price: 350000,
      currency: "TJS",
      districtId,
      address: `Контрольная, ${propertyIds.length + 1}`,
      condition: "GOOD",
      ...data,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function addRawVideo(propertyId: string, filename = "raw.mp4") {
  const storageKey = `${propertyId}/${randomUUID()}.mp4`;
  const filePath = localVideoFilePath(storageKey);
  if (!filePath) throw new Error("путь хранилища не разрешился");
  await fs.mkdir(pathMod.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.alloc(1024));
  rawDirs.add(pathMod.dirname(filePath));
  return prisma.propertyVideo.create({
    data: { propertyId, storageKey, filename, sizeBytes: 1024, uploadedById: montajerId },
  });
}

function sendFile(fileName: string, caption?: string) {
  const updateId = nextUpdateId++;
  return {
    updateId,
    done: handleTelegramUpdate({
      update_id: updateId,
      message: {
        chat: { id: Number(`9${updateId}`) || updateId },
        document: { file_id: `doc-${updateId}`, mime_type: "video/mp4", file_name: fileName },
        ...(caption ? { caption } : {}),
      },
    }),
  };
}

/** Ролик от монтажёра — чат берём фиксированным строковым chatId, как у
 *  настоящего монтажёра теста (Settings.videoMontajerAgentId → telegramChatId). */
function sendMontajerFile(fileName: string) {
  const updateId = nextUpdateId++;
  return {
    updateId,
    done: handleTelegramUpdate({
      update_id: updateId,
      message: {
        chat: { id: MONTAJER_CHAT as unknown as number },
        document: { file_id: `doc-${updateId}`, mime_type: "video/mp4", file_name: fileName },
      },
    }),
  };
}

function textFromMontajer(body: string) {
  return handleTelegramUpdate({
    update_id: nextUpdateId++,
    message: { chat: { id: MONTAJER_CHAT as unknown as number }, text: body },
  });
}

function pressFromMontajer(data: string) {
  return handleTelegramUpdate({
    update_id: nextUpdateId++,
    callback_query: { id: `cb-${runId}-${nextUpdateId}`, data, message: { chat: { id: MONTAJER_CHAT as unknown as number }, message_id: 1 } },
  });
}

/** Тексты, реально ушедшие данному chatId (и обычным sendMessage, и с кнопками). */
function textsTo(chatId: string): string[] {
  return [
    ...sendMessage.mock.calls.filter((c) => c[0] === chatId).map((c) => String(c[1])),
    ...sendMessageWithButtons.mock.calls.filter((c) => c[0] === chatId).map((c) => String(c[1])),
  ];
}

function hadButtons(chatId: string): boolean {
  return sendMessageWithButtons.mock.calls.some((c) => c[0] === chatId);
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Копии монтажа-${runId}` } })).id;
  const passwordHash = await bcrypt.hash("testpass123", 4);
  montajerId = (
    await prisma.agent.create({
      data: { fullName: "Монтажёр копий", phone, role: "EDITOR", passwordHash, telegramChatId: MONTAJER_CHAT },
    })
  ).id;
  observerId = (
    await prisma.agent.create({
      data: {
        fullName: "Наблюдатель монтажа",
        phone: `+99299${runId.toString().slice(-7)}`,
        role: "ADMIN",
        passwordHash,
        telegramChatId: OBSERVER_CHAT,
        montageCopiesTelegram: true,
      },
    })
  ).id;
  observer2Id = (
    await prisma.agent.create({
      data: {
        fullName: "Второй наблюдатель",
        phone: `+99292${runId.toString().slice(-7)}`,
        role: "AGENT",
        passwordHash,
        telegramChatId: OBSERVER2_CHAT,
        montageCopiesTelegram: true,
      },
    })
  ).id;
  const admin = await prisma.agent.create({
    data: { fullName: "Админ копий монтажа", phone: adminPhone, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: adminPhone, password: "testpass123" });
  adminToken = res.body.accessToken;
  grantElevation(adminId);

  originalSettings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { videoHandoffEnabled: true, videoMontajerAgentId: true },
  });
  await prisma.settings.update({ where: { id: "singleton" }, data: { videoHandoffEnabled: true, videoMontajerAgentId: montajerId } });
  setMontajerSendPauseMsForTests(0);
});

beforeEach(async () => {
  await prisma.property.updateMany({
    where: { videoHandoffStatus: "SENT_TO_EDITOR", id: { notIn: propertyIds } },
    data: { videoHandoffStatus: "RECEIVED" },
  });
  await prisma.settings.update({ where: { id: "singleton" }, data: { videoHandoffEnabled: true, videoMontajerAgentId: montajerId } });
  await prisma.telegramDialogState.deleteMany({ where: { chatId: MONTAJER_CHAT } });
  for (const m of [sendMessage, sendMessageWithButtons, sendDocumentFile, sendDocument, logSystemError, dispatchInBackground]) m.mockClear();
  resolveTelegramFileMaterialization.mockReset().mockImplementation(async () => ({ kind: "buffer", buffer: randomBytes(4096) }));
});

afterEach(async () => {
  await settleBackgroundHandoffDispatches().catch(() => {});
  if (propertyIds.length) {
    await prisma.property.updateMany({
      where: { id: { in: propertyIds } },
      data: { videoHandoffStatus: "NONE", videoHandoffSentAt: null, videoHandoffManualSince: null },
    });
  }
});

afterAll(async () => {
  setMontajerSendPauseMsForTests();
  if (originalSettings) await prisma.settings.update({ where: { id: "singleton" }, data: originalSettings });
  await prisma.telegramDialogState.deleteMany({ where: { chatId: MONTAJER_CHAT } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  for (const dir of rawDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: [montajerId, observerId, observer2Id, adminId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("sendToMontajer — единая точка отправки", () => {
  it("copy:true — наблюдатель получает тот же текст с префиксом «Копия. Монтажёр: …» и без кнопок, монтажёр — с кнопками как задано", async () => {
    await sendToMontajer(MONTAJER_CHAT, "Проверочный текст монтажёру", {
      copy: true,
      replyMarkup: [[{ text: "Кнопка", callback_data: "x" }]],
    });

    expect(sendMessageWithButtons).toHaveBeenCalledWith(MONTAJER_CHAT, "Проверочный текст монтажёру", [
      [{ text: "Кнопка", callback_data: "x" }],
    ]);
    const toObserver = textsTo(OBSERVER_CHAT);
    expect(toObserver).toHaveLength(1);
    expect(toObserver[0]).toContain("Копия. Монтажёр: Монтажёр копий");
    expect(toObserver[0]).toContain("Проверочный текст монтажёру");
    expect(hadButtons(OBSERVER_CHAT)).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(OBSERVER_CHAT, expect.any(String));
  });

  it("copy:false — наблюдатель не получает ничего", async () => {
    await sendToMontajer(MONTAJER_CHAT, "Ответ на команду меню", { copy: false });

    expect(sendMessage).toHaveBeenCalledWith(MONTAJER_CHAT, "Ответ на команду меню");
    expect(textsTo(OBSERVER_CHAT)).toHaveLength(0);
  });

  it("отказ Telegram у одного наблюдателя не мешает ни монтажёру, ни второму наблюдателю", async () => {
    sendMessage.mockImplementation(async (chatId: string) => {
      if (chatId === OBSERVER_CHAT) throw new Error("наблюдатель заблокировал бота");
      return {};
    });

    await expect(sendToMontajer(MONTAJER_CHAT, "Текст с одним отказавшим наблюдателем", { copy: true })).resolves.toBeDefined();

    expect(sendMessage).toHaveBeenCalledWith(OBSERVER2_CHAT, expect.stringContaining("Текст с одним отказавшим наблюдателем"));
    expect(logSystemError).toHaveBeenCalledWith("video-handoff", expect.stringContaining(observerId));
  });
});

describe("Контрольное «Отправлено N из N»", () => {
  it("монтажёр получает контрольный текст, наблюдатель — его копию", async () => {
    const property = await seedProperty("контроль");
    await addRawVideo(property.id);
    await prisma.property.update({
      where: { id: property.id },
      data: { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date(), videoHandoffDeliveredAt: null, videoHandoffDispatchAttempts: 0 },
    });

    await dispatchToEditor(property.id, montajerId);

    const controlText = `Отправлено 1 из 1 файла объекта №${property.shortId}.`;
    expect(textsTo(MONTAJER_CHAT)).toContain(controlText);
    const observerCopies = textsTo(OBSERVER_CHAT);
    expect(observerCopies.some((t) => t.includes("Копия. Монтажёр:") && t.includes(controlText))).toBe(true);
  });
});

describe("Снятие с монтажа / продан / удалён", () => {
  async function seat(propertyId: string) {
    await prisma.property.update({
      where: { id: propertyId },
      data: { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() },
    });
  }

  it("«снято с монтажа» (cancelVideoHandoffQueueEntry) — монтажёр и наблюдатель получают одно и то же", async () => {
    const property = await seedProperty("снятие");
    await seat(property.id);

    const result = await cancelVideoHandoffQueueEntry(property.id);

    expect(result.ok).toBe(true);
    const expectedText = `Объект №${property.shortId} сняли с монтажа — доделывать не нужно, ролик можно не присылать.`;
    expect(textsTo(MONTAJER_CHAT)).toContain(expectedText);
    const observerCopies = textsTo(OBSERVER_CHAT);
    expect(observerCopies.some((t) => t.includes("Копия. Монтажёр:") && t.includes(expectedText))).toBe(true);
  });

  it("объект удалён в Корзину (releaseVideoHandoffForTrashed) — тоже уходит наблюдателю", async () => {
    const property = await seedProperty("удаление");
    await seat(property.id);

    await releaseVideoHandoffForTrashed([property.id]);

    const expectedText = `Объект №${property.shortId} удалён — доделывать не нужно, ролик можно не присылать.`;
    expect(textsTo(MONTAJER_CHAT)).toContain(expectedText);
    const observerCopies = textsTo(OBSERVER_CHAT);
    expect(observerCopies.some((t) => t.includes("Копия. Монтажёр:") && t.includes(expectedText))).toBe(true);
  });
});

describe("Квитанция о приёме ролика", () => {
  it("монтажёр получает квитанцию, наблюдатель — её копию", async () => {
    const holder = await seedProperty("квитанция", { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() });

    const { done } = sendMontajerFile(`${holder.shortId}.mp4`);
    await done;

    await waitFor(async () => {
      const state = await prisma.property.findUniqueOrThrow({ where: { id: holder.id }, select: { videoHandoffStatus: true } });
      return state.videoHandoffStatus === "RECEIVED" ? true : null;
    });

    const montajerTexts = textsTo(MONTAJER_CHAT);
    expect(montajerTexts.some((t) => t.includes(`№${holder.shortId}`) && t.includes("принят"))).toBe(true);
    const receiptText = montajerTexts.find((t) => t.includes(`№${holder.shortId}`) && t.includes("принят"))!;
    const observerCopies = textsTo(OBSERVER_CHAT);
    expect(observerCopies.some((t) => t.includes("Копия. Монтажёр:") && t.includes(receiptText))).toBe(true);
  });
});

// Вопрос «чей ролик» для файла без номера убран владельцем 29.09.2026 (#1013);
// кнопки монтажёру остались у отказа «номер не совпал» — на нём и проверяем копию.
describe("Вопрос с кнопками (номер в имени не совпал)", () => {
  it("монтажёр получает отказ кнопками, наблюдатель — текст без кнопок", async () => {
    const holder = await seedProperty("держатель-вопрос", { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date(Date.now() - 60_000) });
    const idle = await seedProperty("не-ждёт-вопрос", {});

    const { done } = sendMontajerFile(`${idle.shortId}.mp4`);
    await done;

    expect(hadButtons(MONTAJER_CHAT)).toBe(true);
    const montajerQuestion = sendMessageWithButtons.mock.calls.find((c) => c[0] === MONTAJER_CHAT)?.[1] as string;
    expect(montajerQuestion).toContain("сейчас не ждёт от вас ролик");

    const observerCopies = textsTo(OBSERVER_CHAT);
    expect(observerCopies.some((t) => t.includes("Копия. Монтажёр:") && t.includes("сейчас не ждёт от вас ролик"))).toBe(true);
    expect(hadButtons(OBSERVER_CHAT)).toBe(false);

    await prisma.property.update({ where: { id: holder.id }, data: { videoHandoffStatus: "NONE" } });
  });
});

describe("Меню монтажёра НЕ копируется наблюдателю", () => {
  it("«очередь» — монтажёр получает ответ, наблюдатель не получает ничего", async () => {
    await textFromMontajer("очередь");

    expect(textsTo(MONTAJER_CHAT).length).toBeGreaterThan(0);
    expect(textsTo(OBSERVER_CHAT)).toHaveLength(0);
  });

  it("«меню» — то же самое", async () => {
    await textFromMontajer("меню");

    expect(textsTo(MONTAJER_CHAT).length).toBeGreaterThan(0);
    expect(textsTo(OBSERVER_CHAT)).toHaveLength(0);
  });
});

describe("Смена монтажёра в Настройках", () => {
  it("старому монтажёру уходит «передан другому», наблюдатель получает копию", async () => {
    const other = await prisma.agent.create({
      data: {
        fullName: "Другой монтажёр",
        phone: otherMontajerPhone,
        role: "AGENT",
        passwordHash: await bcrypt.hash("testpass123", 4),
        telegramChatId: `other-montajer-${runId}`,
      },
    });
    try {
      const holder = await seedProperty("смена-монтажёра", { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() });

      const res = await request(app)
        .patch("/api/v1/settings")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ videoMontajerAgentId: other.id });

      expect(res.status).toBe(200);
      const expectedText = `Объект №${holder.shortId} передан другому монтажёру.`;
      expect(textsTo(MONTAJER_CHAT)).toContain(expectedText);
      const observerCopies = textsTo(OBSERVER_CHAT);
      expect(observerCopies.some((t) => t.includes("Копия. Монтажёр:") && t.includes(expectedText))).toBe(true);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: montajerId } });
      await prisma.agent.delete({ where: { id: other.id } });
    }
  });
});
