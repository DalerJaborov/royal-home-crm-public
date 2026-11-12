import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

/**
 * ПРАВКИ ПО НЕЗАВИСИМОМУ РЕВЬЮ (12.11.2026). Настоящий Postgres и ffmpeg; Telegram и пуши
 * подменены, ElevenLabs не вызывается.
 *  1 — догоняющий проход: только мастер CRM/Шабнам и очередь монтажа, не заявки с сайта;
 *  2 — старые озвучки (без цены в фактах) не «устаревают» от одного поля цены;
 *  4 — потолок символов считает итоговый текст (цифры словами);
 *  5 — «Нужен монтаж» по вышедшему ролику идёт через ту же дверь прав, что кнопка;
 *  6 — после видео без объекта обычный текст идёт обычным путём; пересланное видео не трогаем;
 *  7 — файл не той длины после «Пришлю без голоса» — вопрос кнопками, а не молчаливый приём;
 *  8 — у старой ручной озвучки монтажёру не обещаем mp3;
 *  9 — замок на сведение ролика; 10 — курсор обхода; рубильник роликов от сотрудников.
 */
const tg = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  sendMessageWithButtons: vi.fn(async () => ({ message_id: 2 })),
  answerCallbackQuery: vi.fn(async () => ({})),
  file: null as Buffer | null,
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage: tg.sendMessage, sendMessageWithButtons: tg.sendMessageWithButtons, answerCallbackQuery: tg.answerCallbackQuery, isTelegramEnabled: () => true,
  resolveTelegramFileMaterialization: vi.fn(async () => (tg.file ? { kind: "buffer", buffer: tg.file } : null)),
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 0), sendPushToAgents: vi.fn(async () => 0),
}));

const ffmpegReady = spawnSync(process.env.FFMPEG_BIN || "ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

const { prisma } = await import("../src/db.js");
const { narrationFacts, narrationHash, narrationFactsCurrent } = await import("../src/lib/propertyNarration.js");
const { refreshNarrationDrafts, remixFromMaster, setNarrationSweepBatchForTests, resetNarrationSweepCursorsForTests } = await import("../src/lib/narrationAutoFlow.js");
const { narrationBudgetUsage, speechChars } = await import("../src/lib/narrationGeneration.js");
const { narrationLineForMontajer } = await import("../src/lib/narrationMontajerNote.js");
const { handleStaffClipMessage, handleStaffClipCallback, handleStaffClipText } = await import("../src/telegram/staffClip.js");
const { handleMontajerVideo, handleVoicelessCopyCallback } = await import("../src/telegram/montajerReceive.js");
const { videoHandoffDir } = await import("../src/upload.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");
const { narrationSpeechText } = await import("@royal-home/shared");

const runId = Date.now();
const tail = runId.toString().slice(-6);
const tmp = path.join(os.tmpdir(), `narration-review-${runId}`);
const media = { music: path.join(tmp, "music.mp4"), long: path.join(tmp, "long.mp4") };
const CONFIG = { modelId: "eleven_v4", voices: [{ id: "voiceA", name: "А" }], templates: [{ id: "ru-r", name: "Р", lang: "ru" as const, text: "В продаже {вид}. Площадь {площадь} метров. Цена {цена}." }], autoGenerate: true };
let districtId: string, agentId: string, editorId: string;
const agentChat = `-6${tail}1`, editorChat = `-6${tail}2`;
const propertyIds: string[] = [];
let settingsBefore: { propertyNarrationConfig: unknown; videoHandoffEnabled: boolean; videoMontajerAgentId: string | null; staffClipIntakeEnabled: boolean } | null = null;
const modeBefore = process.env.CRM_NARRATION_EXECUTION_MODE;

function ff(args: string[]) {
  const r = spawnSync(process.env.FFMPEG_BIN || "ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: "ignore" });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}`);
}
async function seedProperty(data: Record<string, unknown> = {}) {
  const p = await prisma.property.create({ data: { title: `Ревью озвучки-${runId}`, type: "APARTMENT", areaSqm: 70, price: 70000, currency: "USD", districtId,
    address: `Сино, ${propertyIds.length + 1}`, condition: "GOOD", status: "EDITING", assignedAgentId: agentId, ...data }, include: { district: true } });
  propertyIds.push(p.id);
  return p;
}
/** Версия, сделанная ДО цены в фактах (11.11.2026): снимок без price, хэш без цены. */
async function seedOldVersion(propertyId: string, extra: Record<string, unknown> = {}) {
  const p = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, include: { district: true } });
  const { price: _p, currency: _c, ...old } = narrationFacts(p);
  return prisma.propertyNarrationVersion.create({ data: { propertyId, revision: 1, script: "Старая ручная озвучка без цены.", factsSnapshot: old, factsHash: narrationHash(old),
    voiceId: "voiceA", modelId: "eleven_v4", status: "READY", storageKey: `${propertyId}/${randomUUID()}.mp3`, createdById: agentId, requestKey: randomUUID(), source: "MANUAL", ...extra } });
}

beforeAll(async () => {
  await fs.mkdir(tmp, { recursive: true });
  if (ffmpegReady) {
    ff(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=6", "-f", "lavfi", "-i", "sine=frequency=300:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", media.music]);
    ff(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=10", "-f", "lavfi", "-i", "sine=frequency=200:duration=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", media.long]);
  }
  districtId = (await prisma.district.create({ data: { name: `Ревью озвучки-${runId}` } })).id;
  const hash = await bcrypt.hash("testpass123", 4);
  agentId = (await prisma.agent.create({ data: { fullName: "Агент Ревью", phone: `+99292${tail}1`, role: "AGENT", passwordHash: hash, telegramChatId: agentChat } })).id;
  editorId = (await prisma.agent.create({ data: { fullName: "Монтажёр Ревью", phone: `+99292${tail}2`, role: "EDITOR", passwordHash: hash, telegramChatId: editorChat } })).id;
  settingsBefore = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { propertyNarrationConfig: true, videoHandoffEnabled: true, videoMontajerAgentId: true, staffClipIntakeEnabled: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: CONFIG, videoHandoffEnabled: true, videoMontajerAgentId: editorId, staffClipIntakeEnabled: true } });
});
beforeEach(() => { vi.clearAllMocks(); tg.file = null; resetNarrationSweepCursorsForTests(); setNarrationSweepBatchForTests({}); });
afterAll(async () => {
  process.env.CRM_NARRATION_EXECUTION_MODE = modeBefore;
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: { ...settingsBefore, propertyNarrationConfig: (settingsBefore.propertyNarrationConfig ?? {}) as object } }).catch(() => {});
  await prisma.staffClipIntake.deleteMany({ where: { agentId } });
  await prisma.telegramDialogState.deleteMany({ where: { chatId: { in: [agentChat, editorChat] } } });
  const props = await prisma.property.findMany({ where: { id: { in: propertyIds } }, select: { videoHandoffFinalPath: true } });
  for (const p of props) if (p.videoHandoffFinalPath) await fs.rm(path.join(videoHandoffDir, path.basename(p.videoHandoffFinalPath)), { force: true });
  for (const id of propertyIds) await fs.rm(path.dirname(localVideoFilePath(`${id}/${randomUUID()}.mp4`)!), { recursive: true, force: true });
  await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.videoRemakeRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, editorId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("ревью 12.11.2026", () => {
  it("1: догоняющий проход не трогает заявку с сайта; мастер и очередь монтажа — да", async () => {
    const site = await seedProperty();
    const wizard = await seedProperty({ createdInCrmWizard: true });
    const queued = await seedProperty({ videoHandoffStatus: "QUEUED", videoHandoffQueueOrder: 900 });
    await refreshNarrationDrafts(CONFIG, new Date());
    const counts = await Promise.all([site, wizard, queued].map((p) => prisma.propertyNarrationVersion.count({ where: { propertyId: p.id } })));
    expect(counts).toEqual([0, 1, 1]);
    await prisma.property.deleteMany({ where: { id: queued.id } });
  });

  it("2: старая озвучка без цены в снимке не устаревает от цены; смена площади — устаревает", async () => {
    const p = await seedProperty();
    const v = await seedOldVersion(p.id);
    expect(narrationFactsCurrent(v, p)).toBe(true);
    await refreshNarrationDrafts(CONFIG, new Date());
    expect(await prisma.propertyNarrationVersion.count({ where: { propertyId: p.id } })).toBe(1);
    const changed = await prisma.property.update({ where: { id: p.id }, data: { areaSqm: 71 }, include: { district: true } });
    expect(narrationFactsCurrent(v, changed)).toBe(false);
    // Новая версия (с ценой в снимке) сравнивается по полному хэшу: смена цены — расхождение.
    const facts = narrationFacts(changed);
    const fresh = { factsHash: narrationHash(facts), factsSnapshot: facts };
    expect(narrationFactsCurrent(fresh, { ...changed, price: 99000 as never })).toBe(false);
  });

  it("4: потолок символов считает то, что уйдёт в синтез (таджикские цифры словами)", async () => {
    const p = await seedProperty();
    const script = "Хонаи 3 ҳуҷра, 80 метри мураббаъ.";
    expect(speechChars(script, "tg")).toBe(narrationSpeechText(script, "tg").length);
    expect(speechChars(script, "tg")).toBeGreaterThan(script.length);
    const before = await narrationBudgetUsage();
    await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script, factsSnapshot: {}, factsHash: "x", status: "READY", createdById: agentId,
      requestKey: randomUUID(), source: "AUTO", language: "tg", generationStartedAt: new Date() } });
    const after = await narrationBudgetUsage();
    expect(after.usedChars - before.usedChars).toBe(narrationSpeechText(script, "tg").length);
  });

  it("8: у старой ручной озвучки монтажёру не обещаем mp3", async () => {
    const p = await seedProperty();
    await seedOldVersion(p.id, { approvedAt: new Date() });
    const line = await narrationLineForMontajer(p.id);
    expect(line).toContain("маркетинг");
    expect(line).not.toContain("mp3");
  });

  it("9: пока ролик смешивается, второй запуск ничего не делает; брошенная метка снимается", async () => {
    process.env.CRM_NARRATION_EXECUTION_MODE = "LIVE";
    const busySince = new Date();
    const p = await seedProperty({ videoMasterMixingAt: busySince, videoMasterStorageKey: "x/y.mp4", videoHandoffStatus: "RECEIVED" });
    expect(await remixFromMaster(p.id)).toBe("SKIPPED");
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).videoMasterMixingAt?.getTime()).toBe(busySince.getTime());
    await prisma.property.update({ where: { id: p.id }, data: { videoMasterMixingAt: new Date(Date.now() - 20 * 60_000) } });
    await remixFromMaster(p.id);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).videoMasterMixingAt).toBeNull();
    process.env.CRM_NARRATION_EXECUTION_MODE = modeBefore;
  });

  it("10: обход фактов идёт курсором — объект за пределом порции проверяется следующим тиком", async () => {
    setNarrationSweepBatchForTests({ facts: 1 });
    const a = await seedProperty(); const b = await seedProperty();
    for (const p of [a, b]) {
      const facts = narrationFacts(p);
      await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script: "Озвучка.", factsSnapshot: facts, factsHash: "stale", status: "READY", createdById: agentId, requestKey: randomUUID(), source: "AUTO", voiceId: "voiceA", modelId: "eleven_v4" } });
    }
    // Порция в один объект: за несколько тиков устаревшие версии получают новые у обоих объектов.
    for (let i = 0; i < 400 && (await prisma.propertyNarrationVersion.count({ where: { propertyId: { in: [a.id, b.id] }, revision: 2 } })) < 2; i++) {
      await refreshNarrationDrafts(CONFIG, new Date());
    }
    expect(await prisma.propertyNarrationVersion.count({ where: { propertyId: { in: [a.id, b.id] }, revision: 2 } })).toBe(2);
  });
});

describe("ролик от сотрудника: ревью", () => {
  const msg = (extra: Record<string, unknown>) => ({ message_id: 20, chat: { id: Number(agentChat), type: "private" }, from: { id: Number(agentChat) }, ...extra }) as never;
  const agent = () => ({ id: agentId, fullName: "Агент Ревью" });
  it("рубильник выключен и пересланное видео — не наши; обычный текст закрывает ожидание", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { staffClipIntakeEnabled: false } });
    expect(await handleStaffClipMessage(msg({ document: { file_id: "a", file_unique_id: `r1-${runId}`, file_name: "c.mp4", mime_type: "video/mp4" } }), agent())).toBe(false);
    await prisma.settings.update({ where: { id: "singleton" }, data: { staffClipIntakeEnabled: true } });
    expect(await handleStaffClipMessage(msg({ forward_origin: { type: "user" }, document: { file_id: "a", file_unique_id: `r2-${runId}`, file_name: "c.mp4", mime_type: "video/mp4" } }), agent())).toBe(false);
    expect(await handleStaffClipMessage(msg({ document: { file_id: "a", file_unique_id: `r3-${runId}`, file_name: "c.mp4", mime_type: "video/mp4" } }), agent())).toBe(true);
    const intake = await prisma.staffClipIntake.findFirstOrThrow({ where: { fileUniqueId: `r3-${runId}` } });
    expect(intake.status).toBe("ASKING");
    expect(await handleStaffClipText(msg({ text: "Шабнам, сколько клиентов сегодня?" }), agent())).toBe(false);
    expect((await prisma.staffClipIntake.findUniqueOrThrow({ where: { id: intake.id } })).status).toBe("CANCELLED");
  });
  it("5: «Нужен монтаж» по вышедшему ролику без права снимать посты — отказ той же двери, перемонтажа нет", async () => {
    const p = await seedProperty({ videoHandoffStatus: "RECEIVED", videoHandoffFinalPath: "/uploads/handoff/x.mp4", publishedChannels: ["FACEBOOK"] });
    tg.file = Buffer.from("source");
    await handleStaffClipMessage(msg({ caption: `№${p.shortId}`, document: { file_id: "m", file_unique_id: `r5-${runId}`, file_name: "s.mp4", mime_type: "video/mp4" } }), agent());
    const intake = await prisma.staffClipIntake.findFirstOrThrow({ where: { fileUniqueId: `r5-${runId}` } });
    await handleStaffClipCallback({ id: randomUUID(), data: `clip:m:${intake.id}`, from: { id: Number(agentChat) }, message: { message_id: 21, chat: { id: Number(agentChat), type: "private" } } } as never);
    expect(await prisma.videoRemakeRequest.count({ where: { propertyId: p.id } })).toBe(0);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).videoHandoffStatus).toBe("RECEIVED");
    expect(tg.sendMessage.mock.calls.concat(tg.sendMessageWithButtons.mock.calls as never).some((c) => String(c[1]).includes("Недостаточно прав"))).toBe(true);
  });
});

describe.skipIf(!ffmpegReady)("7: «Пришлю без голоса», а длина другая — спрашиваем кнопками", () => {
  it("вопрос вместо молчаливого приёма; «это без голоса» — мастер сохраняется", async () => {
    const finalName = `${randomUUID()}.mp4`;
    await fs.copyFile(media.music, path.join(videoHandoffDir, finalName));
    const p = await seedProperty({ videoHandoffStatus: "RECEIVED", videoHandoffFinalPath: `/uploads/handoff/${finalName}` });
    const facts = narrationFacts(p);
    const v = await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script: "Озвучка.", factsSnapshot: facts, factsHash: narrationHash(facts), status: "READY", approvedAt: new Date(), createdById: agentId, requestKey: randomUUID(), source: "AUTO" } });
    await prisma.propertyNarrationDelivery.create({ data: { propertyId: p.id, versionId: v.id, mode: "AUDIO_ONLY", status: "SENT", requestKey: randomUUID(), createdById: agentId, plan: { files: [] }, executionMode: "LIVE", deliveredAt: new Date() } });
    await handleVoicelessCopyCallback(editorChat, editorId, `mj:nv:${p.shortId}`);
    tg.file = await fs.readFile(media.long);
    const input = { chatId: editorChat, agentId: editorId, updateId: 777, fileId: "long", filename: "video.mp4", caption: null };
    await handleMontajerVideo(input);
    const asked = tg.sendMessageWithButtons.mock.calls.find((c) => JSON.stringify(c[2]).includes("mj:nvc:v:777"));
    expect(asked).toBeTruthy();
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).videoMasterStorageKey).toBeNull();
    await handleVoicelessCopyCallback(editorChat, editorId, "mj:nvc:v:777");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.videoMasterStorageKey).toBeTruthy();
    expect(after.videoMasterNarrationVersionId).toBe(v.id);
    expect(after.videoHandoffFinalPath).toBe(`/uploads/handoff/${finalName}`);
  });
});
