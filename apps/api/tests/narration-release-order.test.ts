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

  it("задание публикации: снимок до publishHandoffResult, снятие — после (порядок закреплён)", () => {
    const src = fs.readFileSync(path.join(__dirname, "../src/jobs/videoHandoffPublish.ts"), "utf8");
    const prep = src.indexOf("prepareOldPostsBeforeRemakePublish(property.id)");
    const pub = src.indexOf("publishHandoffResult(property.id");
    const fin = src.indexOf("finishOldPostsAfterRemakePublish(property.id, summary)");
    expect(prep).toBeGreaterThan(0);
    expect(prep).toBeLessThan(pub);
    expect(pub).toBeLessThan(fin);
    expect(src).not.toContain("replaceOldPostsBeforeRemakePublish");
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
