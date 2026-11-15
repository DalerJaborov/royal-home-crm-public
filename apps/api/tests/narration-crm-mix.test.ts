import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { waitFor } from "./helpers/waitFor.js";

/**
 * ЗВУК И ОПИСАНИЕ МЕНЯЮТСЯ БЕЗ МОНТАЖЁРА (11.11.2026, решение владельца). База, файлы и
 * ffmpeg — настоящие; Telegram, пуши и соцсети подменены, ElevenLabs не вызывается вовсе.
 *  — монтажёру сказали «пришлите без голоса» → принятый ролик становится мастером, CRM
 *    накладывает одобренную озвучку сама;
 *  — новая одобренная озвучка → перемикс из мастера, замена вышедшего ролика через тот же
 *    VideoRemakeRequest (replaceOldPostsOnPublish), повтор тика ничего не делает;
 *  — отказ ffmpeg → понятная ошибка на объекте и ErrorLog, вышедший ролик прежний;
 *  — без указания монтажёру старый путь: ролик без звука не принимается;
 *  — шаблон и голос те же → новая версия одобряется сама; другой голос или ручной текст — нет.
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

const ffmpegReady = spawnSync(process.env.FFMPEG_BIN || "ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

const { prisma } = await import("../src/db.js");
const { receiveEditedVideoFromFile, videoHandoffPublishDedupeKey } = await import("../src/lib/videoHandoff.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");
const { probeMediaInfo } = await import("../src/lib/ffmpeg.js");
const { mixNarrationOntoMaster } = await import("../src/lib/narrationMix.js");
const { remixFromMaster, afterNarrationApproved, autoApproveSameChoice } = await import("../src/lib/narrationAutoFlow.js");
const { narrationFacts, narrationHash } = await import("../src/lib/propertyNarration.js");
const { narrationDraftText } = await import("@royal-home/shared");
const { videoHandoffDir } = await import("../src/upload.js");

const runId = Date.now();
const phone = `+99293${runId.toString().slice(-7)}`;
const tmp = path.join(os.tmpdir(), `narration-mix-${runId}`);
const media = { silent: path.join(tmp, "silent.mp4"), music: path.join(tmp, "music.mp4"), voice: path.join(tmp, "voice.mp3"), longVoice: path.join(tmp, "long.mp3") };
let districtId: string;
let agentId: string;
let configBefore: unknown = null;
const propertyIds: string[] = [];
const modeBefore = process.env.CRM_NARRATION_EXECUTION_MODE;
const template = { id: "ru-mix-test", name: "Тест", lang: "ru" as const, text: "В продаже {вид}. Площадь {площадь} метров. Цена {цена}." };
const config = { modelId: "eleven_v4", voices: [{ id: "voiceA", name: "А" }, { id: "voiceB", name: "Б" }], templates: [template], autoGenerate: true };

function ff(args: string[]) {
  const r = spawnSync(process.env.FFMPEG_BIN || "ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: "ignore" });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}`);
}

async function seedProperty(data: Record<string, unknown> = {}) {
  const p = await prisma.property.create({ data: { title: `Озвучка CRM-${runId}`, type: "APARTMENT", areaSqm: 62, price: 60000, currency: "USD", districtId,
    address: "Сино, 1", condition: "GOOD", status: "EDITING", assignedAgentId: agentId, ...data }, include: { district: true } });
  propertyIds.push(p.id);
  return p;
}

/** Готовая одобренная версия озвучки с настоящим mp3 в закрытом хранилище. */
async function seedVersion(propertyId: string, revision: number, file: string, extra: Record<string, unknown> = {}) {
  const p = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, include: { district: true } });
  const id = randomUUID();
  const storageKey = `${propertyId}/${id}.mp3`;
  const dest = localVideoFilePath(storageKey)!;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(file, dest);
  const facts = narrationFacts(p);
  return prisma.propertyNarrationVersion.create({ data: { id, propertyId, revision, script: "Текст озвучки для проверки.", factsSnapshot: facts, factsHash: narrationHash(facts),
    voiceId: "voiceA", modelId: "eleven_v4", status: "READY", storageKey, approvedAt: new Date(), approvedById: agentId, createdById: agentId, requestKey: randomUUID(), source: "AUTO", ...extra } });
}

async function toldMontajer(propertyId: string, versionId: string) {
  await prisma.propertyNarrationDelivery.create({ data: { propertyId, versionId, editorId: null, mode: "AUDIO_ONLY", status: "SENT", requestKey: randomUUID(), createdById: agentId,
    plan: { factsHash: "x", recipientHash: "y", files: [{ id: versionId, storageKey: "k", filename: "f.mp3", caption: "c" }], sourcesHash: "z", mixByCrm: true }, executionMode: "LIVE", deliveredAt: new Date() } });
}

async function copyToTmp(src: string) {
  const dest = path.join(tmp, `${randomUUID()}.mp4`);
  await fs.copyFile(src, dest);
  return dest;
}

const diskOf = (publicPath: string) => path.join(videoHandoffDir, path.basename(publicPath));
const exists = (p: string) => fs.access(p).then(() => true, () => false);

beforeAll(async () => {
  if (!ffmpegReady) return;
  await fs.mkdir(tmp, { recursive: true });
  ff(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", media.silent]);
  ff(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=6", "-f", "lavfi", "-i", "sine=frequency=300:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", media.music]);
  ff(["-f", "lavfi", "-i", "sine=frequency=800:duration=3", "-c:a", "libmp3lame", media.voice]);
  ff(["-f", "lavfi", "-i", "sine=frequency=500:duration=9", "-c:a", "libmp3lame", media.longVoice]);
  districtId = (await prisma.district.create({ data: { name: `Озвучка CRM-${runId}` } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: "Агент озвучки", phone, role: "AGENT", passwordHash: await bcrypt.hash("testpass123", 4) } })).id;
  // С 12.11.2026 по умолчанию голос вклеивает монтажёр: этот файл проверяет порядок «голос кладёт
  // CRM», поэтому рубильник включается явно и возвращается после прогона.
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { propertyNarrationConfig: true } });
  configBefore = settings?.propertyNarrationConfig ?? null;
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", propertyNarrationConfig: { mixByCrm: true } },
    update: { propertyNarrationConfig: { ...((configBefore as Record<string, unknown> | null) ?? {}), mixByCrm: true } } });
});

afterAll(async () => {
  process.env.CRM_NARRATION_EXECUTION_MODE = modeBefore;
  if (ffmpegReady) await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: (configBefore ?? {}) as object } }).catch(() => {});
  if (!ffmpegReady) return;
  const props = await prisma.property.findMany({ where: { id: { in: propertyIds } }, select: { videoHandoffFinalPath: true, videoMasterStorageKey: true } });
  for (const p of props) {
    if (p.videoHandoffFinalPath) await fs.rm(diskOf(p.videoHandoffFinalPath), { force: true });
  }
  for (const id of propertyIds) await fs.rm(path.dirname(localVideoFilePath(`${id}/${randomUUID()}.mp3`)!), { recursive: true, force: true });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: propertyIds.map(videoHandoffPublishDedupeKey) } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { phone } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await fs.rm(tmp, { recursive: true, force: true });
});

describe.skipIf(!ffmpegReady)("CRM сама накладывает озвучку (11.11.2026)", () => {
  it("сведение: голос поверх, длина ролика прежняя; озвучка длиннее ролика — отказ, а не обрезка", async () => {
    const out = path.join(tmp, "mixed.mp4");
    const ok = await mixNarrationOntoMaster({ masterPath: media.music, voicePath: media.voice, outPath: out });
    expect(ok.ok).toBe(true);
    const info = await probeMediaInfo(out);
    expect(info?.hasVideo && info.hasAudio).toBe(true);
    expect(Math.abs((info?.durationSec ?? 0) - 6)).toBeLessThan(0.3);
    const silentOk = await mixNarrationOntoMaster({ masterPath: media.silent, voicePath: media.voice, outPath: path.join(tmp, "mixed2.mp4") });
    expect(silentOk.ok).toBe(true);
    const long = await mixNarrationOntoMaster({ masterPath: media.silent, voicePath: media.longVoice, outPath: path.join(tmp, "mixed3.mp4") });
    expect(long).toMatchObject({ ok: false, code: "VOICE_LONGER" });
    expect(await exists(path.join(tmp, "mixed3.mp4"))).toBe(false);
  });

  it("музыка не мешает голосу (замер 14.11.2026): под голосом музыка глубоко тише, после голоса возвращается; тихий mp3 не ломает приглушение", async () => {
    // Музыка — низкий тон 120 Гц (громко), «голос» — 2 кГц, нарочно тихий (≈ −30 dBFS), 4 с с паузами.
    // Частоты разные: после сведения музыку меряем фильтром ниже 300 Гц по секундам.
    const master = path.join(tmp, "loud-music.mp4"), voice = path.join(tmp, "quiet-voice.mp3"), out = path.join(tmp, "ducked.mp4");
    ff(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=8", "-f", "lavfi", "-i", "sine=frequency=120:duration=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", master]);
    ff(["-f", "lavfi", "-i", "sine=frequency=2000:duration=4", "-af", "volume='if(lt(mod(t,1),0.8),0.045,0)':eval=frame", "-c:a", "libmp3lame", voice]);
    expect((await mixNarrationOntoMaster({ masterPath: master, voicePath: voice, outPath: out })).ok).toBe(true);
    const r = spawnSync(process.env.FFMPEG_BIN || "ffmpeg", ["-hide_banner", "-nostats", "-i", out, "-af",
      "lowpass=f=300,lowpass=f=300,aformat=channel_layouts=mono,asetnsamples=48000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
      "-f", "null", "-"], { encoding: "utf8" });
    const perSecond = [...r.stdout.matchAll(/RMS_level=(-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(perSecond.length).toBeGreaterThanOrEqual(7);
    const underVoice = Math.max(perSecond[1], perSecond[2], perSecond[3]); // голос звучит с 0,3 до 4,3 с
    const afterVoice = Math.min(perSecond[6], perSecond[7]);               // release 800 мс давно прошёл
    expect(afterVoice - underVoice).toBeGreaterThan(12);
  });

  it("монтажёру не говорили «без голоса» — прежний путь: ролик без звука не принимается, с музыкой принимается без мастера", async () => {
    const p = await seedProperty({ videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() });
    await seedVersion(p.id, 1, media.voice);
    const silent = await receiveEditedVideoFromFile(p.id, await copyToTmp(media.silent), "final.mp4");
    expect(silent).toMatchObject({ ok: false });
    expect(!silent.ok && silent.error).toContain("нет звуковой дорожки");
    const withMusic = await receiveEditedVideoFromFile(p.id, await copyToTmp(media.music), "final.mp4");
    expect(withMusic.ok).toBe(true);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.videoMasterStorageKey).toBeNull();
    expect(withMusic.ok && withMusic.narrationMixedRevision).toBeFalsy();
  });

  it("ролик без голоса → мастер, CRM накладывает одобренную озвучку; новая озвучка → перемикс и замена постов, повтор тика пуст", async () => {
    process.env.CRM_NARRATION_EXECUTION_MODE = "LIVE";
    const p = await seedProperty({ videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() });
    const v1 = await seedVersion(p.id, 1, media.voice);
    await toldMontajer(p.id, v1.id);

    const received = await receiveEditedVideoFromFile(p.id, await copyToTmp(media.silent), "bez-golosa.mp4");
    expect(received).toMatchObject({ ok: true, narrationMixedRevision: 1 });
    const accepted = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(accepted.videoHandoffStatus).toBe("RECEIVED");
    expect(accepted.videoMasterNarrationVersionId).toBe(v1.id);
    expect(await exists(localVideoFilePath(accepted.videoMasterStorageKey!)!)).toBe(true);
    const firstFinal = diskOf(accepted.videoHandoffFinalPath!);
    expect((await probeMediaInfo(firstFinal))?.hasAudio).toBe(true);

    // Ролик вышел; потом цена поменялась — новая версия одобрена (агентом или сама).
    await prisma.property.update({ where: { id: p.id }, data: { publishedChannels: ["FACEBOOK"], price: 65000 } });
    const v2 = await seedVersion(p.id, 2, media.voice);
    expect(await afterNarrationApproved(p.id, v2.id)).toBe("CRM_REMIX");

    expect(await remixFromMaster(p.id)).toBe("REMIXED");
    const remixed = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(remixed.videoMasterNarrationVersionId).toBe(v2.id);
    expect(remixed.videoHandoffFinalPath).not.toBe(accepted.videoHandoffFinalPath);
    expect(await exists(firstFinal)).toBe(false);
    expect((await probeMediaInfo(diskOf(remixed.videoHandoffFinalPath!)))?.hasAudio).toBe(true);
    const requests = await prisma.videoRemakeRequest.findMany({ where: { propertyId: p.id } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ reason: "NARRATION_CHANGED", replaceOldPostsOnPublish: true, oldPostsReplacedAt: null });
    // Монтажёру ничего: объект не уходил в очередь монтажа.
    expect(remixed.videoHandoffStatus).toBe("RECEIVED");

    // Повтор тика: та же версия уже наложена — ни нового файла, ни второй заявки.
    expect(await remixFromMaster(p.id)).toBe("SKIPPED");
    expect(await prisma.videoRemakeRequest.count({ where: { propertyId: p.id } })).toBe(1);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).videoHandoffFinalPath).toBe(remixed.videoHandoffFinalPath);
  });

  it("ffmpeg не справился — ошибка на объекте и в журнале, вышедший ролик прежний, повтора каждую минуту нет", async () => {
    process.env.CRM_NARRATION_EXECUTION_MODE = "LIVE";
    const p = await seedProperty({ videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() });
    const v1 = await seedVersion(p.id, 1, media.voice);
    await toldMontajer(p.id, v1.id);
    expect((await receiveEditedVideoFromFile(p.id, await copyToTmp(media.silent), "bez-golosa.mp4")).ok).toBe(true);
    const before = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    const v2 = await seedVersion(p.id, 2, media.longVoice);

    expect(await remixFromMaster(p.id)).toBe("FAILED");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.videoHandoffFinalPath).toBe(before.videoHandoffFinalPath);
    expect(after.videoMasterMixErrorVersionId).toBe(v2.id);
    expect(after.videoMasterMixError).toContain("длиннее ролика");
    await waitFor(() => prisma.errorLog.findFirst({ where: { source: "video-handoff", message: { contains: `Объект №${p.shortId}: новая озвучка (версия 2) не наложена` } } }));
    expect(await remixFromMaster(p.id)).toBe("SKIPPED");
    expect(await prisma.videoRemakeRequest.count({ where: { propertyId: p.id } })).toBe(0);
  });

  it("на приёме озвучка длиннее ролика — ролик не принят, объект ждёт, монтажёру понятная причина", async () => {
    const p = await seedProperty({ videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() });
    const v1 = await seedVersion(p.id, 1, media.longVoice);
    await toldMontajer(p.id, v1.id);
    const result = await receiveEditedVideoFromFile(p.id, await copyToTmp(media.silent), "short.mp4");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("длиннее ролика");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(after.videoMasterStorageKey).toBeNull();
  });

  it("самоодобрение: тот же шаблон и голос — да; другой голос или текст, поправленный руками, — на одобрение агенту", async () => {
    const p = await seedProperty({ videoHandoffStatus: "NONE" });
    const render = async () => {
      const cur = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, include: { district: true } });
      return { facts: narrationFacts(cur), text: narrationDraftText(config, narrationFacts(cur), template.id).text };
    };
    const first = await render();
    await seedVersion(p.id, 1, media.voice, { templateId: template.id, script: first.text, factsSnapshot: first.facts, factsHash: narrationHash(first.facts), source: "WIZARD" });
    await prisma.property.update({ where: { id: p.id }, data: { price: 70000 } });
    const second = await render();
    const fresh = (rev: number, extra: Record<string, unknown> = {}) => seedVersion(p.id, rev, media.voice, { templateId: template.id, script: second.text, factsSnapshot: second.facts,
      factsHash: narrationHash(second.facts), approvedAt: null, approvedById: null, ...extra });

    const otherVoice = await fresh(2, { voiceId: "voiceB" });
    expect(await autoApproveSameChoice(otherVoice.id, config)).toBeNull();
    const same = await fresh(3);
    expect(await autoApproveSameChoice(same.id, config)).toEqual({ approvedById: agentId });
    const row = await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: same.id } });
    expect(row.approvedAt).not.toBeNull();
    expect(row.approvalNotifiedAt).not.toBeNull();

    // Агент когда-то правил текст руками: новая версия по шаблону его правку теряет — пусть слушает сам.
    const q = await seedProperty({ videoHandoffStatus: "NONE" });
    const cur = await prisma.property.findUniqueOrThrow({ where: { id: q.id }, include: { district: true } });
    const facts = narrationFacts(cur);
    await seedVersion(q.id, 1, media.voice, { templateId: template.id, script: "Свой текст агента про квартиру.", factsSnapshot: facts, factsHash: narrationHash(facts) });
    await prisma.property.update({ where: { id: q.id }, data: { price: 71000 } });
    const curNew = await prisma.property.findUniqueOrThrow({ where: { id: q.id }, include: { district: true } });
    const newFacts = narrationFacts(curNew);
    const next = await seedVersion(q.id, 2, media.voice, { templateId: template.id, script: narrationDraftText(config, newFacts, template.id).text, factsSnapshot: newFacts,
      factsHash: narrationHash(newFacts), approvedAt: null, approvedById: null });
    expect(await autoApproveSameChoice(next.id, config)).toBeNull();
  });
});
