import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * БОТ МОНТАЖЁРА ЦЕЛИКОМ (25.09.2026): настоящие telegram/bot.ts, montajerReceive,
 * montajerBot, lib/videoHandoff и база стенда; подменён только Telegram (отправка,
 * скачивание файла), ffprobe и соцсети. В отличие от telegram-agent-link.test.ts,
 * где videoHandoff отрезан целиком, здесь проверяется связка «бот → приём → база».
 *
 *  — файл без номера при двух ждущих объектах: вопрос кнопками, до ответа ничего
 *    не принято; выбор — приём на выбранный, держатель места не тронут; сбой
 *    скачивания после выбора откатывает только выбранный;
 *  — «Ни то, ни другое» и устаревший вопрос ничего не принимают;
 *  — передача через бота выключена в Настройках — понятный отказ (А8);
 *  — квитанция честная: при выключенной автопубликации «публиковаться не будет» (А7);
 *  — меню: каждая команда словом и кнопкой отвечает и не падает на объекте без
 *    фото, видео и публикаций; на полном объекте — фото альбомом, исходники со
 *    ссылками, «где вышел» со ссылкой; чужой чат меню не получает.
 */

const {
  sendMessage,
  sendMessageWithButtons,
  answerCallbackQuery,
  resolveTelegramFileMaterialization,
  sendDocumentFile,
  sendDocument,
  sendPhotoFromDisk,
  sendMediaGroupFiles,
  publishApprovedPost,
} = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string) => ({})),
  sendMessageWithButtons: vi.fn(async (_chatId: string, _text: string, _buttons: unknown) => ({ message_id: 1 })),
  answerCallbackQuery: vi.fn(async () => ({})),
  resolveTelegramFileMaterialization: vi.fn(),
  sendDocumentFile: vi.fn(async (_c: string, _f: unknown, name: string) => ({ message_id: 1, document: { file_id: `fid-${name}` } })),
  sendDocument: vi.fn(async () => ({})),
  sendPhotoFromDisk: vi.fn(async () => ({ message_id: 1 })),
  sendMediaGroupFiles: vi.fn(async () => []),
  publishApprovedPost: vi.fn(async () => [] as unknown[]),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  sendMessageWithButtons,
  answerCallbackQuery,
  resolveTelegramFileMaterialization,
  sendDocumentFile,
  sendDocument,
  sendPhotoFromDisk,
  sendMediaGroupFiles,
}));
vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  publishApprovedPost,
}));
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
    durationSec: 15,
    sizeBytes: 2048,
  })),
}));

delete process.env.TELEGRAM_BOT_TOKEN;
process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";

const { prisma } = await import("../src/db.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");
const { recordMontajerMessage, setMontajerSendPauseMsForTests, videoHandoffPublishDedupeKey } = await import("../src/lib/videoHandoff.js");
const { uploadsDir, videoHandoffDir } = await import("../src/upload.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");
const { waitFor } = await import("./helpers/waitFor.js");

const runId = Date.now();
const phone = `+99291${runId.toString().slice(-7)}`;
const otherPhone = `+99290${runId.toString().slice(-7)}`;
const MONTAJER_CHAT = 760000000 + (runId % 1_000_000);
const STRANGER_CHAT = 761000000 + (runId % 1_000_000);
let nextUpdateId = runId % 1_000_000_000;
let districtId: string;
let montajerId: string;
const propertyIds: string[] = [];
const createdFiles: string[] = [];
const rawDirs = new Set<string>();
const SETTINGS_SELECT = { videoHandoffEnabled: true, videoMontajerAgentId: true, autoPublishEnabled: true } as const;
let savedSettings: { videoHandoffEnabled: boolean; videoMontajerAgentId: string | null; autoPublishEnabled: boolean } | null = null;

async function seedProperty(label: string, data: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Бот монтажёра-${label}-${runId}`,
      type: "APARTMENT",
      areaSqm: 64,
      price: 420000,
      currency: "TJS",
      districtId,
      address: "Ботовая, 5",
      rooms: 2,
      condition: "GOOD",
      status: "EDITING",
      ...data,
    },
  });
  propertyIds.push(p.id);
  return p;
}

const holderData = () => ({ videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date(Date.now() - 60_000) });

/** Недавно сданный в бот и ещё не опубликованный объект: RECEIVED + квитанция. */
async function recentlyReceived(label: string) {
  const p = await seedProperty(label, { videoHandoffStatus: "RECEIVED", videoHandoffSentAt: new Date(Date.now() - 30 * 60_000) });
  await recordMontajerMessage(p.id, "RECEIPT", `Ролик по объекту №${p.shortId} принят, публикую по каналам.`);
  return p;
}

function sendFile(fileName: string, caption?: string) {
  const updateId = nextUpdateId++;
  return {
    updateId,
    done: handleTelegramUpdate({
      update_id: updateId,
      message: {
        chat: { id: MONTAJER_CHAT },
        document: { file_id: `doc-${updateId}`, mime_type: "video/mp4", file_name: fileName },
        ...(caption ? { caption } : {}),
      },
    }),
  };
}

function text(chatId: number, body: string) {
  return handleTelegramUpdate({ update_id: nextUpdateId++, message: { chat: { id: chatId }, text: body } });
}

function press(chatId: number, data: string) {
  return handleTelegramUpdate({
    update_id: nextUpdateId++,
    callback_query: { id: `cb-${runId}-${nextUpdateId}`, data, message: { chat: { id: chatId }, message_id: 1 } },
  });
}

/** Всё, что бот ответил монтажёру, одной строкой на ответ (текст и кнопки). */
function replies(): string[] {
  return [
    ...sendMessage.mock.calls.map((c) => String(c[1])),
    ...sendMessageWithButtons.mock.calls.map((c) => `${String(c[1])}\n${JSON.stringify(c[2])}`),
  ];
}

async function finalPath(id: string) {
  return (await prisma.property.findUniqueOrThrow({ where: { id }, select: { videoHandoffFinalPath: true } })).videoHandoffFinalPath;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Бот монтажёра-${runId}` } })).id;
  montajerId = (
    await prisma.agent.create({
      data: {
        fullName: "Сади тестовый",
        phone,
        role: "EDITOR",
        passwordHash: await bcrypt.hash("testpass123", 4),
        telegramChatId: String(MONTAJER_CHAT),
      },
    })
  ).id;
  // Чужой привязанный сотрудник — меню монтажёра ему недоступно.
  await prisma.agent.create({
    data: { fullName: "Не монтажёр", phone: otherPhone, role: "AGENT", passwordHash: await bcrypt.hash("testpass123", 4), telegramChatId: String(STRANGER_CHAT) },
  });
  savedSettings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" }, select: SETTINGS_SELECT });
  await prisma.settings.update({ where: { id: "singleton" }, data: { videoHandoffEnabled: true, videoMontajerAgentId: montajerId } });
  setMontajerSendPauseMsForTests(0);
});

beforeEach(async () => {
  // Чужие держатели места в общей базе — не наши, иначе бот нашёл бы их первыми.
  await prisma.property.updateMany({
    where: { videoHandoffStatus: "SENT_TO_EDITOR", id: { notIn: propertyIds } },
    data: { videoHandoffStatus: "RECEIVED" },
  });
  await prisma.telegramDialogState.deleteMany({ where: { chatId: String(MONTAJER_CHAT) } });
  for (const m of [sendMessage, sendMessageWithButtons, answerCallbackQuery, sendDocumentFile, sendDocument, sendPhotoFromDisk, sendMediaGroupFiles]) m.mockClear();
  resolveTelegramFileMaterialization.mockReset().mockImplementation(async () => ({ kind: "buffer", buffer: randomBytes(4096) }));
});

afterEach(async () => {
  // Свои объекты больше не ждут ролик — вопрос «чей ролик» следующего теста их не видит.
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { videoHandoffStatus: "NONE", videoHandoffManualSince: null } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { videoHandoffEnabled: true } });
});

afterAll(async () => {
  setMontajerSendPauseMsForTests();
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  const finals = await prisma.property.findMany({ where: { id: { in: propertyIds } }, select: { videoHandoffFinalPath: true } });
  for (const f of finals) if (f.videoHandoffFinalPath) createdFiles.push(path.join(videoHandoffDir, path.basename(f.videoHandoffFinalPath)));
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: propertyIds.map(videoHandoffPublishDedupeKey) } } });
  await prisma.telegramDialogState.deleteMany({ where: { chatId: String(MONTAJER_CHAT) } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  for (const f of createdFiles) await fs.rm(f, { force: true }).catch(() => {});
  for (const d of rawDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  await prisma.agent.deleteMany({ where: { phone: { in: [phone, otherPhone] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("файл без номера и номер мимо (А2, вопрос убран 29.09)", () => {
  // Вопрос «для какого объекта» убран владельцем 29.09.2026 (#1013): файл без номера
  // идёт держателю места, даже когда недавно сдан ещё один объект.
  it("файл без номера при двух ждущих — сразу держателю места, без вопроса", async () => {
    const holder = await seedProperty("держатель", holderData());
    const recent = await recentlyReceived("сдан недавно");
    const before = await finalPath(recent.id);

    await sendFile("lv_0_2026.mp4").done;

    expect(sendMessageWithButtons).not.toHaveBeenCalled();
    expect(await finalPath(holder.id)).toMatch(/^\/uploads\/handoff\//);
    expect(await finalPath(recent.id)).toBe(before);
    expect(await prisma.telegramDialogState.findUnique({ where: { chatId: String(MONTAJER_CHAT) } })).toBeNull();
  });

  it("один кандидат (только держатель) — принимается сразу, без вопроса, как раньше", async () => {
    const holder = await seedProperty("единственный", holderData());

    await sendFile("IMG_1000.MOV").done;

    expect(sendMessageWithButtons).not.toHaveBeenCalled();
    expect(await finalPath(holder.id)).toMatch(/^\/uploads\/handoff\//);
  });

  it("номер в имени не совпал ни с кем — отказ и кнопка «Это №<держатель>», по ней — приём на держателя", async () => {
    const holder = await seedProperty("держатель", holderData());
    const idle = await seedProperty("не ждёт");

    const { updateId, done } = sendFile(`${idle.shortId}.mp4`);
    await done;
    const [, refusal, buttons] = sendMessageWithButtons.mock.calls.at(-1)!;
    expect(refusal).toContain(`Объект №${idle.shortId} сейчас не ждёт от вас ролик`);
    expect(JSON.stringify(buttons)).toContain(`mj:rcv:${updateId}:${holder.shortId}`);
    expect(await finalPath(holder.id)).toBeNull();

    await press(MONTAJER_CHAT, `mj:rcv:${updateId}:${holder.shortId}`);
    expect(await finalPath(holder.id)).toMatch(/^\/uploads\/handoff\//);
    expect(await finalPath(idle.id)).toBeNull();
  });
});

describe("честность бота при приёме", () => {
  it("передача через бота выключена в Настройках — понятный отказ, файл не скачивается (А8)", async () => {
    const holder = await seedProperty("выключено", holderData());
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoHandoffEnabled: false } });

    await sendFile(`${holder.shortId}.mp4`).done;

    expect(resolveTelegramFileMaterialization).not.toHaveBeenCalled();
    expect(replies().some((r) => r.includes("выключена в Настройках CRM"))).toBe(true);
    expect(await finalPath(holder.id)).toBeNull();
  });

  it("автопубликация выключена — квитанция «принят, но публиковаться не будет», а не «публикую» (А7)", async () => {
    const holder = await seedProperty("без автопубликации", holderData());
    await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: false } });
    try {
      await sendFile(`${holder.shortId}.mp4`).done;
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { autoPublishEnabled: savedSettings?.autoPublishEnabled ?? false } });
    }
    const receipt = replies().find((r) => r.startsWith(`Ролик по объекту №${holder.shortId}`))!;
    expect(receipt).toContain("принят, но публиковаться не будет: Автопубликация выключена");
    // Квитанция — в журнале «что ушло монтажёру», ровно тем же текстом.
    const journal = await waitFor(() => prisma.montajerMessage.findFirst({ where: { propertyId: holder.id, kind: "RECEIPT" } }));
    expect(journal.text).toBe(receipt);
  });
});

describe("меню монтажёра (раздел C)", () => {
  async function emptyObject() {
    return seedProperty("пустой", { address: null, rooms: null });
  }

  async function fullObject() {
    const p = await seedProperty("полный", {
      publishedChannels: ["YOUTUBE", "TELEGRAM"],
      publishedPostIds: { YOUTUBE: "abc123" },
    });
    const photoName = `montajer-menu-${randomUUID()}.webp`;
    await fs.mkdir(uploadsDir, { recursive: true });
    await fs.writeFile(path.join(uploadsDir, photoName), Buffer.from("фото"));
    createdFiles.push(path.join(uploadsDir, photoName));
    await prisma.propertyPhoto.create({ data: { propertyId: p.id, url: `/uploads/${photoName}`, thumbUrl: `/uploads/${photoName}`, order: 0 } });
    for (let i = 1; i <= 2; i++) {
      const storageKey = `${p.id}/${randomUUID()}.mp4`;
      const filePath = localVideoFilePath(storageKey)!;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, Buffer.alloc(300));
      rawDirs.add(path.dirname(filePath));
      await prisma.propertyVideo.create({
        data: { propertyId: p.id, storageKey, filename: `IMG_${i}.MOV`, sizeBytes: 300, durationSec: 20 + i, hasAudio: i === 1, uploadedById: montajerId, uploadedAt: new Date(Date.now() - 10_000 + i) },
      });
    }
    return p;
  }

  it("каждая команда словом отвечает и не падает на объекте без фото, видео и публикаций", async () => {
    const e = await emptyObject();
    const commands = ["меню", "помощь", "очередь", `объект ${e.shortId}`, `${e.shortId}`, `фото ${e.shortId}`, `исходники ${e.shortId}`, `где ${e.shortId}`, "сдал", "сроки", "файлы", "добрый вечер"];
    for (const command of commands) {
      sendMessage.mockClear();
      sendMessageWithButtons.mockClear();
      await text(MONTAJER_CHAT, command);
      expect(sendMessage.mock.calls.length + sendMessageWithButtons.mock.calls.length, `«${command}» без ответа`).toBeGreaterThan(0);
    }
    sendMessage.mockClear();
    await text(MONTAJER_CHAT, `фото ${e.shortId}`);
    expect(replies()).toContain(`У объекта №${e.shortId} нет фото.`);
    sendMessage.mockClear();
    await text(MONTAJER_CHAT, `исходники ${e.shortId}`);
    expect(replies()).toContain(`У объекта №${e.shortId} нет исходных видео.`);
    sendMessage.mockClear();
    await text(MONTAJER_CHAT, `где ${e.shortId}`);
    expect(replies()[0]).toContain(`Объект №${e.shortId} ещё нигде не опубликован.`);
  });

  it("каждая кнопка отвечает и не падает — на пустом объекте тоже", async () => {
    const e = await emptyObject();
    const buttons = ["mj:menu", "mj:help", "mj:queue", "mj:card", "mj:files", "mj:done", "mj:time", `mj:obj:${e.shortId}`, `mj:ph:${e.shortId}`, `mj:src:${e.shortId}`, `mj:sf:${e.shortId}`, `mj:pub:${e.shortId}`, "mj:устаревшая"];
    for (const data of buttons) {
      sendMessage.mockClear();
      sendMessageWithButtons.mockClear();
      await press(MONTAJER_CHAT, data);
      expect(sendMessage.mock.calls.length + sendMessageWithButtons.mock.calls.length, `кнопка ${data} без ответа`).toBeGreaterThan(0);
    }
  });

  it("полный объект: карточка с кнопками, фото альбомом, исходники со ссылками, «где вышел» со ссылкой", async () => {
    const f = await fullObject();

    await press(MONTAJER_CHAT, `mj:obj:${f.shortId}`);
    const [, card, cardButtons] = sendMessageWithButtons.mock.calls.at(-1)!;
    expect(card).toContain(`Объект №${f.shortId}`);
    expect(JSON.stringify(cardButtons)).toContain(`mj:ph:${f.shortId}`);
    expect(JSON.stringify(cardButtons)).toContain(`mj:src:${f.shortId}`);
    expect(JSON.stringify(cardButtons)).toContain(`mj:pub:${f.shortId}`);

    await text(MONTAJER_CHAT, `фото ${f.shortId}`);
    expect(sendPhotoFromDisk).toHaveBeenCalledWith(String(MONTAJER_CHAT), expect.stringContaining("montajer-menu-"), `Объект №${f.shortId} — фото`);

    sendMessage.mockClear();
    await text(MONTAJER_CHAT, `исходники ${f.shortId}`);
    const list = replies().join("\n");
    expect(list).toContain(`Исходники объекта №${f.shortId} — 2 шт.`);
    expect(list).toContain("1. IMG_1.MOV");
    expect(list).toContain("звук есть");
    expect(list).toContain("⚠ БЕЗ ЗВУКА");
    expect(list).toContain("/download-file?token=");
    // Не держатель места — кнопки «Прислать файлами» нет.
    expect(list).not.toContain(`mj:sf:${f.shortId}`);

    sendMessage.mockClear();
    await press(MONTAJER_CHAT, `mj:pub:${f.shortId}`);
    const where = replies().join("\n");
    expect(where).toContain("https://youtube.com/shorts/abc123");
    expect(where).toContain("вышел (ссылки на пост нет)");
  });

  it("очередь: держатель и очередь с номерами и кнопками; «📥 Прислать файлами» — только держателю, шлёт все файлы", async () => {
    // Чужая очередь в общей базе заслонила бы наш объект в списке из десяти.
    await prisma.property.updateMany({ where: { videoHandoffStatus: "QUEUED", id: { notIn: propertyIds } }, data: { videoHandoffStatus: "RECEIVED" } });
    const f = await fullObject();
    await prisma.property.update({ where: { id: f.id }, data: holderData() });
    const queued = await seedProperty("в очереди", { videoHandoffStatus: "QUEUED", videoHandoffSentAt: new Date(), videoHandoffQueueOrder: 1 });

    await text(MONTAJER_CHAT, "очередь");
    const [, queueText, queueButtons] = sendMessageWithButtons.mock.calls.at(-1)!;
    expect(queueText).toContain(`В работе у вас: №${f.shortId}`);
    expect(queueText).toContain(`№${queued.shortId}`);
    expect(JSON.stringify(queueButtons)).toContain(`mj:obj:${f.shortId}`);
    expect(JSON.stringify(queueButtons)).toContain(`mj:obj:${queued.shortId}`);

    await text(MONTAJER_CHAT, `исходники ${f.shortId}`);
    expect(JSON.stringify(sendMessageWithButtons.mock.calls.at(-1)![2])).toContain(`mj:sf:${f.shortId}`);

    sendMessage.mockClear();
    await press(MONTAJER_CHAT, `mj:sf:${queued.shortId}`);
    expect(replies().some((r) => r.includes(`Файлами присылаю только объект в работе — №${f.shortId}`))).toBe(true);
    expect(sendDocumentFile).not.toHaveBeenCalled();

    await press(MONTAJER_CHAT, `mj:sf:${f.shortId}`);
    expect(sendDocumentFile).toHaveBeenCalledTimes(2);
    expect(sendDocumentFile.mock.calls.map((c) => String(c[2]))).toEqual([`${f.shortId}_1из2.MOV`, `${f.shortId}_2из2.MOV`]);

    // «сроки» — держатель и ожидающий, «сдал» — отвечает списком или «пока нет».
    sendMessage.mockClear();
    await text(MONTAJER_CHAT, "сроки");
    expect(replies()[0]).toContain(`В работе у вас №${f.shortId}`);
    expect(replies()[0]).toContain(`№${queued.shortId} — ждёт`);
  });

  it("чужой привязанный сотрудник меню монтажёра не получает", async () => {
    await press(STRANGER_CHAT, "mj:queue");
    expect(replies()).toContain("Этот чат сейчас не назначен монтажёром.");
    sendMessage.mockClear();
    await text(STRANGER_CHAT, "очередь");
    expect(replies()[0]).toContain("Это личный чат с CRM-ботом");
  });
});
