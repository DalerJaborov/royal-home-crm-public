import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

/**
 * ПРОСЛУШАТЬ ПЕРЕД ВЫПУСКОМ (17.11.2026). База, файлы и ffmpeg — настоящие; Telegram и пуши подменены.
 *  — ролик вышел, CRM наложила новую озвучку → новый ролик ждёт хозяина, вышедший не тронут, срок самовыпуска стоит;
 *  — «Выпустить» → новый ролик становится роликом объекта, старые посты снимутся (VideoRemakeRequest), прежний файл удалён;
 *  — «Оставить старый» → кандидат удалён, эту версию CRM больше не накладывает; новая версия — новый кандидат;
 *  — срок прошёл → выходит сам; не прошёл — нет;
 *  — пока ждали, пришла новая версия → старый кандидат устарел и не выпускается;
 *  — ролик ещё не вышел или рубильник выключен → подмена сразу, как раньше.
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
const { remixFromMaster } = await import("../src/lib/narrationAutoFlow.js");
const { declineNarrationPreview, notifyPendingNarrationPreviews, releaseDueNarrationPreviews, releaseNarrationPreview } = await import("../src/lib/narrationPreview.js");
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
async function setPreview(on: boolean) {
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: { ...((configBefore as Record<string, unknown> | null) ?? {}), mixByCrm: true, previewBeforeRepublish: on } } });
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
  await setPreview(true);
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

describe.skipIf(!ffmpegReady)("прослушать перед выпуском (17.11.2026)", { timeout: 60_000 }, () => {
  it("вышедший ролик: новый ждёт хозяина, вышедший не тронут; «Выпустить» — подмена, старые посты снимутся", async () => {
    const { p, v1, v2, oldFinal } = await publishedWithNewVoice();
    const t0 = Date.now();
    expect(await remixFromMaster(p.id)).toBe("PREVIEW");
    const waiting = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(waiting.videoHandoffFinalPath).toBe(oldFinal);
    expect(waiting.videoMasterNarrationVersionId).toBe(v1.id);
    expect(waiting.narrationPreviewVersionId).toBe(v2.id);
    expect(await exists(diskOf(waiting.narrationPreviewPath!))).toBe(true);
    expect(await exists(diskOf(oldFinal))).toBe(true);
    expect(waiting.narrationPreviewVoiceSec).toBeGreaterThan(2);
    expect(waiting.narrationPreviewClipSec).toBeGreaterThan(5);
    // 3 часа (ночью — до 07:00 по Душанбе, то есть не раньше чем через 3 часа).
    expect(waiting.narrationPreviewDueAt!.getTime()).toBeGreaterThanOrEqual(t0 + 3 * 3_600_000 - 5_000);
    expect(await prisma.videoRemakeRequest.count({ where: { propertyId: p.id } })).toBe(0);
    // Хозяину — задачей narration-preview-due, ровно один раз (отметка до отправки).
    const sent: Array<{ propertyId: string; versionId: string }> = [];
    await notifyPendingNarrationPreviews(async (n) => { sent.push(n); });
    await notifyPendingNarrationPreviews(async (n) => { sent.push(n); });
    expect(sent.filter((n) => n.propertyId === p.id)).toEqual([{ propertyId: p.id, versionId: v2.id }]);
    // Повтор тика: кандидат уже есть — второго не делаем.
    expect(await remixFromMaster(p.id)).toBe("SKIPPED");

    expect(await releaseNarrationPreview(p.id, v2.id, { agentId, source: "crm" })).toBe("RELEASED");
    const released = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(released.videoHandoffFinalPath).toBe(waiting.narrationPreviewPath);
    expect(released.videoMasterNarrationVersionId).toBe(v2.id);
    expect(released.narrationPreviewPath).toBeNull();
    expect(released.narrationPreviewDueAt).toBeNull();
    expect(await exists(diskOf(oldFinal))).toBe(false);
    const requests = await prisma.videoRemakeRequest.findMany({ where: { propertyId: p.id } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ reason: "NARRATION_CHANGED", replaceOldPostsOnPublish: true, requestedById: agentId });
    // Второе нажатие (или кнопка в другом чате) — ничего.
    expect(await releaseNarrationPreview(p.id, v2.id, { agentId, source: "telegram" })).toBe("STALE");
    expect(await remixFromMaster(p.id)).toBe("SKIPPED");
  });

  it("«Оставить старый»: кандидат удалён, эту версию больше не накладываем; новая версия — новый кандидат", async () => {
    const { p, v2, oldFinal } = await publishedWithNewVoice();
    expect(await remixFromMaster(p.id)).toBe("PREVIEW");
    const preview = (await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).narrationPreviewPath!;
    expect(await declineNarrationPreview(p.id, v2.id, { agentId, source: "crm" }, "KEEP_OLD")).toBe("DECLINED");
    const kept = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(kept.videoHandoffFinalPath).toBe(oldFinal);
    expect(kept.narrationPreviewPath).toBeNull();
    expect(kept.narrationPreviewDeclinedVersionId).toBe(v2.id);
    expect(await exists(diskOf(preview))).toBe(false);
    expect(await remixFromMaster(p.id)).toBe("SKIPPED");
    expect(await declineNarrationPreview(p.id, v2.id, { agentId, source: "crm" }, "KEEP_OLD")).toBe("STALE");

    // «Другой голос или текст» → новая версия → CRM наложит заново и снова пришлёт послушать.
    const v3 = await seedVersion(p.id, 3);
    expect(await remixFromMaster(p.id)).toBe("PREVIEW");
    const again = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(again.narrationPreviewVersionId).toBe(v3.id);
    expect(again.narrationPreviewDeclinedVersionId).toBeNull();
    expect(again.videoHandoffFinalPath).toBe(oldFinal);
  });

  it("срок прослушивания прошёл — выходит сам; не прошёл — ждёт", async () => {
    const { p, v2, oldFinal } = await publishedWithNewVoice();
    expect(await remixFromMaster(p.id)).toBe("PREVIEW");
    const due = (await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).narrationPreviewDueAt!;
    await releaseDueNarrationPreviews(new Date(due.getTime() - 60_000));
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).videoHandoffFinalPath).toBe(oldFinal);
    // Самовыпуск раньше срока не проходит, даже если позвать напрямую.
    expect(await releaseNarrationPreview(p.id, v2.id, { agentId: null, source: "auto" }, new Date(due.getTime() - 60_000))).toBe("STALE");
    await releaseDueNarrationPreviews(new Date(due.getTime() + 1_000));
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.videoMasterNarrationVersionId).toBe(v2.id);
    expect(after.videoHandoffFinalPath).not.toBe(oldFinal);
    // Автор заявки на замену постов — кто одобрил озвучку (молчащий хозяин ничего не нажимал).
    expect((await prisma.videoRemakeRequest.findFirstOrThrow({ where: { propertyId: p.id } })).requestedById).toBe(agentId);
  });

  it("пока ждали, пришла новая версия — старый кандидат не выпускается и убирается", async () => {
    const { p, v2, oldFinal } = await publishedWithNewVoice();
    expect(await remixFromMaster(p.id)).toBe("PREVIEW");
    const preview = (await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).narrationPreviewPath!;
    await seedVersion(p.id, 3);
    expect(await releaseNarrationPreview(p.id, v2.id, { agentId, source: "crm" })).toBe("STALE");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.videoHandoffFinalPath).toBe(oldFinal);
    expect(after.narrationPreviewPath).toBeNull();
    expect(await exists(diskOf(preview))).toBe(false);
  });

  it("ролик ещё не вышел или «прослушать» выключено — подмена сразу, как раньше", async () => {
    const notOut = await publishedWithNewVoice(false);
    expect(await remixFromMaster(notOut.p.id)).toBe("REMIXED");
    expect((await prisma.property.findUniqueOrThrow({ where: { id: notOut.p.id } })).narrationPreviewPath).toBeNull();

    await setPreview(false);
    try {
      const off = await publishedWithNewVoice(true);
      expect(await remixFromMaster(off.p.id)).toBe("REMIXED");
      const row = await prisma.property.findUniqueOrThrow({ where: { id: off.p.id } });
      expect(row.videoMasterNarrationVersionId).toBe(off.v2.id);
      expect(row.narrationPreviewPath).toBeNull();
    } finally {
      await setPreview(true);
    }
  });

  it("ревью 18.11 (третий круг): «Выпустить» и «Оставить старый» одновременно — у объекта всегда есть ролик на диске", async () => {
    const { p, v2, oldFinal } = await publishedWithNewVoice();
    expect(await remixFromMaster(p.id)).toBe("PREVIEW");
    const [rel, dec] = await Promise.all([
      releaseNarrationPreview(p.id, v2.id, { agentId, source: "crm" }),
      declineNarrationPreview(p.id, v2.id, { agentId, source: "telegram" }, "KEEP_OLD"),
    ]);
    // Ровно одно решение прошло, второе — «уже решено».
    expect([rel, dec].filter((r) => r === "STALE")).toHaveLength(1);
    const row = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.narrationPreviewPath).toBeNull();
    expect(await exists(diskOf(row.videoHandoffFinalPath!))).toBe(true);
    if (dec === "DECLINED") expect(row.videoHandoffFinalPath).toBe(oldFinal);
  });

  it("ревью 18.11 (третий круг): рубильник выключили, пока кандидат ждал, — новый ролик заменяет вышедший сразу, кандидат убран", async () => {
    const { p, v2 } = await publishedWithNewVoice();
    expect(await remixFromMaster(p.id)).toBe("PREVIEW");
    const waiting = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    await setPreview(false);
    try {
      expect(await remixFromMaster(p.id)).toBe("REMIXED");
      const row = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
      expect(row.videoMasterNarrationVersionId).toBe(v2.id);
      expect(row.narrationPreviewPath).toBeNull();
      expect(row.narrationPreviewVersionId).toBeNull();
      expect(await exists(diskOf(waiting.narrationPreviewPath!))).toBe(false);
    } finally {
      await setPreview(true);
    }
  });

  it("ревью 18.11: «Без озвучки», цена поменялась без новой версии, стёртый файл — не выпускаем, вышедший ролик цел", async () => {
    // «Без озвучки» снимает кандидата сразу.
    const a = await publishedWithNewVoice();
    expect(await remixFromMaster(a.p.id)).toBe("PREVIEW");
    await setPropertyNarrationOff(a.p.id, true, agentId);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: a.p.id } })).narrationPreviewVersionId).toBeNull();
    expect(await releaseNarrationPreview(a.p.id, a.v2.id, { agentId, source: "crm" })).toBe("STALE");

    // Цена снова поменялась, новая версия ещё не готова: старую цену в сети не выпускаем.
    const b = await publishedWithNewVoice();
    expect(await remixFromMaster(b.p.id)).toBe("PREVIEW");
    await prisma.property.update({ where: { id: b.p.id }, data: { price: 70000 } });
    expect(await releaseNarrationPreview(b.p.id, b.v2.id, { agentId, source: "crm" })).toBe("STALE");
    expect((await prisma.property.findUniqueOrThrow({ where: { id: b.p.id } })).videoHandoffFinalPath).toBe(b.oldFinal);

    // Файл кандидата стёрт с диска: «Выпустить» не оставляет объект без ролика.
    const c = await publishedWithNewVoice();
    expect(await remixFromMaster(c.p.id)).toBe("PREVIEW");
    await fs.rm(diskOf((await prisma.property.findUniqueOrThrow({ where: { id: c.p.id } })).narrationPreviewPath!), { force: true });
    expect(await releaseNarrationPreview(c.p.id, c.v2.id, { agentId, source: "crm" })).toBe("STALE");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: c.p.id } });
    expect(after.videoHandoffFinalPath).toBe(c.oldFinal);
    expect(await exists(diskOf(c.oldFinal))).toBe(true);
    expect(after.narrationPreviewPath).toBeNull();
  });

  it("ревью 18.11 (второй круг): ролик вернули монтажёру — кандидат убирается сам, без срока; «Без озвучки» во время сведения — ни подмены, ни кандидата", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { clipOwnerAutoPublishHours: 0 } });
    try {
      const a = await publishedWithNewVoice();
      expect(await remixFromMaster(a.p.id)).toBe("PREVIEW");
      expect((await prisma.property.findUniqueOrThrow({ where: { id: a.p.id } })).narrationPreviewDueAt).toBeNull();
      await prisma.property.update({ where: { id: a.p.id }, data: { videoHandoffStatus: "SENT_TO_EDITOR" } });
      const swept = await releaseDueNarrationPreviews();
      expect(swept.cleared).toBeGreaterThanOrEqual(1);
      expect((await prisma.property.findUniqueOrThrow({ where: { id: a.p.id } })).narrationPreviewPath).toBeNull();
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { clipOwnerAutoPublishHours: 3 } });
    }
    const b = await publishedWithNewVoice();
    const { placeMixedClip } = await import("../src/lib/narrationPreview.js");
    const cur = await prisma.property.findUniqueOrThrow({ where: { id: b.p.id } });
    await prisma.property.update({ where: { id: b.p.id }, data: { narrationOff: true } });
    const placed = await placeMixedClip({ propertyId: b.p.id, publicPath: "/uploads/handoff/x.mp4", masterKey: cur.videoMasterStorageKey!, seenVersionId: cur.videoMasterNarrationVersionId,
      versionId: b.v2.id, revision: 2, requestedById: agentId, previewEnabled: true, voiceSec: 3, clipSec: 6 });
    expect(placed).toEqual({ kind: "SKIPPED" });
    const after = await prisma.property.findUniqueOrThrow({ where: { id: b.p.id } });
    expect(after.videoHandoffFinalPath).toBe(b.oldFinal);
    expect(after.narrationPreviewPath).toBeNull();
  });
});
