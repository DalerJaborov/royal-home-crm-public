import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

/**
 * ОЗВУЧКА: МОНТАЖЁР ВКЛЕИВАЕТ ГОЛОС САМ (12.11.2026, решения владельца). База и ffmpeg —
 * настоящие; Telegram, пуши и ElevenLabs подменены, платных вызовов нет.
 *  A — монтажёру строка «вклейте mp3 и сдайте два файла»; просьба о ролике без голоса после
 *      готового; ролик без голоса становится мастером (длина и содержимое проверяются);
 *  B — «Без озвучки»: ни версии, ни денег, ждущее гаснет, монтажёру пометка;
 *  C — разовый проход по очереди монтажа: версия на одобрение владельцу, повтор пуст;
 *  D — ролик от сотрудника: объект по подписи, «Нужен монтаж», дубль, «Не тот объект»;
 *  E — проданный объект, напоминания (3 ч агенту, ещё 3 ч руководителю), последний выбор голоса,
 *      словарь произношения (только подмена fetch).
 */
const tg = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  sendMessageWithButtons: vi.fn(async () => ({ message_id: 2 })),
  answerCallbackQuery: vi.fn(async () => ({})),
  sendDocumentFile: vi.fn(async () => ({ message_id: 3 })),
  file: null as Buffer | null,
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage: tg.sendMessage, sendMessageWithButtons: tg.sendMessageWithButtons, answerCallbackQuery: tg.answerCallbackQuery,
  sendDocumentFile: tg.sendDocumentFile, isTelegramEnabled: () => true,
  resolveTelegramFileMaterialization: vi.fn(async () => (tg.file ? { kind: "buffer", buffer: tg.file } : null)),
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 0), sendPushToAgents: vi.fn(async () => 0),
}));

const ffmpegReady = spawnSync(process.env.FFMPEG_BIN || "ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

const { prisma } = await import("../src/db.js");
const { narrationFacts, narrationHash } = await import("../src/lib/propertyNarration.js");
const { startNarrationForNewProperty, requestAutoNarration, approveNarrationVersion, backfillMontageQueue } = await import("../src/lib/narrationAutoFlow.js");
const { setPropertyNarrationOff, retireNarrationsOfClosedProperties } = await import("../src/lib/narrationOptOut.js");
const { narrationLineForMontajer } = await import("../src/lib/narrationMontajerNote.js");
const { voicelessCopyAsk, storeVoicelessCopy, voicelessCopyTarget, isVoicelessCopyLabel } = await import("../src/lib/narrationVoicelessCopy.js");
const { rememberNarrationChoice, narrationLastChoiceFor } = await import("../src/lib/narrationLastChoice.js");
const { syncPronunciationDictionary } = await import("../src/lib/narrationPronunciation.js");
const { remindPendingNarrationApprovals } = await import("../src/telegram/assistantNarration.js");
const { handleStaffClipMessage, handleStaffClipCallback, propertyFromCaption } = await import("../src/telegram/staffClip.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");
const { sendPushToAgent } = await import("../src/push.js");
const { videoHandoffDir } = await import("../src/upload.js");

const runId = Date.now();
const tail = runId.toString().slice(-6);
const tmp = path.join(os.tmpdir(), `narration-montajer-${runId}`);
const media = { music: path.join(tmp, "music.mp4"), silent: path.join(tmp, "silent.mp4"), long: path.join(tmp, "long.mp4"), voice: path.join(tmp, "voice.mp3") };
const TEMPLATE = { id: "ru-test-12", name: "Тест", lang: "ru" as const, text: "В продаже {вид}. Площадь {площадь} метров. Цена {цена}." };
const CONFIG = { modelId: "eleven_v4", voices: [{ id: "voiceA", name: "А", gender: "female" as const }, { id: "voiceB", name: "Б", gender: "male" as const }], templates: [TEMPLATE], autoGenerate: true };
let districtId: string, agentId: string, directorId: string, headId: string;
const agentChat = `-8${tail}1`;
const propertyIds: string[] = [];
let configBefore: unknown = null;
const modeBefore = process.env.CRM_NARRATION_EXECUTION_MODE;

function ff(args: string[]) {
  const r = spawnSync(process.env.FFMPEG_BIN || "ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: "ignore" });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}`);
}
async function seedProperty(data: Record<string, unknown> = {}) {
  const p = await prisma.property.create({ data: { title: `Озвучка монтаж-${runId}`, type: "APARTMENT", areaSqm: 64, price: 61000, currency: "USD", districtId,
    address: `Сино, ${propertyIds.length + 1}`, condition: "GOOD", status: "EDITING", assignedAgentId: agentId, ...data }, include: { district: true } });
  propertyIds.push(p.id);
  return p;
}
async function seedVersion(propertyId: string, extra: Record<string, unknown> = {}) {
  const p = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, include: { district: true } });
  const facts = narrationFacts(p);
  const latest = await prisma.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" } });
  return prisma.propertyNarrationVersion.create({ data: { propertyId, revision: (latest?.revision ?? 0) + 1, script: "Текст озвучки для проверки.", factsSnapshot: facts, factsHash: narrationHash(facts),
    voiceId: "voiceA", modelId: "eleven_v4", status: "READY", storageKey: `${propertyId}/${randomUUID()}.mp3`, createdById: agentId, requestKey: randomUUID(), source: "AUTO", ...extra } });
}
async function sentDelivery(propertyId: string, versionId: string, plan: Record<string, unknown> = {}) {
  return prisma.propertyNarrationDelivery.create({ data: { propertyId, versionId, mode: "AUDIO_ONLY", status: "SENT", requestKey: randomUUID(), createdById: agentId,
    plan: { factsHash: "x", recipientHash: "y", files: [{ id: versionId, storageKey: "k", filename: "f.mp3", caption: "c" }], sourcesHash: "z", ...plan }, executionMode: "LIVE", deliveredAt: new Date() } });
}
async function setConfig(extra: Record<string, unknown> = {}) {
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", propertyNarrationConfig: { ...CONFIG, ...extra } }, update: { propertyNarrationConfig: { ...CONFIG, ...extra } } });
}

beforeAll(async () => {
  await fs.mkdir(tmp, { recursive: true });
  if (ffmpegReady) {
    ff(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=6", "-f", "lavfi", "-i", "sine=frequency=300:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", media.music]);
    ff(["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=6", "-f", "lavfi", "-i", "sine=frequency=200:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", media.silent]);
    ff(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", media.long]);
  }
  districtId = (await prisma.district.create({ data: { name: `Озвучка монтаж-${runId}` } })).id;
  const hash = await bcrypt.hash("testpass123", 4);
  agentId = (await prisma.agent.create({ data: { fullName: "Агент Ролика", phone: `+99291${tail}1`, role: "AGENT", passwordHash: hash, telegramChatId: agentChat } })).id;
  directorId = (await prisma.agent.create({ data: { fullName: "Директор Ролика", phone: `+99291${tail}2`, role: "DIRECTOR", passwordHash: hash } })).id;
  headId = (await prisma.agent.create({ data: { fullName: "Руководитель Ролика", phone: `+99291${tail}3`, role: "HEAD_OF_SALES", passwordHash: hash } })).id;
  configBefore = (await prisma.settings.findUnique({ where: { id: "singleton" }, select: { propertyNarrationConfig: true } }))?.propertyNarrationConfig ?? null;
  await setConfig();
});
beforeEach(() => { vi.clearAllMocks(); tg.file = null; });
afterAll(async () => {
  process.env.CRM_NARRATION_EXECUTION_MODE = modeBefore;
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: (configBefore ?? {}) as object } }).catch(() => {});
  await prisma.staffClipIntake.deleteMany({ where: { agentId } });
  const props = await prisma.property.findMany({ where: { id: { in: propertyIds } }, select: { videoHandoffFinalPath: true } });
  for (const p of props) if (p.videoHandoffFinalPath) await fs.rm(path.join(videoHandoffDir, path.basename(p.videoHandoffFinalPath)), { force: true });
  for (const id of propertyIds) await fs.rm(path.dirname(localVideoFilePath(`${id}/${randomUUID()}.mp4`)!), { recursive: true, force: true });
  await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.videoRemakeRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId, headId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("B: «Без озвучки»", () => {
  it("выбор в мастере: флаг на объекте, ни одной версии, новая озвучка не создаётся", async () => {
    const p = await seedProperty();
    expect(await startNarrationForNewProperty(p.id, agentId, { none: true })).toEqual({ status: "DISABLED" });
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).narrationOff).toBe(true);
    expect(await prisma.propertyNarrationVersion.count({ where: { propertyId: p.id } })).toBe(0);
    expect(await requestAutoNarration({ propertyId: p.id, actorId: agentId, source: "AUTO", debounceMs: 0 })).toEqual({ status: "DISABLED" });
    expect(await narrationLineForMontajer(p.id)).toContain("Без озвучки");
  });
  it("выключили позже: ждущая генерация и неотправленная передача гаснут, включили — снова можно", async () => {
    const p = await seedProperty();
    const v = await seedVersion(p.id, { status: "DRAFT", storageKey: null, generateAfter: new Date() });
    const d = await prisma.propertyNarrationDelivery.create({ data: { propertyId: p.id, versionId: v.id, mode: "AUDIO_ONLY", status: "QUEUED", requestKey: randomUUID(), createdById: agentId, executionMode: "LIVE" } });
    expect(await setPropertyNarrationOff(p.id, true, agentId)).toMatchObject({ changed: true, off: true });
    expect((await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: v.id } })).generateAfter).toBeNull();
    expect((await prisma.propertyNarrationDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("CANCELLED");
    expect(await setPropertyNarrationOff(p.id, false, agentId)).toMatchObject({ changed: true, off: false });
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).narrationOff).toBe(false);
  });
});

describe("A: монтажёр вклеивает голос сам", () => {
  it("строка задания монтажёру: вклеить mp3 и сдать два файла; при «голос кладёт CRM» — прежняя строка", async () => {
    const p = await seedProperty();
    await seedVersion(p.id, { approvedAt: new Date(), approvedById: agentId });
    expect(await narrationLineForMontajer(p.id)).toMatch(/вклейте её сами.*два файла/su);
    await setConfig({ mixByCrm: true });
    expect(await narrationLineForMontajer(p.id)).toContain("БЕЗ голоса");
    await setConfig();
  });
  it("просьба о ролике без голоса — только если голос вклеивал монтажёр, и не при «Без озвучки»", async () => {
    const p = await seedProperty({ videoHandoffStatus: "RECEIVED", videoHandoffFinalPath: "/uploads/handoff/none.mp4" });
    expect(await voicelessCopyAsk(p.id)).toBeNull();
    const v = await seedVersion(p.id, { approvedAt: new Date(), approvedById: agentId });
    await sentDelivery(p.id, v.id, { mixByCrm: true });
    expect(await voicelessCopyAsk(p.id)).toBeNull();
    await sentDelivery(p.id, v.id);
    const ask = await voicelessCopyAsk(p.id);
    expect(ask?.buttons[0]?.map((b) => b.callback_data)).toEqual([`mj:nv:${p.shortId}`, `mj:nvx:${p.shortId}`]);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).videoMasterRequestedAt).not.toBeNull();
    await prisma.property.update({ where: { id: p.id }, data: { narrationOff: true } });
    expect(await voicelessCopyAsk(p.id)).toBeNull();
  });
  it("подпись «без голоса 123» узнаётся; номер другого объекта после кнопки — обычный готовый ролик", async () => {
    expect(isVoicelessCopyLabel("123_bez_golosa.mp4", null)).toBe(true);
    expect(isVoicelessCopyLabel("123.mp4", "без голоса")).toBe(true);
    expect(isVoicelessCopyLabel("123.mp4", "финал")).toBe(false);
    const p = await seedProperty();
    const chatId = `-7${tail}9`;
    await prisma.telegramDialogState.upsert({ where: { chatId }, create: { chatId, agentId, kind: "montajer_voiceless", payload: { propertyId: p.id, shortId: p.shortId }, expiresAt: new Date(Date.now() + 60_000) },
      update: { agentId, kind: "montajer_voiceless", payload: { propertyId: p.id, shortId: p.shortId }, expiresAt: new Date(Date.now() + 60_000) } });
    expect(await voicelessCopyTarget({ chatId, agentId, filename: "video.mp4", caption: null })).toMatchObject({ propertyId: p.id, via: "button" });
    expect(await voicelessCopyTarget({ chatId, agentId, filename: `${p.shortId + 100000}.mp4`, caption: null })).toBeNull();
    await prisma.telegramDialogState.deleteMany({ where: { chatId } });
  });
  it.skipIf(!ffmpegReady)("ролик без голоса становится мастером с версией из ролика; другая длина или тот же файл — нет", async () => {
    const finalName = `${randomUUID()}.mp4`;
    await fs.copyFile(media.music, path.join(videoHandoffDir, finalName));
    const p = await seedProperty({ videoHandoffStatus: "RECEIVED", videoHandoffFinalPath: `/uploads/handoff/${finalName}` });
    const v = await seedVersion(p.id, { approvedAt: new Date(), approvedById: agentId });
    await sentDelivery(p.id, v.id);
    expect(await storeVoicelessCopy(p.id, media.long)).toMatchObject({ ok: false, code: "MISMATCH" });
    expect(await storeVoicelessCopy(p.id, path.join(videoHandoffDir, finalName))).toMatchObject({ ok: false, code: "REFUSED" });
    expect(await storeVoicelessCopy(p.id, media.silent)).toMatchObject({ ok: true });
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.videoMasterNarrationVersionId).toBe(v.id);
    expect(after.videoMasterStorageKey).toBeTruthy();
    expect(await fs.access(localVideoFilePath(after.videoMasterStorageKey!)!).then(() => true, () => false)).toBe(true);
  });
});

describe("C: озвучка к роликам в монтаже — владельцу", () => {
  it("версия BACKFILL от системы, повтор пуст, «Без озвучки» пропускается; одобряет только владелец", async () => {
    const queued = await seedProperty({ videoHandoffStatus: "QUEUED", videoHandoffQueueOrder: 1 });
    const off = await seedProperty({ videoHandoffStatus: "QUEUED", videoHandoffQueueOrder: 2, narrationOff: true });
    const config = { ...CONFIG, defaultVoiceId: "voiceB" };
    await backfillMontageQueue(config, new Date());
    await backfillMontageQueue(config, new Date());
    const rows = await prisma.propertyNarrationVersion.findMany({ where: { propertyId: { in: [queued.id, off.id] } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ propertyId: queued.id, source: "BACKFILL", createdById: "system", voiceId: "voiceB" });
    await prisma.propertyNarrationVersion.update({ where: { id: rows[0]!.id }, data: { status: "READY", storageKey: `${queued.id}/a.mp3` } });
    const input = { propertyId: queued.id, versionId: rows[0]!.id, expectedRevision: 1, isManager: false };
    expect(await approveNarrationVersion({ ...input, actorId: agentId, actorRole: "AGENT" })).toBe("FORBIDDEN");
    expect(await approveNarrationVersion({ ...input, actorId: directorId, actorRole: "DIRECTOR" })).toBe("AUDIO_APPROVED");
  });
});

describe("E: соседние ситуации", () => {
  it("объект продан: ждущая генерация и передача монтажёру гаснут", async () => {
    const p = await seedProperty({ status: "SOLD" });
    const v = await seedVersion(p.id, { status: "DRAFT", storageKey: null, generateAfter: new Date() });
    const d = await prisma.propertyNarrationDelivery.create({ data: { propertyId: p.id, versionId: v.id, mode: "AUDIO_ONLY", status: "QUEUED", requestKey: randomUUID(), createdById: agentId, executionMode: "LIVE" } });
    expect(await retireNarrationsOfClosedProperties(p.id)).toBe(2);
    expect((await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: v.id } })).generateAfter).toBeNull();
    expect((await prisma.propertyNarrationDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("CANCELLED");
  });
  it("последний выбор голоса и шаблона запоминается; голос убрали из настроек — сброс на общий", async () => {
    await rememberNarrationChoice(agentId, { voiceId: "voiceB", templateId: TEMPLATE.id });
    expect(await narrationLastChoiceFor(agentId, CONFIG)).toEqual({ voiceId: "voiceB", templateId: TEMPLATE.id });
    expect(await narrationLastChoiceFor(agentId, { ...CONFIG, voices: [CONFIG.voices[0]!] })).toEqual({ templateId: TEMPLATE.id });
    // Мастер без явного выбора берёт последний голос сотрудника.
    const p = await seedProperty();
    await startNarrationForNewProperty(p.id, agentId, {});
    expect((await prisma.propertyNarrationVersion.findFirstOrThrow({ where: { propertyId: p.id } })).voiceId).toBe("voiceB");
  });
  it("напоминание: через 3 часа агенту, ещё через 3 — руководителю; ночью молчит; без автоодобрения", async () => {
    const p = await seedProperty();
    const morning = new Date("2026-11-12T05:00:00Z"); // 10:00 по Душанбе
    const v = await seedVersion(p.id, { source: "WIZARD", approvalNotifiedAt: new Date(morning.getTime() - 4 * 3_600_000) });
    expect(await remindPendingNarrationApprovals(new Date("2026-11-11T20:00:00Z"))).toBe(0);
    await remindPendingNarrationApprovals(morning);
    const reminded = await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: v.id } });
    expect(reminded.approvalRemindedAt).not.toBeNull();
    expect(reminded.approvalEscalatedAt).toBeNull();
    expect(tg.sendMessageWithButtons.mock.calls.some((c) => String(c[1]).includes("три часа"))).toBe(true);
    await remindPendingNarrationApprovals(new Date(morning.getTime() + 3 * 3_600_000 + 60_000));
    const escalated = await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: v.id } });
    expect(escalated.approvalEscalatedAt).not.toBeNull();
    expect(escalated.approvedAt).toBeNull();
    // У руководителя нет Telegram — уходит пуш с той же карточкой одобрения.
    expect(vi.mocked(sendPushToAgent).mock.calls.some((c) => c[0] === headId)).toBe(true);
  });
  it("словарь произношения: только для eleven_v4, создание, обновление, очистка — архивом", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET", body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ id: "dict1", version_id: `ver${calls.length}` }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const rules = [{ word: "ҳавлӣ", phoneme: "/havˈli/", needsNative: true }, { word: "Сино", alias: "Сино́" }];
    expect(await syncPronunciationDictionary({ ...CONFIG, modelId: "eleven_v4_turbo", pronunciationRules: rules }, "k", fetcher)).toEqual({ status: "SKIPPED" });
    expect(await syncPronunciationDictionary({ ...CONFIG, pronunciationRules: rules }, "k", fetcher)).toEqual({ status: "SYNCED", dictionaries: [{ id: "dict1", versionId: "ver1" }] });
    expect(calls[0]!.url).toMatch(/add-from-rules$/);
    expect(calls[0]!.body).toMatchObject({ rules: [{ type: "phoneme", string_to_replace: "ҳавлӣ", phoneme: "havˈli", alphabet: "ipa" }, { type: "alias", string_to_replace: "Сино", alias: "Сино́" }] });
    await syncPronunciationDictionary({ ...CONFIG, pronunciationRules: rules, pronunciationDictionaries: [{ id: "dict1" }] }, "k", fetcher);
    expect(calls[1]!.url).toMatch(/dict1\/set-rules$/);
    expect(await syncPronunciationDictionary({ ...CONFIG, pronunciationRules: [], pronunciationDictionaries: [{ id: "dict1" }] }, "k", fetcher)).toEqual({ status: "SYNCED", dictionaries: [] });
    expect(calls[2]).toMatchObject({ method: "PATCH", body: { archived: true } });
  });
});

describe("D: ролик от сотрудника в Telegram", () => {
  const msg = (extra: Record<string, unknown>) => ({ message_id: 10, chat: { id: Number(agentChat), type: "private" }, from: { id: Number(agentChat) }, ...extra }) as never;
  const press = (data: string) => handleStaffClipCallback({ id: randomUUID(), data, from: { id: Number(agentChat) }, message: { message_id: 11, chat: { id: Number(agentChat), type: "private" } } } as never);
  it("объект по подписи: номер где угодно, ссылка CRM, ссылка сайта", async () => {
    const p = await seedProperty({ siteListingId: Number(`9${tail}`) });
    expect((await propertyFromCaption(null, `смотрите №${p.shortId} вечером`))?.id).toBe(p.id);
    expect((await propertyFromCaption(null, `https://crm.royalhome.tj/properties/${p.id}`))?.id).toBe(p.id);
    expect((await propertyFromCaption(null, `https://royalhome.tj/tg/khona/9${tail}`))?.id).toBe(p.id);
    expect(await propertyFromCaption("IMG_1234.MOV", "просто видео")).toBeNull();
  });
  it("«Нужен монтаж»: исходник у объекта, агенту уведомление не себе; дубль не принимается; «Не тот объект» откатывает", async () => {
    const p = await seedProperty();
    tg.file = Buffer.from("not-a-real-video-but-a-source-file");
    const unique = `uniq-${runId}`;
    expect(await handleStaffClipMessage(msg({ caption: `№${p.shortId}`, document: { file_id: "f1", file_unique_id: unique, file_name: "clip.mp4", mime_type: "video/mp4", file_size: 34 } }), { id: agentId, fullName: "Агент Ролика" })).toBe(true);
    const intake = await prisma.staffClipIntake.findFirstOrThrow({ where: { agentId, fileUniqueId: unique } });
    expect(intake).toMatchObject({ status: "CHOSEN", propertyId: p.id });
    expect(String(tg.sendMessageWithButtons.mock.calls.at(-1)?.[1])).toContain("Что с ним сделать");
    await press(`clip:m:${intake.id}`);
    const done = await prisma.staffClipIntake.findUniqueOrThrow({ where: { id: intake.id } });
    expect(done.status).toBe("MONTAGE");
    expect(await prisma.propertyVideo.count({ where: { propertyId: p.id, uploadKey: `tg-staff-clip:${intake.id}` } })).toBe(1);
    // Второй тап той же кнопки ничего не задваивает.
    await press(`clip:m:${intake.id}`);
    expect(await prisma.propertyVideo.count({ where: { propertyId: p.id } })).toBe(1);
    // Тот же файл ещё раз.
    tg.sendMessage.mockClear();
    await handleStaffClipMessage(msg({ caption: `№${p.shortId}`, document: { file_id: "f2", file_unique_id: unique, file_name: "clip.mp4", mime_type: "video/mp4", file_size: 34 } }), { id: agentId, fullName: "Агент Ролика" });
    expect(String(tg.sendMessage.mock.calls.at(-1)?.[1])).toContain("уже добавлен");
    await press(`clip:u:${intake.id}`);
    expect(await prisma.propertyVideo.count({ where: { propertyId: p.id } })).toBe(0);
    const undone = await prisma.staffClipIntake.findUniqueOrThrow({ where: { id: intake.id } });
    expect(undone.status).toBe("ASKING");
    expect(undone.excluded).toEqual([p.id]);
  });
  it("чужой объект без права — не предлагается, спрашиваем", async () => {
    const other = await seedProperty({ assignedAgentId: directorId });
    await handleStaffClipMessage(msg({ caption: `№${other.shortId}`, document: { file_id: "f3", file_unique_id: `u3-${runId}`, file_name: "c.mp4", mime_type: "video/mp4", file_size: 10 } }), { id: agentId, fullName: "Агент Ролика" });
    const intake = await prisma.staffClipIntake.findFirstOrThrow({ where: { agentId, fileUniqueId: `u3-${runId}` } });
    expect(intake.status).toBe("ASKING");
    expect(String(tg.sendMessageWithButtons.mock.calls.at(-1)?.[1])).toContain("недоступен");
  });
});
