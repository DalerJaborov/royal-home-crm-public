import { useTelegramClientBot } from "./helpers/telegramClientBot.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs";
import fsp from "node:fs/promises";
import pathMod from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { waitFor } from "./helpers/waitFor.js";
useTelegramClientBot();

/**
 * КОРОТКИЕ СООБЩЕНИЯ МОНТАЖЁРУ (28.11.2026, lib/montajerTexts.ts, рубильник Settings.montajerShortMessages).
 *
 * Решения владельца: факты карточки только под первым файлом, файлы 2..N одной строкой; при одном файле без
 * голоса итога «Отправлено N из N» нет, кнопки «Очередь» и «Пропустить» под самим файлом; «Дальше в очереди»
 * из подписи убрано; везде «Объект №N», без длинных тире; голос объявляется один раз. Рубильник ВЫКЛ —
 * прежние тексты слово в слово. Здесь же тесты на сообщения, которых раньше не было ни в одном тесте:
 * «голос задерживается», «Без озвучки», «Чей это ролик?», «Жду ролик», «Из альбома», вид очереди, тяжёлый файл.
 */

const { sendMessage, sendMessageWithButtons, sendDocumentFile, sendDocument, resolveTelegramFileMaterialization, logSystemError } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string) => ({})),
  sendMessageWithButtons: vi.fn(async (_chatId: string, _text: string, _buttons: unknown) => ({ message_id: 1 })),
  sendDocumentFile: vi.fn(async (_c: string, _f: unknown, name: string, _caption?: string, _t?: number, _s?: boolean, _b?: unknown) => ({
    message_id: 1,
    document: { file_id: `fid-${name}-${Math.random()}`, file_unique_id: `fuid-${name}` },
  })),
  sendDocument: vi.fn(async (_c: string, _f: string, _caption?: string, _b?: unknown) => ({})),
  resolveTelegramFileMaterialization: vi.fn(async () => ({ kind: "buffer", buffer: randomBytes(4096) })),
  logSystemError: vi.fn(async () => {}),
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
  logSystemError,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => {}),
  sendPushToAgents: vi.fn(async () => 0),
}));
vi.mock("../src/lib/ffmpeg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ffmpeg.js")>()),
  probeMediaInfo: vi.fn(async () => ({
    hasVideo: true, hasAudio: true, videoCodec: "h264", audioCodec: "aac", width: 1080, height: 1920, rotation: 0, durationSec: 10, sizeBytes: 1024,
  })),
}));

delete process.env.TELEGRAM_BOT_TOKEN;
process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");
const { handleMontajerVideo, handleVoicelessCopyCallback } = await import("../src/telegram/montajerReceive.js");
const { dispatchToEditor, setMontajerSendPauseMsForTests, settleBackgroundHandoffDispatches } = await import("../src/lib/videoHandoff.js");
const { montajerQueueView } = await import("../src/lib/montajerViews.js");
const { runNarrationAutoFlow } = await import("../src/lib/narrationAutoFlow.js");
const { NARRATION_QUOTA_EXCEEDED } = await import("../src/lib/propertyNarration.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");
const { SHORT_MONTAJER_TEXTS, LEGACY_MONTAJER_TEXTS } = await import("../src/lib/montajerTexts.js");
const { TELEGRAM_BOT_SEND_LIMIT_BYTES } = await import("../src/telegram/api.js");

const runId = Date.now();
const MONTAJER_CHAT = `mj-short-${runId}`;
const OBSERVER_CHAT = `mj-short-observer-${runId}`;
let nextUpdateId = (runId % 1_000_000_000) + 7;
let districtId: string;
let montajerId: string;
let observerId: string;
let adminId: string;
let adminToken: string;
const propertyIds: string[] = [];
const rawDirs = new Set<string>();
let originalSettings: { videoHandoffEnabled: boolean; videoMontajerAgentId: string | null; montajerShortMessages: boolean } | null = null;

async function seedProperty(label: string, data: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Короткие монтажёру-${label}-${runId}-${propertyIds.length}`,
      type: "APARTMENT", areaSqm: 55, floor: 3, totalFloors: 9, price: 350000, currency: "TJS", districtId,
      address: `Короткая, ${propertyIds.length + 1}`, condition: "GOOD", rooms: 2, ...data,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function addRawVideo(propertyId: string, data: Record<string, unknown> = {}) {
  const storageKey = `${propertyId}/${randomUUID()}.mp4`;
  const filePath = localVideoFilePath(storageKey);
  if (!filePath) throw new Error("путь хранилища не разрешился");
  await fsp.mkdir(pathMod.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, Buffer.alloc(1024));
  rawDirs.add(pathMod.dirname(filePath));
  const video = await prisma.propertyVideo.create({
    data: { propertyId, storageKey, filename: `IMG_${randomUUID().slice(0, 4)}.mp4`, sizeBytes: 1024, uploadedById: montajerId, ...data },
  });
  return { video, filePath };
}

async function seat(propertyId: string) {
  await prisma.property.update({
    where: { id: propertyId },
    data: { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date(), videoHandoffDeliveredAt: null, videoHandoffDispatchAttempts: 0 },
  });
}

async function setShort(on: boolean) {
  await prisma.settings.update({ where: { id: "singleton" }, data: { montajerShortMessages: on } });
}

function textsTo(chatId: string): string[] {
  return [
    ...sendMessage.mock.calls.filter((c) => c[0] === chatId).map((c) => String(c[1])),
    ...sendMessageWithButtons.mock.calls.filter((c) => c[0] === chatId).map((c) => String(c[1])),
  ];
}
function captionsTo(chatId: string): string[] {
  return sendDocumentFile.mock.calls.filter((c) => c[0] === chatId).map((c) => String(c[3]));
}
function videoInput(filename: string, extra: Partial<{ albumGroupId: string }> = {}) {
  const updateId = nextUpdateId++;
  return { chatId: MONTAJER_CHAT, agentId: montajerId, updateId, fileId: `doc-${updateId}`, filename, caption: null, ...extra };
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Короткие монтажёру-${runId}` } })).id;
  const passwordHash = await bcrypt.hash("testpass123", 4);
  montajerId = (await prisma.agent.create({
    data: { fullName: "Монтажёр коротких", phone: `+99293${runId.toString().slice(-7)}`, role: "EDITOR", passwordHash, telegramChatId: MONTAJER_CHAT },
  })).id;
  observerId = (await prisma.agent.create({
    data: { fullName: "Наблюдатель коротких", phone: `+99291${runId.toString().slice(-7)}`, role: "ADMIN", passwordHash, telegramChatId: OBSERVER_CHAT, montageCopiesTelegram: true },
  })).id;
  const adminPhone = `+99295${runId.toString().slice(-7)}`;
  adminId = (await prisma.agent.create({ data: { fullName: "Админ коротких", phone: adminPhone, role: "ADMIN", passwordHash } })).id;
  adminToken = (await request(app).post("/api/v1/auth/login").send({ phone: adminPhone, password: "testpass123" })).body.accessToken;
  originalSettings = await prisma.settings.upsert({
    where: { id: "singleton" }, update: {}, create: { id: "singleton" },
    select: { videoHandoffEnabled: true, videoMontajerAgentId: true, montajerShortMessages: true },
  });
  setMontajerSendPauseMsForTests(0);
});

beforeEach(async () => {
  await prisma.property.updateMany({ where: { videoHandoffStatus: "SENT_TO_EDITOR", id: { notIn: propertyIds } }, data: { videoHandoffStatus: "RECEIVED" } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { videoHandoffEnabled: true, videoMontajerAgentId: montajerId, montajerShortMessages: true } });
  await prisma.telegramDialogState.deleteMany({ where: { chatId: MONTAJER_CHAT } });
  for (const m of [sendMessage, sendMessageWithButtons, sendDocumentFile, sendDocument, logSystemError]) m.mockClear();
});

afterEach(async () => {
  await settleBackgroundHandoffDispatches().catch(() => {});
  vi.restoreAllMocks();
  if (propertyIds.length) {
    await prisma.property.updateMany({
      where: { id: { in: propertyIds } },
      data: { videoHandoffStatus: "NONE", videoHandoffSentAt: null, videoHandoffManualSince: null, videoHandoffMontajerSkippedAt: null },
    });
  }
});

afterAll(async () => {
  setMontajerSendPauseMsForTests();
  if (originalSettings) await prisma.settings.update({ where: { id: "singleton" }, data: originalSettings });
  await prisma.telegramDialogState.deleteMany({ where: { chatId: MONTAJER_CHAT } });
  await prisma.propertyNarrationVersion.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  for (const dir of rawDirs) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: [montajerId, observerId, adminId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

const REPLY_KEYS = ["handoffDisabled", "albumFirstOnly", "publishedNamed", "published", "reopenFailed", "downloadFailed", "saveFailed", "voicelessDownloadFailed",
  "voicelessSaveFailed", "voicelessSaved", "voicelessWaiting", "questionStale", "questionStaleWithNumber", "coversNotNeeded", "videoNoteRefused", "otherAttachment", "notAssignedForward"] as const;

/** Все короткие тексты с образцовыми данными: сторож тире и «ОБ-» проходит по каждому. */
function allShortSamples(): string[] {
  const t = SHORT_MONTAJER_TEXTS;
  const facts = "Объект №235\nАгент: Тест\nРайон: Сино\nАдрес: Рудаки, 1\nЭтаж: 3\nЭтажность: 9\nПлощадь: 55 м²\nКомнаты: 2";
  const notes = ["off", "mix", "preparing", "manual", "follows", "later", "delayed", "delayedNotified", "awaitingApproval"] as const;
  const body = { facts, queueLine: "", silent: [{ filename: "IMG_1.mov", position: 2 }], total: 2, voiceHint: "" };
  const out: (string | null)[] = [
    t.fileCaptionHead(235, 0, 2, { rawFacts: "0:32", sizeBytes: 48 * 1024 * 1024, durationSec: 32, hasAudio: false }),
    t.restFileBody(facts),
    ...notes.map((n) => t.handoffBody({ ...body, narration: n })),
    ...notes.map((n) => t.narrationLine(n, "")),
    t.remakeBody({ ...body, narration: "mix", shortId: 235, reasonLabel: "Данные карточки изменились, нужен новый текст", voiceChanges: false, comment: "Цена — новая", diff: [{ label: "Этаж", was: "3", becomes: "4" }, { label: "Комнаты", becomes: "3" }, { label: "Адрес", was: "x" }] }),
    t.deliveryControl(235, 2, 2, t.voiceNextLine(false, "")),
    t.deliveryControl(235, 1, 2, null),
    t.heavyFile("Объект №235 · 🎬 видео", "2100", "https://x/y"),
    t.heavyFile("Объект №235 · 🎬 видео", "2100", null),
    t.giveUpLink(235, { filename: "IMG_1.mov", position: 1, total: 2 }, "https://x/y"),
    t.giveUpLink(235, { filename: "IMG_1.mov", position: 1, total: 1 }, null),
    ...(["mix", "soundOnly", "plain"] as const).map((m) => t.voiceCaption(235, 2, m, "")),
    t.sourceWithVoiceCaption(235, 2, facts),
    t.narrationDelayed(235),
    t.narrationOff(235),
    t.factsChanged(235, "Этаж: 3 → 4", [t.changeLine("Этаж", "3", "4"), "Исходные файлы: загружено — 2 (видео-исходники)"]),
    t.handoffCancelled(235, "продан"),
    t.handoffCancelled(235, "готов — ролик загрузили из CRM"),
    t.handedOver(235),
    t.whoseClip({ holder: 235, skipped: [230, 231] }).text,
    t.notWaiting({ declared: 230, exists: true, holder: 235, withButton: true }).text,
    t.notWaiting({ declared: 230, exists: false, holder: null, withButton: false }).text,
    ...REPLY_KEYS.map((k) => t.reply(k, { shortId: 235, filename: "IMG_1.mov", inWork: " Сейчас у вас №230.", label: "стикер" })),
    ...(["later", "preparing", "awaitingApproval"] as const).map((n) => t.remakeBody({ ...body, narration: n, shortId: 235, reasonLabel: "Другое", voiceChanges: false, comment: null, diff: null })),
  ];
  return out.filter((s): s is string => !!s);
}

describe("тексты монтажёру: сторож короткого вида", () => {
  it("ни одного длинного тире, «ОБ-» и «ролик №N»; «придёт» с «ё»", () => {
    const samples = allShortSamples();
    expect(samples.length).toBeGreaterThan(30);
    for (const text of samples) {
      expect(text, text).not.toMatch(/[—–]/);
      expect(text, text).not.toContain("ОБ-");
      expect(text, text).not.toMatch(/ролик[ау]? №\d/);
      expect(text, text).not.toMatch(/придет|дошлем/);
    }
  });

  it("сторож на исходники: ни в одном вызове sendToMontajer (приём файла, вложения бота) нет строки с тире", async () => {
    const fsp = await import("node:fs/promises");
    const pathMod = await import("node:path");
    for (const rel of ["../src/telegram/montajerReceive.ts", "../src/telegram/bot.ts"]) {
      const src = await fsp.readFile(pathMod.resolve(import.meta.dirname, rel), "utf8");
      for (const m of src.matchAll(/sendToMontajer\(([\s\S]*?)\{\s*copy/g)) {
        expect(m[1], `${rel}: ${m[1]}`).not.toMatch(/"[^"\n]*[—–][^"\n]*"|`[^`\n]*[—–][^`\n]*`/);
      }
    }
  });

  it("тире-разделитель заменяется, числовой диапазон остаётся диапазоном", () => {
    const t = SHORT_MONTAJER_TEXTS;
    expect(t.handoffCancelled(235, "готов — ролик загрузили")).toBe("Объект №235 готов: ролик загрузили. Монтировать не нужно, ролик присылать не надо.");
    expect(t.factsChanged(235, "", ["Площадь: было 50–60 м², стало 61 м²"])).toContain("50-60");
  });

  it("перемонтаж: строка про голос остаётся, пока он не дошёл (later, preparing, awaitingApproval), и нет, когда голос идёт следом", () => {
    const base = { facts: "Объект №235\nЭтаж: 4", queueLine: "", silent: [], total: 1, voiceHint: "", shortId: 235, reasonLabel: "Другое", voiceChanges: false, comment: null, diff: null };
    for (const n of ["later", "preparing", "awaitingApproval"] as const) expect(SHORT_MONTAJER_TEXTS.remakeBody({ ...base, narration: n })).toContain("🎙 Голос");
    expect(SHORT_MONTAJER_TEXTS.remakeBody({ ...base, narration: "follows" })).not.toContain("🎙");
  });

  it("рубильник ВЫКЛ: ответы бота на приём файла прежние слово в слово", () => {
    expect(LEGACY_MONTAJER_TEXTS.reply("coversNotNeeded")).toBe("Обложки теперь делаем сами — присылать не нужно, просто пришлите готовый ролик.");
    expect(LEGACY_MONTAJER_TEXTS.reply("voicelessWaiting", { shortId: 7 })).toBe("Жду ролик №7 без голоса: пришлите его файлом в течение часа.");
    expect(LEGACY_MONTAJER_TEXTS.reply("questionStale")).toBe("Этот вопрос уже устарел — пришлите файл ещё раз.");
  });

  it("сторож ловит поломку: прежние тексты в него не проходят", () => {
    expect(LEGACY_MONTAJER_TEXTS.handoffCancelled(235, "продан")).toMatch(/[—–]/);
    expect(LEGACY_MONTAJER_TEXTS.factsChanged(235, "Этаж: 3 → 4", [])).toContain("ОБ-");
  });

  it("образцы из плана владельца — слово в слово", () => {
    const t = SHORT_MONTAJER_TEXTS;
    expect(t.fileCaptionHead(235, 1, 2, { rawFacts: "", sizeBytes: 31 * 1024 * 1024, durationSec: 18, hasAudio: true })).toBe("Объект №235 · 🎬 видео 2 из 2 · 31 МБ, 0:18, со звуком");
    expect(t.deliveryControl(235, 2, 2, t.voiceNextLine(false, ""))).toBe("Объект №235: 2 видео отправлено. Голос придёт следом.");
    expect(t.deliveryControl(235, 1, 2, null)).toBe("Объект №235: дошло 1 из 2 видео, остальное дошлём сами.");
    expect(t.voiceCaption(235, 2, "plain", "")).toBe("Объект №235 · 🎙 голос, версия 2. Вклейте его сами, музыка и громкость на вас.");
    expect(t.voiceCaption(235, 2, "soundOnly", "")).toBe("Объект №235 · 🎙 новый голос, версия 2. Замените в ролике только голос, остальное не трогайте.");
    expect(t.narrationDelayed(235)).toBe("Объект №235: голос задерживается. Монтируйте как обычно, он придёт отдельным файлом.");
    expect(t.narrationOff(235)).toBe("Объект №235: голос в ролик не нужен.");
    expect(t.factsChanged(235, "", [t.changeLine("Этаж", "3", "4")])).toBe("⚠️ Объект №235: в карточке изменилось. Этаж: было 3, стало 4. Учтите в монтаже.");
    expect(t.handoffCancelled(235, "продан")).toBe("Объект №235 продан. Монтировать не нужно, ролик присылать не надо.");
    expect(t.notWaiting({ declared: 230, exists: true, holder: 235, withButton: false }).text)
      .toBe("Файл не принят: объект №230 не ждёт ролик. Сейчас у вас №235. Пришлите файл с номером объекта в имени, например 235.mp4.");
    const remake = t.remakeBody({ facts: "Объект №235\nЭтаж: 4", queueLine: "", narration: "follows", silent: [], total: 1, voiceHint: "", shortId: 235,
      reasonLabel: "Надпись на видео неверная", voiceChanges: false, comment: null, diff: null });
    expect(remake).toBe("🔁 Объект №235 на переделку\nЧто исправить: Надпись на видео неверная.\n\nЭтаж: 4");
  });
});

describe("передача файлов монтажёру", () => {
  it("два файла: факты только под первым, второй одной строкой, итог короткий с кнопками, без «Дальше в очереди»", async () => {
    const property = await seedProperty("два-файла");
    await addRawVideo(property.id, { uploadedAt: new Date(Date.now() - 2000) });
    await addRawVideo(property.id, { uploadedAt: new Date(Date.now() - 1000), hasAudio: false });
    const queued = await seedProperty("в-очереди");
    await addRawVideo(queued.id);
    await prisma.property.update({ where: { id: queued.id }, data: { videoHandoffStatus: "QUEUED", videoHandoffSentAt: new Date() } });
    await seat(property.id);

    await dispatchToEditor(property.id, montajerId);

    const [first, second] = captionsTo(MONTAJER_CHAT);
    expect(first).toMatch(new RegExp(`^Объект №${property.shortId} · 🎬 видео 1 из 2 · <1 МБ\\n\\nРайон:`));
    expect(first).not.toContain("Дальше в очереди");
    expect(first).toContain("⚠ Без звука: видео 2. Звук наложите при монтаже.");
    expect(first.match(new RegExp(`№${property.shortId}`, "g"))).toHaveLength(1);
    expect(second).toBe(`Объект №${property.shortId} · 🎬 видео 2 из 2 · <1 МБ`);
    const summary = sendMessageWithButtons.mock.calls.find((c) => c[0] === MONTAJER_CHAT);
    expect(summary?.[1]).toBe(`Объект №${property.shortId}: 2 видео отправлено.`);
    expect(JSON.stringify(summary?.[2])).toContain(`mj:sk:${property.shortId}`);
    // Наблюдатель: те же короткие подписи с пометкой «Копия», итог без кнопок.
    expect(captionsTo(OBSERVER_CHAT).length + sendDocument.mock.calls.filter((c) => c[0] === OBSERVER_CHAT).length).toBe(2);
    expect(textsTo(OBSERVER_CHAT).some((t) => t.includes(`Объект №${property.shortId}: 2 видео отправлено.`))).toBe(true);
    await prisma.property.update({ where: { id: queued.id }, data: { videoHandoffStatus: "NONE", videoHandoffSentAt: null } });
  });

  it("один файл без голоса: итога нет, кнопки «Очередь» и «Пропустить» под самим файлом; наблюдателю без кнопок", async () => {
    const property = await seedProperty("один-файл");
    await addRawVideo(property.id);
    await seat(property.id);

    await dispatchToEditor(property.id, montajerId);

    expect(textsTo(MONTAJER_CHAT)).toEqual([]);
    const call = sendDocumentFile.mock.calls.find((c) => c[0] === MONTAJER_CHAT)!;
    expect(String(call[3])).toMatch(new RegExp(`^Объект №${property.shortId} · 🎬 видео · <1 МБ\\n\\n`));
    expect(JSON.stringify(call[6])).toContain("mj:queue");
    expect(JSON.stringify(call[6])).toContain(`mj:sk:${property.shortId}`);
    const observerFile = sendDocument.mock.calls.find((c) => c[0] === OBSERVER_CHAT) ?? sendDocumentFile.mock.calls.find((c) => c[0] === OBSERVER_CHAT);
    expect(observerFile).toBeDefined();
    expect(observerFile!.at(-1)).toBeUndefined();
    const deliveredAt = (await prisma.property.findUniqueOrThrow({ where: { id: property.id }, select: { videoHandoffDeliveredAt: true } })).videoHandoffDeliveredAt;
    expect(deliveredAt).not.toBeNull();
  });

  it("рубильник ВЫКЛ: прежние тексты — «файл k из N», факты под каждым файлом, «Отправлено 1 из 1 файла»", async () => {
    await setShort(false);
    const single = await seedProperty("прежний-один");
    await addRawVideo(single.id);
    await seat(single.id);
    await dispatchToEditor(single.id, montajerId);
    expect(textsTo(MONTAJER_CHAT)).toContain(`Отправлено 1 из 1 файла объекта №${single.shortId}.`);
    await prisma.property.update({ where: { id: single.id }, data: { videoHandoffStatus: "RECEIVED" } });

    sendDocumentFile.mockClear();
    const pair = await seedProperty("прежний-два");
    await addRawVideo(pair.id, { uploadedAt: new Date(Date.now() - 2000) });
    await addRawVideo(pair.id, { uploadedAt: new Date(Date.now() - 1000) });
    await seat(pair.id);
    await dispatchToEditor(pair.id, montajerId);
    const [, second] = captionsTo(MONTAJER_CHAT);
    expect(second).toMatch(new RegExp(`^Объект №${pair.shortId} · файл 2 из 2\\n\\nОбъект №${pair.shortId}\\nРайон: `));
  });

  it("тяжёлый файл: вместо документа ссылка короткими словами, кнопки под ним, если он единственный", async () => {
    const property = await seedProperty("тяжёлый");
    const { filePath } = await addRawVideo(property.id);
    await seat(property.id);
    const realStat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, "stat").mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      const st = await realStat(p as string, ...(rest as []));
      if (pathMod.resolve(String(p)) === pathMod.resolve(filePath)) Object.defineProperty(st, "size", { value: TELEGRAM_BOT_SEND_LIMIT_BYTES + 5 * 1024 * 1024 });
      return st;
    }) as typeof fs.promises.stat);

    await dispatchToEditor(property.id, montajerId);

    expect(sendDocumentFile.mock.calls.filter((c) => c[0] === MONTAJER_CHAT)).toHaveLength(0);
    const heavy = sendMessageWithButtons.mock.calls.find((c) => c[0] === MONTAJER_CHAT);
    expect(heavy?.[1]).toMatch(/Telegram такой не принимает\. Скачайте по ссылке: https:\/\/crm-test\.royalhome\.tj\/api\/v1\/properties\//);
    expect(heavy?.[1]).not.toMatch(/[—–]/);
    expect(JSON.stringify(heavy?.[2])).toContain(`mj:sk:${property.shortId}`);
  });
});

describe("голос: задерживается и «Без озвучки»", () => {
  it("кончились кредиты озвучки — монтажёру один раз «голос задерживается» (обход озвучки)", async () => {
    const property = await seedProperty("задержка");
    await seat(property.id);
    await prisma.propertyNarrationVersion.create({
      data: { propertyId: property.id, revision: 1, script: "Текст.", factsSnapshot: {}, factsHash: "h", voiceId: "v", modelId: "m", status: "DRAFT",
        createdById: adminId, requestKey: randomUUID(), source: "AUTO", errorCode: NARRATION_QUOTA_EXCEEDED, generationStartedAt: new Date() },
    });

    const report = await runNarrationAutoFlow({ now: new Date() });

    expect(report.editorDelay).toBe(1);
    expect(textsTo(MONTAJER_CHAT)).toContain(`Объект №${property.shortId}: голос задерживается. Монтируйте как обычно, он придёт отдельным файлом.`);
    expect(textsTo(OBSERVER_CHAT)).toEqual([]);
    sendMessage.mockClear();
    await runNarrationAutoFlow({ now: new Date() });
    expect(textsTo(MONTAJER_CHAT)).toEqual([]);
  });

  it("«голос задерживается» не дошёл (Telegram отказал): метка снимается, следующий обход пробует снова, а строка про задержку остаётся в задании", async () => {
    const property = await seedProperty("задержка-сбой");
    await seat(property.id);
    const version = await prisma.propertyNarrationVersion.create({
      data: { propertyId: property.id, revision: 1, script: "Текст.", factsSnapshot: {}, factsHash: "h", voiceId: "v", modelId: "m", status: "DRAFT",
        createdById: adminId, requestKey: randomUUID(), source: "AUTO", errorCode: NARRATION_QUOTA_EXCEEDED, generationStartedAt: new Date() },
    });
    sendMessage.mockRejectedValueOnce(new Error("Telegram: Bad Gateway"));
    const first = await runNarrationAutoFlow({ now: new Date() });
    expect(first.editorDelay).toBe(0);
    expect((await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: version.id } })).editorDelayNotifiedAt).toBeNull();
    const second = await runNarrationAutoFlow({ now: new Date() });
    expect(second.editorDelay).toBe(1);
    expect((await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: version.id } })).editorDelayNotifiedAt).not.toBeNull();
  });

  it("единственный файл без звука: «без звука» сказано один раз", async () => {
    const property = await seedProperty("один-без-звука");
    await addRawVideo(property.id, { hasAudio: false });
    await seat(property.id);
    await dispatchToEditor(property.id, montajerId);
    const head = String(sendDocumentFile.mock.calls.find((c) => c[0] === MONTAJER_CHAT)![3]);
    expect(head.match(/без звука/gi)).toHaveLength(1);
  });

  it("агент выбрал «Без озвучки», пока ролик у монтажёра — короткая строка, наблюдателю копия; ВЫКЛ — прежняя", async () => {
    const property = await seedProperty("без-озвучки");
    await seat(property.id);

    const res = await request(app).post(`/api/v1/properties/${property.id}/narration/mode`).set("Authorization", `Bearer ${adminToken}`).send({ off: true });
    expect(res.status).toBe(200);
    const expected = `Объект №${property.shortId}: голос в ролик не нужен.`;
    await waitFor(async () => (textsTo(MONTAJER_CHAT).includes(expected) ? true : null));
    expect(textsTo(OBSERVER_CHAT).some((t) => t.includes(expected))).toBe(true);

    await setShort(false);
    await prisma.property.update({ where: { id: property.id }, data: { narrationOff: false } });
    await request(app).post(`/api/v1/properties/${property.id}/narration/mode`).set("Authorization", `Bearer ${adminToken}`).send({ off: true });
    const legacy = `Объект №${property.shortId}: агент выбрал «Без озвучки» — голос в ролик не нужен.`;
    await waitFor(async () => (textsTo(MONTAJER_CHAT).includes(legacy) ? true : null));
  });
});

describe("приём файла от монтажёра", () => {
  it("«Чей это ролик?»: файл без номера, монтажёр недавно пропускал объект — короткий вопрос и кнопки «№H в работе», «№S», «Другой»", async () => {
    const holder = await seedProperty("держатель-чей");
    await seat(holder.id);
    const skipped = await seedProperty("пропущен-чей");
    await prisma.property.update({ where: { id: skipped.id }, data: { videoHandoffStatus: "QUEUED", videoHandoffSentAt: new Date(), videoHandoffMontajerSkippedAt: new Date() } });

    await handleMontajerVideo(videoInput("IMG_7777.mp4"));

    const ask = sendMessageWithButtons.mock.calls.find((c) => c[0] === MONTAJER_CHAT)!;
    expect(ask[1]).toBe("Чей это ролик? В имени файла нет номера. Нажмите объект:");
    const labels = (ask[2] as { text: string; callback_data: string }[][]).map((row) => row[0]!.text);
    expect(labels).toEqual([`№${holder.shortId} в работе`, `№${skipped.shortId}`, "Другой"]);
    expect((ask[2] as { callback_data: string }[][])[0]![0]!.callback_data).toMatch(new RegExp(`^mj:rcv:\\d+:${holder.shortId}$`));
    expect(textsTo(OBSERVER_CHAT).some((t) => t.includes("Чей это ролик?"))).toBe(true);

    await setShort(false);
    sendMessageWithButtons.mockClear();
    await handleMontajerVideo(videoInput("IMG_7778.mp4"));
    expect(sendMessageWithButtons.mock.calls.find((c) => c[0] === MONTAJER_CHAT)?.[1])
      .toBe(`Чей это ролик? В имени файла нет номера объекта. Сейчас у вас в работе №${holder.shortId}. Недавно вы пропускали №${skipped.shortId}. Нажмите номер объекта.`);
  });

  it("номер объекта, который ролик не ждёт: короткий отказ с примером имени и кнопкой «№H в работе»", async () => {
    const holder = await seedProperty("держатель-отказ");
    await seat(holder.id);
    const idle = await seedProperty("не-ждёт");

    await handleMontajerVideo(videoInput(`${idle.shortId}.mp4`));

    const ask = sendMessageWithButtons.mock.calls.find((c) => c[0] === MONTAJER_CHAT)!;
    expect(ask[1]).toBe(
      `Файл не принят: объект №${idle.shortId} не ждёт ролик. Сейчас у вас №${holder.shortId}. Пришлите файл с номером объекта в имени, например ${holder.shortId}.mp4.\nИли нажмите кнопку, если это ролик для №${holder.shortId}.`
    );
    expect((ask[2] as { text: string }[][])[0]![0]!.text).toBe(`№${holder.shortId} в работе`);
  });

  it("«Жду ролик №N без голоса» — ответ на кнопку «Пришлю без голоса»", async () => {
    const property = await seedProperty("жду-без-голоса");
    await handleVoicelessCopyCallback(MONTAJER_CHAT, montajerId, `mj:nv:${property.shortId}`);
    expect(textsTo(MONTAJER_CHAT)).toContain(`Объект №${property.shortId}: жду ролик без голоса. Пришлите его файлом в течение часа.`);
    expect(textsTo(OBSERVER_CHAT)).toEqual([]);
  });

  it("альбом: берётся только первый файл, монтажёру одно пояснение на группу", async () => {
    const holder = await seedProperty("альбом");
    await seat(holder.id);
    const group = `album-${runId}`;

    await handleMontajerVideo(videoInput(`${holder.shortId}.mp4`, { albumGroupId: group }));
    await handleMontajerVideo(videoInput(`${holder.shortId}_2.mp4`, { albumGroupId: group }));
    await handleMontajerVideo(videoInput(`${holder.shortId}_3.mp4`, { albumGroupId: group }));

    const notes = textsTo(MONTAJER_CHAT).filter((t) => t.startsWith("Из альбома взят только первый файл"));
    expect(notes).toEqual([`Из альбома взят только первый файл (${holder.shortId}.mp4). Нужен другой? Пришлите его отдельным сообщением.`]);
  });
});

describe("вид очереди монтажёру (lib/montajerViews.ts)", () => {
  it("держатель, ждущие по порядку, кнопки «Пропустить» и номера при включённом управлении", async () => {
    const holder = await seedProperty("очередь-держатель");
    await seat(holder.id);
    await prisma.property.updateMany({ where: { videoHandoffStatus: "QUEUED", id: { notIn: propertyIds } }, data: { videoHandoffStatus: "NONE" } });
    const waiting = await seedProperty("очередь-ждёт");
    await prisma.property.update({ where: { id: waiting.id }, data: { videoHandoffStatus: "QUEUED", videoHandoffSentAt: new Date() } });

    const view = await montajerQueueView(new Date(), { controls: true });
    expect(view.text).toContain("🗂 Очередь монтажа");
    expect(view.text).toMatch(new RegExp(`В работе у вас: №${holder.shortId}`));
    expect(view.text).toMatch(new RegExp(`\\d\\) №${waiting.shortId}`));
    const callbacks = JSON.stringify(view.buttons);
    expect(callbacks).toContain(`mj:sk:${holder.shortId}`);
    expect(callbacks).toContain(`mj:qi:${waiting.shortId}`);

    const plain = await montajerQueueView(new Date(), { controls: false });
    expect(plain.text).toContain("Нажмите номер — откроется карточка объекта.");
    expect(JSON.stringify(plain.buttons)).not.toContain("mj:sk:");
    await prisma.property.update({ where: { id: waiting.id }, data: { videoHandoffStatus: "NONE", videoHandoffSentAt: null } });
  });
});

describe("смена монтажёра: «передан другому» одной функцией", () => {
  it("Настройки шлют прежнему монтажёру один и тот же текст", async () => {
    const other = await prisma.agent.create({
      data: { fullName: "Новый монтажёр", phone: `+99296${runId.toString().slice(-7)}`, role: "AGENT", passwordHash: await bcrypt.hash("x1234567", 4), telegramChatId: `mj-short-other-${runId}` },
    });
    try {
      const holder = await seedProperty("смена");
      await seat(holder.id);
      const { grantElevation } = await import("../src/lib/stepUp.js");
      grantElevation(adminId);
      const res = await request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`).send({ videoMontajerAgentId: other.id });
      expect(res.status).toBe(200);
      expect(textsTo(MONTAJER_CHAT)).toContain(`Объект №${holder.shortId} передан другому монтажёру.`);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: montajerId } });
      await settleBackgroundHandoffDispatches().catch(() => {});
      await prisma.agent.delete({ where: { id: other.id } });
    }
  });

  it("рубильник сохраняется через Настройки", async () => {
    const { grantElevation } = await import("../src/lib/stepUp.js");
    grantElevation(adminId);
    const res = await request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`).send({ montajerShortMessages: false });
    expect(res.status).toBe(200);
    expect((await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { montajerShortMessages: true } })).montajerShortMessages).toBe(false);
  });
});
