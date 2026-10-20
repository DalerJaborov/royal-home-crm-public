import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirstSecondsPost } from "@royal-home/shared";

/**
 * «Первые секунды ролика» (24.09.2026): удержание по площадкам, сравнение
 * групп по началу ролика, разбор начала ИИ и постановка разбора с экрана.
 * Сеть, ffmpeg и ИИ подменены; база настоящая.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-first-seconds-"));
const videoFile = path.join(tmpDir, "final.mp4");

const ai = vi.hoisted(() => ({ answer: null as unknown, calls: [] as { images?: unknown[] }[] }));
const frames = vi.hoisted(() => ({ ok: true, count: 0 }));
const stats = vi.hoisted(() => ({ posts: [] as unknown[] }));

vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: vi.fn(async (params: { images?: unknown[] }) => {
    ai.calls.push(params);
    return ai.answer;
  }),
}));

vi.mock("../src/lib/ffmpeg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ffmpeg.js")>()),
  probeDurationSec: vi.fn(async () => 12),
  tryRunFfmpeg: vi.fn(async (opts: { args: string[] }) => {
    if (!frames.ok) return null;
    frames.count++;
    fs.writeFileSync(opts.args[opts.args.length - 1], Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return { stdout: "", stderr: "", code: 0 };
  }),
}));

vi.mock("../src/lib/videoHandoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/videoHandoff.js")>()),
  videoHandoffFinalDiskPath: vi.fn((p: string) => (p.endsWith("gone.mp4") ? path.join(tmpDir, "gone.mp4") : videoFile)),
}));

vi.mock("../src/lib/postStats.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/postStats.js")>()),
  loadPostStats: vi.fn(async () => ({ fetchedAt: new Date().toISOString(), platforms: [], posts: stats.posts, byHour: [] })),
}));

import { prisma } from "../src/db.js";
import { normalizeSkipRate } from "../src/lib/postStats.js";
import { compareOpenings, loadFirstSeconds, retentionOf } from "../src/lib/firstSeconds.js";
import { analyzeVideoOpening, openingFrameTimes } from "../src/jobs/videoOpening.js";

const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
let districtId: string;
let propertyId: string;
let propertyShortId: number;
const videoPath = `/uploads/handoff/fs-${runId}.mp4`;

function stat(channel: string, over: Partial<{ avgWatchSec: number; skipRate: number; watchedShare: number; views: number }>) {
  return {
    channel,
    views: over.views ?? null,
    likes: null,
    comments: null,
    url: null,
    avgWatchSec: over.avgWatchSec ?? null,
    skipRate: over.skipRate ?? null,
    watchedShare: over.watchedShare ?? null,
  };
}

beforeAll(async () => {
  fs.writeFileSync(videoFile, "video");
  districtId = (await prisma.district.create({ data: { name: `Тест-район-секунды-${runId}` } })).id;
  const p = await prisma.property.create({
    data: {
      title: `Первые секунды ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 2",
      condition: "GOOD",
      videoHandoffFinalPath: videoPath,
    },
  });
  propertyId = p.id;
  propertyShortId = p.shortId;
});

beforeEach(() => {
  ai.answer = null;
  ai.calls = [];
  frames.ok = true;
  frames.count = 0;
  stats.posts = [];
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: `video-opening:${propertyId}` } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("удержание по площадкам", () => {
  it("доля ушедших у Instagram приходит процентами — приводим к доле", () => {
    expect(normalizeSkipRate(42.5)).toBeCloseTo(0.425);
    expect(normalizeSkipRate(0.3)).toBeCloseTo(0.3);
    expect(normalizeSkipRate("12")).toBeCloseTo(0.12);
    expect(normalizeSkipRate(4250)).toBeNull();
    expect(normalizeSkipRate(null)).toBeNull();
  });

  it("досмотренная доля: YouTube отдаёт сам, Instagram — время на длину ролика, круг по кругу — не больше 1", () => {
    const r = retentionOf(
      [stat("INSTAGRAM", { avgWatchSec: 6, skipRate: 0.4 }), stat("YOUTUBE", { avgWatchSec: 9, watchedShare: 0.5 })],
      12
    );
    expect(r.skipRate).toBeCloseTo(0.4);
    expect(r.avgWatchSec).toBeCloseTo(7.5);
    expect(r.watchedShare).toBeCloseTo((6 / 12 + 0.5) / 2);

    expect(retentionOf([stat("INSTAGRAM", { avgWatchSec: 30 })], 12).watchedShare).toBe(1);
    // Длина ролика неизвестна — доли по Instagram нет, среднее время есть.
    const noDuration = retentionOf([stat("INSTAGRAM", { avgWatchSec: 6 })], null);
    expect(noDuration.watchedShare).toBeNull();
    expect(noDuration.avgWatchSec).toBe(6);
  });
});

describe("какое начало досматривают", () => {
  const post = (i: number, firstShot: "KITCHEN" | "FACADE", share: number, hasPerson = false): FirstSecondsPost => ({
    propertyId: `p${i}`,
    shortId: i,
    title: `Объект ${i}`,
    views: 100,
    skipRate: null,
    avgWatchSec: null,
    watchedShare: share,
    opening: { firstShot, hasPerson, hasText: false, hookScore: 5, note: "", tip: null, durationSec: 12 },
    openingMissing: null,
  });

  it("меньше шести роликов — выводов нет", () => {
    const res = compareOpenings([post(1, "KITCHEN", 0.8), post(2, "FACADE", 0.2)]);
    expect(res.counted).toBe(2);
    expect(res.factors).toEqual([]);
  });

  it("кухня первой держит дольше фасада — лучшая группа «кухня»", () => {
    const posts = [
      post(1, "KITCHEN", 0.7, true),
      post(2, "KITCHEN", 0.8, true),
      post(3, "KITCHEN", 0.6),
      post(4, "FACADE", 0.2),
      post(5, "FACADE", 0.3),
      post(6, "FACADE", 0.25, true),
    ];
    const res = compareOpenings(posts);
    expect(res.counted).toBe(6);
    const shot = res.factors.find((f) => f.key === "firstShot");
    expect(shot?.best).toBe("кухня");
    expect(shot?.sample).toBe(3);
    expect(shot?.bestShare).toBeCloseTo(0.7);
    // Надпись у всех одинаковая — признак ничего не различает и не показывается.
    expect(res.factors.find((f) => f.key === "text")).toBeUndefined();
  });

  it("ролик без разбора или без цифры удержания в сравнение не идёт", () => {
    const posts = [1, 2, 3, 4, 5, 6].map((i) => post(i, i % 2 ? "KITCHEN" : "FACADE", 0.5));
    posts[0] = { ...posts[0], opening: null, openingMissing: "pending" };
    posts[1] = { ...posts[1], watchedShare: null };
    expect(compareOpenings(posts).counted).toBe(4);
  });
});

describe("разбор начала ролика", () => {
  it("кадры берутся в пределах ролика", () => {
    expect(openingFrameTimes(12)).toEqual([0.2, 1.5, 3]);
    expect(openingFrameTimes(2)).toEqual([0.2, 1.5, 1.9]);
    expect(openingFrameTimes(null)).toEqual([0.2, 1.5, 3]);
  });

  it("три кадра уходят ИИ одним вызовом, итог записан; неизвестный план — «другое»", async () => {
    ai.answer = { firstShot: "KITCHEN", hasPerson: false, hasText: true, hookScore: 12, note: " Светлая  кухня ", tip: "" };
    expect(await analyzeVideoOpening({ propertyId, videoPath })).toBe("ok");
    expect(frames.count).toBe(3);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].images).toHaveLength(3);
    const row = await prisma.videoOpening.findUnique({ where: { propertyId_videoPath: { propertyId, videoPath } } });
    expect(row).toMatchObject({ status: "OK", firstShot: "KITCHEN", hasText: true, hookScore: 10, note: "Светлая кухня", tip: null, durationSec: 12 });

    ai.answer = { firstShot: "SPACESHIP", hasPerson: false, hasText: false, hookScore: 3, note: "что-то" };
    expect(await analyzeVideoOpening({ propertyId, videoPath })).toBe("ok");
    const again = await prisma.videoOpening.findUnique({ where: { propertyId_videoPath: { propertyId, videoPath } } });
    expect(again?.firstShot).toBe("OTHER");
    expect(await prisma.videoOpening.count({ where: { propertyId } })).toBe(1);
  });

  it("ИИ не ответил — строка FAILED, не падение; кадры не достались — ИИ не зовём", async () => {
    ai.answer = null;
    expect(await analyzeVideoOpening({ propertyId, videoPath })).toBe("failed");
    expect((await prisma.videoOpening.findUnique({ where: { propertyId_videoPath: { propertyId, videoPath } } }))?.status).toBe("FAILED");

    frames.ok = false;
    ai.calls = [];
    expect(await analyzeVideoOpening({ propertyId, videoPath })).toBe("failed");
    expect(ai.calls).toHaveLength(0);
  });

  it("у объекта уже другой ролик — старый файл не разбираем", async () => {
    expect(await analyzeVideoOpening({ propertyId, videoPath: "/uploads/handoff/old.mp4" })).toBe("stale");
    expect(await prisma.videoOpening.count({ where: { propertyId, videoPath: "/uploads/handoff/old.mp4" } })).toBe(0);
  });
});

describe("экран «Первые секунды»", () => {
  it("не разобранный ролик ставится в очередь один раз, разобранный показывается с удержанием", async () => {
    await prisma.videoOpening.deleteMany({ where: { propertyId } });
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: `video-opening:${propertyId}` } });
    stats.posts = [
      {
        propertyId,
        shortId: propertyShortId,
        title: `Первые секунды ${runId}`,
        publishedAt: null,
        publishHour: null,
        stats: [stat("INSTAGRAM", { views: 500, avgWatchSec: 3, skipRate: 0.6 })],
      },
    ];

    const first = await loadFirstSeconds();
    const mine = first.posts.find((p) => p.propertyId === propertyId)!;
    expect(mine.openingMissing).toBe("pending");
    expect(mine.skipRate).toBeCloseTo(0.6);
    expect(first.pending).toBe(1);
    await loadFirstSeconds();
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: `video-opening:${propertyId}` } })).toBe(1);

    ai.answer = { firstShot: "FACADE", hasPerson: false, hasText: false, hookScore: 3, note: "Дом снаружи издалека", tip: "Начать с гостиной" };
    await analyzeVideoOpening({ propertyId, videoPath });
    const second = await loadFirstSeconds();
    const done = second.posts.find((p) => p.propertyId === propertyId)!;
    expect(done.openingMissing).toBeNull();
    expect(done.opening).toMatchObject({ firstShot: "FACADE", tip: "Начать с гостиной", durationSec: 12 });
    // 3 с из 12 — досматривают четверть.
    expect(done.watchedShare).toBeCloseTo(0.25);
    expect(second.retentionAvailable).toBe(true);
  });

  it("файла ролика нет на сервере — «нет файла», в очередь не ставим", async () => {
    await prisma.property.update({ where: { id: propertyId }, data: { videoHandoffFinalPath: "/uploads/handoff/gone.mp4" } });
    try {
      expect(await analyzeVideoOpening({ propertyId, videoPath: "/uploads/handoff/gone.mp4" })).toBe("no-file");
      stats.posts = [
        { propertyId, shortId: propertyShortId, title: "x", publishedAt: null, publishHour: null, stats: [] },
      ];
      const res = await loadFirstSeconds();
      expect(res.posts[0].openingMissing).toBe("no-file");
      expect(res.pending).toBe(0);
    } finally {
      await prisma.property.update({ where: { id: propertyId }, data: { videoHandoffFinalPath: videoPath } });
    }
  });
});
