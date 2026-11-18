import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * НОВАЯ ОЗВУЧКА ВЫХОДИТ: ОЧЕРЕДЬ, ПОРЯДОК «СНАЧАЛА НОВЫЙ, ПОТОМ СТАРЫЙ», ДЛИНА ДО ОПЛАТЫ (18.11.2026).
 *  — снимок старых постов берётся один раз; старый снимается только в сети, где уже вышел новый;
 *  — новый не вышел → старый остаётся и возвращается в карточку; TikTok → «удалите сами» со ссылкой;
 *  — Instagram без ключа удаления и отказ удаления → вручную со ссылкой; рубильник выключен → старые остаются;
 *  — повтор задания не снимает и не публикует второй раз;
 *  — очередь выпуска: ночью → утром 09:00, пять утверждений → пять разных слотов через промежуток, одновременные
 *    утверждения не берут один слот;
 *  — текст длиннее ролика не уходит в ElevenLabs (ни кнопкой агента, ни обходом).
 * Сеть подменена целиком: ни Meta, ни YouTube, ни TikTok, ни ElevenLabs не зовутся.
 */
const del = vi.hoisted(() => ({
  facebook: vi.fn(async (_id: string, _token: string) => ({ ok: true })),
  youtube: vi.fn(async (_creds: unknown, _id: string) => ({ ok: true })),
  instagram: vi.fn(async (_id: string, _token: string) => ({ ok: true })),
  generate: vi.fn(async () => ({ status: "READY" as const })),
  push: vi.fn(async () => 1),
  publish: vi.fn(),
}));
// Публикация в сети подменена: проверяется порядок «снимок → публикация → снятие» и повтор задания, не сами сети.
vi.mock("../src/lib/videoHandoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/videoHandoff.js")>()),
  publishHandoffResult: del.publish, notifyVideoHandoffPublishResult: vi.fn(async () => {}), releaseQueueIfClear: vi.fn(async () => {}),
  blockDuplicateFinalBeforePublish: vi.fn(async () => false),
}));
vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  deleteFacebookVideo: del.facebook, deleteYouTubeVideo: del.youtube, deleteInstagramMedia: del.instagram,
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  loadCredentials: vi.fn(async () => ({ pageToken: "page-token", pageId: "page-1" })),
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: del.push, sendPushToAgents: vi.fn(async () => 0),
}));
vi.mock("../src/lib/narrationGeneration.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/narrationGeneration.js")>();
  return { ...real, generateNarrationVersion: del.generate, narrationProviderReady: () => true,
    loadNarrationConfiguration: async () => ({ ...(await real.loadNarrationConfiguration()), key: "test-key-not-real" }) };
});

const { prisma } = await import("../src/db.js");
const { finishOldPostsAfterRemakePublish, finishOldPostsSweep, prepareOldPostsBeforeRemakePublish } = await import("../src/lib/remakeOldPosts.js");
const { nextNarrationSlot, DEFAULT_PUBLISH_SCHEDULE_RULES } = await import("../src/lib/publishSchedule.js");
const { schedulePublishAfterAccept, videoHandoffPublishDedupeKey } = await import("../src/lib/videoHandoff.js");
const { requestAutoNarration, runNarrationAutoFlow, NARRATION_TEXT_TOO_LONG } = await import("../src/lib/narrationAutoFlow.js");
const { setNarrationClipSecForTests, resetNarrationClipCacheForTests } = await import("../src/lib/narrationLengthCalibration.js");
const { narrationFacts, narrationHash } = await import("../src/lib/propertyNarration.js");
const { videoHandoffDir } = await import("../src/upload.js");
const { videoHandoffPublishJob } = await import("../src/jobs/videoHandoffPublish.js");
const { clipCountsAsPublished } = await import("../src/lib/publishedClip.js");

const runId = Date.now();
let districtId = "";
let agentId = "";
const propertyIds: string[] = [];
let settingsBefore: { propertyNarrationConfig: unknown; autoPublishEnabled: boolean; tiktokCreatorUsername: string | null } | null = null;
const modeBefore = process.env.CRM_NARRATION_EXECUTION_MODE;
const BASE_CONFIG = { modelId: "eleven_v4", voices: [{ id: "voiceA", name: "А" }], autoGenerate: true, templates: [{ id: "t1", name: "Т", lang: "ru", text: "Квартира, {площадь} квадратных метров. Цена {цена}." }] };

async function setConfig(extra: Record<string, unknown> = {}) {
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: { ...BASE_CONFIG, ...extra } } });
}
async function seed(channels: string[], postIds: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const p = await prisma.property.create({ data: { title: `Выпуск ${runId}-${propertyIds.length}`, type: "APARTMENT", rooms: 2, areaSqm: 58, floor: 5, price: 450000, currency: "TJS",
    districtId, address: "Тестовая, 1", condition: "GOOD", status: "AVAILABLE", intakeAgentId: agentId, publishedChannels: channels, publishedPostIds: postIds, ...extra } as never });
  propertyIds.push(p.id);
  return p;
}
async function narrationRemake(propertyId: string) {
  return prisma.videoRemakeRequest.create({ data: { propertyId, reason: "NARRATION_CHANGED", requestedById: agentId, replaceOldPostsOnPublish: true } });
}
/** Новая публикация вышла в этих сетях (то, что пишет applySucceededPublishResults). */
async function newPostsLive(propertyId: string, ids: Record<string, string>) {
  await prisma.property.update({ where: { id: propertyId }, data: { publishedChannels: Object.keys(ids), publishedPostIds: ids } });
}
const outcomeOf = async (propertyId: string) => (await prisma.videoRemakeRequest.findFirstOrThrow({ where: { propertyId }, orderBy: { createdAt: "desc" } }));

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Выпуск ${runId}` } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: `Агент выпуска ${runId}`, phone: `+992938${String(runId).slice(-6)}`, role: "AGENT", passwordHash: "x" } })).id;
  const s = await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {}, select: { propertyNarrationConfig: true, autoPublishEnabled: true, tiktokCreatorUsername: true } });
  settingsBefore = s;
  await prisma.settings.update({ where: { id: "singleton" }, data: { tiktokCreatorUsername: "royalhome", autoPublishEnabled: true, metaIgManageToken: null } });
  await setConfig();
  process.env.CRM_NARRATION_EXECUTION_MODE = "LIVE";
});

afterAll(async () => {
  process.env.CRM_NARRATION_EXECUTION_MODE = modeBefore;
  resetNarrationClipCacheForTests();
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: (settingsBefore.propertyNarrationConfig ?? {}) as object,
    autoPublishEnabled: settingsBefore.autoPublishEnabled, tiktokCreatorUsername: settingsBefore.tiktokCreatorUsername } });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: propertyIds.map(videoHandoffPublishDedupeKey) } } });
  await prisma.propertyNarrationVersion.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.videoRemakeRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("сначала новый пост, потом старый", () => {
  it("новый вышел в Facebook — старый снят по старому id; YouTube не вышел — старый остался и вернулся в карточку; TikTok — удалите сами со ссылкой", async () => {
    del.facebook.mockClear(); del.youtube.mockClear(); del.push.mockClear();
    const p = await seed(["FACEBOOK", "YOUTUBE", "TIKTOK"], { FACEBOOK: "fb-old", FACEBOOK_POST: "fbp-old", YOUTUBE: "yt-old", TIKTOK: "tt-old" });
    await narrationRemake(p.id);
    expect(await prepareOldPostsBeforeRemakePublish(p.id)).toBe(true);
    // Каналы вычеркнуты, иначе публикация пропустила бы их.
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).publishedChannels).toEqual([]);
    await newPostsLive(p.id, { FACEBOOK: "fb-new", TIKTOK: "tt-new" });
    const res = await finishOldPostsAfterRemakePublish(p.id, { failedChannels: [{ channel: "YOUTUBE" }], pendingChannels: [] });
    expect(res?.removed).toEqual(["FACEBOOK"]);
    expect(del.facebook).toHaveBeenCalledTimes(1);
    expect(del.facebook.mock.calls[0]![0]).toBe("fb-old");
    expect(del.youtube).not.toHaveBeenCalled();
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.publishedChannels.sort()).toEqual(["FACEBOOK", "TIKTOK", "YOUTUBE"]);
    expect(after.publishedPostIds).toMatchObject({ FACEBOOK: "fb-new", TIKTOK: "tt-new", YOUTUBE: "yt-old" });
    const req = await outcomeOf(p.id);
    expect(req.oldPostsReplacedAt).not.toBeNull();
    expect(req.oldPostsOutcome).toMatchObject({ FACEBOOK: { state: "OLD_REMOVED" }, YOUTUBE: { state: "NEW_FAILED" },
      TIKTOK: { state: "OLD_MANUAL", url: "https://www.tiktok.com/@royalhome/video/tt-old" } });
    expect(del.push).toHaveBeenCalledWith(agentId, expect.objectContaining({ tag: `remake-old-posts-${p.id}` }));
  });

  it("повтор задания: снимок не переписывается новыми id, второй раз ничего не снимается", async () => {
    del.facebook.mockClear();
    const p = await seed(["FACEBOOK"], { FACEBOOK: "fb-old2" });
    await narrationRemake(p.id);
    expect(await prepareOldPostsBeforeRemakePublish(p.id)).toBe(true);
    // Задание упало после публикации, до снятия: повтор.
    await newPostsLive(p.id, { FACEBOOK: "fb-new2" });
    expect(await prepareOldPostsBeforeRemakePublish(p.id)).toBe(true);
    expect((await outcomeOf(p.id)).oldPosts).toMatchObject({ postIds: { FACEBOOK: "fb-old2" } });
    // Публикация на повторе пропускает вышедший канал (он снова в карточке) — дубля нет.
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).publishedChannels).toEqual(["FACEBOOK"]);
    await finishOldPostsAfterRemakePublish(p.id, { failedChannels: [], pendingChannels: [] });
    await finishOldPostsAfterRemakePublish(p.id, { failedChannels: [], pendingChannels: [] });
    await finishOldPostsSweep();
    expect(del.facebook).toHaveBeenCalledTimes(1);
    expect(del.facebook.mock.calls[0]![0]).toBe("fb-old2");
  });

  it("Instagram ещё дозревает — ждёт; вышел — без ключа удаления старый вручную со ссылкой; отказ удаления Facebook — тоже вручную", async () => {
    del.facebook.mockClear();
    del.facebook.mockResolvedValueOnce({ ok: false, error: "сеть отказала" } as never);
    const p = await seed(["INSTAGRAM", "FACEBOOK"], { INSTAGRAM: "ig-old", FACEBOOK: "fb-old3" }, { instagramUrl: "https://www.instagram.com/reel/OLD/" });
    await narrationRemake(p.id);
    await prepareOldPostsBeforeRemakePublish(p.id);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).instagramUrl).toBeNull();
    await newPostsLive(p.id, { FACEBOOK: "fb-new3" });
    await finishOldPostsAfterRemakePublish(p.id, { failedChannels: [], pendingChannels: [{ channel: "INSTAGRAM" }] });
    let req = await outcomeOf(p.id);
    expect(req.oldPostsReplacedAt).toBeNull();
    expect(req.oldPostsOutcome).toMatchObject({ INSTAGRAM: { state: "WAITING" }, FACEBOOK: { state: "OLD_MANUAL" } });
    // Контейнер Instagram дозрел (обход отложенных контейнеров записал новый пост).
    await prisma.property.update({ where: { id: p.id }, data: { publishedChannels: ["FACEBOOK", "INSTAGRAM"], publishedPostIds: { FACEBOOK: "fb-new3", INSTAGRAM: "ig-new" }, instagramUrl: "https://www.instagram.com/reel/NEW/" } });
    await finishOldPostsSweep();
    req = await outcomeOf(p.id);
    expect(req.oldPostsReplacedAt).not.toBeNull();
    expect(req.oldPostsOutcome).toMatchObject({ INSTAGRAM: { state: "OLD_MANUAL", url: "https://www.instagram.com/reel/OLD/" } });
    expect(del.instagram).not.toHaveBeenCalled();
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).instagramUrl).toBe("https://www.instagram.com/reel/NEW/");
  });

  it("рубильник «Снимать старые посты при новой озвучке» выключен — старые остаются рядом с новыми", async () => {
    del.facebook.mockClear();
    await setConfig({ removeOldPostsOnNarration: false });
    try {
      const p = await seed(["FACEBOOK"], { FACEBOOK: "fb-old4" });
      await narrationRemake(p.id);
      await prepareOldPostsBeforeRemakePublish(p.id);
      await newPostsLive(p.id, { FACEBOOK: "fb-new4" });
      await finishOldPostsAfterRemakePublish(p.id, { failedChannels: [], pendingChannels: [] });
      expect(del.facebook).not.toHaveBeenCalled();
      expect((await outcomeOf(p.id)).oldPostsOutcome).toMatchObject({ FACEBOOK: { state: "OLD_KEPT" } });
    } finally { await setConfig(); }
  });

  it("задание публикации падает посреди публикации: старый не снят; повтор не публикует второй раз и снимает старый один раз", async () => {
    del.facebook.mockClear(); del.publish.mockReset();
    const finalName = `job-${runId}.mp4`;
    fs.mkdirSync(videoHandoffDir, { recursive: true });
    fs.writeFileSync(path.join(videoHandoffDir, finalName), "x");
    const p = await seed(["FACEBOOK"], { FACEBOOK: "fb-old-job" }, { videoHandoffStatus: "RECEIVED", status: "EDITING", videoHandoffFinalPath: `/uploads/handoff/${finalName}` });
    await narrationRemake(p.id);
    // Первый заход: Facebook успел выйти (onChannelPublished записал новый id), потом процесс упал.
    del.publish.mockImplementationOnce(async (id: string) => {
      await prisma.property.update({ where: { id }, data: { publishedChannels: ["FACEBOOK"], publishedPostIds: { FACEBOOK: "fb-new-job" } } });
      throw new Error("рестарт посреди публикации");
    });
    await expect(videoHandoffPublishJob.run({ propertyId: p.id }, {} as never)).rejects.toThrow("рестарт");
    expect(del.facebook).not.toHaveBeenCalled();
    // Ролик всё это время «вышел» для правил утверждения: каналы вычеркнуты, но снимок старых постов есть.
    expect(await clipCountsAsPublished(p.id, { publishedChannels: [], instagramUrl: null })).toBe(true);
    // Повтор: публикация видит Facebook уже вышедшим и ничего не шлёт заново.
    del.publish.mockImplementationOnce(async (id: string) => {
      const cur = await prisma.property.findUniqueOrThrow({ where: { id } });
      expect(cur.publishedChannels).toEqual(["FACEBOOK"]);
      return { attempted: true, succeededChannels: [], failedChannels: [], pendingChannels: [], notes: [], instagramUrl: null, wentAvailable: false, blockers: [] };
    });
    await videoHandoffPublishJob.run({ propertyId: p.id }, {} as never);
    expect(del.publish).toHaveBeenCalledTimes(2);
    expect(del.facebook).toHaveBeenCalledTimes(1);
    expect(del.facebook.mock.calls[0]![0]).toBe("fb-old-job");
    expect((await outcomeOf(p.id)).oldPostsReplacedAt).not.toBeNull();
    fs.rmSync(path.join(videoHandoffDir, finalName), { force: true });
  });

  it("заявке трое суток (монтаж шёл долго), Instagram дозревает — срок считается от публикации, старый не возвращается", async () => {
    const p = await seed(["INSTAGRAM"], { INSTAGRAM: "ig-old-slow" }, { instagramUrl: "https://www.instagram.com/reel/SLOW/" });
    const req = await narrationRemake(p.id);
    await prisma.videoRemakeRequest.update({ where: { id: req.id }, data: { createdAt: new Date(Date.now() - 3 * 86_400_000) } });
    await prepareOldPostsBeforeRemakePublish(p.id);
    await finishOldPostsAfterRemakePublish(p.id, { failedChannels: [], pendingChannels: [{ channel: "INSTAGRAM" }] });
    await finishOldPostsSweep(new Date(Date.now() + 3_600_000));
    let row = await outcomeOf(p.id);
    expect(row.oldPostsOutcome).toMatchObject({ INSTAGRAM: { state: "WAITING" } });
    expect(row.oldPostsCheckedAt).not.toBeNull();
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).instagramUrl).toBeNull();
    // Через двое суток после публикации так и не вышел — тогда старый возвращается и остаётся.
    await finishOldPostsSweep(new Date(Date.now() + 2 * 86_400_000 + 3_600_000));
    row = await outcomeOf(p.id);
    expect(row.oldPostsOutcome).toMatchObject({ INSTAGRAM: { state: "NEW_FAILED" } });
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).instagramUrl).toBe("https://www.instagram.com/reel/SLOW/");
  });

  it("два прохода разом (задание и обход) — старый пост снят один раз, итог по сетям не теряется", async () => {
    del.facebook.mockClear(); del.youtube.mockClear();
    const p = await seed(["FACEBOOK", "YOUTUBE"], { FACEBOOK: "fb-par", YOUTUBE: "yt-par" });
    await narrationRemake(p.id);
    await prepareOldPostsBeforeRemakePublish(p.id);
    await newPostsLive(p.id, { FACEBOOK: "fb-par-new", YOUTUBE: "yt-par-new" });
    await Promise.all([
      finishOldPostsAfterRemakePublish(p.id, { failedChannels: [], pendingChannels: [] }),
      finishOldPostsAfterRemakePublish(p.id, null),
      finishOldPostsSweep(),
    ]);
    await finishOldPostsSweep();
    expect(del.facebook).toHaveBeenCalledTimes(1);
    expect(del.youtube).toHaveBeenCalledTimes(1);
    const row = await outcomeOf(p.id);
    expect(row.oldPostsOutcome).toMatchObject({ FACEBOOK: { state: "OLD_REMOVED" }, YOUTUBE: { state: "OLD_REMOVED" } });
    expect(row.oldPostsReplacedAt).not.toBeNull();
  });

  it("обход идёт от давно не проверенных: двадцать ждущих TikTok не задерживают двадцать первую заявку", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) {
      const p = await seed(["INSTAGRAM"], { INSTAGRAM: `ig-q-${i}` }, { instagramUrl: `https://www.instagram.com/reel/Q${i}/` });
      await narrationRemake(p.id);
      await prepareOldPostsBeforeRemakePublish(p.id);
      ids.push(p.id);
    }
    await finishOldPostsSweep();
    await finishOldPostsSweep();
    const checked = await prisma.videoRemakeRequest.findMany({ where: { propertyId: { in: ids } }, select: { oldPostsCheckedAt: true } });
    expect(checked.every((r) => r.oldPostsCheckedAt !== null)).toBe(true);
  });
});

describe("миграция: без человека в сеть не выходит", () => {
  it("SQL миграции снимает утверждение с кандидатов, отказов «Оставить старый» и автоутверждённых версий вышедших роликов; утверждённое человеком и не вышедшее не трогает", async () => {
    const sql = fs.readFileSync(path.join(__dirname, "../prisma/migrations/20261118220000_narration_simple_approve/migration.sql"), "utf8");
    const data = sql.slice(sql.indexOf("-- ДАННЫЕ"));
    const at = new Date(Date.now() - 3_600_000);
    async function withVersion(published: boolean, kind: "auto" | "human" | "candidate" | "declined" | "mixed") {
      const p = await seed(published ? ["FACEBOOK"] : [], published ? { FACEBOOK: "m" } : {}, { videoHandoffStatus: "RECEIVED" });
      const fresh = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, include: { district: true } });
      const facts = narrationFacts(fresh);
      const v = await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script: "Квартира, звоните.", factsSnapshot: facts, factsHash: narrationHash(facts),
        voiceId: "voiceA", modelId: "eleven_v4", status: "READY", storageKey: `${p.id}/m.mp3`, createdById: agentId, requestKey: randomUUID(), source: "AUTO",
        approvedAt: at, approvedById: agentId, approvalNotifiedAt: kind === "auto" ? at : new Date(at.getTime() - 60_000) } });
      if (kind === "candidate") await prisma.property.update({ where: { id: p.id }, data: { narrationPreviewVersionId: v.id } });
      if (kind === "declined") await prisma.property.update({ where: { id: p.id }, data: { narrationPreviewDeclinedVersionId: v.id } });
      if (kind === "mixed") await prisma.property.update({ where: { id: p.id }, data: { videoMasterNarrationVersionId: v.id } });
      return v.id;
    }
    const reset = [await withVersion(true, "auto"), await withVersion(true, "candidate"), await withVersion(true, "declined")];
    const kept = [await withVersion(true, "human"), await withVersion(false, "auto"), await withVersion(true, "mixed")];
    for (const statement of data.split(/;\s*\n/).map((x) => x.trim()).filter((x) => x.replace(/--[^\n]*\n?/g, "").trim())) await prisma.$executeRawUnsafe(statement);
    for (const id of reset) expect((await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id } })).approvedAt).toBeNull();
    for (const id of kept) expect((await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id } })).approvedAt).not.toBeNull();
  });

  it("«Оставить старый» держит версию, пока её не утвердит человек; утвердил — отметка отказа снята", async () => {
    const { approveNarrationVersion } = await import("../src/lib/narrationAutoFlow.js");
    const p = await seed(["FACEBOOK"], { FACEBOOK: "d" }, { videoHandoffStatus: "RECEIVED" });
    const fresh = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, include: { district: true } });
    const facts = narrationFacts(fresh);
    const v = await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script: "Квартира, звоните.", factsSnapshot: facts, factsHash: narrationHash(facts),
      voiceId: "voiceA", modelId: "eleven_v4", status: "READY", storageKey: `${p.id}/d.mp3`, createdById: agentId, requestKey: randomUUID(), source: "AUTO" } });
    await prisma.property.update({ where: { id: p.id }, data: { narrationPreviewDeclinedVersionId: v.id } });
    expect(await approveNarrationVersion({ propertyId: p.id, versionId: v.id, expectedRevision: 1, actorId: agentId, isManager: false })).toBe("AUDIO_APPROVED");
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).narrationPreviewDeclinedVersionId).toBeNull();
  });
});

describe("очередь выпуска новой озвучки", () => {
  // 18.11.2026 по Душанбе = UTC+5.
  const at = (hhmm: string, day = "2026-11-18") => new Date(`${day}T${hhmm}:00+05:00`);
  const rules = DEFAULT_PUBLISH_SCHEDULE_RULES;

  it("днём — сразу; ночью — утром в 09:00", () => {
    expect(nextNarrationSlot(at("14:00"), [], rules, 15).at.toISOString()).toBe(at("14:00").toISOString());
    const night = nextNarrationSlot(at("23:10"), [], rules, 15);
    expect(night.at.toISOString()).toBe(at("09:00", "2026-11-19").toISOString());
    expect(night.reason).toContain("утром в 09:00");
    expect(night.reason).not.toContain("—");
    expect(nextNarrationSlot(at("06:30"), [], rules, 15).at.toISOString()).toBe(at("09:00").toISOString());
  });

  it("пять утверждений сразу — пять разных слотов через 15 минут, обычный слот рядом соблюдается", () => {
    const occupied: Date[] = [at("14:05")]; // обычный ролик по сетке
    const slots: Date[] = [];
    for (let i = 0; i < 5; i++) {
      const s = nextNarrationSlot(at("14:00"), occupied, rules, 15).at;
      slots.push(s); occupied.push(s);
    }
    expect(new Set(slots.map((s) => s.getTime())).size).toBe(5);
    for (const s of slots) for (const o of occupied) if (o !== s) expect(Math.abs(s.getTime() - o.getTime())).toBeGreaterThanOrEqual(15 * 60_000);
    expect(slots[0]!.getTime()).toBeGreaterThanOrEqual(at("14:20").getTime());
  });

  it("два утверждения в одну секунду — разные слоты (общий замок), повтор постановки не плодит заданий", async () => {
    const a = await seed([], {}, { videoHandoffStatus: "RECEIVED", status: "EDITING" });
    const b = await seed([], {}, { videoHandoffStatus: "RECEIVED", status: "EDITING" });
    await narrationRemake(a.id); await narrationRemake(b.id);
    const [ra, rb] = await Promise.all([schedulePublishAfterAccept(a.id), schedulePublishAfterAccept(b.id)]);
    expect(ra.scheduledPublishAt && rb.scheduledPublishAt).toBeTruthy();
    expect(Math.abs(ra.scheduledPublishAt!.getTime() - rb.scheduledPublishAt!.getTime())).toBeGreaterThanOrEqual(15 * 60_000);
    const reason = (await prisma.property.findUniqueOrThrow({ where: { id: a.id } })).scheduledPublishReason ?? "";
    expect(reason).toMatch(/ролик выходит сразу|выйдет утром|Перед ним в очереди/);
    await schedulePublishAfterAccept(a.id);
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: videoHandoffPublishDedupeKey(a.id) } })).toBe(1);
  });
});

describe("длина текста до оплаты", () => {
  const LONG = "Квартира в Душанбе. ".repeat(40);
  it("агент прислал текст длиннее ролика — отказ с понятной строкой, версия не создана", async () => {
    const p = await seed(["FACEBOOK"], { FACEBOOK: "x" }, { videoHandoffStatus: "RECEIVED", videoHandoffFinalPath: `/uploads/handoff/len-${runId}.mp4` });
    setNarrationClipSecForTests(path.join(videoHandoffDir, `len-${runId}.mp4`), 20);
    const out = await requestAutoNarration({ propertyId: p.id, actorId: agentId, source: "AGENT", script: LONG, templateId: "t1", voiceId: "voiceA", debounceMs: 0 });
    expect(out.status).toBe("INVALID");
    expect(out.status === "INVALID" && out.error).toMatch(/Длиннее ролика на \d+ с\. Сократите текст/);
    expect(await prisma.propertyNarrationVersion.count({ where: { propertyId: p.id } })).toBe(0);
    // Короткий текст проходит.
    const ok = await requestAutoNarration({ propertyId: p.id, actorId: agentId, source: "AGENT", script: "Квартира в Душанбе, звоните.", templateId: "t1", voiceId: "voiceA", debounceMs: 0 });
    expect(ok.status).toBe("QUEUED");
  });

  it("обход: черновик длиннее ролика не уходит в ElevenLabs — версия «длиннее ролика», денег не потрачено", async () => {
    del.generate.mockClear();
    const p = await seed(["FACEBOOK"], { FACEBOOK: "y" }, { videoHandoffStatus: "RECEIVED", videoHandoffFinalPath: `/uploads/handoff/len2-${runId}.mp4` });
    setNarrationClipSecForTests(path.join(videoHandoffDir, `len2-${runId}.mp4`), 20);
    const fresh = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, include: { district: true } });
    const facts = narrationFacts(fresh);
    const v = await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script: LONG, factsSnapshot: facts, factsHash: narrationHash(facts), voiceId: "voiceA",
      modelId: "eleven_v4", templateId: "t1", language: "ru", status: "DRAFT", generateAfter: new Date(Date.now() - 1000), createdById: agentId, requestKey: randomUUID(), source: "AUTO" } });
    await runNarrationAutoFlow();
    expect(del.generate).not.toHaveBeenCalledWith(expect.objectContaining({ versionId: v.id }));
    const row = await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: v.id } });
    expect(row).toMatchObject({ status: "FAILED", errorCode: NARRATION_TEXT_TOO_LONG, generateAfter: null });
  });
});

describe("напоминание об утверждении, когда ролик уже вышел", () => {
  it("одно напоминание через сутки, без руководителя; через 4 часа — ничего", async () => {
    const { remindPendingNarrationApprovals } = await import("../src/telegram/assistantNarration.js");
    const now = new Date("2026-11-18T12:00:00+05:00");
    const p = await seed(["FACEBOOK"], { FACEBOOK: "r" }, { videoHandoffStatus: "RECEIVED", assignedAgentId: agentId });
    const fresh = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, include: { district: true } });
    const facts = narrationFacts(fresh);
    const v = await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script: "Квартира, звоните.", factsSnapshot: facts, factsHash: narrationHash(facts),
      voiceId: "voiceA", modelId: "eleven_v4", status: "READY", storageKey: `${p.id}/r.mp3`, createdById: agentId, requestKey: randomUUID(), source: "AUTO",
      approvalNotifiedAt: new Date(now.getTime() - 4 * 3_600_000) } });
    await remindPendingNarrationApprovals(now);
    expect((await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: v.id } })).approvalRemindedAt).toBeNull();
    await prisma.propertyNarrationVersion.update({ where: { id: v.id }, data: { approvalNotifiedAt: new Date(now.getTime() - 25 * 3_600_000) } });
    await remindPendingNarrationApprovals(now);
    const once = await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: v.id } });
    expect(once.approvalRemindedAt).not.toBeNull();
    // Второй проход через сутки — ни повтора, ни руководителю (approvalEscalatedAt ставится сразу).
    await remindPendingNarrationApprovals(new Date(now.getTime() + 24 * 3_600_000));
    expect((await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: v.id } })).approvalRemindedAt?.getTime()).toBe(once.approvalRemindedAt!.getTime());
    expect(once.approvalEscalatedAt).not.toBeNull();
  });
});

describe("новая озвучка сразу после правки карточки", () => {
  it("цена поменялась — черновик сейчас, пауза не больше 30 с; ремонт поменялся — озвучка не нужна", async () => {
    const { requestNarrationAfterEdit, NARRATION_AFTER_EDIT_DEBOUNCE_MS } = await import("../src/lib/narrationAutoFlow.js");
    const p = await seed(["FACEBOOK"], { FACEBOOK: "e" });
    const fresh = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, include: { district: true } });
    const facts = narrationFacts(fresh);
    await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script: "Квартира, звоните.", factsSnapshot: facts, factsHash: narrationHash(facts), voiceId: "voiceA",
      modelId: "eleven_v4", templateId: "t1", status: "READY", approvedAt: new Date(), approvedById: agentId, createdById: agentId, requestKey: randomUUID(), source: "AUTO" } });
    await prisma.property.update({ where: { id: p.id }, data: { condition: "EXCELLENT" } });
    expect(await requestNarrationAfterEdit(p.id)).toBeNull();
    await prisma.property.update({ where: { id: p.id }, data: { price: 470000 } });
    const now = new Date();
    const out = await requestNarrationAfterEdit(p.id, now);
    expect(out?.status).toBe("QUEUED");
    const draft = await prisma.propertyNarrationVersion.findFirstOrThrow({ where: { propertyId: p.id }, orderBy: { revision: "desc" } });
    expect(draft.status).toBe("DRAFT");
    expect(draft.generateAfter!.getTime() - now.getTime()).toBeLessThanOrEqual(NARRATION_AFTER_EDIT_DEBOUNCE_MS);
  });
});

describe("вторая замена, пока первая не закрыта (второе ревью 18.11)", () => {
  it("А вышла в Facebook и YouTube, TikTok ждёт повтора; утвердили Б — свежий снимок, посты А «старые», старый TikTok перенесён, Б выходит во все сети", async () => {
    const { openReplacement } = await import("../src/lib/remakeRequests.js");
    const { tiktokPublishRetryDedupeKey } = await import("../src/jobs/tiktokPublishRetryPolicy.js");
    del.facebook.mockClear(); del.youtube.mockClear();
    const p = await seed(["FACEBOOK", "YOUTUBE", "TIKTOK"], { FACEBOOK: "fb-0", YOUTUBE: "yt-0", TIKTOK: "tt-0" });
    const r1 = await narrationRemake(p.id);
    await prepareOldPostsBeforeRemakePublish(p.id);
    await newPostsLive(p.id, { FACEBOOK: "fb-A", YOUTUBE: "yt-A" });
    await finishOldPostsAfterRemakePublish(p.id, { failedChannels: [], pendingChannels: [{ channel: "TIKTOK" }] });
    expect((await prisma.videoRemakeRequest.findUniqueOrThrow({ where: { id: r1.id } })).oldPostsOutcome).toMatchObject({ TIKTOK: { state: "WAITING" } });
    expect(del.facebook.mock.calls.map((c) => c[0])).toEqual(["fb-0"]);
    await prisma.backgroundJob.create({ data: { type: "tiktok-publish-retry", payload: { propertyId: p.id }, dedupeKey: tiktokPublishRetryDedupeKey(p.id), status: "PENDING", maxAttempts: 3, runAt: new Date(Date.now() + 3_600_000) } });

    // Цена снова поменялась, утвердили Б: одна дверь замены.
    const r2 = await prisma.$transaction((tx) => openReplacement(tx, { propertyId: p.id, reason: "NARRATION_CHANGED", requestedById: agentId }));
    expect(r2.reused).toBe(false);
    expect((await prisma.videoRemakeRequest.findUniqueOrThrow({ where: { id: r1.id } })).oldPostsReplacedAt).not.toBeNull();
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: tiktokPublishRetryDedupeKey(p.id), status: "PENDING" } })).toBe(0);
    expect(await prepareOldPostsBeforeRemakePublish(p.id)).toBe(true);
    // Все сети свободны для Б: публикация ничего не пропустит.
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).publishedChannels).toEqual([]);
    await newPostsLive(p.id, { FACEBOOK: "fb-B", YOUTUBE: "yt-B", TIKTOK: "tt-B" });
    del.facebook.mockClear(); del.youtube.mockClear();
    await finishOldPostsAfterRemakePublish(p.id, { failedChannels: [], pendingChannels: [] });
    expect(del.facebook.mock.calls.map((c) => c[0])).toEqual(["fb-A"]);
    expect(del.youtube.mock.calls.map((c) => c[1])).toEqual(["yt-A"]);
    const done = await prisma.videoRemakeRequest.findUniqueOrThrow({ where: { id: r2.id } });
    expect(done.oldPostsReplacedAt).not.toBeNull();
    // Старый TikTok (ещё от исходного ролика) — вручную, ссылкой на него.
    expect(done.oldPostsOutcome).toMatchObject({ FACEBOOK: { state: "OLD_REMOVED" }, YOUTUBE: { state: "OLD_REMOVED" },
      TIKTOK: { state: "OLD_MANUAL", url: "https://www.tiktok.com/@royalhome/video/tt-0" } });
  });

  it("публикация ещё не началась — заявка та же (без дублей), возврат монтажёру только пишется в историю", async () => {
    const { openReplacement } = await import("../src/lib/remakeRequests.js");
    const p = await seed(["FACEBOOK"], { FACEBOOK: "fb-d" });
    const a = await prisma.$transaction((tx) => openReplacement(tx, { propertyId: p.id, reason: "CARD_DATA_CHANGED", requestedById: agentId }));
    const b = await prisma.$transaction((tx) => openReplacement(tx, { propertyId: p.id, reason: "NARRATION_CHANGED", requestedById: agentId }));
    expect(b).toMatchObject({ id: a.id, reused: true });
    expect(await prisma.videoRemakeRequest.count({ where: { propertyId: p.id, replaceOldPostsOnPublish: true, oldPostsReplacedAt: null } })).toBe(1);
    // Новая озвучка поверх возврата: очередь новой озвучки.
    expect((await prisma.videoRemakeRequest.findUniqueOrThrow({ where: { id: a.id } })).reason).toBe("NARRATION_CHANGED");
  });

  it("старые дубли открытых заявок одного объекта: обход сливает их в последнюю и закрывает, отметка проверки у всех", async () => {
    del.facebook.mockClear();
    const p = await seed(["FACEBOOK"], { FACEBOOK: "fb-old-dup" });
    const older = await narrationRemake(p.id);
    await prepareOldPostsBeforeRemakePublish(p.id);
    // Дубль из прежнего кода: вторая открытая заявка, снимок взят позже (старый пост первой ещё висит).
    await newPostsLive(p.id, { FACEBOOK: "fb-mid" });
    await prisma.videoRemakeRequest.create({ data: { propertyId: p.id, reason: "NARRATION_CHANGED", requestedById: agentId, replaceOldPostsOnPublish: true, createdAt: new Date(Date.now() + 1000),
      oldPosts: { channels: ["FACEBOOK"], main: ["FACEBOOK"], postIds: { FACEBOOK: "fb-mid" }, instagramUrl: null, takenAt: new Date().toISOString() }, oldPostsOutcome: { FACEBOOK: { state: "WAITING" } } } });
    await newPostsLive(p.id, { FACEBOOK: "fb-new-dup" });
    await finishOldPostsSweep();
    expect((await prisma.videoRemakeRequest.findUniqueOrThrow({ where: { id: older.id } })).oldPostsReplacedAt).not.toBeNull();
    expect(del.facebook.mock.calls.map((c) => c[0]).sort()).toEqual(["fb-mid", "fb-old-dup"]);
    expect(await prisma.videoRemakeRequest.count({ where: { propertyId: p.id, replaceOldPostsOnPublish: true, oldPostsReplacedAt: null } })).toBe(0);
  });
});

describe("«ролик вышел» — одна дверь", () => {
  it("никакой другой файл не считает «вышел» руками: только lib/publishedClip.ts", () => {
    const root = path.join(__dirname, "../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "generated") walk(full); continue; }
        if (!/\.ts$/.test(entry.name) || full.endsWith(path.join("lib", "publishedClip.ts"))) continue;
        const text = fs.readFileSync(full, "utf8");
        if (/publishedChannels\??\.length\s*\?\?\s*0\)\s*>\s*0\s*\|\|[^\n]*instagramUrl/.test(text)) offenders.push(path.relative(root, full));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe("подмена ролика второй озвучкой идёт через ту же дверь", () => {
  it("replaceFinalWithMix при открытой замене со снимком открывает новую, прежнюю закрывает", async () => {
    const { replaceFinalWithMix } = await import("../src/lib/narrationPreview.js");
    const p = await seed(["FACEBOOK"], { FACEBOOK: "fb-r0" }, { videoHandoffStatus: "RECEIVED" });
    const r1 = await narrationRemake(p.id);
    await prepareOldPostsBeforeRemakePublish(p.id);
    await newPostsLive(p.id, { FACEBOOK: "fb-rA" });
    await prisma.$transaction((tx) => replaceFinalWithMix(tx, { propertyId: p.id, publicPath: "/uploads/handoff/x.mp4", versionId: randomUUID(), revision: 3, requestedById: agentId, published: true }));
    const open = await prisma.videoRemakeRequest.findMany({ where: { propertyId: p.id, replaceOldPostsOnPublish: true, oldPostsReplacedAt: null } });
    expect(open).toHaveLength(1);
    expect(open[0]!.id).not.toBe(r1.id);
    expect(open[0]!.oldPosts).toBeNull();
  });
});

describe("третье ревью 18.11", () => {
  it("заявки на замену пишет только lib/remakeRequests.ts (нет обходной двери)", () => {
    const root = path.join(__dirname, "../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "generated") walk(full); continue; }
        if (!/\.ts$/.test(entry.name) || full.endsWith(path.join("lib", "remakeRequests.ts"))) continue;
        if (/videoRemakeRequest\.(create|createMany|upsert)\s*\(/.test(fs.readFileSync(full, "utf8"))) offenders.push(path.relative(root, full));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it("старые данные: R1 со снимком и более новая R2 без снимка — обход R2 не закрывает; её снимок забирает старые посты R1", async () => {
    del.facebook.mockClear();
    const p = await seed(["FACEBOOK"], { FACEBOOK: "fb-o1" });
    const r1 = await narrationRemake(p.id);
    await prepareOldPostsBeforeRemakePublish(p.id);
    await finishOldPostsAfterRemakePublish(p.id, { failedChannels: [], pendingChannels: [{ channel: "FACEBOOK" }] });
    // Прежний код: возврат монтажёру завёл R2 поверх идущей R1.
    const r2 = await prisma.videoRemakeRequest.create({ data: { propertyId: p.id, reason: "CARD_DATA_CHANGED", requestedById: agentId, replaceOldPostsOnPublish: true, createdAt: new Date(Date.now() + 1000) } });
    await finishOldPostsAfterRemakePublish(p.id, null);
    expect((await prisma.videoRemakeRequest.findUniqueOrThrow({ where: { id: r2.id } })).oldPostsReplacedAt).toBeNull();
    await newPostsLive(p.id, { FACEBOOK: "fb-a1" });
    expect(await prepareOldPostsBeforeRemakePublish(p.id)).toBe(true);
    expect((await prisma.videoRemakeRequest.findUniqueOrThrow({ where: { id: r1.id } })).oldPostsReplacedAt).not.toBeNull();
    await newPostsLive(p.id, { FACEBOOK: "fb-b1" });
    await finishOldPostsAfterRemakePublish(p.id, { failedChannels: [], pendingChannels: [] });
    expect(del.facebook.mock.calls.map((c) => c[0]).sort()).toEqual(["fb-a1", "fb-o1"]);
    expect((await prisma.videoRemakeRequest.findUniqueOrThrow({ where: { id: r2.id } })).oldPostsReplacedAt).not.toBeNull();
  });

  it("А не вышла нигде, утвердили Б: перенесённые старые посты держат «ролик вышел»", async () => {
    const p = await seed([], {});
    await prisma.videoRemakeRequest.create({ data: { propertyId: p.id, reason: "NARRATION_CHANGED", requestedById: agentId, replaceOldPostsOnPublish: true,
      carriedOldPosts: [{ channel: "TIKTOK", postIds: { TIKTOK: "tt-c" }, instagramUrl: null }] } });
    expect(await clipCountsAsPublished(p.id, { publishedChannels: [], instagramUrl: null })).toBe(true);
  });

  it("самоодобрение на вышедшем ролике снова у человека (сообщение уйдёт заново); на невышедшем не трогается", async () => {
    const { reopenAutoApprovalsOnPublishedClips } = await import("../src/lib/narrationPreview.js");
    const at = new Date(Date.now() - 60_000);
    const mk = async (published: boolean) => {
      const p = await seed(published ? ["FACEBOOK"] : [], published ? { FACEBOOK: "z" } : {}, { videoHandoffStatus: "RECEIVED" });
      const fresh = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, include: { district: true } });
      const facts = narrationFacts(fresh);
      return (await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script: "Квартира, звоните.", factsSnapshot: facts, factsHash: narrationHash(facts),
        voiceId: "voiceA", modelId: "eleven_v4", status: "READY", storageKey: `${p.id}/z.mp3`, createdById: agentId, requestKey: randomUUID(), source: "AUTO",
        approvedAt: at, approvedById: agentId, approvalNotifiedAt: at } })).id;
    };
    const pub = await mk(true), notPub = await mk(false);
    await reopenAutoApprovalsOnPublishedClips();
    expect(await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: pub } })).toMatchObject({ approvedAt: null, approvalNotifiedAt: null });
    expect((await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: notPub } })).approvedAt).not.toBeNull();
  });
});
