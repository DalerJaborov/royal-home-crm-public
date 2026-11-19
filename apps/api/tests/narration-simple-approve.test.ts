import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

/**
 * ОДНО УТВЕРЖДЕНИЕ ОЗВУЧКИ (18.11.2026, владелец: «поменял, послушал, утвердил — ролик сразу уходит»). База, файлы и
 * ffmpeg — настоящие; Telegram и пуши подменены, ElevenLabs не зовётся вовсе.
 *  — вышедший ролик + утверждённая озвучка → перемикс сразу подменяет ролик (кандидата нет), заявка на замену постов
 *    NARRATION_CHANGED, время выпуска — очередью новой озвучки (сразу / утром);
 *  — вышедший ролик: озвучка без человека не утверждается (autoApproveSameChoice), не вышедший — как раньше;
 *  — кандидаты, оставшиеся от «прослушать перед выпуском», убираются, их версия снова ждёт человека;
 *  — «Без озвучки» во время сведения — подмены нет.
 */
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage: vi.fn(async () => {}),
  sendDocumentFile: vi.fn(async () => ({})),
  sendDocument: vi.fn(async () => ({})),
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 0),
  sendPushToAgents: vi.fn(async () => 0),
}));

// ElevenLabs не зовётся никогда: синтез подменён готовым звуком.
const tts = vi.hoisted(() => ({ audio: vi.fn(async () => ({ status: "READY" as const, audio: Buffer.from("synthetic"), requestId: "test-request" })) }));
vi.mock("../src/lib/propertyNarration.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/propertyNarration.js")>()),
  generateNarrationAudio: tts.audio,
}));

const ffmpegReady = spawnSync(process.env.FFMPEG_BIN || "ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

const { prisma } = await import("../src/db.js");
const { receiveEditedVideoFromFile, videoHandoffPublishDedupeKey } = await import("../src/lib/videoHandoff.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");
const { approveNarrationVersion, autoApproveSameChoice, remixFromMaster, runNarrationAutoFlow } = await import("../src/lib/narrationAutoFlow.js");
const { clearLeftoverNarrationPreviews, placeMixedClip } = await import("../src/lib/narrationPreview.js");
const { setPropertyNarrationOff } = await import("../src/lib/narrationOptOut.js");
const { narrationFacts, narrationHash } = await import("../src/lib/propertyNarration.js");
const { videoHandoffDir } = await import("../src/upload.js");

const runId = Date.now();
const phone = `+99294${runId.toString().slice(-7)}`;
const tmp = path.join(os.tmpdir(), `narration-preview-${runId}`);
const media = { silent: path.join(tmp, "silent.mp4"), voice: path.join(tmp, "voice.mp3") };
let districtId: string;
let agentId: string;
let configBefore: unknown = null;
let hoursBefore = 3;
const propertyIds: string[] = [];
const modeBefore = process.env.CRM_NARRATION_EXECUTION_MODE;

function ff(args: string[]) {
  const r = spawnSync(process.env.FFMPEG_BIN || "ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: "ignore" });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}`);
}
const TEMPLATE = { id: "t1", name: "Т", lang: "ru" as const, text: "Квартира, {площадь} квадратных метров. Цена {цена}." };
async function setConfig() {
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: { ...((configBefore as Record<string, unknown> | null) ?? {}), mixByCrm: true,
    modelId: "eleven_v4", voices: [{ id: "voiceA", name: "А" }], templates: [TEMPLATE], previewBeforeRepublish: true } } });
}
async function seedProperty() {
  const p = await prisma.property.create({ data: { title: `Прослушать-${runId}`, type: "APARTMENT", areaSqm: 62, price: 60000, currency: "USD", districtId,
    address: "Сино, 1", condition: "GOOD", status: "EDITING", assignedAgentId: agentId, videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() } });
  propertyIds.push(p.id);
  return p;
}
async function seedVersion(propertyId: string, revision: number) {
  const p = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, include: { district: true } });
  const id = randomUUID();
  const storageKey = `${propertyId}/${id}.mp3`;
  const dest = localVideoFilePath(storageKey)!;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(media.voice, dest);
  const facts = narrationFacts(p);
  return prisma.propertyNarrationVersion.create({ data: { id, propertyId, revision, script: "Текст озвучки для проверки.", factsSnapshot: facts, factsHash: narrationHash(facts),
    voiceId: "voiceA", modelId: "eleven_v4", status: "READY", storageKey, approvedAt: new Date(), approvedById: agentId, createdById: agentId, requestKey: randomUUID(), source: "AUTO" } });
}
async function toldMontajer(propertyId: string, versionId: string) {
  await prisma.propertyNarrationDelivery.create({ data: { propertyId, versionId, editorId: null, mode: "AUDIO_ONLY", status: "SENT", requestKey: randomUUID(), createdById: agentId,
    plan: { factsHash: "x", recipientHash: "y", files: [{ id: versionId, storageKey: "k", filename: "f.mp3", caption: "c" }], sourcesHash: "z", mixByCrm: true }, executionMode: "LIVE", deliveredAt: new Date() } });
}
const diskOf = (publicPath: string) => path.join(videoHandoffDir, path.basename(publicPath));
const exists = (p: string) => fs.access(p).then(() => true, () => false);

/** Ролик принят от монтажёра без голоса (мастер), CRM наложила v1; ролик вышел (или нет); цена поменялась — v2 одобрена. */
async function publishedWithNewVoice(published = true) {
  const p = await seedProperty();
  const v1 = await seedVersion(p.id, 1);
  await toldMontajer(p.id, v1.id);
  const copy = path.join(tmp, `${randomUUID()}.mp4`);
  await fs.copyFile(media.silent, copy);
  expect((await receiveEditedVideoFromFile(p.id, copy, "bez-golosa.mp4")).ok).toBe(true);
  await prisma.property.update({ where: { id: p.id }, data: { ...(published ? { publishedChannels: ["FACEBOOK"] } : {}), price: 65000, clipReviewStatus: "NONE" } });
  const before = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
  const v2 = await seedVersion(p.id, 2);
  return { p, v1, v2, oldFinal: before.videoHandoffFinalPath! };
}

beforeAll(async () => {
  if (!ffmpegReady) return;
  await fs.mkdir(tmp, { recursive: true });
  ff(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", media.silent]);
  ff(["-f", "lavfi", "-i", "sine=frequency=800:duration=3", "-c:a", "libmp3lame", media.voice]);
  districtId = (await prisma.district.create({ data: { name: `Прослушать-${runId}` } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: "Агент прослушивания", phone, role: "AGENT", passwordHash: await bcrypt.hash("testpass123", 4) } })).id;
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {}, select: { propertyNarrationConfig: true, clipOwnerAutoPublishHours: true } });
  configBefore = settings.propertyNarrationConfig ?? null;
  hoursBefore = settings.clipOwnerAutoPublishHours;
  await prisma.settings.update({ where: { id: "singleton" }, data: { clipOwnerAutoPublishHours: 3 } });
  await setConfig();
  process.env.CRM_NARRATION_EXECUTION_MODE = "LIVE";
}, 120_000);

afterAll(async () => {
  process.env.CRM_NARRATION_EXECUTION_MODE = modeBefore;
  if (!ffmpegReady) return;
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: (configBefore ?? {}) as object, clipOwnerAutoPublishHours: hoursBefore } }).catch(() => {});
  const props = await prisma.property.findMany({ where: { id: { in: propertyIds } }, select: { videoHandoffFinalPath: true, narrationPreviewPath: true } });
  for (const p of props) for (const f of [p.videoHandoffFinalPath, p.narrationPreviewPath]) if (f) await fs.rm(diskOf(f), { force: true });
  for (const id of propertyIds) await fs.rm(path.dirname(localVideoFilePath(`${id}/${randomUUID()}.mp3`)!), { recursive: true, force: true });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: propertyIds.map(videoHandoffPublishDedupeKey) } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } }).catch(() => {});
  await prisma.district.deleteMany({ where: { id: districtId } }).catch(() => {});
  await fs.rm(tmp, { recursive: true, force: true });
});

const NARRATION_REASONS = /ролик выходит сразу|выйдет утром|Перед ним в очереди/;

describe.skipIf(!ffmpegReady)("одно утверждение озвучки (18.11.2026)", { timeout: 60_000 }, () => {
  it("вышедший ролик + утверждённая озвучка: подмена сразу, без кандидата; заявка на замену постов; время — очередью новой озвучки", async () => {
    const { p, v2, oldFinal } = await publishedWithNewVoice();
    expect(await remixFromMaster(p.id)).toBe("REMIXED");
    const row = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.videoMasterNarrationVersionId).toBe(v2.id);
    expect(row.videoHandoffFinalPath).not.toBe(oldFinal);
    expect(row.narrationPreviewPath).toBeNull();
    expect(await exists(diskOf(row.videoHandoffFinalPath!))).toBe(true);
    expect(await exists(diskOf(oldFinal))).toBe(false);
    const remake = await prisma.videoRemakeRequest.findFirstOrThrow({ where: { propertyId: p.id } });
    expect(remake).toMatchObject({ reason: "NARRATION_CHANGED", replaceOldPostsOnPublish: true, oldPostsReplacedAt: null });
    // Замер длины голоса записан: основа оценки «укладывается ли текст» до оплаты.
    expect((await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: v2.id } })).audioSec).toBeGreaterThan(2);
    // Время ставится очередью новой озвучки (автопубликация может быть выключена в тестовой базе — тогда времени нет).
    if (row.scheduledPublishAt) {
      expect(row.scheduledPublishReason).toMatch(NARRATION_REASONS);
      expect(row.scheduledPublishAt.getTime() - Date.now()).toBeLessThan(20 * 3_600_000);
    }
    // Повтор тика ничего не сводит заново.
    expect(await remixFromMaster(p.id)).toBe("SKIPPED");
  });

  it("ролик ещё не вышел — подмена сразу, заявки на замену постов нет", async () => {
    const notOut = await publishedWithNewVoice(false);
    expect(await remixFromMaster(notOut.p.id)).toBe("REMIXED");
    expect(await prisma.videoRemakeRequest.count({ where: { propertyId: notOut.p.id } })).toBe(0);
  });

  it("вышедший ролик: новая озвучка без человека не утверждается; не вышедший — сама, как раньше", async () => {
    const { config } = await (await import("../src/lib/narrationGeneration.js")).loadNarrationConfiguration();
    const { narrationDraftText } = await import("@royal-home/shared");
    for (const published of [true, false]) {
      const p = await seedProperty();
      await prisma.property.update({ where: { id: p.id }, data: { videoHandoffStatus: "RECEIVED", ...(published ? { publishedChannels: ["FACEBOOK"] } : {}) } });
      const fresh = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, include: { district: true } });
      const facts = narrationFacts(fresh);
      const prevFacts = { ...facts, price: "55000" };
      await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script: narrationDraftText(config, prevFacts, "t1", null).text, factsSnapshot: prevFacts,
        factsHash: narrationHash(prevFacts), voiceId: "voiceA", modelId: "eleven_v4", templateId: "t1", status: "READY", approvedAt: new Date(), approvedById: agentId, createdById: agentId,
        requestKey: randomUUID(), source: "WIZARD" } });
      const v2 = await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 2, script: narrationDraftText(config, facts, "t1", null).text, factsSnapshot: facts,
        factsHash: narrationHash(facts), voiceId: "voiceA", modelId: "eleven_v4", templateId: "t1", status: "READY", storageKey: `${p.id}/x.mp3`, createdById: agentId,
        requestKey: randomUUID(), source: "AUTO" } });
      const auto = await autoApproveSameChoice(v2.id, config);
      expect(auto === null).toBe(published);
      expect(!!(await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: v2.id } })).approvedAt).toBe(!published);
    }
  });

  it("кандидат, оставшийся от «прослушать перед выпуском» (или заведённый старым worker в окне выката), убирается: файл удалён, версия снова ждёт человека; повтор ничего не делает", async () => {
    const { p, v2, oldFinal } = await publishedWithNewVoice();
    const leftover = `/uploads/handoff/leftover-${randomUUID()}.mp4`;
    await fs.copyFile(media.silent, diskOf(leftover));
    const cur = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    await prisma.property.update({ where: { id: p.id }, data: { narrationPreviewPath: leftover, narrationPreviewVersionId: v2.id, narrationPreviewMasterKey: cur.videoMasterStorageKey,
      narrationPreviewAt: new Date(), narrationPreviewDueAt: new Date(Date.now() - 60_000) } });
    expect(await clearLeftoverNarrationPreviews()).toBeGreaterThanOrEqual(1);
    const row = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.narrationPreviewPath).toBeNull();
    expect(row.narrationPreviewVersionId).toBeNull();
    expect(row.videoHandoffFinalPath).toBe(oldFinal);
    expect(await exists(diskOf(leftover))).toBe(false);
    expect((await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: v2.id } })).approvedAt).toBeNull();
    expect(await remixFromMaster(p.id)).toBe("SKIPPED");
    expect(await clearLeftoverNarrationPreviews()).toBe(0);
  });

  it("«Без озвучки» во время сведения — подмены нет, вышедший ролик цел", async () => {
    const b = await publishedWithNewVoice();
    const cur = await prisma.property.findUniqueOrThrow({ where: { id: b.p.id } });
    await prisma.property.update({ where: { id: b.p.id }, data: { narrationOff: true } });
    const placed = await placeMixedClip({ propertyId: b.p.id, publicPath: "/uploads/handoff/x.mp4", masterKey: cur.videoMasterStorageKey!, seenVersionId: cur.videoMasterNarrationVersionId,
      versionId: b.v2.id, revision: 2, requestedById: agentId });
    expect(placed).toEqual({ kind: "SKIPPED" });
    const after = await prisma.property.findUniqueOrThrow({ where: { id: b.p.id } });
    expect(after.videoHandoffFinalPath).toBe(b.oldFinal);
  });
  it("«Оставить старый», нажатый до выката, держит версию: обход её не сводит", async () => {
    const { p, v2 } = await publishedWithNewVoice();
    await prisma.property.update({ where: { id: p.id }, data: { narrationPreviewDeclinedVersionId: v2.id } });
    expect(await remixFromMaster(p.id)).toBe("SKIPPED");
  });

  it("кнопка маркетинга: ролик вышел — аудио по утверждённому тексту ждёт утверждения после прослушивания; утверждает маркетинг", async () => {
    const { generateNarrationVersion, loadNarrationConfiguration } = await import("../src/lib/narrationGeneration.js");
    const { config } = await loadNarrationConfiguration();
    const p = await seedProperty();
    await prisma.property.update({ where: { id: p.id }, data: { videoHandoffStatus: "RECEIVED", publishedChannels: ["FACEBOOK"] } });
    const fresh = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, include: { district: true } });
    const facts = narrationFacts(fresh);
    const v = await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script: "Квартира, звоните нам.", factsSnapshot: facts, factsHash: narrationHash(facts),
      voiceId: "voiceA", modelId: "eleven_v4", status: "DRAFT", approvedAt: new Date(), approvedById: agentId, createdById: agentId, requestKey: randomUUID(), source: "MANUAL" } });
    const out = await generateNarrationVersion({ propertyId: p.id, versionId: v.id, expectedRevision: 1, requireApproval: true, config, key: "test-key-not-real" });
    expect(out.status).toBe("READY");
    const after = await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: v.id } });
    expect(after.status).toBe("READY");
    expect(after.approvedAt).toBeNull();
    // Обход без утверждения ничего не выпускает.
    expect(await remixFromMaster(p.id)).toBe("SKIPPED");
    // Агенту — обычное одно сообщение «готово, послушайте», и утверждает он с теми же правами (ревью 18.11).
    const notify = vi.fn(async () => {});
    await runNarrationAutoFlow({ notifyAgent: notify });
    expect(notify).toHaveBeenCalledWith(v.id);
    await runNarrationAutoFlow({ notifyAgent: notify });
    expect(notify.mock.calls.filter((c) => (c as unknown[])[0] === v.id)).toHaveLength(1);
    expect(await approveNarrationVersion({ propertyId: p.id, versionId: v.id, expectedRevision: 1, actorId: agentId, isManager: false })).toBe("AUDIO_APPROVED");
  });
  it("постоянный сторож (окно выката): кандидат и самоодобрение на вышедшем ролике не сводятся; утверждение человека их выпускает", async () => {
    const a = await publishedWithNewVoice();
    await prisma.propertyNarrationVersion.update({ where: { id: a.v2.id }, data: { approvalNotifiedAt: (await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: a.v2.id } })).approvedAt } });
    expect(await remixFromMaster(a.p.id)).toBe("SKIPPED");
    expect(await approveNarrationVersion({ propertyId: a.p.id, versionId: a.v2.id, expectedRevision: 2, actorId: agentId, isManager: false })).toBe("AUDIO_APPROVED");
    expect(await remixFromMaster(a.p.id)).toBe("REMIXED");

    const b = await publishedWithNewVoice();
    await prisma.property.update({ where: { id: b.p.id }, data: { narrationPreviewVersionId: b.v2.id } });
    expect(await remixFromMaster(b.p.id)).toBe("SKIPPED");
  });

  it("уже утверждённая версия с отметкой «Оставить старый»: утверждение снимает отметку, ролик не застревает", async () => {
    const { p, v2 } = await publishedWithNewVoice();
    await prisma.property.update({ where: { id: p.id }, data: { narrationPreviewDeclinedVersionId: v2.id } });
    expect(await approveNarrationVersion({ propertyId: p.id, versionId: v2.id, expectedRevision: 2, actorId: agentId, isManager: false })).toBe("AUDIO_APPROVED");
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).narrationPreviewDeclinedVersionId).toBeNull();
    expect(await remixFromMaster(p.id)).toBe("REMIXED");
  });
  it("аудио маркетинга на НЕвышедшем ролике: агенту ни сообщения, ни напоминания (он не может его утвердить)", async () => {
    const p = await seedProperty();
    await prisma.property.update({ where: { id: p.id }, data: { videoHandoffStatus: "RECEIVED" } });
    const fresh = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, include: { district: true } });
    const facts = narrationFacts(fresh);
    const v = await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script: "Квартира, звоните нам.", factsSnapshot: facts, factsHash: narrationHash(facts),
      voiceId: "voiceA", modelId: "eleven_v4", status: "READY", storageKey: `${p.id}/m.mp3`, createdById: agentId, requestKey: randomUUID(), source: "MANUAL" } });
    const notify = vi.fn(async () => {});
    await runNarrationAutoFlow({ notifyAgent: notify });
    expect(notify.mock.calls.filter((c) => (c as unknown[])[0] === v.id)).toHaveLength(0);
  });
});
