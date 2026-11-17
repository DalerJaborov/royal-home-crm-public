import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { waitFor } from "./helpers/waitFor.js";

/**
 * НОВАЯ ОЗВУЧКА НА ВЫШЕДШИЙ РОЛИК БЕЗ МОНТАЖЁРА (16.11.2026, решение владельца). База, файлы и
 * ffmpeg — настоящие; сервис отделения голоса (lib/voiceSeparator.ts) подменён: «музыку» он
 * отдаёт синусом, число слов в ней задаёт тест. Монтажёрский возврат подменён шпионом.
 *  — ролика без голоса нет → CRM_SEPARATE → обход делает мастер (MACHINE) и сразу перемикс;
 *  — сторож: в музыке слова → мастер не принят, объект монтажёру, повтора нет;
 *  — отказ сервиса → монтажёру;
 *  — длина: (а) ускорение, (б) короче шаблон и одна перегенерация, (в) стоп-кадр, (г) монтажёр;
 *  — две правки цены подряд → одна версия → одно отделение и один перемикс.
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
const sep = vi.hoisted(() => ({ words: 0, fail: null as string | null, failCode: "FAILED" as "FAILED" | "ABSENT" | "TIMEOUT", calls: 0 }));
vi.mock("../src/lib/voiceSeparator.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/voiceSeparator.js")>();
  const { spawnSync: run } = await import("node:child_process");
  return {
    ...real,
    separateVoice: vi.fn(async (input: { audioPath: string; outPath: string }) => {
      sep.calls++;
      if (sep.fail) return { ok: false as const, code: sep.failCode, error: sep.fail };
      // «Музыка без голоса» той же длины, что звук ролика.
      const r = run(process.env.FFMPEG_BIN || "ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", input.audioPath, "-af", "volume=0.3", "-c:a", "flac", input.outPath], { stdio: "ignore" });
      if (r.status !== 0) return { ok: false as const, code: "FAILED" as const, error: "ffmpeg в подмене" };
      return { ok: true as const, words: sep.words, speechSec: sep.words ? 2 : 0, separateMs: 1000, checkMs: 500, text: sep.words ? "старый голос" : "" };
    }),
  };
});
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
const { afterNarrationApproved, autoApproveSameChoice, remixFromMaster, requestAutoNarration, makeMachineMasterFor: makeMachineMaster, runMachineMastersTick: runMachineMasters } = await import("../src/lib/narrationAutoFlow.js");
const { narrationMixNoteFor } = await import("../src/lib/narrationAutoMaster.js");
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
const env = { mode: process.env.CRM_NARRATION_EXECUTION_MODE, url: process.env.VOICE_SEPARATOR_URL };
const longT = { id: "ru-sep-long", name: "Длинный", lang: "ru" as const, text: "В продаже {вид}, светлая и тёплая, с хорошим ремонтом и видом на горы. Площадь {площадь} метров. Цена {цена}. Звоните, покажем в любое время." };
const shortT = { id: "ru-sep-short", name: "Короткий", lang: "ru" as const, text: "{вид}, {площадь} метров, {цена}." };
const baseConfig = { modelId: "eleven_v4", voices: [{ id: "voiceA", name: "А" }], templates: [longT, shortT], autoGenerate: true };

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
  process.env.VOICE_SEPARATOR_URL = "http://voice-separator.test:8090";
}, 120_000);

beforeEach(async () => {
  sep.words = 0; sep.fail = null; sep.failCode = "FAILED"; sep.calls = 0;
  sendBack.mockClear();
  if (ffmpegReady) await setConfig();
});

afterAll(async () => {
  process.env.CRM_NARRATION_EXECUTION_MODE = env.mode;
  if (env.url === undefined) delete process.env.VOICE_SEPARATOR_URL; else process.env.VOICE_SEPARATOR_URL = env.url;
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
describe.skipIf(!ffmpegReady)("старый голос убирает CRM (16.11.2026)", { timeout: 60_000 }, () => {
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

  it("ролика без голоса нет → CRM_SEPARATE; обход: мастер MACHINE, перемикс, замена постов; повтор пуст", async () => {
    const { p, v1, v2 } = await priceChanged(media.v3);
    expect(await afterNarrationApproved(p.id, v2.id)).toBe("CRM_SEPARATE");
    const before = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(await narrationMixNoteFor(before, v2)).toContain("убирает из ролика старый голос");

    expect(await makeMachineMaster(p.id)).toBe("REMIXED");
    expect(sep.calls).toBe(1);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.videoMasterSource).toBe("MACHINE");
    expect(after.videoMasterNarrationVersionId).toBe(v2.id);
    expect(after.videoHandoffStatus).toBe("RECEIVED");
    expect(after.videoHandoffFinalPath).not.toBe(before.videoHandoffFinalPath);
    expect(await exists(localVideoFilePath(after.videoMasterStorageKey!)!)).toBe(true);
    expect((await probeMediaInfo(diskOf(after.videoHandoffFinalPath!)))?.hasAudio).toBe(true);
    expect(await prisma.videoRemakeRequest.count({ where: { propertyId: p.id, reason: "NARRATION_CHANGED", replaceOldPostsOnPublish: true } })).toBe(1);
    expect(sendBack).not.toHaveBeenCalled();
    void v1;

    // Повтор: мастер уже есть, озвучка наложена — ни второго отделения, ни второй заявки.
    expect(await makeMachineMaster(p.id)).toBe("SKIPPED");
    expect(await remixFromMaster(p.id)).toBe("SKIPPED");
    expect(sep.calls).toBe(1);
    expect(await prisma.videoRemakeRequest.count({ where: { propertyId: p.id } })).toBe(1);
  });

  it("сторож: в музыке остались слова — мастер не принят, объект монтажёру, повтора на этот ролик нет", async () => {
    sep.words = 12;
    const { p, v2 } = await priceChanged(media.v3);
    expect(await makeMachineMaster(p.id)).toBe("FAILED");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.videoMasterStorageKey).toBeNull();
    expect(after.videoMasterAutoError).toContain("12 слов");
    expect(after.videoMasterAutoErrorFinalPath).toBe(after.videoHandoffFinalPath);
    expect(sendBack).toHaveBeenCalledWith(p.id, agentId, "NARRATION_CHANGED", expect.any(String), null, { removeFromSocial: "on-new-video" });
    await waitFor(() => prisma.errorLog.findFirst({ where: { source: "video-handoff", message: { contains: `Объект №${p.shortId}: старый голос из ролика не убран` } } }));
    // Настоящий возврат уводит объект в очередь монтажа (здесь он подменён шпионом).
    expect(await narrationMixNoteFor({ ...after, videoHandoffStatus: "QUEUED" }, v2)).toContain("звук заменит монтажёр");
    expect(await makeMachineMaster(p.id)).toBe("SKIPPED");
    expect(sep.calls).toBe(1);
  });

  it("сервис не ответил — монтажёру; выключатель в Настройках — сразу монтажёру, без отделения", async () => {
    sep.fail = "Сервис отделения голоса недоступен";
    const a = await priceChanged(media.v3);
    // Временный сбой (ревью 16.11): не приговор — повтор через 10 мин, на третий раз монтажёру.
    expect(await makeMachineMaster(a.p.id)).toBe("RETRY");
    expect(await makeMachineMaster(a.p.id)).toBe("SKIPPED");
    expect(sendBack).not.toHaveBeenCalled();
    expect(await makeMachineMaster(a.p.id, new Date(Date.now() + 11 * 60_000))).toBe("RETRY");
    expect(await makeMachineMaster(a.p.id, new Date(Date.now() + 22 * 60_000))).toBe("FAILED");
    expect(sep.calls).toBe(3);
    expect(sendBack).toHaveBeenCalledTimes(1);

    // Не уложился в предел — сразу монтажёру, без повторов.
    sendBack.mockClear();
    sep.failCode = "TIMEOUT";
    const t = await priceChanged(media.v3);
    expect(await makeMachineMaster(t.p.id)).toBe("FAILED");
    expect(sendBack).toHaveBeenCalledTimes(1);

    // Сервиса нет вовсе (прод 17.11, ENOTFOUND): голос вклеивал монтажёр — ему сразу, но БЕЗ отметки отказа.
    sendBack.mockClear();
    sep.failCode = "ABSENT";
    const x = await priceChanged(media.v3);
    expect(await makeMachineMaster(x.p.id)).toBe("RETRY");
    expect(sendBack).toHaveBeenCalledTimes(1);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: x.p.id } })).videoMasterAutoErrorFinalPath).toBeNull();
    sep.failCode = "FAILED";
    expect((await prisma.property.findUniqueOrThrow({ where: { id: a.p.id } })).videoMasterAutoError).toContain("недоступен");

    sendBack.mockClear();
    await setConfig({ autoSeparateVoice: false });
    const b = await priceChanged(media.v3);
    expect(await afterNarrationApproved(b.p.id, b.v2.id)).toBe("SOUND_REMAKE");
    expect(sendBack).toHaveBeenCalledTimes(1);
    // Монтажёр подменён — объект остался RECEIVED; убираем его из обходов следующих проверок.
    await prisma.property.update({ where: { id: b.p.id }, data: { narrationOff: true } });
  });

  it("сервис не подключён (нет VOICE_SEPARATOR_URL) — обход молчит, одобрение идёт монтажёру по-старому", async () => {
    const saved = process.env.VOICE_SEPARATOR_URL;
    delete process.env.VOICE_SEPARATOR_URL;
    try {
      const { p, v2 } = await priceChanged(media.v3);
      expect(await runMachineMasters()).toBe("IDLE");
      expect(await afterNarrationApproved(p.id, v2.id)).toBe("SOUND_REMAKE");
      await prisma.property.update({ where: { id: p.id }, data: { narrationOff: true } });
    } finally {
      process.env.VOICE_SEPARATOR_URL = saved;
    }
    expect(sep.calls).toBe(0);
  });

  it("ролик ещё не вышел (сдан раньше одобрения) — машина не трогает: голос вклеивает монтажёр, как решено 12.11", async () => {
    const p = await seedPublished();
    await prisma.property.update({ where: { id: p.id }, data: { publishedChannels: [] } });
    const v1 = await seedVersion(p.id, 1, media.v3);
    expect(await afterNarrationApproved(p.id, v1.id)).not.toBe("CRM_SEPARATE");
    expect(await makeMachineMaster(p.id)).toBe("SKIPPED");
    expect(sep.calls).toBe(0);
    await prisma.property.update({ where: { id: p.id }, data: { narrationOff: true } });
  });

  it("машину выключили после одобрения — обход не держит объект молча, отдаёт монтажёру один раз", async () => {
    const { p, v2 } = await priceChanged(media.v3);
    expect(await afterNarrationApproved(p.id, v2.id)).toBe("CRM_SEPARATE");
    await setConfig({ autoSeparateVoice: false });
    await runMachineMasters();
    expect(sendBack).toHaveBeenCalledWith(p.id, agentId, "NARRATION_CHANGED", expect.any(String), null, { removeFromSocial: "on-new-video" });
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).videoMasterAutoErrorFinalPath).not.toBeNull();
    const calls = sendBack.mock.calls.filter((c) => (c as unknown[])[0] === p.id).length;
    await runMachineMasters();
    expect(sendBack.mock.calls.filter((c) => (c as unknown[])[0] === p.id).length).toBe(calls);
    expect(sep.calls).toBe(0);
  });

  it("сторож забраковал, а монтажёру уйти нечем (новая версия устарела к моменту отказа) — карточка честно говорит «прежний ролик»", async () => {
    sep.words = 30;
    const { p, v2 } = await priceChanged(media.v3);
    // Пока шло отделение, агент сменил текст: новая версия ещё не одобрена — возвращать монтажёру нечего.
    await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 3, script: "Новый текст агента.", factsSnapshot: v2.factsSnapshot as object, factsHash: v2.factsHash,
      voiceId: "voiceA", modelId: "eleven_v4", status: "DRAFT", createdById: agentId, requestKey: randomUUID(), source: "AGENT" } });
    expect(await makeMachineMaster(p.id)).toBe("SKIPPED");
    await prisma.propertyNarrationVersion.deleteMany({ where: { propertyId: p.id, revision: 3 } });
    const realFail = await makeMachineMaster(p.id);
    expect(realFail).toBe("FAILED");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(await narrationMixNoteFor({ ...after, videoHandoffStatus: "RECEIVED" }, v2)).toContain("в соцсетях пока прежний ролик");
    await waitFor(() => prisma.errorLog.findFirst({ where: { message: { contains: `Объект №${p.shortId}: старый голос из ролика не убран` } } }));
  });

  it("№204 (прод 17.11): озвучку монтажёру не передавали, ролик вышел без неё — машина не трогает (решение 12.11), сервиса нет — тоже без отметки", async () => {
    sep.fail = "Сервис отделения голоса недоступен: getaddrinfo ENOTFOUND voice-separator";
    sep.failCode = "ABSENT";
    const p = await seedPublished();
    await prisma.property.update({ where: { id: p.id }, data: { price: 65000 } });
    const v1 = await seedVersion(p.id, 1, media.v3);
    expect(await makeMachineMaster(p.id)).toBe("SKIPPED");
    expect(await afterNarrationApproved(p.id, v1.id)).not.toBe("CRM_SEPARATE");
    sep.fail = null;
    expect(await makeMachineMaster(p.id, new Date(Date.now() + 31 * 60_000))).toBe("SKIPPED");
    expect(sep.calls).toBe(0);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.videoMasterAutoErrorFinalPath).toBeNull();
    expect(after.videoMasterStorageKey).toBeNull();
  });

  it("сервиса нет, голос вклеивал монтажёр: ему сразу, без отметки; подняли сервис — следующая смена цены идёт машиной", async () => {
    sep.fail = "Сервис отделения голоса недоступен: getaddrinfo ENOTFOUND voice-separator";
    sep.failCode = "ABSENT";
    const { p } = await priceChanged(media.v3);
    expect(await makeMachineMaster(p.id)).toBe("RETRY");
    expect(sendBack).toHaveBeenCalledTimes(1);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).videoMasterAutoErrorFinalPath).toBeNull();
    // Настоящий возврат увёл бы объект в монтаж; шпион его оставил — после паузы и подъёма сервиса машина берёт его.
    sep.fail = null;
    expect(await makeMachineMaster(p.id, new Date(Date.now() + 31 * 60_000))).toBe("REMIXED");
  });

  it("ролик без звука вовсе: убирать нечего, мастер = ролик, новая озвучка ложится", async () => {
    const { p, v2 } = await priceChanged(media.v3, { audio: false });
    expect(await makeMachineMaster(p.id)).toBe("REMIXED");
    expect(sep.calls).toBe(0);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).videoMasterNarrationVersionId).toBe(v2.id);
  });

  it("длина (а): голос длиннее на ~10 % — ускорен, агенту строка в карточке", async () => {
    const { p, v2 } = await priceChanged(media.v68);
    expect(await makeMachineMaster(p.id)).toBe("REMIXED");
    const v = await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: v2.id } });
    expect(v.mixNote).toMatch(/ускорила его на \d+%/u);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(Math.abs((await probeMediaInfo(diskOf(after.videoHandoffFinalPath!)))!.durationSec - 6)).toBeLessThan(0.4);
    expect(await narrationMixNoteFor(after, v)).toBe(v.mixNote);
  });

  it("длина (б): текст по шаблону — одна перегенерация коротким шаблоном, сама одобряется; укороченную не укорачивают", async () => {
    const { p, v2 } = await priceChanged(media.v9);
    // Мастер готов, а сведение просит текст короче — нового ролика пока нет.
    expect(await makeMachineMaster(p.id)).toBe("MADE");
    const versions = await prisma.propertyNarrationVersion.findMany({ where: { propertyId: p.id }, orderBy: { revision: "asc" } });
    expect(versions).toHaveLength(3);
    const v3 = versions[2]!;
    expect(v3).toMatchObject({ shortenedFromId: v2.id, templateId: shortT.id, status: "DRAFT", source: "AUTO" });
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).videoMasterMixErrorVersionId).toBe(v2.id);

    // Генерацию (ElevenLabs) изображаем готовым mp3: 9 с — оценка не сбылась, текст всё ещё длинный.
    const storageKey = `${p.id}/${v3.id}.mp3`;
    await fs.copyFile(media.v9, localVideoFilePath(storageKey)!);
    await prisma.propertyNarrationVersion.update({ where: { id: v3.id }, data: { status: "READY", storageKey, generateAfter: null } });
    expect(await autoApproveSameChoice(v3.id, (await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } })).propertyNarrationConfig as never)).toEqual({ approvedById: agentId });
    expect(await afterNarrationApproved(p.id, v3.id)).toBe("CRM_REMIX");
    // Вторая перегенерация не заказывается: (в) стоп-кадр.
    expect(await remixFromMaster(p.id)).toBe("REMIXED");
    expect(await prisma.propertyNarrationVersion.count({ where: { propertyId: p.id } })).toBe(3);
    const v3after = await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: v3.id } });
    expect(v3after.mixNote).toMatch(/продлила последний кадр/u);
  });

  it("длина (в): текст правлен руками — шаблон не меняем, стоп-кадр; (г) голос 15 с на 6 с — монтажёру", async () => {
    const a = await priceChanged(media.v9, { v2: { script: "Текст агента своими словами, длинный и подробный, про квартиру и район." } });
    expect(await makeMachineMaster(a.p.id)).toBe("REMIXED");
    expect(await prisma.propertyNarrationVersion.count({ where: { propertyId: a.p.id } })).toBe(2);
    expect((await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: a.v2.id } })).mixNote).toMatch(/последний кадр/u);

    const b = await priceChanged(media.v15, { v2: { script: "Другой ручной текст агента." } });
    expect(await makeMachineMaster(b.p.id)).toBe("MADE");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: b.p.id } });
    expect(after.videoMasterMixErrorVersionId).toBe(b.v2.id);
    expect(after.videoMasterMixError).toContain("длиннее ролика");
    expect(sendBack).toHaveBeenCalledWith(b.p.id, agentId, "NARRATION_CHANGED", expect.stringContaining("длиннее ролика"), null, { removeFromSocial: "on-new-video" });
  });

  it("идемпотентность: две правки цены подряд — одна новая версия, одно отделение, один перемикс", async () => {
    await setConfig({ debounceMinutes: 3 });
    const p = await seedPublished();
    const v1 = await seedVersion(p.id, 1, media.v3);
    await editorVoiced(p.id, v1.id);
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
    expect(await afterNarrationApproved(p.id, vid)).toBe("CRM_SEPARATE");
    expect(await afterNarrationApproved(p.id, vid)).toBe("CRM_SEPARATE");
    const [x, y] = await Promise.all([makeMachineMaster(p.id), makeMachineMaster(p.id)]);
    expect([x, y].filter((r) => r === "REMIXED")).toHaveLength(1);
    expect(await makeMachineMaster(p.id)).toBe("SKIPPED");
    expect(sep.calls).toBe(1);
    expect(await prisma.videoRemakeRequest.count({ where: { propertyId: p.id } })).toBe(1);
  });
});
