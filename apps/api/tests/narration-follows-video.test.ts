import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * ГОЛОС — ВМЕСТЕ С ВИДЕО (21.11.2026, владелец: «Проверь почему нет озвучки»). Объект №211: озвучку одобрили,
 * mp3 ушёл монтажёру 20.11, а видео объекта стояло в очереди монтажа и дошло до него только 21.11. В задании
 * к видео стояло «озвучка придёт отдельным mp3», но второй передачи не было — голос пришёл на сутки раньше
 * ролика и потерялся. Правило: mp3 приходит монтажёру ВМЕСТЕ с видео.
 *  — одобрено до выдачи видео: mp3 раньше не уходит, уходит сразу после файлов, до «отправлено N из N»;
 *  — повторная выдача (перемонтаж, «Сделаю позже» → «Взять сейчас», новый монтажёр): mp3 снова, один раз;
 *  — двойной вызов той же выдачи и обход озвучки следом: один mp3;
 *  — одобрено, когда видео уже у монтажёра: сразу, как раньше;
 *  — голос ушёл раньше видео (как №211): обход один раз досылает его следом, второй раз — нет;
 *  — строка монтажёру говорит правду: «следующим сообщением» / «как будет готова».
 * Настоящие videoHandoff → крючок → narrationAutoFlow → narrationDelivery и база стенда; подменены Telegram, пуш, ffprobe.
 */
const tg = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string, _text: string) => ({ message_id: 1 })),
  sendMessageWithButtons: vi.fn(async (_chatId: string, _text: string, _buttons: unknown) => ({ message_id: 1 })),
  sendDocumentFile: vi.fn(async (_c: string, _f: unknown, name: string, _caption?: string) => ({ message_id: 1, document: { file_id: `fid-${name}` } })),
  sendDocument: vi.fn(async (_c: string, _fileId: string, _caption?: string) => ({ message_id: 1 })),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage: tg.sendMessage,
  sendMessageWithButtons: tg.sendMessageWithButtons,
  sendDocumentFile: tg.sendDocumentFile,
  sendDocument: tg.sendDocument,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => {}),
  sendPushToAgents: vi.fn(async () => 0),
}));
vi.mock("../src/lib/ffmpeg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ffmpeg.js")>()),
  probeMediaInfo: vi.fn(async () => ({ hasVideo: true, hasAudio: true, videoCodec: "h264", audioCodec: "aac", width: 1080, height: 1920, rotation: 0, durationSec: 15, sizeBytes: 2048 })),
}));

delete process.env.TELEGRAM_BOT_TOKEN;

const { prisma } = await import("../src/db.js");
const vh = await import("../src/lib/videoHandoff.js");
const { afterNarrationApproved, narrationAfterVideoIssued, narrationsOwedToMontajer, runNarrationAutoFlow } = await import("../src/lib/narrationAutoFlow.js");
const { executeNarrationDelivery, executeQueuedNarrationDeliveries, prepareNarrationDeliveryPlan, retryTelegramRateLimit, NARRATION_WAITS_FOR_VIDEO_TEXT } = await import("../src/lib/narrationDelivery.js");
const { TelegramApiError } = await import("../src/telegram/api.js");
const { narrationFacts, narrationHash } = await import("../src/lib/propertyNarration.js");
const { localVideoFilePath, localVideoUpload, localVideoDelete } = await import("../src/lib/localVideoStorage.js");
const { runVideoHandoffRedeliveryTick } = await import("../src/lib/videoHandoffRedelivery.js");
const { waitForSettled } = await import("./helpers/waitFor.js");

const runId = Date.now();
const MONTAJER_CHAT = String(764000000 + (runId % 1_000_000));
const NEW_MONTAJER_CHAT = String(765000000 + (runId % 1_000_000));
let districtId = "";
let montajerId = "";
let newMontajerId = "";
let approverId = "";
const propertyIds: string[] = [];
const files: string[] = [];
let savedSettings: Record<string, unknown> | null = null;
const SETTINGS_SELECT = { videoHandoffEnabled: true, videoMontajerAgentId: true, videoHandoffQueuePaused: true, montajerQueueControlEnabled: true } as const;

type Seeded = { id: string; shortId: number };
async function seedProperty(label: string, data: Record<string, unknown> = {}): Promise<Seeded> {
  const p = await prisma.property.create({ data: { title: `Голос за видео-${label}-${runId}`, type: "APARTMENT", areaSqm: 61, price: 400000, currency: "TJS", districtId,
    address: "Видео, 1", rooms: 2, condition: "GOOD", status: "EDITING", ...data } });
  propertyIds.push(p.id);
  const storageKey = `${p.id}/${randomUUID()}.mp4`;
  const filePath = localVideoFilePath(storageKey)!;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.alloc(300));
  files.push(storageKey);
  await prisma.propertyVideo.create({ data: { propertyId: p.id, storageKey, filename: "IMG_1.MOV", sizeBytes: 300, durationSec: 20, hasAudio: true, uploadedById: approverId } });
  return { id: p.id, shortId: p.shortId };
}
/** Готовая озвучка, одобренная человеком (файл mp3 на диске). */
async function approvedVoice(p: Seeded, approved = true) {
  const full = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, include: { district: true } });
  const facts = narrationFacts(full);
  const storageKey = `${p.id}/${randomUUID()}.mp3`;
  await localVideoUpload(storageKey, Buffer.from("synthetic mp3 bytes"));
  files.push(storageKey);
  return prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script: "Синтетический текст озвучки.", factsSnapshot: facts, factsHash: narrationHash(facts),
    status: "READY", storageKey, approvedAt: approved ? new Date() : null, approvedById: approved ? approverId : null, createdById: approverId, requestKey: randomUUID(), source: "AUTO" } });
}

/** Порядковые номера вызовов: файлы видео, mp3 озвучки и контрольное «отправлено N из N» объекта. */
function sendsFor(p: Seeded, chat = MONTAJER_CHAT) {
  const docs = tg.sendDocumentFile.mock.calls.map((c, i) => ({ c, order: tg.sendDocumentFile.mock.invocationCallOrder[i]! })).filter(({ c }) => c[0] === chat);
  const byId = tg.sendDocument.mock.calls.map((c, i) => ({ c, order: tg.sendDocument.mock.invocationCallOrder[i]! })).filter(({ c }) => c[0] === chat);
  const head = `Объект №${p.shortId} ·`;
  const video = [...docs.filter(({ c }) => String(c[3] ?? "").startsWith(head) && !String(c[3]).startsWith(`${head} 🎙`)), ...byId.filter(({ c }) => String(c[2] ?? "").startsWith(head) && !String(c[2]).startsWith(`${head} 🎙`))].map((x) => x.order);
  const voice = docs.filter(({ c }) => String(c[2]) === `property-${p.shortId}-voice-v1.mp3`).map((x) => x.order);
  const control = [...tg.sendMessage.mock.calls.map((c, i) => ({ c, order: tg.sendMessage.mock.invocationCallOrder[i]! })),
    ...tg.sendMessageWithButtons.mock.calls.map((c, i) => ({ c, order: tg.sendMessageWithButtons.mock.invocationCallOrder[i]! }))]
    .filter(({ c }) => c[0] === chat && isControlText(String(c[1]), p)).map((x) => x.order);
  return { video: video.sort((a, b) => a - b), voice: voice.sort((a, b) => a - b), control: control.sort((a, b) => a - b) };
}
/** Итог «отправлено N из N» объекта: прежний вид «Отправлено…», короткий (28.11.2026) «Объект №N: K видео отправлено.» / «дошло k из K». */
function isControlText(text: string, p: Seeded): boolean {
  if (text.startsWith("Отправлено")) return text.includes(`№${p.shortId}`);
  return text.startsWith(`Объект №${p.shortId}: `) && /видео отправлено|дошло \d+ из \d+/.test(text);
}
/** Тексты итогового «отправлено N из N» объекта. */
function controlTexts(p: Seeded, chat = MONTAJER_CHAT): string[] {
  return [...tg.sendMessage.mock.calls, ...tg.sendMessageWithButtons.mock.calls]
    .filter((c) => c[0] === chat && isControlText(String(c[1]), p)).map((c) => String(c[1]));
}
const deliveries = (p: Seeded) => prisma.propertyNarrationDelivery.findMany({ where: { propertyId: p.id }, orderBy: { createdAt: "asc" } });

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Голос за видео-${runId}` } })).id;
  const hash = await bcrypt.hash("testpass123", 4);
  montajerId = (await prisma.agent.create({ data: { fullName: "Монтажёр голоса", phone: `+99296${String(runId).slice(-7)}`, role: "MARKETING", passwordHash: hash, telegramChatId: MONTAJER_CHAT } })).id;
  newMontajerId = (await prisma.agent.create({ data: { fullName: "Новый монтажёр голоса", phone: `+99297${String(runId).slice(-7)}`, role: "EDITOR", passwordHash: hash, telegramChatId: NEW_MONTAJER_CHAT } })).id;
  approverId = (await prisma.agent.create({ data: { fullName: "Одобряющий голос", phone: `+99298${String(runId).slice(-7)}`, role: "DIRECTOR", passwordHash: hash } })).id;
  savedSettings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" }, select: SETTINGS_SELECT });
  vh.setMontajerSendPauseMsForTests(0);
  vh.setVideoIssuedToMontajerHook(narrationAfterVideoIssued);
});
beforeEach(async () => {
  vi.stubEnv("CRM_NARRATION_EXECUTION_MODE", "LIVE");
  await prisma.settings.update({ where: { id: "singleton" }, data: { videoHandoffEnabled: true, videoMontajerAgentId: montajerId, videoHandoffQueuePaused: false, montajerQueueControlEnabled: true } });
  // Чужие держатели и ждущие в общей базе — не наши.
  await prisma.property.updateMany({ where: { videoHandoffStatus: { in: ["SENT_TO_EDITOR", "QUEUED"] }, id: { notIn: propertyIds } }, data: { videoHandoffStatus: "RECEIVED", videoHandoffQueueOrder: null } });
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { videoHandoffStatus: "NONE", videoHandoffQueueOrder: null } });
  for (const m of Object.values(tg)) m.mockClear();
});
afterEach(async () => {
  await vh.settleBackgroundHandoffDispatches();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  vh.setVideoIssuedToMontajerHook(null);
  vh.setMontajerSendPauseMsForTests();
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.propertyNarrationDelivery.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyNarrationVersion.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: propertyIds.map(vh.videoHandoffPublishDedupeKey) } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  for (const key of files) await localVideoDelete(key).catch(() => false);
  await prisma.auditLog.deleteMany({ where: { agentId: { in: [montajerId, newMontajerId, approverId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [montajerId, newMontajerId, approverId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("одобрено до выдачи видео", () => {
  it("видео в очереди: mp3 не уходит; объект выдан — mp3 сразу после файлов, до «отправлено N из N»", async () => {
    const holder = await seedProperty("держатель", { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date(), videoHandoffDeliveredAt: new Date() });
    const p = await seedProperty("в очереди", { videoHandoffStatus: "QUEUED", videoHandoffSentAt: new Date(), videoHandoffQueueOrder: 1 });
    const v = await approvedVoice(p);
    expect(await afterNarrationApproved(p.id, v.id)).not.toBe("QUEUED");
    await runNarrationAutoFlow({});
    await executeQueuedNarrationDeliveries();
    expect(sendsFor(p).voice).toHaveLength(0);
    expect(await prisma.propertyNarrationDelivery.count({ where: { propertyId: p.id, status: { notIn: ["WAITING", "CANCELLED"] } } })).toBe(0);
    // Держатель сдан — место уходит следующему, его файлы фоном.
    await prisma.property.update({ where: { id: holder.id }, data: { videoHandoffStatus: "RECEIVED" } });
    await vh.releaseQueueIfClear(holder.id);
    await vh.settleBackgroundHandoffDispatches();
    const s = sendsFor(p);
    expect(s.video).toHaveLength(1);
    expect(s.voice).toHaveLength(1);
    expect(s.voice[0]!).toBeGreaterThan(s.video.at(-1)!);
    expect(s.control).toHaveLength(1);
    // «следующим сообщением» — правда: mp3 идёт сразу за итогом, в котором это сказано.
    expect(s.voice[0]!).toBeGreaterThan(s.control[0]!);
    expect(controlTexts(p).at(-1)).toBe(`Объект №${p.shortId}: 1 видео отправлено. Голос придёт следом.`);
    expect((await deliveries(p)).filter((d) => d.status === "SENT")).toHaveLength(1);
  });

  it("место выдано, а файлы ещё не дошли: одобрение и обход голос не шлют, поставленная раньше передача ждёт", async () => {
    const p = await seedProperty("файлы идут", { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date(), videoHandoffDeliveredAt: null });
    const v = await approvedVoice(p);
    expect(await afterNarrationApproved(p.id, v.id)).not.toBe("QUEUED");
    await runNarrationAutoFlow({});
    expect(await narrationsOwedToMontajer()).not.toContainEqual({ id: v.id, propertyId: p.id });
    // Передача, поставленная до этой правки (видео тогда ещё не было), — при отправке ждёт, а не уходит раньше ролика.
    const old = await prisma.propertyNarrationDelivery.create({ data: { propertyId: p.id, versionId: v.id, editorId: montajerId, mode: "AUDIO_ONLY", requestKey: randomUUID(), createdById: approverId,
      plan: { factsHash: v.factsHash, recipientHash: "x", sourcesHash: "x", files: [{ id: v.id, storageKey: v.storageKey!, filename: "v.mp3", caption: "c" }] }, status: "QUEUED", executionMode: "LIVE" } });
    expect(await executeNarrationDelivery(old.id)).toEqual({ status: "WAITING" });
    expect(sendsFor(p).voice).toHaveLength(0);
    // Файлы дошли (досылка) — голос следом, одной передачей.
    expect(await vh.dispatchToEditor(p.id, montajerId)).toBe(true);
    const s = sendsFor(p);
    expect(s.voice).toHaveLength(1);
    expect(s.voice[0]!).toBeGreaterThan(s.video.at(-1)!);
    const rows = await deliveries(p);
    expect(rows.filter((d) => d.status === "SENT")).toHaveLength(1);
    expect(rows.find((d) => d.id === old.id)?.status).toBe("CANCELLED");
  });
});

describe("повторная выдача видео — mp3 снова, один раз", () => {
  it("«Сделаю позже» → «Взять сейчас» и перемонтаж: на каждую выдачу один mp3; двойной вызов той же выдачи и обход — без дублей", async () => {
    const p = await seedProperty("повтор");
    await approvedVoice(p);
    await vh.queueVideoHandoff(p.id);
    await vh.settleBackgroundHandoffDispatches();
    expect(sendsFor(p).voice).toHaveLength(1);

    // Двойной вызов той же выдачи: файлов нет — голоса нет; крючок напрямую и обход — тот же ключ.
    await vh.dispatchToEditor(p.id, montajerId);
    await narrationAfterVideoIssued(p.id, montajerId);
    await runNarrationAutoFlow({});
    await executeQueuedNarrationDeliveries();
    expect(sendsFor(p).voice).toHaveLength(1);

    // «Сделаю позже»: другой объект берёт место; «Взять №N сейчас» — объект снова у монтажёра.
    const other = await seedProperty("другой", { videoHandoffStatus: "QUEUED", videoHandoffSentAt: new Date(), videoHandoffQueueOrder: 1 });
    const deferred = await vh.swapVideoHandoffHolder({ mode: "defer", holderId: p.id });
    if (!deferred.ok) throw new Error(deferred.error);
    vh.dispatchInBackground(deferred.seated.id, montajerId); // так делает бот (montajerQueueControl.ts)
    await vh.settleBackgroundHandoffDispatches();
    expect(sendsFor(p).voice).toHaveLength(1);
    const taken = await vh.swapVideoHandoffHolder({ mode: "take", takeId: p.id, expectedHolderId: other.id });
    if (!taken.ok) throw new Error(taken.error);
    vh.dispatchInBackground(taken.seated.id, montajerId);
    await vh.settleBackgroundHandoffDispatches();
    let s = sendsFor(p);
    expect(s.video).toHaveLength(2);
    expect(s.voice).toHaveLength(2);
    expect(s.voice[1]!).toBeGreaterThan(s.video[1]!);

    // Перемонтаж (возврат монтажёру с причиной): новая выдача — mp3 ещё раз, без генерации.
    await prisma.property.update({ where: { id: p.id }, data: { videoHandoffStatus: "RECEIVED" } });
    await prisma.property.update({ where: { id: other.id }, data: { videoHandoffStatus: "RECEIVED" } });
    await vh.queueVideoHandoff(p.id, { reason: "OTHER", comment: "переделка" }, "front");
    await vh.settleBackgroundHandoffDispatches();
    await runNarrationAutoFlow({});
    await executeQueuedNarrationDeliveries();
    s = sendsFor(p);
    expect(s.video).toHaveLength(3);
    expect(s.voice).toHaveLength(3);
    expect(new Set((await deliveries(p)).map((d) => d.requestKey)).size).toBe(3);
  });

  it("сменили монтажёра: новому — файлы и следом mp3; прежнему ждущая передача не уходит", async () => {
    const p = await seedProperty("новый монтажёр");
    await approvedVoice(p);
    await vh.queueVideoHandoff(p.id);
    await vh.settleBackgroundHandoffDispatches();
    expect(sendsFor(p).voice).toHaveLength(1);
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: newMontajerId } });
    await runVideoHandoffRedeliveryTick();
    await vh.settleBackgroundHandoffDispatches();
    const s = sendsFor(p, NEW_MONTAJER_CHAT);
    expect(s.video).toHaveLength(1);
    expect(s.voice).toHaveLength(1);
    expect(s.voice[0]!).toBeGreaterThan(s.video[0]!);
    await runNarrationAutoFlow({});
    await executeQueuedNarrationDeliveries();
    expect(sendsFor(p, NEW_MONTAJER_CHAT).voice).toHaveLength(1);
    expect(sendsFor(p).voice).toHaveLength(1);
  });
});

describe("одобрено, когда видео уже у монтажёра", () => {
  it("mp3 уходит сразу (как раньше), повторное одобрение — «уже»", async () => {
    const p = await seedProperty("одобрено позже");
    await vh.queueVideoHandoff(p.id);
    await vh.settleBackgroundHandoffDispatches();
    expect(sendsFor(p).video).toHaveLength(1);
    const v = await approvedVoice(p);
    expect(await afterNarrationApproved(p.id, v.id)).toBe("QUEUED");
    await executeQueuedNarrationDeliveries();
    expect(sendsFor(p).voice).toHaveLength(1);
    expect(await afterNarrationApproved(p.id, v.id)).toBe("ALREADY");
    await runNarrationAutoFlow({});
    await executeQueuedNarrationDeliveries();
    expect(sendsFor(p).voice).toHaveLength(1);
  });
});

describe("голос ушёл раньше видео (как №211)", () => {
  it("обход один раз досылает mp3 следом за видео, второй раз — нет", async () => {
    const p = await seedProperty("211");
    const v = await approvedVoice(p);
    // 20.11: голос ушёл; видео стояло в очереди.
    const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);
    await prisma.propertyNarrationDelivery.create({ data: { propertyId: p.id, versionId: v.id, editorId: montajerId, mode: "AUDIO_ONLY", requestKey: `auto:${v.id}:${montajerId}`,
      createdById: approverId, status: "SENT", executionMode: "LIVE", createdAt: dayAgo, deliveredAt: dayAgo } });
    // 21.11: видео дошло до монтажёра без крючка (так было до правки).
    vh.setVideoIssuedToMontajerHook(null);
    try {
      await vh.queueVideoHandoff(p.id);
      await vh.settleBackgroundHandoffDispatches();
    } finally { vh.setVideoIssuedToMontajerHook(narrationAfterVideoIssued); }
    expect(sendsFor(p).voice).toHaveLength(0);
    expect(await narrationsOwedToMontajer()).toContainEqual({ id: v.id, propertyId: p.id });
    await runNarrationAutoFlow({});
    await executeQueuedNarrationDeliveries();
    expect(sendsFor(p).voice).toHaveLength(1);
    await runNarrationAutoFlow({});
    await executeQueuedNarrationDeliveries();
    expect(sendsFor(p).voice).toHaveLength(1);
    expect(await narrationsOwedToMontajer()).not.toContainEqual({ id: v.id, propertyId: p.id });
  });
});

describe("строка монтажёру", () => {
  // Короткий вид (28.11.2026): голос, который уйдёт следом, объявляет итог («Голос придёт следом.»), в задании строки нет.
  it("одобрена и уйдёт сейчас — в задании строки нет (скажет итог); готовится — «готовится»; выключена отправка — «позже»", async () => {
    const p = await seedProperty("строка");
    const v = await approvedVoice(p);
    expect(await vh.buildMontajerMessageText(p.id, null)).not.toContain("🎙");
    vi.stubEnv("CRM_NARRATION_EXECUTION_MODE", "PREVIEW");
    expect(await vh.buildMontajerMessageText(p.id, null)).toContain("🎙 Голос придёт отдельным файлом позже, вклейте его сами.");
    vi.stubEnv("CRM_NARRATION_EXECUTION_MODE", "LIVE");
    await prisma.propertyNarrationVersion.update({ where: { id: v.id }, data: { status: "DRAFT", approvedAt: null, approveAsId: approverId } });
    expect(await vh.buildMontajerMessageText(p.id, null)).toContain("🎙 Голос готовится и придёт отдельным файлом, вклейте его сами.");
  });

  it("прежний вид (рубильник коротких ВЫКЛ): «сразу после файлов», «как будет готова», итог «следующим сообщением»", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { montajerShortMessages: false } });
    try {
      const p = await seedProperty("строка прежняя");
      await approvedVoice(p);
      expect(await vh.buildMontajerMessageText(p.id, null)).toContain("🎙 Озвучка одобрена: mp3 придёт сразу после файлов ролика — вклейте её сами.");
      await vh.queueVideoHandoff(p.id);
      await vh.settleBackgroundHandoffDispatches();
      expect(controlTexts(p).at(-1)).toContain("🎙 Озвучка — следующим сообщением, вклейте её сами.");
      vi.stubEnv("CRM_NARRATION_EXECUTION_MODE", "PREVIEW");
      expect(await vh.buildMontajerMessageText(p.id, null)).toContain("🎙 Озвучка придёт сюда, как будет готова, — вклейте её сами.");
    } finally {
      vi.stubEnv("CRM_NARRATION_EXECUTION_MODE", "LIVE");
      await prisma.settings.update({ where: { id: "singleton" }, data: { montajerShortMessages: true } });
    }
  });

  it("цену поменяли после одобрения: ни «сразу», ни «следующим»; файлы ушли, mp3 нет, тревоги в журнале нет", async () => {
    const p = await seedProperty("цена сменилась");
    await approvedVoice(p);
    await prisma.property.update({ where: { id: p.id }, data: { areaSqm: 99 } }); // факты озвучки разошлись
    expect(await vh.buildMontajerMessageText(p.id, null)).toContain("🎙 Голос придёт отдельным файлом позже");
    await vh.queueVideoHandoff(p.id);
    await vh.settleBackgroundHandoffDispatches();
    expect(sendsFor(p).video).toHaveLength(1);
    expect(sendsFor(p).voice).toHaveLength(0);
    expect(controlTexts(p).join("\n")).not.toMatch(/Озвучка|Голос/);
    // Журнал пишется «в отрыве» (logSystemError) — ждём, пока запись осядет, и только тогда считаем.
    expect(await waitForSettled(() => prisma.errorLog.count({ where: { dedupKey: { startsWith: `narration-delivery-refused:${p.id}:` } } }))).toBe(0);
  });

  it("цена в долларах в одобренном тексте: «следующим» не обещается", async () => {
    const p = await seedProperty("доллары");
    const v = await approvedVoice(p);
    await prisma.propertyNarrationVersion.update({ where: { id: v.id }, data: { script: "Квартира за восемьдесят пять тысяч долларов." } });
    expect(await vh.buildMontajerMessageText(p.id, null)).not.toContain("сразу после файлов");
    await vh.queueVideoHandoff(p.id);
    await vh.settleBackgroundHandoffDispatches();
    expect(controlTexts(p).join("\n")).not.toMatch(/Озвучка|Голос/);
    expect(sendsFor(p).voice).toHaveLength(0);
  });
});

describe("лимит Telegram", () => {
  it("mp3 — после той же паузы, что между файлами одного чата", async () => {
    const at: Array<{ what: string; t: number }> = [];
    tg.sendDocumentFile.mockImplementation(async (_c: string, _f: unknown, name: string) => { at.push({ what: name, t: Date.now() }); return { message_id: 1, document: { file_id: `fid-${name}` } }; });
    tg.sendMessageWithButtons.mockImplementation(async (_c: string, text: string) => { at.push({ what: text, t: Date.now() }); return { message_id: 1 }; });
    vh.setMontajerSendPauseMsForTests(300);
    try {
      const p = await seedProperty("пауза");
      await approvedVoice(p);
      await vh.queueVideoHandoff(p.id);
      await vh.settleBackgroundHandoffDispatches();
      const control = at.find((x) => x.what.includes("видео отправлено"));
      const voice = at.find((x) => x.what.endsWith(".mp3"));
      expect(control && voice).toBeTruthy();
      expect(voice!.t - control!.t).toBeGreaterThanOrEqual(280);
    } finally {
      vh.setMontajerSendPauseMsForTests(0);
      tg.sendDocumentFile.mockImplementation(async (_c: string, _f: unknown, name: string) => ({ message_id: 1, document: { file_id: `fid-${name}` } }));
      tg.sendMessageWithButtons.mockImplementation(async () => ({ message_id: 1 }));
    }
  });

  it("Telegram ответил 429 на mp3 — ждём retry_after и шлём ещё раз: голос дошёл, передача SENT", async () => {
    const p = await seedProperty("429");
    await approvedVoice(p);
    let refused = 0;
    tg.sendDocumentFile.mockImplementation(async (_c: string, _f: unknown, name: string) => {
      if (name.endsWith(".mp3") && refused++ === 0) throw new TelegramApiError(429, "sendDocument", "Too Many Requests: retry after 0", { retry_after: 0 });
      return { message_id: 1, document: { file_id: `fid-${name}` } };
    });
    try {
      await vh.queueVideoHandoff(p.id);
      await vh.settleBackgroundHandoffDispatches();
    } finally {
      tg.sendDocumentFile.mockImplementation(async (_c: string, _f: unknown, name: string) => ({ message_id: 1, document: { file_id: `fid-${name}` } }));
    }
    expect(refused).toBe(2);
    expect(sendsFor(p).voice).toHaveLength(2); // отказ и повтор
    const rows = await deliveries(p);
    expect(rows.map((d) => d.status)).toEqual(["SENT"]);
  });

  it("429 не прошёл и после повторов — голос точно не дошёл: FAILED («передайте вручную»), а не «неизвестно»", async () => {
    const p = await seedProperty("429 всегда");
    await approvedVoice(p);
    tg.sendDocumentFile.mockImplementation(async (_c: string, _f: unknown, name: string) => {
      if (name.endsWith(".mp3")) throw new TelegramApiError(429, "sendDocument", "Too Many Requests: retry after 600", { retry_after: 600 });
      return { message_id: 1, document: { file_id: `fid-${name}` } };
    });
    try {
      await vh.queueVideoHandoff(p.id);
      await vh.settleBackgroundHandoffDispatches();
    } finally {
      tg.sendDocumentFile.mockImplementation(async (_c: string, _f: unknown, name: string) => ({ message_id: 1, document: { file_id: `fid-${name}` } }));
    }
    const [row] = await deliveries(p);
    expect(row).toMatchObject({ status: "FAILED" });
    expect(row!.lastError).toContain("передайте вручную");
  });

  it("повтор только на 429 и только когда просят подождать не дольше минуты; другие ошибки — без повтора", async () => {
    const waits: number[] = [];
    const wait = async (ms: number) => { waits.push(ms); };
    let n = 0;
    expect(await retryTelegramRateLimit(async () => { if (n++ < 2) throw new TelegramApiError(429, "x", "slow", { retry_after: 3 }); return "ok"; }, wait)).toBe("ok");
    expect(waits).toEqual([4000, 4000]);
    n = 0;
    await expect(retryTelegramRateLimit(async () => { n++; throw new TelegramApiError(429, "x", "slow", { retry_after: 3 }); }, wait)).rejects.toThrow("slow");
    expect(n).toBe(3); // две попытки повтора, не больше
    n = 0;
    await expect(retryTelegramRateLimit(async () => { n++; throw new TelegramApiError(429, "x", "flood", { retry_after: 600 }); }, wait)).rejects.toThrow("flood");
    // Ожидание с новой попыткой не влезает в бюджет файла (сторож зависших счёл бы живую отправку зависшей) — без повтора.
    n = 0;
    await expect(retryTelegramRateLimit(async () => { n++; throw new TelegramApiError(429, "x", "busy", { retry_after: 30 }); }, wait)).rejects.toThrow("busy");
    expect(n).toBe(1);
    n = 0;
    await expect(retryTelegramRateLimit(async () => { n++; throw new Error("timeout"); }, wait)).rejects.toThrow("timeout");
    expect(n).toBe(1);
    n = 0;
    await expect(retryTelegramRateLimit(async () => { n++; throw new TelegramApiError(400, "x", "Bad Request"); }, wait)).rejects.toThrow("Bad Request");
    expect(n).toBe(1);
  });
});

describe("ручная передача с исходниками — аварийный путь, видео не ждёт", () => {
  it("видео не дошло: только голос — отказ с подсказкой; с исходниками — готовится и уходит", async () => {
    const p = await seedProperty("вручную", { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date(), videoHandoffDeliveredAt: null });
    const v = await approvedVoice(p);
    await expect(prepareNarrationDeliveryPlan(p.id, v.id, "AUDIO_ONLY")).rejects.toThrow(NARRATION_WAITS_FOR_VIDEO_TEXT);
    expect(NARRATION_WAITS_FOR_VIDEO_TEXT).toContain("вместе с исходниками");
    const { editorId, plan } = await prepareNarrationDeliveryPlan(p.id, v.id, "WITH_SOURCES");
    const row = await prisma.propertyNarrationDelivery.create({ data: { propertyId: p.id, versionId: v.id, editorId, mode: "WITH_SOURCES", requestKey: randomUUID(), createdById: approverId,
      plan, status: "QUEUED", executionMode: "LIVE" } });
    expect(await executeNarrationDelivery(row.id)).toEqual({ status: "SENT" });
    expect(sendsFor(p).voice).toHaveLength(1);
  });
});

describe("ждущая передача и прежняя выдача", () => {
  it("голос этой версии уходил в ПРЕЖНЕЙ выдаче — ждущую передачу не гасим, она уходит за новым видео", async () => {
    const p = await seedProperty("ждёт", { videoHandoffStatus: "QUEUED", videoHandoffSentAt: new Date(), videoHandoffQueueOrder: 1 });
    const v = await approvedVoice(p);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);
    await prisma.propertyNarrationDelivery.create({ data: { propertyId: p.id, versionId: v.id, editorId: montajerId, mode: "AUDIO_ONLY", requestKey: `old:${v.id}`,
      createdById: approverId, status: "SENT", executionMode: "LIVE", createdAt: dayAgo, deliveredAt: dayAgo } });
    // План ждущей передачи обход всё равно пересоберёт свежим, когда видео дойдёт.
    const waiting = await prisma.propertyNarrationDelivery.create({ data: { propertyId: p.id, versionId: v.id, editorId: montajerId, mode: "AUDIO_ONLY", requestKey: `wait:${v.id}`,
      createdById: approverId, plan: { factsHash: v.factsHash, recipientHash: "x", sourcesHash: "x", files: [{ id: v.id, storageKey: v.storageKey!, filename: "v.mp3", caption: "c" }] }, status: "WAITING", executionMode: "LIVE" } });
    // Видео выдано без крючка (крючок ставит свою передачу и гасит ждущую — здесь проверяется сам обход ждущих).
    vh.setVideoIssuedToMontajerHook(null);
    try {
      await vh.queueVideoHandoff(p.id);
      await vh.settleBackgroundHandoffDispatches();
    } finally { vh.setVideoIssuedToMontajerHook(narrationAfterVideoIssued); }
    await runNarrationAutoFlow({});
    expect((await prisma.propertyNarrationDelivery.findUniqueOrThrow({ where: { id: waiting.id } })).status).not.toBe("CANCELLED");
    await executeQueuedNarrationDeliveries();
    expect(sendsFor(p).voice).toHaveLength(1);
    expect((await prisma.propertyNarrationDelivery.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe("SENT");
  });
});

describe("крючок поставлен в обоих процессах", () => {
  it("index.ts и worker.ts регистрируют setVideoIssuedToMontajerHook (не поставлен — голос ждёт обхода минуту)", async () => {
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    for (const file of ["../src/index.ts", "../src/worker.ts"]) {
      const src = strip(await fs.readFile(new URL(file, import.meta.url), "utf8"));
      expect(src.split("setVideoIssuedToMontajerHook(narrationAfterVideoIssued)").length - 1, file).toBe(1);
    }
  });
});
