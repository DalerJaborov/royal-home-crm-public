import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

/**
 * ПЕРЕМИКС ВЫШЕДШЕГО РОЛИКА: ДЛИНА ГОЛОСА = ДЛИНА РОЛИКА (16.11.2026). База, файлы и ffmpeg —
 * настоящие; ролик без голоса (мастер) прислал монтажёр. Монтажёрский возврат подменён шпионом.
 *  — длина: (а) ускорение, (б) короче шаблон и одна перегенерация, (в) стоп-кадр, (г) монтажёр;
 *  — две правки цены подряд → одна версия → один перемикс.
 * До 18.11.2026 файл назывался narration-auto-separate.test.ts и проверял ещё машинное отделение
 * голоса (сервис voice-separator); его убрали решением владельца, проверки длины остались здесь.
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
const sendBack = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, queued: false })));
vi.mock("../src/lib/publishedVideoFix.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/publishedVideoFix.js")>()),
  sendBackToMontajer: sendBack,
}));

const ffmpegReady = spawnSync(process.env.FFMPEG_BIN || "ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

const { prisma } = await import("../src/db.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");
const { probeMediaInfo } = await import("../src/lib/ffmpeg.js");
const { planNarrationFit, narrationFitNote, mixNarrationOntoMaster } = await import("../src/lib/narrationMix.js");
const { afterNarrationApproved, approveNarrationVersion, autoApproveSameChoice, narrationMixNoteFor, remixFromMaster, requestAutoNarration } = await import("../src/lib/narrationAutoFlow.js");
const { storeNarrationMaster } = await import("../src/lib/narrationMaster.js");
const { narrationFacts, narrationHash } = await import("../src/lib/propertyNarration.js");
const { narrationDraftText } = await import("@royal-home/shared");
const { videoHandoffDir } = await import("../src/upload.js");

const runId = Date.now();
const phone = `+99294${runId.toString().slice(-7)}`;
const tmp = path.join(os.tmpdir(), `narration-sep-${runId}`);
const media = {
  voiced: path.join(tmp, "voiced.mp4"), silent: path.join(tmp, "silent.mp4"),
  v3: path.join(tmp, "v3.mp3"), v68: path.join(tmp, "v68.mp3"), v9: path.join(tmp, "v9.mp3"), v15: path.join(tmp, "v15.mp3"),
};
let districtId: string;
let agentId: string;
let configBefore: unknown = null;
const propertyIds: string[] = [];
const env = { mode: process.env.CRM_NARRATION_EXECUTION_MODE };
const longT = { id: "ru-sep-long", name: "Длинный", lang: "ru" as const, text: "В продаже {вид}, светлая и тёплая, с хорошим ремонтом и видом на горы. Площадь {площадь} метров. Цена {цена}. Звоните, покажем в любое время." };
const shortT = { id: "ru-sep-short", name: "Короткий", lang: "ru" as const, text: "{вид}, {площадь} метров, {цена}." };
// previewBeforeRepublish: false — здесь проверяется сам перемикс и подмена; «прослушать перед выпуском» — narration-preview.test.ts.
const baseConfig = { modelId: "eleven_v4", voices: [{ id: "voiceA", name: "А" }], templates: [longT, shortT], autoGenerate: true, previewBeforeRepublish: false };

function ff(args: string[]) {
  const r = spawnSync(process.env.FFMPEG_BIN || "ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: "ignore" });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}`);
}
const tone = (sec: number, out: string) => ff(["-f", "lavfi", "-i", `sine=frequency=700:duration=${sec}`, "-c:a", "libmp3lame", out]);
const exists = (p: string) => fs.access(p).then(() => true, () => false);
const diskOf = (publicPath: string) => path.join(videoHandoffDir, path.basename(publicPath));

async function setConfig(extra: Record<string, unknown> = {}) {
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: { ...baseConfig, ...extra } } });
}

/** Вышедший ролик (6 с, музыка+голос) уже лежит готовым; голос в нём вклеил монтажёр (версия 1). */
async function seedPublished(opts: { audio?: boolean } = {}) {
  const p = await prisma.property.create({ data: { title: `Голос CRM-${runId}`, type: "APARTMENT", areaSqm: 62, price: 60000, currency: "USD", districtId,
    address: "Сино, 1", condition: "GOOD", status: "AVAILABLE", assignedAgentId: agentId, videoHandoffStatus: "RECEIVED", publishedChannels: ["FACEBOOK"] }, include: { district: true } });
  propertyIds.push(p.id);
  const name = `${p.id}-${randomUUID()}.mp4`;
  await fs.mkdir(videoHandoffDir, { recursive: true });
  await fs.copyFile(opts.audio === false ? media.silent : media.voiced, path.join(videoHandoffDir, name));
  await prisma.property.update({ where: { id: p.id }, data: { videoHandoffFinalPath: `/uploads/handoff/${name}`, videoHandoffReceivedAt: new Date() } });
  return p;
}

/** Готовая одобренная версия с настоящим mp3. script по умолчанию — длинный шаблон по фактам объекта. */
async function seedVersion(propertyId: string, revision: number, file: string, extra: Record<string, unknown> = {}) {
  const p = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, include: { district: true } });
  const id = randomUUID();
  const storageKey = `${propertyId}/${id}.mp3`;
  const dest = localVideoFilePath(storageKey)!;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(file, dest);
  const facts = narrationFacts(p);
  return prisma.propertyNarrationVersion.create({ data: { id, propertyId, revision, script: narrationDraftText(baseConfig, facts, longT.id).text, factsSnapshot: facts, factsHash: narrationHash(facts),
    voiceId: "voiceA", modelId: "eleven_v4", templateId: longT.id, language: "ru", status: "READY", storageKey, approvedAt: new Date(), approvedById: agentId, createdById: agentId,
    requestKey: randomUUID(), source: "AUTO", ...extra } });
}
async function editorVoiced(propertyId: string, versionId: string) {
  await prisma.propertyNarrationDelivery.create({ data: { propertyId, versionId, editorId: null, mode: "AUDIO_ONLY", status: "SENT", requestKey: randomUUID(), createdById: agentId,
    plan: { factsHash: "x", recipientHash: "y", files: [], sourcesHash: "z" }, executionMode: "LIVE", deliveredAt: new Date() } });
}
/** Объект с вышедшим роликом, где голос v1 вклеил монтажёр, и новой одобренной озвучкой v2. */
async function priceChanged(voice: string, opts: { audio?: boolean; v2?: Record<string, unknown> } = {}) {
  const p = await seedPublished(opts);
  const v1 = await seedVersion(p.id, 1, media.v3);
  await editorVoiced(p.id, v1.id);
  await prisma.property.update({ where: { id: p.id }, data: { price: 65000 } });
  // Ролик без голоса прислал монтажёр (music+звук того же ролика): из него CRM сводит новый.
  const key = await storeNarrationMaster(p.id, media.voiced);
  await prisma.property.update({ where: { id: p.id }, data: { videoMasterStorageKey: key, videoMasterSource: "EDITOR", videoMasterNarrationVersionId: v1.id } });
  const v2 = await seedVersion(p.id, 2, voice, opts.v2);
  return { p, v1, v2 };
}

beforeAll(async () => {
  if (!ffmpegReady) return;
  await fs.mkdir(tmp, { recursive: true });
  ff(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=6", "-f", "lavfi", "-i", "sine=frequency=300:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", media.voiced]);
  ff(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", media.silent]);
  tone(3, media.v3); tone(6.8, media.v68); tone(9, media.v9); tone(15, media.v15);
  districtId = (await prisma.district.create({ data: { name: `Голос CRM-${runId}` } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: "Агент голоса", phone, role: "AGENT", passwordHash: await bcrypt.hash("testpass123", 4) } })).id;
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {}, select: { propertyNarrationConfig: true } });
  configBefore = settings.propertyNarrationConfig ?? null;
  process.env.CRM_NARRATION_EXECUTION_MODE = "LIVE";
}, 120_000);

beforeEach(async () => {
  sendBack.mockClear();
  if (ffmpegReady) await setConfig();
});

afterAll(async () => {
  process.env.CRM_NARRATION_EXECUTION_MODE = env.mode;
  if (!ffmpegReady) return;
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: (configBefore ?? {}) as object } }).catch(() => {});
  const props = await prisma.property.findMany({ where: { id: { in: propertyIds } }, select: { videoHandoffFinalPath: true } });
  for (const p of props) if (p.videoHandoffFinalPath) await fs.rm(diskOf(p.videoHandoffFinalPath), { force: true });
  for (const id of propertyIds) await fs.rm(path.dirname(localVideoFilePath(`${id}/${randomUUID()}.mp3`)!), { recursive: true, force: true });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { phone } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("длина голоса = длина ролика: план (16.11.2026)", () => {
  it("влезает — как есть; до 15 % — ускорение; дальше — стоп-кадр до 3 с; ещё длиннее — нельзя", () => {
    expect(planNarrationFit(5, 25)).toEqual({ tier: "PLAIN", tempo: 1, freezeSec: 0 });
    const speed = planNarrationFit(27, 25);
    expect(speed.tier).toBe("SPEED");
    expect(speed.tempo).toBeGreaterThan(1);
    expect(speed.tempo).toBeLessThanOrEqual(1.15);
    // 25 с ролик, 35 с голос (пример владельца): ускорения мало, стоп-кадр 3 с тоже не спасает.
    expect(planNarrationFit(35, 25).tier).toBe("TOO_LONG");
    const freeze = planNarrationFit(31, 25);
    expect(freeze).toMatchObject({ tier: "FREEZE", tempo: 1.15 });
    expect(freeze.freezeSec).toBeGreaterThan(0);
    expect(freeze.freezeSec).toBeLessThanOrEqual(3);
    expect(planNarrationFit(31, 25, { allowFreeze: false }).tier).toBe("TOO_LONG");
    // Ролик длиннее голоса — норма.
    expect(planNarrationFit(10, 120).tier).toBe("PLAIN");
    expect(narrationFitNote(speed)).toMatch(/ускорила его на \d+%/u);
    expect(narrationFitNote(freeze)).toMatch(/продлила последний кадр/u);
    expect(narrationFitNote({ tier: "PLAIN", tempo: 1, freezeSec: 0 })).toBeNull();
  });
});

// Настоящий ffmpeg (перекодирование со стоп-кадром) на нагруженной машине — до ~20 с на проверку.
describe.skipIf(!ffmpegReady)("перемикс вышедшего ролика из ролика без голоса (16.11.2026)", { timeout: 60_000 }, () => {
  it("сведение со стоп-кадром: ролик длиннее на стоп-кадр, звук и картинка есть; на приёме от монтажёра подгонки нет", async () => {
    const out = path.join(tmp, "freeze.mp4");
    const fitted = await mixNarrationOntoMaster({ masterPath: media.voiced, voicePath: media.v9, outPath: out, fit: { allowFreeze: true } });
    expect(fitted).toMatchObject({ ok: true, fit: { tier: "FREEZE" } });
    const info = await probeMediaInfo(out);
    expect(info?.hasVideo && info.hasAudio).toBe(true);
    expect(info!.durationSec).toBeGreaterThan(6.8);
    expect(info!.durationSec).toBeLessThanOrEqual(9.3);
    expect(await mixNarrationOntoMaster({ masterPath: media.voiced, voicePath: media.v68, outPath: path.join(tmp, "strict.mp4") })).toMatchObject({ ok: false, code: "VOICE_LONGER" });
  });

  it("длина (а): голос длиннее на ~10 % — ускорен, агенту строка в карточке", async () => {
    const { p, v2 } = await priceChanged(media.v68);
    expect(await remixFromMaster(p.id)).toBe("REMIXED");
    const v = await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: v2.id } });
    expect(v.mixNote).toMatch(/ускорила его на \d+%/u);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(Math.abs((await probeMediaInfo(diskOf(after.videoHandoffFinalPath!)))!.durationSec - 6)).toBeLessThan(0.4);
    expect(narrationMixNoteFor(after, v)).toBe(v.mixNote);
  });

  it("длина (б): текст по шаблону — одна перегенерация коротким шаблоном; ролик вышел — её утверждает человек (18.11); укороченную не укорачивают", async () => {
    const { p, v2 } = await priceChanged(media.v9);
    // Сведение просит текст короче — нового ролика пока нет.
    expect(await remixFromMaster(p.id)).toBe("SHORTENING");
    const versions = await prisma.propertyNarrationVersion.findMany({ where: { propertyId: p.id }, orderBy: { revision: "asc" } });
    expect(versions).toHaveLength(3);
    const v3 = versions[2]!;
    expect(v3).toMatchObject({ shortenedFromId: v2.id, templateId: shortT.id, status: "DRAFT", source: "AUTO" });
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).videoMasterMixErrorVersionId).toBe(v2.id);

    // Генерацию (ElevenLabs) изображаем готовым mp3: 9 с — оценка не сбылась, текст всё ещё длинный.
    const storageKey = `${p.id}/${v3.id}.mp3`;
    await fs.copyFile(media.v9, localVideoFilePath(storageKey)!);
    await prisma.propertyNarrationVersion.update({ where: { id: v3.id }, data: { status: "READY", storageKey, generateAfter: null } });
    // Ролик уже вышел (18.11.2026): утверждение = выпуск, поэтому укороченную версию сама CRM не утверждает.
    expect(await autoApproveSameChoice(v3.id, (await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } })).propertyNarrationConfig as never)).toBeNull();
    expect(await approveNarrationVersion({ propertyId: p.id, versionId: v3.id, expectedRevision: v3.revision, actorId: agentId, isManager: false })).toBe("AUDIO_APPROVED");
    expect(await afterNarrationApproved(p.id, v3.id)).toBe("CRM_REMIX");
    // Вторая перегенерация не заказывается: (в) стоп-кадр.
    expect(await remixFromMaster(p.id)).toBe("REMIXED");
    expect(await prisma.propertyNarrationVersion.count({ where: { propertyId: p.id } })).toBe(3);
    const v3after = await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: v3.id } });
    expect(v3after.mixNote).toMatch(/продлила последний кадр/u);
  });

  it("длина (в): текст правлен руками — шаблон не меняем, стоп-кадр; (г) голос 15 с на 6 с — монтажёру", async () => {
    const a = await priceChanged(media.v9, { v2: { script: "Текст агента своими словами, длинный и подробный, про квартиру и район." } });
    expect(await remixFromMaster(a.p.id)).toBe("REMIXED");
    expect(await prisma.propertyNarrationVersion.count({ where: { propertyId: a.p.id } })).toBe(2);
    expect((await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: a.v2.id } })).mixNote).toMatch(/последний кадр/u);

    const b = await priceChanged(media.v15, { v2: { script: "Другой ручной текст агента." } });
    expect(await remixFromMaster(b.p.id)).toBe("FAILED");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: b.p.id } });
    expect(after.videoMasterMixErrorVersionId).toBe(b.v2.id);
    expect(after.videoMasterMixError).toContain("длиннее ролика");
    expect(sendBack).toHaveBeenCalledWith(b.p.id, agentId, "NARRATION_CHANGED", expect.stringContaining("длиннее ролика"), null, { removeFromSocial: "on-new-video" });
  });

  it("идемпотентность: две правки цены подряд — одна новая версия, один перемикс", async () => {
    await setConfig({ debounceMinutes: 3 });
    const p = await seedPublished();
    const v1 = await seedVersion(p.id, 1, media.v3);
    await editorVoiced(p.id, v1.id);
    const key = await storeNarrationMaster(p.id, media.voiced);
    await prisma.property.update({ where: { id: p.id }, data: { videoMasterStorageKey: key, videoMasterSource: "EDITOR", videoMasterNarrationVersionId: v1.id } });
    await prisma.property.update({ where: { id: p.id }, data: { price: 61000 } });
    const first = await requestAutoNarration({ propertyId: p.id, actorId: agentId, source: "AUTO" });
    await prisma.property.update({ where: { id: p.id }, data: { price: 62000 } });
    const second = await requestAutoNarration({ propertyId: p.id, actorId: agentId, source: "AUTO" });
    expect(first).toMatchObject({ status: "QUEUED", coalesced: false });
    expect(second).toMatchObject({ status: "QUEUED", coalesced: true });
    expect(second.status === "QUEUED" && first.status === "QUEUED" && second.versionId === first.versionId).toBe(true);
    expect(await prisma.propertyNarrationVersion.count({ where: { propertyId: p.id } })).toBe(2);
    // Генерацию изображаем: версия готова и одобрена.
    const vid = first.status === "QUEUED" ? first.versionId : "";
    const storageKey = `${p.id}/${vid}.mp3`;
    await fs.copyFile(media.v3, localVideoFilePath(storageKey)!);
    await prisma.propertyNarrationVersion.update({ where: { id: vid }, data: { status: "READY", storageKey, approvedAt: new Date(), approvedById: agentId, generateAfter: null } });
    expect(await afterNarrationApproved(p.id, vid)).toBe("CRM_REMIX");
    expect(await afterNarrationApproved(p.id, vid)).toBe("CRM_REMIX");
    const [x, y] = await Promise.all([remixFromMaster(p.id), remixFromMaster(p.id)]);
    expect([x, y].filter((r) => r === "REMIXED")).toHaveLength(1);
    expect(await remixFromMaster(p.id)).toBe("SKIPPED");
    expect(await prisma.videoRemakeRequest.count({ where: { propertyId: p.id } })).toBe(1);
  });
});
