import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * МОНТАЖЁР УПРАВЛЯЕТ ОЧЕРЕДЬЮ ИЗ БОТА (19.11.2026, владелец: «дай монтажёру
 * пропускать очередь кнопкой или передвигать её или переходить к другим»).
 *
 * Настоящие telegram/bot.ts → montajerBot → lib/montajerQueueControl →
 * lib/videoHandoff и база стенда; подменены только Telegram, пуш и ffprobe.
 * Проверяется связка «нажатие → очередь в базе → файлы → журнал → аудит → пуш»:
 *  — «Сделаю позже», «Уже сделан / не нужен», «Взять №M сейчас», перестановка;
 *  — повторное и устаревшее нажатие ничего не задваивает и не теряет;
 *  — чужой сотрудник, пауза руководства, «Отложить», выключенный рубильник.
 */

const { sendMessage, sendMessageWithButtons, answerCallbackQuery, sendDocumentFile, sendDocument, sendPushToAgents, resolveTelegramFileMaterialization, publishApprovedPost } = vi.hoisted(() => ({
  resolveTelegramFileMaterialization: vi.fn(),
  publishApprovedPost: vi.fn(async () => [] as unknown[]),
  sendMessage: vi.fn(async (_chatId: string, _text: string) => ({})),
  sendMessageWithButtons: vi.fn(async (_chatId: string, _text: string, _buttons: unknown) => ({ message_id: 1 })),
  answerCallbackQuery: vi.fn(async () => ({})),
  sendDocumentFile: vi.fn(async (_c: string, _f: unknown, name: string, _caption?: string) => ({ message_id: 1, document: { file_id: `fid-${name}` } })),
  sendDocument: vi.fn(async (_c: string, _fileId: string, _caption?: string) => ({})),
  sendPushToAgents: vi.fn(async (_ids: string[], _payload: unknown) => 0),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  sendMessageWithButtons,
  answerCallbackQuery,
  sendDocumentFile,
  sendDocument,
  resolveTelegramFileMaterialization,
}));
vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  publishApprovedPost,
}));
vi.mock("../src/lib/ffmpeg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ffmpeg.js")>()),
  probeMediaInfo: vi.fn(async () => ({ hasVideo: true, hasAudio: true, videoCodec: "h264", audioCodec: "aac", width: 1080, height: 1920, rotation: 0, durationSec: 15, sizeBytes: 2048 })),
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => {}),
  sendPushToAgents,
}));

delete process.env.TELEGRAM_BOT_TOKEN;
process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";

const { prisma } = await import("../src/db.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");
const { orderedQueue, setMontajerSendPauseMsForTests, settleBackgroundHandoffDispatches, queueVideoHandoff, montajerSkippedDoneText, swapVideoHandoffHolder, cancelVideoHandoffQueueEntry, dispatchToEditor, videoHandoffPublishDedupeKey } = await import(
  "../src/lib/videoHandoff.js"
);
const { montajerSkipLater, NOT_MONTAJER_TEXT, QUEUE_CONTROL_OFF_TEXT } = await import("../src/lib/montajerQueueControl.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");
const { waitFor, waitForSettled } = await import("./helpers/waitFor.js");

const runId = Date.now();
const phone = `+99293${runId.toString().slice(-7)}`;
const otherPhone = `+99294${runId.toString().slice(-7)}`;
const bossPhone = `+99295${runId.toString().slice(-7)}`;
const MONTAJER_CHAT = 762000000 + (runId % 1_000_000);
const STRANGER_CHAT = 763000000 + (runId % 1_000_000);
let nextUpdateId = runId % 1_000_000_000;
let districtId: string;
let montajerId: string;
let strangerId: string;
const propertyIds: string[] = [];
const rawDirs = new Set<string>();
const SETTINGS_SELECT = {
  videoHandoffEnabled: true,
  videoMontajerAgentId: true,
  videoHandoffQueuePaused: true,
  montajerQueueControlEnabled: true,
} as const;
let savedSettings: Record<string, unknown> | null = null;

type Seeded = { id: string; shortId: number };

async function seedProperty(label: string, data: Record<string, unknown> = {}): Promise<Seeded> {
  const p = await prisma.property.create({
    data: {
      title: `Очередь монтажёра-${label}-${runId}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: 400000,
      currency: "TJS",
      districtId,
      address: "Очередная, 1",
      rooms: 2,
      condition: "GOOD",
      status: "EDITING",
      ...data,
    },
  });
  propertyIds.push(p.id);
  const storageKey = `${p.id}/${randomUUID()}.mp4`;
  const filePath = localVideoFilePath(storageKey)!;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.alloc(300));
  rawDirs.add(path.dirname(filePath));
  await prisma.propertyVideo.create({
    data: { propertyId: p.id, storageKey, filename: "IMG_1.MOV", sizeBytes: 300, durationSec: 20, hasAudio: true, uploadedById: montajerId },
  });
  return { id: p.id, shortId: p.shortId };
}

const holder = (label: string) =>
  seedProperty(label, { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date(Date.now() - 60_000), videoHandoffDeliveredAt: new Date() });
const queued = (label: string, order: number, extra: Record<string, unknown> = {}) =>
  seedProperty(label, { videoHandoffStatus: "QUEUED", videoHandoffSentAt: new Date(), videoHandoffQueueOrder: order, ...extra });

async function press(chatId: number, data: string) {
  await handleTelegramUpdate({
    update_id: nextUpdateId++,
    callback_query: { id: `cb-q-${runId}-${nextUpdateId}`, data, message: { chat: { id: chatId }, message_id: 1 } },
  });
  await settleBackgroundHandoffDispatches();
}

/** Последний ответ бота монтажёру: текст и кнопки одной строкой. */
function lastReply(): string {
  const plain = sendMessage.mock.calls.map((c) => ({ order: sendMessage.mock.invocationCallOrder[sendMessage.mock.calls.indexOf(c)]!, s: String(c[1]) }));
  const withButtons = sendMessageWithButtons.mock.calls.map((c, i) => ({
    order: sendMessageWithButtons.mock.invocationCallOrder[i]!,
    s: `${String(c[1])}\n${JSON.stringify(c[2])}`,
  }));
  const all = [...plain, ...withButtons].sort((a, b) => a.order - b.order);
  return all.at(-1)?.s ?? "";
}

function allReplies(): string[] {
  return [...sendMessage.mock.calls.map((c) => String(c[1])), ...sendMessageWithButtons.mock.calls.map((c) => `${String(c[1])}\n${JSON.stringify(c[2])}`)];
}

/** Бот хоть раз ответил монтажёру этим текстом (файлы следующего идут фоном и могут прийти позже ответа). */
function said(part: string): boolean {
  return allReplies().some((r) => r.includes(part));
}

/** Сколько раз файлы объекта ушли монтажёру (файлом или по file_id). */
function filesSentFor(p: Seeded): number {
  const head = `Объект №${p.shortId} ·`;
  return (
    sendDocumentFile.mock.calls.filter((c) => String(c[3] ?? "").startsWith(head)).length +
    sendDocument.mock.calls.filter((c) => String(c[2] ?? "").startsWith(head)).length
  );
}

async function state(p: Seeded) {
  return prisma.property.findUniqueOrThrow({
    where: { id: p.id },
    select: { videoHandoffStatus: true, videoHandoffQueueOrder: true, videoHandoffRemakeReason: true, videoHandoffRemakeComment: true },
  });
}

async function queueShortIds(): Promise<number[]> {
  return (await orderedQueue()).filter((q) => propertyIds.includes(q.id)).map((q) => q.shortId);
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Очередь монтажёра-${runId}` } })).id;
  const hash = await bcrypt.hash("testpass123", 4);
  montajerId = (
    await prisma.agent.create({ data: { fullName: "Монтажёр очереди", phone, role: "MARKETING", passwordHash: hash, telegramChatId: String(MONTAJER_CHAT) } })
  ).id;
  strangerId = (
    await prisma.agent.create({ data: { fullName: "Чужой сотрудник", phone: otherPhone, role: "AGENT", passwordHash: hash, telegramChatId: String(STRANGER_CHAT) } })
  ).id;
  // Руководитель с правом модерации — адресат пуша «монтажёр снял, уже сделан».
  await prisma.agent.create({ data: { fullName: "Руководитель монтажа", phone: bossPhone, role: "DIRECTOR", passwordHash: hash } });
  savedSettings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" }, select: SETTINGS_SELECT });
  setMontajerSendPauseMsForTests(0);
});

beforeEach(async () => {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { videoHandoffEnabled: true, videoMontajerAgentId: montajerId, videoHandoffQueuePaused: false, montajerQueueControlEnabled: true },
  });
  // Чужие держатели и ждущие в общей базе — не наши: иначе место и очередь были бы чужими.
  await prisma.property.updateMany({
    where: { videoHandoffStatus: { in: ["SENT_TO_EDITOR", "QUEUED"] }, id: { notIn: propertyIds } },
    data: { videoHandoffStatus: "RECEIVED", videoHandoffQueueOrder: null },
  });
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { videoHandoffStatus: "NONE", videoHandoffQueueOrder: null, videoHandoffHeldAt: null, videoHandoffMontajerSkippedAt: null },
  });
  await prisma.agent.update({ where: { id: montajerId }, data: { isActive: true } });
  for (const m of [sendMessage, sendMessageWithButtons, answerCallbackQuery, sendDocumentFile, sendDocument, sendPushToAgents]) m.mockClear();
  sendDocumentFile.mockImplementation(async (_c: string, _f: unknown, name: string) => ({ message_id: 1, document: { file_id: `fid-${name}` } }));
  resolveTelegramFileMaterialization.mockReset().mockImplementation(async () => ({ kind: "buffer", buffer: randomBytes(4096) }));
  await prisma.telegramDialogState.deleteMany({ where: { chatId: String(MONTAJER_CHAT) } });
  await prisma.agent.update({ where: { id: montajerId }, data: { role: "MARKETING" } });
});

afterEach(async () => {
  await settleBackgroundHandoffDispatches();
});

afterAll(async () => {
  setMontajerSendPauseMsForTests();
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await waitForSettled(() => prisma.auditLog.count({ where: { entityId: { in: propertyIds } } }));
  await prisma.auditLog.deleteMany({ where: { entityId: { in: propertyIds } } });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: propertyIds.map(videoHandoffPublishDedupeKey) } } });
  await prisma.telegramDialogState.deleteMany({ where: { chatId: String(MONTAJER_CHAT) } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  for (const d of rawDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  await prisma.agent.deleteMany({ where: { phone: { in: [phone, otherPhone, bossPhone] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("кнопки под заданием", () => {
  it("под файлами — «🗂 Очередь» и «⏭ Пропустить №N»; рубильник выключен — без кнопок", async () => {
    const a = await seedProperty("задание");
    await queueVideoHandoff(a.id);
    await settleBackgroundHandoffDispatches();
    expect(filesSentFor(a)).toBe(1);
    const control = sendMessageWithButtons.mock.calls.find((c) => String(c[1]).startsWith("Отправлено 1 из 1 файла"));
    expect(control, "контрольное сообщение с кнопками").toBeTruthy();
    expect(JSON.stringify(control![2])).toContain(`mj:sk:${a.shortId}`);
    expect(JSON.stringify(control![2])).toContain("mj:queue");

    await prisma.property.update({ where: { id: a.id }, data: { videoHandoffStatus: "NONE" } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { montajerQueueControlEnabled: false } });
    sendMessage.mockClear();
    sendMessageWithButtons.mockClear();
    await queueVideoHandoff(a.id);
    await settleBackgroundHandoffDispatches();
    expect(sendMessage.mock.calls.some((c) => String(c[1]).startsWith("Отправлено 1 из 1 файла"))).toBe(true);
    expect(sendMessageWithButtons.mock.calls.some((c) => JSON.stringify(c[2]).includes("mj:sk:"))).toBe(false);
  });
});

describe("⏭ Пропустить — «Сделаю позже»", () => {
  it("держатель в конец очереди, следующий выдан, файлы ушли один раз; журнал и аудит есть; повтор — «уже не у вас»", async () => {
    const h = await holder("держатель");
    const a = await queued("первый", 1);
    const b = await queued("второй", 2);

    await press(MONTAJER_CHAT, `mj:sk:${h.shortId}`);
    expect(lastReply()).toContain(`Что сделать с №${h.shortId}?`);
    expect(lastReply()).toContain(`mj:skl:${h.shortId}`);
    expect(lastReply()).toContain(`mj:skd:${h.shortId}`);

    await press(MONTAJER_CHAT, `mj:skl:${h.shortId}`);
    expect((await state(a)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect((await state(h)).videoHandoffStatus).toBe("QUEUED");
    expect(await queueShortIds()).toEqual([b.shortId, h.shortId]);
    expect(filesSentFor(a)).toBe(1);
    expect(filesSentFor(h)).toBe(0);
    expect(said(`№${h.shortId} в очереди 2-м. Вам идёт №${a.shortId}`)).toBe(true);

    const journal = await waitFor(() => prisma.montajerMessage.findFirst({ where: { propertyId: h.id, kind: "QUEUE_CONTROL" } }));
    expect(journal.text).toContain(`Монтажёр пропустил №${h.shortId}: сделает позже`);
    const audit = await waitFor(() =>
      prisma.auditLog.findFirst({ where: { entityId: h.id, action: "PROPERTY_VIDEO_HANDOFF_MONTAJER_DEFERRED" }, select: { agentId: true } })
    );
    expect(audit.agentId).toBe(montajerId);

    // Двойной клик / старая кнопка: ничего не двигается, файлы не уходят второй раз.
    await press(MONTAJER_CHAT, `mj:skl:${h.shortId}`);
    expect(lastReply()).toContain(`Объект №${h.shortId} уже не у вас.`);
    expect((await state(a)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(await queueShortIds()).toEqual([b.shortId, h.shortId]);
    expect(filesSentFor(a)).toBe(1);

    // Вторая кнопка того же старого меню — «Уже сделан»: объект теперь ждёт в
    // очереди, а не у монтажёра, — снимать его по старому сообщению нельзя.
    await press(MONTAJER_CHAT, `mj:skd:${h.shortId}`);
    expect(lastReply()).toContain(`Объект №${h.shortId} уже не у вас.`);
    expect((await state(h)).videoHandoffStatus).toBe("QUEUED");
    expect(await queueShortIds()).toEqual([b.shortId, h.shortId]);
  });

  it("других объектов нет — «Сделаю позже» не предлагается и не срабатывает, объект остаётся у монтажёра", async () => {
    const h = await holder("один");
    await press(MONTAJER_CHAT, `mj:sk:${h.shortId}`);
    expect(lastReply()).toContain("Других объектов в очереди нет");
    expect(lastReply()).not.toContain(`mj:skl:${h.shortId}`);
    await press(MONTAJER_CHAT, `mj:skl:${h.shortId}`);
    expect(lastReply()).toContain(`№${h.shortId} остаётся у вас`);
    expect((await state(h)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
  });

  it("переделка не теряет причину: вернувшись в очередь, объект остаётся перемонтажом", async () => {
    // Настоящий перемонтаж: постановка с причиной, отправка файлов (захват гасит
    // videoHandoffRemake*, причина захода остаётся в videoHandoffRoundRemake*).
    const h = await seedProperty("переделка");
    await queueVideoHandoff(h.id, { reason: "OTHER", comment: "Поменять музыку" }, "front");
    await settleBackgroundHandoffDispatches();
    expect(await state(h)).toMatchObject({ videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffRemakeReason: null });
    const a = await queued("следом", 1);

    await press(MONTAJER_CHAT, `mj:skl:${h.shortId}`);
    expect((await state(a)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(await state(h)).toMatchObject({ videoHandoffStatus: "QUEUED", videoHandoffRemakeReason: "OTHER", videoHandoffRemakeComment: "Поменять музыку" });

    sendMessageWithButtons.mockClear();
    await press(MONTAJER_CHAT, "mj:queue");
    expect(lastReply()).toContain(`№${h.shortId}`);
    expect(lastReply()).toContain("🔁 переделка");
  });
});

describe("⏭ Пропустить — «Уже сделан / не нужен»", () => {
  it("держатель снят штатной дверью, следующий выдан, руководству пуш с видом, аудит и журнал; монтажёру не пишем «сняли»", async () => {
    const h = await holder("сделан сам");
    const a = await queued("следующий", 1);

    await press(MONTAJER_CHAT, `mj:skd:${h.shortId}`);
    expect((await state(h)).videoHandoffStatus).toBe("RECEIVED");
    expect((await state(a)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(filesSentFor(a)).toBe(1);
    expect(said(`Готово: №${h.shortId} снят из очереди, руководителю сообщил. Следующий у вас: №${a.shortId}`)).toBe(true);
    expect(allReplies().some((r) => r.includes("доделывать не нужно"))).toBe(false);

    await waitFor(() => (sendPushToAgents.mock.calls.length > 0 ? true : null));
    const [, payload] = sendPushToAgents.mock.calls[0]!;
    expect(payload).toMatchObject({ kind: "task", title: `Монтажёр пропустил №${h.shortId}: уже сделан` });
    const journal = await waitFor(() => prisma.montajerMessage.findFirst({ where: { propertyId: h.id, kind: "CANCELLED" } }));
    expect(journal.text).toBe(montajerSkippedDoneText(h.shortId));
    await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: h.id, action: "PROPERTY_VIDEO_HANDOFF_MONTAJER_DONE" } }));

    // Повтор: ничего не снято второй раз, следующий остаётся у монтажёра, пуш один.
    await press(MONTAJER_CHAT, `mj:skd:${h.shortId}`);
    expect(lastReply()).toContain(`Объект №${h.shortId} уже не у вас.`);
    expect((await state(a)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(filesSentFor(a)).toBe(1);
    expect(sendPushToAgents).toHaveBeenCalledTimes(1);
  });

  it("ждущий объект «уже сделан» из подменю — снят из очереди, держатель не тронут", async () => {
    const h = await holder("работает");
    const a = await queued("сделан вне системы", 1);
    const b = await queued("ждёт", 2);

    await press(MONTAJER_CHAT, `mj:qd:${a.shortId}`);
    expect((await state(a)).videoHandoffStatus).toBe("RECEIVED");
    expect((await state(h)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(await queueShortIds()).toEqual([b.shortId]);
    await waitFor(() => (sendPushToAgents.mock.calls.length > 0 ? true : null));
    expect(filesSentFor(b)).toBe(0);
  });
});

describe("Взять №M сейчас", () => {
  it("выбранный уходит монтажёру, прежний держатель — первым среди ждущих; повтор — «очередь изменилась»", async () => {
    const h = await holder("был в работе");
    const a = await queued("первый", 1);
    const b = await queued("нужен срочно", 2);

    await press(MONTAJER_CHAT, `mj:qi:${b.shortId}`);
    expect(lastReply()).toContain(`В очереди 2-м из 2.`);
    expect(lastReply()).toContain(`mj:tk:${b.shortId}:${h.shortId}`);

    await press(MONTAJER_CHAT, `mj:tk:${b.shortId}:${h.shortId}`);
    expect((await state(b)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(await queueShortIds()).toEqual([h.shortId, a.shortId]);
    expect(filesSentFor(b)).toBe(1);
    expect(said(`Готово: №${b.shortId} теперь у вас`)).toBe(true);
    expect(said(`№${h.shortId} вернулся в очередь 1-м`)).toBe(true);
    await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: b.id, action: "PROPERTY_VIDEO_HANDOFF_MONTAJER_TOOK" } }));
    await waitFor(() => prisma.montajerMessage.findFirst({ where: { propertyId: h.id, kind: "QUEUE_CONTROL" } }));

    await press(MONTAJER_CHAT, `mj:tk:${b.shortId}:${h.shortId}`);
    expect(lastReply()).toContain("Очередь только что изменилась");
    expect((await state(b)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(await queueShortIds()).toEqual([h.shortId, a.shortId]);
    expect(filesSentFor(b)).toBe(1);
  });

  it("текущего нет — выбранный просто выдаётся", async () => {
    const a = await queued("первый", 1);
    const b = await queued("второй", 2);
    // Место свободно, но мы сами держим очередь — обычный случай «выдать выбранный».
    await press(MONTAJER_CHAT, `mj:tk:${b.shortId}:0`);
    expect((await state(b)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(await queueShortIds()).toEqual([a.shortId]);
    expect(filesSentFor(b)).toBe(1);
  });

  it("отложенный руководителем — кнопки «взять» нет, старая кнопка отказывает", async () => {
    const h = await holder("в работе");
    const held = await queued("отложен", 1, { videoHandoffHeldAt: new Date(), videoHandoffHoldReason: "ждём ремонт" });

    await press(MONTAJER_CHAT, `mj:qi:${held.shortId}`);
    expect(lastReply()).toContain("Отложен руководителем (ждём ремонт)");
    expect(lastReply()).not.toContain("mj:tk:");

    await press(MONTAJER_CHAT, `mj:tk:${held.shortId}:${h.shortId}`);
    expect(lastReply()).toContain("отложен руководителем");
    expect((await state(h)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect((await state(held)).videoHandoffStatus).toBe("QUEUED");
  });
});

describe("перестановка ждущих", () => {
  it("в начало, выше, ниже — той же moveVideoHandoffInQueue, с журналом и аудитом", async () => {
    const a = await queued("A", 1);
    const b = await queued("B", 2);
    const c = await queued("C", 3);

    await press(MONTAJER_CHAT, `mj:mv:${c.shortId}:f`);
    expect(await queueShortIds()).toEqual([c.shortId, a.shortId, b.shortId]);
    expect(lastReply()).toContain(`Передвинул: №${c.shortId} теперь 1-й.`);

    await press(MONTAJER_CHAT, `mj:mv:${b.shortId}:u`);
    expect(await queueShortIds()).toEqual([c.shortId, b.shortId, a.shortId]);

    await press(MONTAJER_CHAT, `mj:mv:${c.shortId}:d`);
    expect(await queueShortIds()).toEqual([b.shortId, c.shortId, a.shortId]);

    await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: c.id, action: "PROPERTY_VIDEO_HANDOFF_MONTAJER_MOVED" } }));
    // Перестановка место монтажёра не выдаёт: монтажёру ничего не ушло.
    expect(sendDocumentFile).not.toHaveBeenCalled();
  });
});

describe("кто и когда может", () => {
  it("чужой сотрудник — отказ, очередь не тронута (и через бот, и прямым вызовом)", async () => {
    const h = await holder("чужой жмёт");
    const a = await queued("ждёт", 1);

    await press(STRANGER_CHAT, `mj:skl:${h.shortId}`);
    expect(lastReply()).toContain("Этот чат сейчас не назначен монтажёром.");
    expect((await montajerSkipLater(strangerId, h.shortId)).text).toBe(NOT_MONTAJER_TEXT);
    expect((await state(h)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect((await state(a)).videoHandoffStatus).toBe("QUEUED");
  });

  it("отключённый монтажёр — отказ, ничего не меняется", async () => {
    const h = await holder("отключён");
    await queued("ждёт", 1);
    await prisma.agent.update({ where: { id: montajerId }, data: { isActive: false } });
    expect((await montajerSkipLater(montajerId, h.shortId)).text).toBe(NOT_MONTAJER_TEXT);
    await press(MONTAJER_CHAT, `mj:skl:${h.shortId}`);
    expect((await state(h)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
  });

  it("очередь на паузе: «сделаю позже» и «взять» запрещены, «уже сделан» можно — следующий не выдаётся", async () => {
    const h = await holder("пауза");
    const a = await queued("ждёт паузу", 1);
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoHandoffQueuePaused: true } });

    await press(MONTAJER_CHAT, `mj:sk:${h.shortId}`);
    expect(lastReply()).toContain("Очередь на паузе, включает руководитель");
    expect(lastReply()).not.toContain(`mj:skl:${h.shortId}`);

    await press(MONTAJER_CHAT, `mj:skl:${h.shortId}`);
    expect(lastReply()).toContain("Очередь на паузе, включает руководитель");
    await press(MONTAJER_CHAT, `mj:tk:${a.shortId}:${h.shortId}`);
    expect((await state(h)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect((await state(a)).videoHandoffStatus).toBe("QUEUED");

    await press(MONTAJER_CHAT, "mj:queue");
    expect(lastReply()).toContain("Очередь на паузе, включает руководитель");

    await press(MONTAJER_CHAT, `mj:skd:${h.shortId}`);
    expect((await state(h)).videoHandoffStatus).toBe("RECEIVED");
    expect((await state(a)).videoHandoffStatus).toBe("QUEUED");
    expect(lastReply()).toContain("Следующий пока не придёт");
    expect(filesSentFor(a)).toBe(0);
  });

  it("рубильник выключен: кнопок управления нет, нажатие — «выключено руководителем»", async () => {
    const h = await holder("выключено");
    const a = await queued("ждёт", 1);
    await prisma.settings.update({ where: { id: "singleton" }, data: { montajerQueueControlEnabled: false } });

    await press(MONTAJER_CHAT, "mj:queue");
    expect(lastReply()).toContain(`mj:obj:${a.shortId}`);
    expect(lastReply()).not.toContain("mj:sk:");
    expect(lastReply()).not.toContain("mj:qi:");

    for (const data of [`mj:sk:${h.shortId}`, `mj:skl:${h.shortId}`, `mj:skd:${h.shortId}`, `mj:tk:${a.shortId}:${h.shortId}`, `mj:mv:${a.shortId}:f`, `mj:qd:${a.shortId}`]) {
      await press(MONTAJER_CHAT, data);
      expect(lastReply(), data).toBe(QUEUE_CONTROL_OFF_TEXT);
    }
    expect((await state(h)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect((await state(a)).videoHandoffStatus).toBe("QUEUED");
  });

  it("слово «пропустить» открывает то же меню, что кнопка; «Отмена» ничего не меняет", async () => {
    const h = await holder("словом");
    await queued("ждёт", 1);
    await handleTelegramUpdate({ update_id: nextUpdateId++, message: { chat: { id: MONTAJER_CHAT }, text: "пропустить" } });
    expect(lastReply()).toContain(`Что сделать с №${h.shortId}?`);
    await press(MONTAJER_CHAT, "mj:x");
    expect(lastReply()).toContain("Хорошо, ничего не меняю.");
    expect((await state(h)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
  });
});

/** Монтажёр прислал файл в бот (готовый ролик). */
async function sendFile(fileName: string) {
  const updateId = nextUpdateId++;
  await handleTelegramUpdate({
    update_id: updateId,
    message: { chat: { id: MONTAJER_CHAT }, document: { file_id: `doc-${updateId}`, mime_type: "video/mp4", file_name: fileName } },
  });
  await settleBackgroundHandoffDispatches();
  return updateId;
}

async function finalOf(p: Seeded) {
  return (await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffFinalPath: true } })).videoHandoffFinalPath;
}

describe("ревью 19.11: ролик не уходит чужому объекту после пропуска", () => {
  it("снял «уже сделан», выдан следующий, файл без номера — вопрос «чей ролик», а не приём на новый; ответ — приём на снятый", async () => {
    const h = await holder("сделан вне системы");
    const a = await queued("выдан следом", 1);
    await press(MONTAJER_CHAT, `mj:skd:${h.shortId}`);
    expect((await state(a)).videoHandoffStatus).toBe("SENT_TO_EDITOR");

    const updateId = await sendFile("final_edit.mp4");
    expect(await finalOf(a)).toBeNull();
    expect(lastReply()).toContain(`mj:rcv:${updateId}:${h.shortId}`);
    expect(lastReply()).toContain(`mj:rcv:${updateId}:${a.shortId}`);

    await press(MONTAJER_CHAT, `mj:rcv:${updateId}:${h.shortId}`);
    expect(await finalOf(h)).toMatch(/^\/uploads\/handoff\//);
    expect(await finalOf(a)).toBeNull();
    expect((await state(a)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(said(`Ролик по объекту №${h.shortId} принят`)).toBe(true);
  });

  it("«Сделаю позже», потом ролик отложенного с номером — принят штатно к нему, место следующего не тронуто", async () => {
    const h = await holder("отложил и доделал");
    const a = await queued("следующий", 1);
    await press(MONTAJER_CHAT, `mj:skl:${h.shortId}`);
    await sendFile(`${h.shortId}.mp4`);
    expect(await finalOf(h)).toMatch(/^\/uploads\/handoff\//);
    expect((await state(h)).videoHandoffStatus).toBe("RECEIVED");
    expect((await state(a)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(await queueShortIds()).toEqual([]);
  });

  it("без пропусков файл без номера по-прежнему уходит объекту в работе без вопроса", async () => {
    const h = await holder("обычный");
    await sendFile("final.mp4");
    expect(await finalOf(h)).toMatch(/^\/uploads\/handoff\//);
  });
});

describe("ревью 19.11: гонка обмена с приёмом ролика", () => {
  it("ролик принят, пока шёл обмен, — принятый объект не возвращается в очередь", async () => {
    const h = await holder("принят во время обмена");
    await queued("ждёт", 1);
    // Приём ролика держит строку объекта и пишет RECEIVED; обмен в это время уже прочитал «у монтажёра».
    const receiving = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "Property" WHERE id = ${h.id} FOR UPDATE`;
      await tx.property.update({ where: { id: h.id }, data: { videoHandoffStatus: "RECEIVED", videoHandoffFinalPath: "/uploads/handoff/race.mp4" } });
      await new Promise((r) => setTimeout(r, 700));
    });
    await new Promise((r) => setTimeout(r, 150));
    const result = await swapVideoHandoffHolder({ mode: "defer", holderId: h.id });
    await receiving;
    await settleBackgroundHandoffDispatches();
    expect(result.ok).toBe(false);
    expect((await state(h)).videoHandoffStatus).toBe("RECEIVED");
  });
});

describe("ревью 19.11: причина переделки — только текущего захода", () => {
  it("обычный заход после старой переделки: «Сделаю позже» не делает его переделкой", async () => {
    const h = await seedProperty("старая переделка");
    await prisma.montajerMessage.create({ data: { propertyId: h.id, kind: "REMAKE", text: "🔁 ПЕРЕМОНТАЖ (прошлый заход)" } });
    await prisma.videoRemakeRequest.create({ data: { propertyId: h.id, reason: "NARRATION_CHANGED", requestedById: montajerId } });
    // Обычная передача, файлы ещё идут: журнал HANDOFF этого захода ещё не записан.
    await prisma.property.update({ where: { id: h.id }, data: { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() } });
    await queued("следом", 1);
    await press(MONTAJER_CHAT, `mj:skl:${h.shortId}`);
    expect(await state(h)).toMatchObject({ videoHandoffStatus: "QUEUED", videoHandoffRemakeReason: null });
  });
});

describe("ревью 19.11: отложенный руководителем", () => {
  it("у отложенного нет «Уже сделан», и дверь его не снимает; снятие руководством гасит «отложен»", async () => {
    await holder("в работе");
    const held = await queued("отложен", 1, { videoHandoffHeldAt: new Date(), videoHandoffHoldReason: "ждём" });
    await press(MONTAJER_CHAT, `mj:qi:${held.shortId}`);
    expect(lastReply()).not.toContain(`mj:qd:${held.shortId}`);
    await press(MONTAJER_CHAT, `mj:qd:${held.shortId}`);
    expect((await state(held)).videoHandoffStatus).toBe("QUEUED");
    expect(lastReply()).toContain("отложен руководителем");

    expect((await cancelVideoHandoffQueueEntry(held.id)).ok).toBe(true);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: held.id }, select: { videoHandoffHeldAt: true, videoHandoffHoldReason: true } });
    expect(after).toEqual({ videoHandoffHeldAt: null, videoHandoffHoldReason: null });
  });
});

describe("ревью 19.11: мелочи", () => {
  it("пуш «уже сделан» не уходит самому монтажёру и говорит про старые посты у переделки вышедшего ролика", async () => {
    await prisma.agent.update({ where: { id: montajerId }, data: { role: "DIRECTOR" } });
    const h = await holder("переделка вышедшего");
    // Заход — переделка вышедшего ролика (поля текущего захода записаны при захвате отправки).
    await prisma.property.update({ where: { id: h.id }, data: { publishedChannels: ["TELEGRAM"], videoHandoffRoundRemakeReason: "OTHER" } });
    await press(MONTAJER_CHAT, `mj:skd:${h.shortId}`);
    await waitFor(() => (sendPushToAgents.mock.calls.length > 0 ? true : null));
    const [ids, payload] = sendPushToAgents.mock.calls[0]!;
    expect(ids).not.toContain(montajerId);
    expect(JSON.stringify(payload)).toContain("старые посты");
  });

  it("рубильник выключен — в меню нет строки «пропустить»; включён — есть", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { montajerQueueControlEnabled: false } });
    await handleTelegramUpdate({ update_id: nextUpdateId++, message: { chat: { id: MONTAJER_CHAT }, text: "меню" } });
    expect(lastReply()).not.toContain("«пропустить»");
    await prisma.settings.update({ where: { id: "singleton" }, data: { montajerQueueControlEnabled: true } });
    await handleTelegramUpdate({ update_id: nextUpdateId++, message: { chat: { id: MONTAJER_CHAT }, text: "меню" } });
    expect(lastReply()).toContain("«пропустить»");
  });

  it("больше десяти ждущих — «и ещё N» в тексте очереди", async () => {
    for (let i = 1; i <= 12; i++) await queued(`много-${i}`, i);
    await press(MONTAJER_CHAT, "mj:queue");
    expect(lastReply()).toContain("… и ещё 2");
  });

  it("отложен, пока шли файлы, — отправка остановлена без записи «объект сняли» в журнал ошибок", async () => {
    const h = await holder("отложен на лету");
    await prisma.property.update({ where: { id: h.id }, data: { videoHandoffDeliveredAt: null } });
    // Второй файл того же объекта: первый «уходит», и в этот момент монтажёр жмёт «Сделаю позже».
    const storageKey = `${h.id}/${randomUUID()}.mp4`;
    const filePath = localVideoFilePath(storageKey)!;
    await fs.writeFile(filePath, Buffer.alloc(300));
    await prisma.propertyVideo.create({ data: { propertyId: h.id, storageKey, filename: "IMG_2.MOV", sizeBytes: 300, durationSec: 20, hasAudio: true, uploadedById: montajerId } });
    const a = await queued("следующий", 1);
    sendDocumentFile.mockImplementationOnce(async (_c: string, _f: unknown, name: string) => {
      await swapVideoHandoffHolder({ mode: "defer", holderId: h.id });
      return { message_id: 1, document: { file_id: `fid-${name}` } };
    });
    const since = new Date();
    await dispatchToEditor(h.id, montajerId);
    await settleBackgroundHandoffDispatches();
    expect((await state(h)).videoHandoffStatus).toBe("QUEUED");
    expect((await state(a)).videoHandoffStatus).toBe("SENT_TO_EDITOR");
    const errors = await waitForSettled(() =>
      prisma.errorLog.findMany({ where: { createdAt: { gte: since }, message: { contains: `№${h.shortId}` } }, select: { message: true } })
    );
    expect(errors.map((e) => e.message).filter((m) => /прервана|сняли/.test(m))).toEqual([]);
  });
});
