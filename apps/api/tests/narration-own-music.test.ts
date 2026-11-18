import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

/**
 * СВОЯ МУЗЫКА ПРИ ПЕРЕМОНТАЖЕ (18.11.2026, решение владельца). База, файлы и ffmpeg — настоящие, ElevenLabs
 * не зовётся вовсе: «озвучка» — синус 700 Гц, «трек» — синус 440 Гц, звук вышедшего ролика — синус 1000 Гц.
 *  — загрузка: тип по содержимому, предел размера, длина через ffprobe;
 *  — выбор трека: случайный, не тот же подряд;
 *  — подложка: картинка копией, исходный звук не попал, длина = ролик, трек короче ролика зациклен;
 *  — перемонтаж: рубильник ВКЛ + треки → весь звук заменён, голос сверху, музыка под голосом тише;
 *    рубильник ВЫКЛ или библиотека пуста → монтажёру; «прослушать перед выпуском» — кандидат.
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

const { prisma } = await import("../src/db.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");
const { probeMediaInfo } = await import("../src/lib/ffmpeg.js");
const music = await import("../src/lib/narrationMusic.js");
const { afterNarrationApproved, remixFromMaster } = await import("../src/lib/narrationAutoFlow.js");
const { narrationFacts, narrationHash } = await import("../src/lib/propertyNarration.js");
const { videoHandoffDir } = await import("../src/upload.js");

const runId = Date.now();
const phone = `+99293${runId.toString().slice(-7)}`;
const tmp = path.join(os.tmpdir(), `narration-music-${runId}`);
const media = { clip: path.join(tmp, "clip.mp4"), voice: path.join(tmp, "voice.mp3"), trackA: path.join(tmp, "a.mp3"), trackB: path.join(tmp, "b.m4a"), short: path.join(tmp, "short.mp3"), wav: path.join(tmp, "x.wav") };
let districtId: string;
let agentId: string;
let configBefore: unknown = null;
const propertyIds: string[] = [];
const trackIds: string[] = [];
const envMode = process.env.CRM_NARRATION_EXECUTION_MODE;
const baseConfig = { modelId: "eleven_v4", voices: [{ id: "voiceA", name: "А" }], autoGenerate: true, previewBeforeRepublish: false, ownMusicRemix: true, ownMusicRemixSince: "2020-01-01T00:00:00.000Z" };

function ff(args: string[]) {
  const r = spawnSync(FF, ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: "ignore" });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}`);
}
/** Средняя громкость полосы частот (дБ) на отрезке: так видно, чей звук в файле. */
function bandDb(file: string, freq: number, from = 0, to = 999): number {
  const r = spawnSync(FF, ["-hide_banner", "-nostats", "-ss", String(from), "-t", String(to - from), "-i", file, "-af", `bandpass=f=${freq}:width_type=h:w=40,bandpass=f=${freq}:width_type=h:w=40,volumedetect`, "-f", "null", "-"], { encoding: "utf8" });
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/u.exec(r.stderr ?? "");
  return !m || m[1] === "-inf" ? -120 : Number(m[1]);
}
const diskOf = (publicPath: string) => path.join(videoHandoffDir, path.basename(publicPath));

async function setConfig(extra: Record<string, unknown> = {}) {
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: { ...baseConfig, ...extra } } });
}
async function addTrack(file: string, title: string) {
  const res = await music.addNarrationMusicTrack({ buffer: await fs.readFile(file), title, createdById: agentId });
  if (!res.ok) throw new Error(res.error);
  trackIds.push(res.id);
  return res.id;
}
async function clearLibrary() {
  for (const t of await prisma.narrationMusicTrack.findMany()) await music.deleteNarrationMusicTrack(t.id);
  trackIds.length = 0;
}

/** Вышедший ролик (6 с, звук 1000 Гц), голос v1 вклеил монтажёр; цена поменялась → v2 одобрена. Ролика без голоса нет. */
async function priceChanged() {
  const p = await prisma.property.create({ data: { title: `Своя музыка-${runId}`, type: "APARTMENT", areaSqm: 62, price: 60000, currency: "USD", districtId,
    address: "Сино, 1", condition: "GOOD", status: "AVAILABLE", assignedAgentId: agentId, videoHandoffStatus: "RECEIVED", publishedChannels: ["FACEBOOK"] }, include: { district: true } });
  propertyIds.push(p.id);
  const name = `${p.id}-${randomUUID()}.mp4`;
  await fs.mkdir(videoHandoffDir, { recursive: true });
  await fs.copyFile(media.clip, path.join(videoHandoffDir, name));
  await prisma.property.update({ where: { id: p.id }, data: { videoHandoffFinalPath: `/uploads/handoff/${name}`, videoHandoffReceivedAt: new Date() } });
  const v1 = await seedVersion(p.id, 1);
  await prisma.propertyNarrationDelivery.create({ data: { propertyId: p.id, versionId: v1.id, editorId: null, mode: "AUDIO_ONLY", status: "SENT", requestKey: randomUUID(), createdById: agentId,
    plan: { factsHash: "x", recipientHash: "y", files: [], sourcesHash: "z" }, executionMode: "LIVE", deliveredAt: new Date() } });
  return { p, v2: await newPrice(p.id, 65000, 2) };
}
async function newPrice(propertyId: string, price: number, revision: number) {
  await prisma.property.update({ where: { id: propertyId }, data: { price } });
  return seedVersion(propertyId, revision);
}
async function seedVersion(propertyId: string, revision: number) {
  const p = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, include: { district: true } });
  const id = randomUUID();
  const storageKey = `${propertyId}/${id}.mp3`;
  const dest = localVideoFilePath(storageKey)!;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(media.voice, dest);
  const facts = narrationFacts(p);
  return prisma.propertyNarrationVersion.create({ data: { id, propertyId, revision, script: "Квартира на продажу.", factsSnapshot: facts, factsHash: narrationHash(facts),
    voiceId: "voiceA", modelId: "eleven_v4", language: "ru", status: "READY", storageKey, approvedAt: new Date(), approvedById: agentId, createdById: agentId,
    requestKey: randomUUID(), source: "AGENT" } });
}

beforeAll(async () => {
  if (!ffmpegReady) return;
  await fs.mkdir(tmp, { recursive: true });
  ff(["-f", "lavfi", "-i", "color=c=blue:size=320x568:rate=25:duration=6", "-f", "lavfi", "-i", "sine=frequency=1000:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", media.clip]);
  ff(["-f", "lavfi", "-i", "sine=frequency=700:duration=2.5", "-c:a", "libmp3lame", media.voice]);
  ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-c:a", "libmp3lame", media.trackA]);
  // Трек короче ролика (5 с на 6 с): CRM зацикливает.
  ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-c:a", "aac", media.trackB]);
  ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", media.short]);
  ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=6", media.wav]);
  districtId = (await prisma.district.create({ data: { name: `Своя музыка-${runId}` } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: "Агент музыки", phone, role: "AGENT", passwordHash: await bcrypt.hash("testpass123", 4) } })).id;
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

describe("своя музыка: тип файла и выбор трека", () => {
  it("тип — по содержимому: ID3 и кадр MPEG — mp3, ftyp — m4a; wav, картинка и текст — нет", () => {
    expect(music.sniffMusicFormat(Buffer.from("ID3\u0004\u0000\u0000", "latin1"))).toBe("mp3");
    expect(music.sniffMusicFormat(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]))).toBe("mp3");
    expect(music.sniffMusicFormat(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A ", "latin1")]))).toBe("m4a");
    expect(music.sniffMusicFormat(Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVE", "latin1"))).toBeNull();
    expect(music.sniffMusicFormat(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull();
    expect(music.sniffMusicFormat(Buffer.from("hello.mp3", "utf8"))).toBeNull();
  });
  it("случайный трек, не тот же подряд; один трек — он же; пусто — ничего", () => {
    const ids = ["a", "b", "c"];
    for (let i = 0; i < 60; i++) expect(music.pickMusicTrackId(ids, "b")).not.toBe("b");
    expect(new Set(Array.from({ length: 60 }, () => music.pickMusicTrackId(ids, null))).size).toBeGreaterThan(1);
    expect(music.pickMusicTrackId(["a"], "a")).toBe("a");
    expect(music.pickMusicTrackId([], null)).toBeNull();
    expect(music.pickMusicTrackId(ids, "b", () => 0.999)).toBe("c");
  });
});

describe.skipIf(!ffmpegReady)("своя музыка: загрузка и подложка", { timeout: 60_000 }, () => {
  it("загрузка: mp3 и m4a приняты с длиной от ffprobe; wav, «mp3» из текста, короткий и тяжёлый — отказ", async () => {
    const a = await addTrack(media.trackA, "Утро");
    const row = await prisma.narrationMusicTrack.findUniqueOrThrow({ where: { id: a } });
    expect(row).toMatchObject({ title: "Утро", format: "mp3" });
    expect(Math.abs(row.durationSec - 8)).toBeLessThan(0.3);
    expect(await fs.stat(localVideoFilePath(row.storageKey)!)).toBeTruthy();
    expect((await prisma.narrationMusicTrack.findUniqueOrThrow({ where: { id: await addTrack(media.trackB, "Вечер") } })).format).toBe("m4a");
    const reject = async (buffer: Buffer) => music.addNarrationMusicTrack({ buffer, title: "x", createdById: agentId });
    expect(await reject(await fs.readFile(media.wav))).toMatchObject({ ok: false, status: 400 });
    expect(await reject(Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.alloc(4000, 7)]))).toMatchObject({ ok: false, status: 400 });
    expect(await reject(await fs.readFile(media.short))).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("короче") });
    expect(await reject(Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.alloc(15 * 1024 * 1024 + 1)]))).toMatchObject({ ok: false, status: 413 });
    // Отказ не оставляет файлов и записей.
    expect(await prisma.narrationMusicTrack.count()).toBe(2);
    expect(await music.deleteNarrationMusicTrack(a)).toBe(true);
    await expect(fs.stat(localVideoFilePath(row.storageKey)!)).rejects.toThrow();
  });

  it("подложка: длина = ролик, картинка копией, звука ролика нет, трек короче ролика зациклен, в конце затухание", async () => {
    const out = path.join(tmp, "bed.mp4");
    const bed = await music.buildMusicBed({ clipPath: media.clip, trackPath: media.trackB, outPath: out });
    expect(bed.ok).toBe(true);
    const info = (await probeMediaInfo(out))!;
    expect(info.hasVideo && info.hasAudio).toBe(true);
    expect(info.videoCodec).toBe("h264");
    expect(Math.abs(info.durationSec - 6)).toBeLessThan(0.15);
    expect(bandDb(out, 1000)).toBeLessThan(bandDb(out, 440) - 30);
    // Трек 5 с на ролик 6 с: на 5,1–5,3 с музыка идёт (по кругу), а не тишина; последние 0,2 с — затухание.
    expect(bandDb(out, 440, 5.0, 5.3)).toBeGreaterThan(-45);
    expect(bandDb(out, 440, 5.8, 6)).toBeLessThan(bandDb(out, 440, 2, 3) - 6);
  });
});

describe.skipIf(!ffmpegReady)("своя музыка: перемонтаж вышедшего ролика", { timeout: 90_000 }, () => {
  it("рубильник ВКЛ и треки есть: весь звук заменён, голос сверху, музыка под голосом тише; следующий раз — другой трек", async () => {
    const a = await addTrack(media.trackA, "А");
    const b = await addTrack(media.trackB, "Б");
    const { p, v2 } = await priceChanged();
    expect(await afterNarrationApproved(p.id, v2.id)).toBe("CRM_REMIX");
    expect(sendBack).not.toHaveBeenCalled();
    expect(await remixFromMaster(p.id)).toBe("REMIXED");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.videoMasterNarrationVersionId).toBe(v2.id);
    // Чистая картинка ролика монтажёра — основа следующих перемонтажей (ревью 18.11).
    expect(after.videoMasterSource).toBe("MUSIC_BASE");
    expect([a, b]).toContain(after.narrationMusicTrackId);
    const out = diskOf(after.videoHandoffFinalPath!);
    const info = (await probeMediaInfo(out))!;
    expect(Math.abs(info.durationSec - 6)).toBeLessThan(0.3);
    expect(bandDb(out, 1000)).toBeLessThan(-60);
    expect(bandDb(out, 700, 0.5, 2.5)).toBeGreaterThan(-40);
    // Приглушение под голосом (sidechaincompress, lib/narrationMix.ts): музыка во время голоса тише, чем после.
    expect(bandDb(out, 440, 0.8, 2.5)).toBeLessThan(bandDb(out, 440, 3.6, 4.4) - 6);
    expect(await prisma.videoRemakeRequest.count({ where: { propertyId: p.id, reason: "NARRATION_CHANGED" } })).toBe(1);
    // Повтор тика ничего не делает.
    expect(await remixFromMaster(p.id)).toBe("SKIPPED");

    // Снова поменяли цену: трек другой, не тот же подряд.
    const first = after.narrationMusicTrackId;
    const v3 = await newPrice(p.id, 70000, 3);
    expect(await remixFromMaster(p.id)).toBe("REMIXED");
    const again = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(again.videoMasterNarrationVersionId).toBe(v3.id);
    expect(again.narrationMusicTrackId).not.toBe(first);
    expect(bandDb(diskOf(again.videoHandoffFinalPath!), 1000)).toBeLessThan(-60);
  });

  it("рубильник ВЫКЛ или библиотека пуста — объект монтажёру прежним возвратом, CRM ролик не трогает", async () => {
    await setConfig({ ownMusicRemix: false });
    await addTrack(media.trackA, "А");
    const off = await priceChanged();
    expect(await afterNarrationApproved(off.p.id, off.v2.id)).toBe("SOUND_REMAKE");
    expect(await remixFromMaster(off.p.id)).toBe("SKIPPED");
    await setConfig();
    await clearLibrary();
    const empty = await priceChanged();
    expect(await afterNarrationApproved(empty.p.id, empty.v2.id)).toBe("SOUND_REMAKE");
    expect(await remixFromMaster(empty.p.id)).toBe("SKIPPED");
    expect(sendBack).toHaveBeenCalledTimes(2);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: empty.p.id } })).narrationMusicTrackId).toBeNull();
  });

  it("«прослушать перед выпуском» включено: новый ролик — кандидат, вышедший не тронут", async () => {
    await setConfig({ previewBeforeRepublish: true });
    await addTrack(media.trackA, "А");
    const { p } = await priceChanged();
    const before = (await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).videoHandoffFinalPath;
    expect(await remixFromMaster(p.id)).toBe("PREVIEW");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.videoHandoffFinalPath).toBe(before);
    expect(after.narrationPreviewPath).not.toBeNull();
    expect(bandDb(diskOf(after.narrationPreviewPath!), 1000)).toBeLessThan(-60);
    // Ждёт хозяина — следующий тик не сводит заново.
    expect(await remixFromMaster(p.id)).toBe("SKIPPED");
  });
});
