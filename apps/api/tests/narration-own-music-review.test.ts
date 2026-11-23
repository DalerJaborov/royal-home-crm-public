import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

/**
 * СВОЯ МУЗЫКА И ТЕКСТ НА РОЛИКЕ: находки слепого ревью 18.11.2026. Каждая проверка краснеет без своей починки.
 *  — чистая картинка ролика монтажёра (MUSIC_BASE): второй перемонтаж не рисует плашку поверх прежней,
 *    файл монтажёра не теряется;
 *  — своя музыка не справилась — новая цена уходит монтажёру;
 *  — своя музыка подхватывает только озвучки, одобренные после включения;
 *  — мастер машины (MACHINE) не используется;
 *  — тяжёлый перемонтаж — один объект за тик.
 * База, файлы и ffmpeg настоящие; ElevenLabs не зовётся.
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

const FF = process.env.FFMPEG_BIN || "ffmpeg";
const ffmpegReady = spawnSync(FF, ["-version"], { stdio: "ignore" }).status === 0;
const drawtextReady = ffmpegReady && /drawtext/u.test(spawnSync(FF, ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout ?? "");

const { prisma } = await import("../src/db.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");
const { probeMediaInfo } = await import("../src/lib/ffmpeg.js");
const music = await import("../src/lib/narrationMusic.js");
const { afterNarrationApproved, remixFromMaster, remixFromMasters, resetNarrationSweepCursorsForTests } = await import("../src/lib/narrationAutoFlow.js");
const { storeNarrationMaster } = await import("../src/lib/narrationMaster.js");
const { narrationFacts, narrationHash } = await import("../src/lib/propertyNarration.js");
const { videoHandoffDir } = await import("../src/upload.js");
const { ownMusicRemixSinceAfterSave } = await import("@royal-home/shared");

const runId = Date.now();
const phone = `+99292${runId.toString().slice(-7)}`;
const tmp = path.join(os.tmpdir(), `narration-music-review-${runId}`);
const media = { clip: path.join(tmp, "clip.mp4"), voice: path.join(tmp, "voice.mp3"), track: path.join(tmp, "a.mp3") };
let districtId: string;
let agentId: string;
let configBefore: unknown = null;
const propertyIds: string[] = [];
const envMode = process.env.CRM_NARRATION_EXECUTION_MODE;
const SINCE = "2020-01-01T00:00:00.000Z";
const baseConfig = { modelId: "eleven_v4", voices: [{ id: "voiceA", name: "А" }], autoGenerate: true, previewBeforeRepublish: false, ownMusicRemix: true, ownMusicRemixSince: SINCE };

function ff(args: string[]) {
  const r = spawnSync(FF, ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: "ignore" });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}`);
}
const diskOf = (publicPath: string) => path.join(videoHandoffDir, path.basename(publicPath));
const exists = (p: string) => fs.access(p).then(() => true, () => false);
async function setConfig(extra: Record<string, unknown> = {}) {
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: { ...baseConfig, ...extra } } });
}
async function clearLibrary() {
  for (const t of await prisma.narrationMusicTrack.findMany()) await music.deleteNarrationMusicTrack(t.id);
}
async function addTrack() {
  const res = await music.addNarrationMusicTrack({ buffer: await fs.readFile(media.track), title: "А", createdById: agentId });
  if (!res.ok) throw new Error(res.error);
  return res.id;
}
async function seedVersion(propertyId: string, revision: number, approvedAt = new Date()) {
  const p = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, include: { district: true } });
  const id = randomUUID();
  const storageKey = `${propertyId}/${id}.mp3`;
  const dest = localVideoFilePath(storageKey)!;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(media.voice, dest);
  const facts = narrationFacts(p);
  return prisma.propertyNarrationVersion.create({ data: { id, propertyId, revision, script: "Квартира на продажу. Звоните.", factsSnapshot: facts, factsHash: narrationHash(facts),
    voiceId: "voiceA", modelId: "eleven_v4", language: "ru", status: "READY", storageKey, approvedAt, approvedById: agentId, createdById: agentId, requestKey: randomUUID(), source: "AGENT" } });
}
/** Вышедший ролик монтажёра (голос v1 вклеил он), цена в сомони; затем цена поменялась → v2 одобрена. */
async function priceChanged(price: number, opts: { approvedAt?: Date } = {}) {
  const p = await prisma.property.create({ data: { title: `Ревью музыки-${runId}`, type: "APARTMENT", areaSqm: 62, price, currency: "TJS", districtId,
    address: "Сино, 1", condition: "GOOD", status: "AVAILABLE", assignedAgentId: agentId, videoHandoffStatus: "RECEIVED", publishedChannels: ["FACEBOOK"] } });
  propertyIds.push(p.id);
  const name = `${p.id}-${randomUUID()}.mp4`;
  await fs.mkdir(videoHandoffDir, { recursive: true });
  await fs.copyFile(media.clip, path.join(videoHandoffDir, name));
  await prisma.property.update({ where: { id: p.id }, data: { videoHandoffFinalPath: `/uploads/handoff/${name}`, videoHandoffReceivedAt: new Date() } });
  const v1 = await seedVersion(p.id, 1, new Date("2019-06-01T00:00:00Z"));
  await prisma.propertyNarrationDelivery.create({ data: { propertyId: p.id, versionId: v1.id, editorId: null, mode: "AUDIO_ONLY", status: "SENT", requestKey: randomUUID(), createdById: agentId,
    plan: { factsHash: "x", recipientHash: "y", files: [], sourcesHash: "z" }, executionMode: "LIVE", deliveredAt: new Date() } });
  await prisma.property.update({ where: { id: p.id }, data: { price: price + 1 } });
  return { p, v2: await seedVersion(p.id, 2, opts.approvedAt) };
}
/** Цвет пикселя кадра на секунде t (RGB). */
function pixel(file: string, t: number, x: number, y: number): [number, number, number] {
  const r = spawnSync(FF, ["-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", file, "-vf", `crop=2:2:${x}:${y}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1024 });
  const b = r.stdout as Buffer;
  return [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0];
}

beforeAll(async () => {
  if (!ffmpegReady) return;
  await fs.mkdir(tmp, { recursive: true });
  ff(["-f", "lavfi", "-i", "color=c=0x445566:size=320x568:rate=25:duration=6", "-f", "lavfi", "-i", "sine=frequency=1000:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", media.clip]);
  ff(["-f", "lavfi", "-i", "sine=frequency=700:duration=2.5", "-c:a", "libmp3lame", media.voice]);
  ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-c:a", "libmp3lame", media.track]);
  districtId = (await prisma.district.create({ data: { name: `Ревью музыки-${runId}` } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: "Агент ревью", phone, role: "AGENT", passwordHash: await bcrypt.hash("testpass123", 4) } })).id;
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {}, select: { propertyNarrationConfig: true } });
  configBefore = settings.propertyNarrationConfig ?? null;
  process.env.CRM_NARRATION_EXECUTION_MODE = "LIVE";
}, 120_000);
beforeEach(async () => {
  sendBack.mockClear();
  if (!ffmpegReady) return;
  await setConfig();
  await clearLibrary();
});
afterAll(async () => {
  process.env.CRM_NARRATION_EXECUTION_MODE = envMode;
  if (!ffmpegReady) return;
  await clearLibrary();
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: (configBefore ?? {}) as object } }).catch(() => {});
  const props = await prisma.property.findMany({ where: { id: { in: propertyIds } }, select: { videoHandoffFinalPath: true, narrationPreviewPath: true } });
  for (const p of props) for (const f of [p.videoHandoffFinalPath, p.narrationPreviewPath]) if (f) await fs.rm(diskOf(f), { force: true });
  for (const id of propertyIds) await fs.rm(path.dirname(localVideoFilePath(`${id}/${randomUUID()}.mp3`)!), { recursive: true, force: true });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { phone } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("момент включения своей музыки", () => {
  it("включили — сейчас; было включено — прежний; выключили — нет; присланное с экрана не берётся", () => {
    const now = new Date("2026-11-18T10:00:00.000Z");
    expect(ownMusicRemixSinceAfterSave({}, { ownMusicRemix: true }, now)).toBe(now.toISOString());
    expect(ownMusicRemixSinceAfterSave({ ownMusicRemix: true, ownMusicRemixSince: SINCE }, { ownMusicRemix: true }, now)).toBe(SINCE);
    expect(ownMusicRemixSinceAfterSave({ ownMusicRemix: false, ownMusicRemixSince: SINCE }, { ownMusicRemix: true }, now)).toBe(now.toISOString());
    expect(ownMusicRemixSinceAfterSave({ ownMusicRemix: true, ownMusicRemixSince: SINCE }, { ownMusicRemix: false }, now)).toBeUndefined();
  });
});

describe.skipIf(!ffmpegReady)("своя музыка: находки ревью", { timeout: 120_000 }, () => {
  it.skipIf(!drawtextReady)("второй перемонтаж строится из чистой картинки: прежняя плашка с ценой не остаётся, файл монтажёра сохранён", async () => {
    await setConfig({ textOverlay: true });
    await addTrack();
    // Цена длинная, потом короткая: при сборке поверх прошлого результата синяя плашка длинной цены торчала бы справа.
    const { p } = await priceChanged(1_234_566);
    expect(await remixFromMaster(p.id)).toBe("REMIXED");
    const first = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(first.videoMasterSource).toBe("MUSIC_BASE");
    const basePath = localVideoFilePath(first.videoMasterStorageKey!)!;
    expect(await exists(basePath)).toBe(true);
    expect((await probeMediaInfo(basePath))!.hasAudio).toBe(false);
    const plateTail = pixel(diskOf(first.videoHandoffFinalPath!), 5, 140, 66);
    expect(plateTail[2]).toBeGreaterThan(180); // длинная цена: синяя плашка доходит сюда

    await prisma.property.update({ where: { id: p.id }, data: { price: 9_000 } });
    await seedVersion(p.id, 3);
    expect(await remixFromMaster(p.id)).toBe("REMIXED");
    const second = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(second.videoMasterStorageKey).toBe(first.videoMasterStorageKey);
    const out = diskOf(second.videoHandoffFinalPath!);
    expect(await exists(diskOf(first.videoHandoffFinalPath!))).toBe(false);
    // Короткая цена: здесь уже фон ролика (0x445566), а не остаток прежней плашки.
    const [r, , b] = pixel(out, 5, 140, 66);
    expect(b).toBeLessThan(140);
    expect(Math.abs(r - 0x44)).toBeLessThan(25);
  });

  it("своя музыка не справилась (файла трека нет на диске) — новая цена уходит монтажёру", async () => {
    const trackId = await addTrack();
    const row = await prisma.narrationMusicTrack.findUniqueOrThrow({ where: { id: trackId } });
    await fs.rm(localVideoFilePath(row.storageKey)!, { force: true });
    const { p } = await priceChanged(50_000);
    expect(await remixFromMaster(p.id)).toBe("FAILED");
    expect(sendBack).toHaveBeenCalledWith(p.id, agentId, "NARRATION_CHANGED", expect.any(String), null, { removeFromSocial: "on-new-video" });
  });

  it("своя музыка берёт только озвучки, одобренные после включения", async () => {
    await setConfig({ ownMusicRemixSince: new Date(Date.now() + 60_000).toISOString() });
    await addTrack();
    const { p } = await priceChanged(60_000);
    expect(await remixFromMaster(p.id)).toBe("SKIPPED");
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).videoMasterStorageKey).toBeNull();
  });

  it("мастер машины (MACHINE) не используется: своя музыка выключена — CRM ролик не трогает, одобрение уходит монтажёру", async () => {
    await setConfig({ ownMusicRemix: false, ownMusicRemixSince: undefined });
    const { p, v2 } = await priceChanged(70_000);
    const key = await storeNarrationMaster(p.id, media.clip);
    await prisma.property.update({ where: { id: p.id }, data: { videoMasterStorageKey: key, videoMasterSource: "MACHINE" } });
    expect(await remixFromMaster(p.id)).toBe("SKIPPED");
    expect(await afterNarrationApproved(p.id, v2.id)).toBe("SOUND_REMAKE");
  });

  it("тяжёлый перемонтаж — один объект за тик обхода", async () => {
    await addTrack();
    const a = await priceChanged(80_000);
    const b = await priceChanged(81_000);
    resetNarrationSweepCursorsForTests();
    const done = async () => (await prisma.property.findMany({ where: { id: { in: [a.p.id, b.p.id] }, videoMasterSource: "MUSIC_BASE" } })).length;
    for (let tick = 0; tick < 50 && (await done()) === 0; tick++) await remixFromMasters();
    expect(await done()).toBe(1);
    for (let tick = 0; tick < 50 && (await done()) < 2; tick++) await remixFromMasters();
    expect(await done()).toBe(2);
  });
});
