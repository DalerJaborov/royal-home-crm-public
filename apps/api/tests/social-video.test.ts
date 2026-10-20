import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import {
  SOCIAL_VIDEO_CHANNELS,
  SOCIAL_VIDEO_LIMITS,
  evaluateVideoForChannel,
  type SocialVideoChannel,
  type SocialVideoChannelInfo,
  type SocialVideoFacts,
} from "@royal-home/shared";

vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  publishApprovedPost: vi.fn(),
}));
vi.mock("../src/lib/socialVideoChannels.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialVideoChannels.js")>()),
  loadChannelInfos: vi.fn(),
  loadChannelLive: vi.fn(),
  // Токен аккаунта и чат Telegram подставляет сервис, у стенда их нет — детерминированная подмена.
  resolveInstagramTarget: vi.fn(async (accountId: string | null) =>
    accountId ? { key: `INSTAGRAM:${accountId}`, token: `tok-${accountId}`, label: accountId } : { key: "INSTAGRAM", token: "tok-default", label: "основной" }
  ),
  resolveTelegramTarget: vi.fn(async (chatId: string) => ({ key: `TELEGRAM:${chatId}`, chatId, label: chatId })),
}));
vi.mock("../src/lib/socialVideoTrends.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialVideoTrends.js")>()),
  getSocialVideoTrends: vi.fn(async () => ({ digest: ["тест-тренд"], updatedAt: new Date().toISOString(), source: "FALLBACK", sources: [] })),
}));
vi.mock("../src/lib/socialVideoFrame.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialVideoFrame.js")>()),
  extractVideoFrameJpeg: vi.fn(async () => null),
}));
vi.mock("../src/lib/socialVideoAi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialVideoAi.js")>()),
  generateSocialVideoCaptions: vi.fn(),
  generateSocialVideoCoverImage: vi.fn(),
}));

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 1),
}));

import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { uploadsDir } from "../src/upload.js";
import { publishApprovedPost, type PublishResult } from "../src/lib/socialPublish.js";
import { loadChannelInfos, loadChannelLive } from "../src/lib/socialVideoChannels.js";
import { generateSocialVideoCaptions, generateSocialVideoCoverImage, SocialVideoAiError } from "../src/lib/socialVideoAi.js";
import {
  SOCIAL_VIDEO_PUBLISH_JOB_TYPE,
  finalStatusOf,
  normalizeDestinations,
  parseDestinations,
  runSocialVideoPublish,
  runSocialVideoScheduleTick,
} from "../src/lib/socialVideoPosts.js";
import { updateOwnerMarks } from "../src/lib/publishedMarks.js";
import { sendPushToAgent } from "../src/push.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Свободные ролики в соцсети (12.10.2026): промо-ролик без объекта, публикация сразу и по
 * расписанию, каналы по выбору. Проверяем доступ ролей, загрузку и разбор файла, правила
 * пригодности ролика каналу (одна функция на сервер и экран), запуск публикации (без
 * двойного захода), запись исхода по каждому каналу, повтор упавшего, расписание,
 * оборванные публикации, обложки трёх видов, ИИ-подписи и охранитель публикатора.
 *
 * Сети нет: публикатор, живые данные площадок и ИИ подменены (с importOriginal — остальные
 * имена модулей остаются настоящими, правило про подмены в CLAUDE.md).
 */

const runId = Date.now();
const password = "testpass123";
const mockedPublish = vi.mocked(publishApprovedPost);
const mockedInfos = vi.mocked(loadChannelInfos);
const mockedLive = vi.mocked(loadChannelLive);
const mockedCaptions = vi.mocked(generateSocialVideoCaptions);
const mockedCoverImage = vi.mocked(generateSocialVideoCoverImage);

const agentIds: string[] = [];
const videoIds: string[] = [];
const tokens: Record<string, string> = {};
const tmpFiles: string[] = [];

const READY: SocialVideoChannelInfo[] = SOCIAL_VIDEO_CHANNELS.map((channel) => ({
  channel,
  label: channel,
  connected: true,
  ready: true,
  problem: null,
  limits: SOCIAL_VIDEO_LIMITS[channel],
  accounts: [{ id: null, label: channel, username: null, isDefault: true, ready: true, problem: null }],
}));

/** Instagram с двумя аккаунтами («по умолчанию» и ещё один) и Telegram с двумя чатами. */
const READY_MULTI: SocialVideoChannelInfo[] = READY.map((info) => {
  if (info.channel === "INSTAGRAM") {
    return {
      ...info,
      accounts: [
        { id: null, label: "Royal Home", username: "royal.home.tj", isDefault: true, ready: true, problem: null },
        { id: "acc-info", label: "Royal Home Info", username: "royalhome.info", isDefault: false, ready: true, problem: null },
      ],
    };
  }
  if (info.channel === "TELEGRAM") {
    return {
      ...info,
      accounts: [
        { id: "-1001", label: "Канал (основной)", username: null, isDefault: true, ready: true, problem: null },
        { id: "-1002", label: "Группа агентов", username: null, isDefault: false, ready: true, problem: null },
      ],
    };
  }
  return info;
});

const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** Строка ролика напрямую в базе + заглушка файла на диске (публикатор подменён, файл нужен только проверке «файл на месте»). */
async function makeRow(data: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const videoPath = `/uploads/handoff/promo-${id}.mp4`;
  const disk = path.join(uploadsDir, "handoff", `promo-${id}.mp4`);
  await fs.promises.mkdir(path.dirname(disk), { recursive: true });
  await fs.promises.writeFile(disk, "stub");
  const row = await prisma.socialVideoPost.create({
    data: {
      id,
      title: `Тест-ролик ${runId}`,
      caption: "Тестовая подпись",
      videoPath,
      originalName: "t.mp4",
      sizeBytes: 4,
      durationSec: 30,
      width: 1080,
      height: 1920,
      hasAudio: true,
      videoCodec: "h264",
      channels: ["INSTAGRAM", "TELEGRAM"],
      ...data,
    },
  });
  videoIds.push(row.id);
  return row;
}

/** Публикатор с адресами: исход по ключу (`INSTAGRAM:acc-info` и т. п.) — "ok" или текст ошибки. */
function planTargets(plan: Record<string, "ok" | string>) {
  mockedPublish.mockImplementation(async (params) => {
    const out: PublishResult[] = [];
    const keys = [
      ...(params.instagramTargets ?? []).map((t) => ({ channel: "INSTAGRAM" as const, key: t.key })),
      ...(params.telegramTargets ?? []).map((t) => ({ channel: "TELEGRAM" as const, key: t.key })),
    ].filter((t) => !params.skipKeys?.includes(t.key));
    for (const { channel, key } of keys) {
      const planned = plan[key];
      if (!planned) continue;
      await params.onChannelStarted?.(channel, key);
      if (planned === "ok") {
        const result: PublishResult = { channel, destinationKey: key, ok: true, postId: `${key}-post` };
        out.push(result);
        await params.onChannelPublished?.(result);
      } else {
        out.push({ channel, destinationKey: key, ok: false, error: planned });
      }
    }
    return out;
  });
}

function planPublish(plan: Partial<Record<SocialVideoChannel, "ok" | string>>) {
  mockedPublish.mockImplementation(async (params) => {
    const out: PublishResult[] = [];
    for (const channel of SOCIAL_VIDEO_CHANNELS) {
      if (params.skipChannels?.includes(channel)) continue;
      const planned = plan[channel];
      if (!planned) continue;
      await params.onChannelStarted?.(channel, channel);
      if (planned === "ok") {
        const result: PublishResult = {
          channel,
          ok: true,
          postId: `${channel.toLowerCase()}-post`,
          ...(channel === "INSTAGRAM" ? { permalink: "https://www.instagram.com/reel/abc123/" } : {}),
        };
        out.push(result);
        await params.onChannelPublished?.(result);
      } else {
        out.push({ channel, ok: false, error: planned });
      }
    }
    return out;
  });
}

const ffmpegOk = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const roles: Array<[string, string]> = [
    ["AGENT", "974"],
    ["EDITOR", "975"],
    ["MARKETING", "976"],
    ["DIRECTOR", "977"],
    ["ADMIN", "978"],
  ];
  for (const [role, prefix] of roles) {
    const agent = await prisma.agent.create({
      data: { fullName: `Тест-ролики-${role}`, phone: `+992${prefix}${runId}`, role: role as never, passwordHash },
    });
    agentIds.push(agent.id);
    tokens[role] = await login(agent.phone);
  }
});

beforeEach(() => {
  mockedPublish.mockReset();
  mockedInfos.mockReset();
  mockedLive.mockReset();
  mockedCaptions.mockReset();
  mockedCoverImage.mockReset();
  mockedInfos.mockResolvedValue(READY);
  mockedLive.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  const rows = await prisma.socialVideoPost.findMany({ where: { id: { in: videoIds } }, select: { videoPath: true, coverPath: true, coverSquarePath: true } });
  for (const row of rows) {
    for (const publicPath of [row.videoPath, row.coverPath, row.coverSquarePath]) {
      if (publicPath) await fs.promises.rm(path.join(uploadsDir, publicPath.slice("/uploads/".length)), { force: true });
    }
  }
  await prisma.socialVideoPost.deleteMany({ where: { id: { in: videoIds } } });
  await prisma.backgroundJob.deleteMany({ where: { type: SOCIAL_VIDEO_PUBLISH_JOB_TYPE } }).catch(() => {});
  await deleteAgentsWithTraces(agentIds);
  for (const file of tmpFiles) await fs.promises.rm(file, { force: true });
});

// ───────────────────────────── правила пригодности ролика ─────────────────────────────

describe("evaluateVideoForChannel — пределы площадок", () => {
  const good: SocialVideoFacts = { durationSec: 30, sizeBytes: 20 * 1024 * 1024, width: 1080, height: 1920, videoCodec: "h264", hasAudio: true };

  it("хороший вертикальный ролик подходит всем шести каналам без причин отказа", () => {
    for (const channel of SOCIAL_VIDEO_CHANNELS) {
      expect(evaluateVideoForChannel(channel, good, "").blockers, channel).toEqual([]);
    }
  });

  it("Instagram: длиннее 15 минут и тяжелее 300 МБ — отказ; чужой кодек — отказ", () => {
    expect(evaluateVideoForChannel("INSTAGRAM", { ...good, durationSec: 16 * 60 }, "").level).toBe("BLOCK");
    expect(evaluateVideoForChannel("INSTAGRAM", { ...good, sizeBytes: 301 * 1024 * 1024 }, "").level).toBe("BLOCK");
    expect(evaluateVideoForChannel("INSTAGRAM", { ...good, videoCodec: "vp9" }, "").blockers[0]).toMatch(/VP9/);
    expect(evaluateVideoForChannel("INSTAGRAM", { ...good, durationSec: 2 }, "").level).toBe("BLOCK");
  });

  it("TikTok: предел длины берётся у самого TikTok (runtime), а не из запасного числа", () => {
    const long = { ...good, durationSec: 90 };
    expect(evaluateVideoForChannel("TIKTOK", long, "").level).toBe("OK");
    const verdict = evaluateVideoForChannel("TIKTOK", long, "", { maxDurationSec: 60 });
    expect(verdict.level).toBe("BLOCK");
    expect(verdict.blockers[0]).toMatch(/вашего аккаунта по данным TikTok/);
  });

  it("Telegram: потолок отправки — из runtime сервера Bot API", () => {
    const big = { ...good, sizeBytes: 80 * 1024 * 1024 };
    expect(evaluateVideoForChannel("TELEGRAM", big, "", { maxSizeBytes: 50 * 1024 * 1024 }).level).toBe("BLOCK");
    expect(evaluateVideoForChannel("TELEGRAM", big, "", { maxSizeBytes: 2000 * 1024 * 1024 }).level).toBe("OK");
  });

  it("Facebook: вертикаль 3–90 с — Reels, остальное — обычное видео с предупреждением, но не отказ", () => {
    expect(evaluateVideoForChannel("FACEBOOK", good, "").format).toBe("Reels");
    const horizontal = evaluateVideoForChannel("FACEBOOK", { ...good, width: 1920, height: 1080 }, "");
    expect(horizontal.format).toBe("Обычное видео");
    expect(horizontal.level).toBe("WARN");
  });

  it("YouTube: вертикаль до 3 минут — Shorts, длиннее — обычное видео", () => {
    expect(evaluateVideoForChannel("YOUTUBE", { ...good, durationSec: 120 }, "").format).toBe("Shorts");
    const long = evaluateVideoForChannel("YOUTUBE", { ...good, durationSec: 200 }, "");
    expect(long.format).toBe("Обычное видео");
    expect(long.level).toBe("WARN");
  });

  it("Threads: длиннее 5 минут — отказ; слишком длинный текст — предупреждение об обрезке", () => {
    expect(evaluateVideoForChannel("THREADS", { ...good, durationSec: 400 }, "").level).toBe("BLOCK");
    const verdict = evaluateVideoForChannel("THREADS", good, "а".repeat(600));
    expect(verdict.level).toBe("WARN");
    expect(verdict.warnings[0]).toMatch(/обрезанная до 500/);
  });

  it("не удалось измерить длительность — это предупреждение, а не отказ", () => {
    const verdict = evaluateVideoForChannel("INSTAGRAM", { ...good, durationSec: null }, "");
    expect(verdict.level).toBe("WARN");
    expect(verdict.blockers).toEqual([]);
  });
});

describe("ночная чистка диска не трогает файлы свободных роликов", () => {
  it("имена promo-<uuid>… не опознаются ни одним шаблоном (иначе файл ролика был бы принят за мусор)", async () => {
    const { classifyFileName } = await import("../src/lib/diskCleanup.js");
    const id = crypto.randomUUID();
    expect(classifyFileName("handoff", `promo-${id}.mp4`)).toBeNull();
    expect(classifyFileName("covers", `promo-${id}-abc123-cover.jpg`)).toBeNull();
    expect(classifyFileName("covers", `promo-${id}-abc123-square.jpg`)).toBeNull();
  });
});

describe("finalStatusOf", () => {
  it("все вышли — DONE; часть — PARTIAL; ничего — FAILED", () => {
    const ok = (state: "PUBLISHED" | "FAILED") => ({ state, error: null, note: null, postId: null, url: null, retriable: false, attempts: 1, startedAt: null, finishedAt: null });
    expect(finalStatusOf(["INSTAGRAM", "TELEGRAM"], { INSTAGRAM: ok("PUBLISHED"), TELEGRAM: ok("PUBLISHED") })).toBe("DONE");
    expect(finalStatusOf(["INSTAGRAM", "TELEGRAM"], { INSTAGRAM: ok("PUBLISHED"), TELEGRAM: ok("FAILED") })).toBe("PARTIAL");
    expect(finalStatusOf(["INSTAGRAM"], { INSTAGRAM: ok("FAILED") })).toBe("FAILED");
  });
});

// ───────────────────────────── охранитель публикатора и пометки ─────────────────────────────

describe("publishApprovedPost — хозяин публикации", () => {
  it("требует ровно одно из propertyId / freeVideoId", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/socialPublish.js")>("../src/lib/socialPublish.js");
    await expect(actual.publishApprovedPost({ localVideoPath: "/uploads/handoff/x.mp4", caption: "" })).rejects.toThrow(/ровно одно/);
    await expect(
      actual.publishApprovedPost({ propertyId: "a", freeVideoId: "b", localVideoPath: "/uploads/handoff/x.mp4", caption: "" })
    ).rejects.toThrow(/ровно одно/);
  });

  it("настоящий публикатор для свободного ролика без адреса CRM: отказы по каналам с текстом «свободный ролик», пропущенные каналы не трогает", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/socialPublish.js")>("../src/lib/socialPublish.js");
    const saved = process.env.CRM_PUBLIC_URL;
    delete process.env.CRM_PUBLIC_URL;
    try {
      const started: string[] = [];
      const results = await actual.publishApprovedPost({
        freeVideoId: "free-1",
        localVideoPath: "/uploads/handoff/promo-x.mp4",
        caption: "",
        skipChannels: ["THREADS"],
        onChannelStarted: async (channel) => {
          started.push(channel);
        },
      });
      expect(results.map((r) => r.channel).sort()).toEqual(["FACEBOOK", "INSTAGRAM", "TELEGRAM"]);
      expect(results.every((r) => !r.ok && /CRM_PUBLIC_URL/.test(r.error ?? ""))).toBe(true);
      // До ранней проверки адреса каналы в работу не берутся — «публикуется» на экране не мигает зря.
      expect(started).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.CRM_PUBLIC_URL = saved;
    }
  });
});

describe("updateOwnerMarks — метки на свободном ролике", () => {
  it("пишет условно, читает свежее; «менять нечего» ничего не пишет", async () => {
    const row = await makeRow();
    const first = await updateOwnerMarks({ kind: "freeVideo", id: row.id }, (cur) => ({
      channels: [...cur.channels, "TIKTOK"],
      postIds: { ...cur.postIds, TIKTOK_PENDING: "pub-1" },
    }));
    expect(first.applied).toBe(true);
    const after = await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.publishedChannels).toEqual(["TIKTOK"]);
    expect((after.publishedPostIds as Record<string, string>).TIKTOK_PENDING).toBe("pub-1");
    expect((await updateOwnerMarks({ kind: "freeVideo", id: row.id }, () => null)).applied).toBe(false);
    expect((await updateOwnerMarks({ kind: "freeVideo", id: crypto.randomUUID() }, (cur) => cur)).applied).toBe(false);
  });
});

// ───────────────────────────── доступ ─────────────────────────────

describe("доступ к /social-videos", () => {
  it("без входа — 401; агент и монтажёр — 403; маркетинг, директор, админ — 200", async () => {
    expect((await request(app).get("/api/v1/social-videos")).status).toBe(401);
    expect((await request(app).get("/api/v1/social-videos").set(auth("AGENT"))).status).toBe(403);
    expect((await request(app).get("/api/v1/social-videos").set(auth("EDITOR"))).status).toBe(403);
    for (const role of ["MARKETING", "DIRECTOR", "ADMIN"]) {
      const res = await request(app).get("/api/v1/social-videos").set(auth(role));
      expect(res.status, role).toBe(200);
      expect(res.body.counts).toBeDefined();
    }
  });

  it("справочник каналов отдаёт лимиты с источниками", async () => {
    const res = await request(app).get("/api/v1/social-videos/channels").set(auth("MARKETING"));
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(6);
    expect(res.body.channels[0].limits.sources.length).toBeGreaterThan(0);
  });
});

// ───────────────────────────── загрузка ─────────────────────────────

describe("POST /social-videos — загрузка ролика", () => {
  it.skipIf(!ffmpegOk)("принимает MP4, измеряет, перепаковывает с moov впереди, создаёт черновик", async () => {
    const src = path.join(os.tmpdir(), `sv-test-${runId}.mp4`);
    tmpFiles.push(src);
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=540x960:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src,
    ], { stdio: "ignore" });

    const res = await request(app)
      .post("/api/v1/social-videos")
      .set(auth("MARKETING"))
      .field("title", `Загруженный ${runId}`)
      .field("caption", "Подпись")
      .field("channels", JSON.stringify(["INSTAGRAM", "YOUTUBE"]))
      .attach("video", src, { filename: "promo.mp4", contentType: "video/mp4" });
    expect(res.status).toBe(201);
    videoIds.push(res.body.id);
    expect(res.body.status).toBe("DRAFT");
    expect(res.body.channels).toEqual(["INSTAGRAM", "YOUTUBE"]);
    expect(res.body.durationSec).toBeGreaterThan(2.5);
    expect(res.body.durationSec).toBeLessThan(3.5);
    expect(res.body.width).toBe(540);
    expect(res.body.height).toBe(960);
    expect(res.body.hasAudio).toBe(true);
    // Сервер сам подписывает путь файла в JSON (?t=…) — экран подставляет его в плеер как есть.
    const cleanPath = String(res.body.videoPath).split("?")[0];
    expect(res.body.videoPath).toContain("?t=");
    expect(cleanPath).toMatch(/^\/uploads\/handoff\/promo-[0-9a-f-]{36}\.mp4$/);
    expect(res.body.verdicts).toHaveLength(2);
    expect(fs.existsSync(path.join(uploadsDir, cleanPath.slice("/uploads/".length)))).toBe(true);
  });

  it("не видео по расширению — 422 и человеческий текст; без файла — 400; без названия — 400", async () => {
    const txt = path.join(os.tmpdir(), `sv-test-${runId}.txt`);
    tmpFiles.push(txt);
    await fs.promises.writeFile(txt, "не видео");
    const bad = await request(app)
      .post("/api/v1/social-videos")
      .set(auth("MARKETING"))
      .field("title", "x")
      .attach("video", txt, { filename: "note.txt", contentType: "video/mp4" });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatch(/MP4 или MOV/);

    expect((await request(app).post("/api/v1/social-videos").set(auth("MARKETING")).field("title", "x")).status).toBe(400);
    const noTitle = await request(app).post("/api/v1/social-videos").set(auth("MARKETING")).attach("video", txt, { filename: "a.mp4", contentType: "video/mp4" });
    expect(noTitle.status).toBe(400);
  });

  it.skipIf(!ffmpegOk)("произвольные байты под видом .mp4 не принимаются и не остаются на диске", async () => {
    const junk = path.join(os.tmpdir(), `sv-junk-${runId}.mp4`);
    tmpFiles.push(junk);
    await fs.promises.writeFile(junk, Buffer.from("#EXTM3U\n#EXT-X-VERSION:3\nhttp://example.invalid/x.ts\n"));
    const before = fs.readdirSync(path.join(uploadsDir, "handoff")).filter((f) => f.startsWith("promo-")).length;
    const res = await request(app)
      .post("/api/v1/social-videos")
      .set(auth("MARKETING"))
      .field("title", "мусор")
      .attach("video", junk, { filename: "x.mp4", contentType: "video/mp4" });
    expect(res.status).toBe(422);
    const after = fs.readdirSync(path.join(uploadsDir, "handoff")).filter((f) => f.startsWith("promo-")).length;
    expect(after).toBe(before);
  });

  it("агенту загрузка закрыта — 403", async () => {
    const res = await request(app).post("/api/v1/social-videos").set(auth("AGENT")).field("title", "x");
    expect(res.status).toBe(403);
  });
});

// ───────────────────────────── правка ─────────────────────────────

describe("PATCH /social-videos/:id", () => {
  it("меняет название, подпись, описание и каналы; чужой канал вычищает из результатов", async () => {
    const row = await makeRow({ channelResults: { TELEGRAM: { state: "FAILED", error: "x", note: null, postId: null, url: null, retriable: false, attempts: 1, startedAt: null, finishedAt: null } } });
    const res = await request(app)
      .patch(`/api/v1/social-videos/${row.id}`)
      .set(auth("DIRECTOR"))
      .send({ title: "Новое имя", caption: "Новая подпись", brief: "про акцию", channels: ["YOUTUBE"] });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Новое имя");
    expect(res.body.brief).toBe("про акцию");
    expect(res.body.channels).toEqual(["YOUTUBE"]);
    expect(res.body.results.TELEGRAM).toBeUndefined();
  });

  it("опубликованному менять подпись и каналы нельзя, название можно; пустой запрос — 400", async () => {
    const row = await makeRow({ status: "DONE" });
    expect((await request(app).patch(`/api/v1/social-videos/${row.id}`).set(auth("ADMIN")).send({ caption: "ещё" })).status).toBe(409);
    expect((await request(app).patch(`/api/v1/social-videos/${row.id}`).set(auth("ADMIN")).send({ title: "ок" })).status).toBe(200);
    expect((await request(app).patch(`/api/v1/social-videos/${row.id}`).set(auth("ADMIN")).send({})).status).toBe(400);
  });

  it("публикуемому и несуществующему — 409 / 404", async () => {
    const row = await makeRow({ status: "PUBLISHING" });
    expect((await request(app).patch(`/api/v1/social-videos/${row.id}`).set(auth("ADMIN")).send({ title: "x" })).status).toBe(409);
    expect((await request(app).patch(`/api/v1/social-videos/${crypto.randomUUID()}`).set(auth("ADMIN")).send({ title: "x" })).status).toBe(404);
  });
});

// ───────────────────────────── публикация ─────────────────────────────

describe("POST /social-videos/:id/publish — проверки до запуска", () => {
  it("без каналов — 409 «выберите канал»", async () => {
    const row = await makeRow({ channels: [] });
    const res = await request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("MARKETING")).send({ mode: "NOW" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/хотя бы один канал/);
  });

  it("неподключённый канал блокирует с причиной", async () => {
    mockedInfos.mockResolvedValue(READY.map((i) => (i.channel === "TELEGRAM" ? { ...i, ready: false, connected: false, problem: "Бот не настроен на сервере" } : i)));
    const row = await makeRow();
    const res = await request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("MARKETING")).send({ mode: "NOW" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Telegram: Бот не настроен на сервере/);
    expect(mockedPublish).not.toHaveBeenCalled();
  });

  it("ролик длиннее живого лимита TikTok — отказ с пояснением; Instagram с пустой квотой — отказ", async () => {
    mockedLive.mockResolvedValue([
      { channel: "TIKTOK", account: "@a", runtime: { maxDurationSec: 60 }, quota: null, problem: null, note: null, checkedAt: new Date().toISOString() },
      { channel: "INSTAGRAM", account: "@b", runtime: {}, quota: { used: 100, total: 100, remaining: 0, windowHours: 24 }, problem: "Суточный лимит исчерпан", note: null, checkedAt: new Date().toISOString() },
    ]);
    const row = await makeRow({ durationSec: 90, channels: ["TIKTOK", "INSTAGRAM"] });
    const res = await request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("MARKETING")).send({ mode: "NOW" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/TikTok: Ролик 1 мин 30 с — длиннее предела 1 мин/);
    expect(res.body.error).toMatch(/Instagram: Суточный лимит исчерпан/);
  });

  it("расписание: слишком близкое время и мусор — 422; нет времени — 400", async () => {
    const row = await makeRow();
    const soon = new Date(Date.now() + 30_000).toISOString();
    expect((await request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("MARKETING")).send({ mode: "SCHEDULE", scheduledAt: soon })).status).toBe(422);
    expect((await request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("MARKETING")).send({ mode: "SCHEDULE" })).status).toBe(400);
  });

  it("файл пропал с диска — 409 с понятным текстом", async () => {
    const row = await makeRow();
    await fs.promises.rm(path.join(uploadsDir, row.videoPath.slice("/uploads/".length)), { force: true });
    const res = await request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("MARKETING")).send({ mode: "NOW" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Файл ролика пропал/);
  });
});

describe("публикация сразу: исход по каждому каналу, повтор упавшего", () => {
  it("один вышел, другой отказал → PARTIAL; «Повторить» добирает упавший → DONE; вышедший не публикуется второй раз", async () => {
    const row = await makeRow({ channels: ["INSTAGRAM", "TELEGRAM"], caption: "Привет, мир" });
    planPublish({ INSTAGRAM: "ok", TELEGRAM: "Bad Request: chat not found" });

    const started = await request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("MARKETING")).send({ mode: "NOW" });
    expect(started.status).toBe(202);
    expect(started.body.status).toBe("PUBLISHING");
    expect(started.body.results.INSTAGRAM.state).toBe("QUEUED");

    await runSocialVideoPublish(row.id);

    const after = await request(app).get(`/api/v1/social-videos/${row.id}`).set(auth("MARKETING"));
    expect(after.body.status).toBe("PARTIAL");
    expect(after.body.results.INSTAGRAM).toMatchObject({ state: "PUBLISHED", postId: "instagram-post", url: "https://www.instagram.com/reel/abc123/", attempts: 1 });
    expect(after.body.results.TELEGRAM).toMatchObject({ state: "FAILED", error: "Bad Request: chat not found", attempts: 1 });
    expect(after.body.finishedAt).not.toBeNull();

    // Публикатору ушёл свободный ролик, а не объект; чужие каналы пропущены.
    const call = mockedPublish.mock.calls[0][0];
    expect(call.freeVideoId).toBe(row.id);
    expect(call.propertyId).toBeUndefined();
    expect(call.caption).toBe("Привет, мир");
    expect(call.skipChannels).toEqual(expect.arrayContaining(["FACEBOOK", "YOUTUBE", "TIKTOK", "THREADS"]));
    expect(call.skipChannels).not.toContain("INSTAGRAM");

    // Метки «где висит» записаны на ролике.
    const db = await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: row.id } });
    expect(db.publishedChannels).toEqual(["INSTAGRAM"]);
    expect(db.instagramUrl).toBe("https://www.instagram.com/reel/abc123/");

    // Повтор.
    planPublish({ TELEGRAM: "ok" });
    const retry = await request(app).post(`/api/v1/social-videos/${row.id}/retry`).set(auth("MARKETING")).send({});
    expect(retry.status).toBe(202);
    expect(retry.body.status).toBe("PUBLISHING");
    expect(retry.body.results.INSTAGRAM.state).toBe("PUBLISHED");
    await runSocialVideoPublish(row.id);

    const final = await request(app).get(`/api/v1/social-videos/${row.id}`).set(auth("MARKETING"));
    expect(final.body.status).toBe("DONE");
    expect(final.body.results.TELEGRAM).toMatchObject({ state: "PUBLISHED", attempts: 2, error: null });
    const retryCall = mockedPublish.mock.calls[1][0];
    expect(retryCall.skipChannels).toContain("INSTAGRAM");
    expect(retryCall.skipChannels).not.toContain("TELEGRAM");
  });

  it("итог публикации приходит автору пушем: частично — с причиной, целиком — «опубликован»", async () => {
    vi.mocked(sendPushToAgent).mockClear();
    const author = agentIds[2]; // MARKETING
    const row = await makeRow({ channels: ["INSTAGRAM", "TELEGRAM"], createdById: author, title: "Акция" });
    planPublish({ INSTAGRAM: "ok", TELEGRAM: "chat not found" });
    await request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("MARKETING")).send({ mode: "NOW" });
    await runSocialVideoPublish(row.id);
    expect(sendPushToAgent).toHaveBeenCalledTimes(1);
    const [agentId, payload] = vi.mocked(sendPushToAgent).mock.calls[0];
    expect(agentId).toBe(author);
    expect(payload).toMatchObject({ title: "Ролик вышел не везде", url: "/social-videos" });
    expect(payload.body).toMatch(/Акция.*Instagram.*Telegram: chat not found/);

    vi.mocked(sendPushToAgent).mockClear();
    planPublish({ TELEGRAM: "ok" });
    await request(app).post(`/api/v1/social-videos/${row.id}/retry`).set(auth("MARKETING")).send({});
    await runSocialVideoPublish(row.id);
    expect(vi.mocked(sendPushToAgent).mock.calls[0][1]).toMatchObject({ title: "Ролик опубликован" });
  });

  it("повторный заход после гибели процесса: оборвавшийся на канале НЕ публикуется вслепую, нетронутые добираются", async () => {
    const stamp = { error: null, note: null, postId: null, url: null, retriable: false, attempts: 1, startedAt: null, finishedAt: null };
    const row = await makeRow({
      channels: ["INSTAGRAM", "TELEGRAM"],
      status: "PUBLISHING",
      startedAt: new Date(),
      channelResults: { INSTAGRAM: { ...stamp, state: "PUBLISHING" }, TELEGRAM: { ...stamp, state: "QUEUED", attempts: 0 } },
    });
    planPublish({ INSTAGRAM: "ok", TELEGRAM: "ok" });
    await runSocialVideoPublish(row.id);
    const res = await request(app).get(`/api/v1/social-videos/${row.id}`).set(auth("MARKETING"));
    expect(res.body.results.INSTAGRAM.state).toBe("FAILED");
    expect(res.body.results.INSTAGRAM.error).toMatch(/оборвалась на этом канале.*проверьте/);
    expect(res.body.results.TELEGRAM.state).toBe("PUBLISHED");
    expect(res.body.status).toBe("PARTIAL");
    const call = mockedPublish.mock.calls[0][0];
    expect(call.skipChannels).toContain("INSTAGRAM");
    expect(call.skipChannels).not.toContain("TELEGRAM");
  });

  it("сбой базы при записи исхода канала не превращает вышедший пост в «пропущен» и не даёт «Повторить» его задвоить", async () => {
    const row = await makeRow({ channels: ["INSTAGRAM"] });
    // Публикатор вернул успех, но колбэк записи не сработал (как при сбое базы внутри него).
    mockedPublish.mockImplementation(async () => [{ channel: "INSTAGRAM", ok: true, postId: "ig-late", permalink: "https://www.instagram.com/reel/late/" }]);
    await request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("MARKETING")).send({ mode: "NOW" });
    await runSocialVideoPublish(row.id);
    const res = await request(app).get(`/api/v1/social-videos/${row.id}`).set(auth("MARKETING"));
    expect(res.body.status).toBe("DONE");
    expect(res.body.results.INSTAGRAM).toMatchObject({ state: "PUBLISHED", postId: "ig-late" });
  });

  it("все отказали → FAILED; площадка просит подождать (retriable) помечается отдельно", async () => {
    const row = await makeRow({ channels: ["TIKTOK"] });
    mockedPublish.mockImplementation(async (params) => {
      await params.onChannelStarted?.("TIKTOK");
      return [{ channel: "TIKTOK", ok: false, error: "spam_risk_too_many_posts", retriable: true }];
    });
    await request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("MARKETING")).send({ mode: "NOW" });
    await runSocialVideoPublish(row.id);
    const res = await request(app).get(`/api/v1/social-videos/${row.id}`).set(auth("MARKETING"));
    expect(res.body.status).toBe("FAILED");
    expect(res.body.results.TIKTOK).toMatchObject({ state: "FAILED", retriable: true });
  });

  it("публикатор упал исключением → каналы в ошибке, ролик не зависает в «публикуется»", async () => {
    const row = await makeRow({ channels: ["INSTAGRAM"] });
    mockedPublish.mockRejectedValue(new Error("база отвалилась"));
    await request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("MARKETING")).send({ mode: "NOW" });
    await runSocialVideoPublish(row.id);
    const res = await request(app).get(`/api/v1/social-videos/${row.id}`).set(auth("MARKETING"));
    expect(res.body.status).toBe("FAILED");
    expect(res.body.results.INSTAGRAM.error).toMatch(/Сбой при публикации: .*база отвалилась/);
  });

  it("канал выбран, но публикатор о нём промолчал → SKIPPED с объяснением, а не тихий успех", async () => {
    const row = await makeRow({ channels: ["INSTAGRAM", "THREADS"] });
    planPublish({ INSTAGRAM: "ok" });
    await request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("MARKETING")).send({ mode: "NOW" });
    await runSocialVideoPublish(row.id);
    const res = await request(app).get(`/api/v1/social-videos/${row.id}`).set(auth("MARKETING"));
    expect(res.body.status).toBe("PARTIAL");
    expect(res.body.results.THREADS.state).toBe("SKIPPED");
    expect(res.body.results.THREADS.error).toMatch(/не приняла канал в работу/);
  });

  it("две кнопки подряд: один заход, второй — 409", async () => {
    const row = await makeRow();
    planPublish({ INSTAGRAM: "ok", TELEGRAM: "ok" });
    const [a, b] = await Promise.all([
      request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("MARKETING")).send({ mode: "NOW" }),
      request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("ADMIN")).send({ mode: "NOW" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
  });

  it("повторять нечего, пока нет упавших каналов — 409", async () => {
    const row = await makeRow({ status: "DONE" });
    expect((await request(app).post(`/api/v1/social-videos/${row.id}/retry`).set(auth("MARKETING")).send({})).status).toBe(409);
  });
});

describe("расписание", () => {
  it("запланировать → тик запускает в свой час → публикуется; «вернуть в черновик» снимает", async () => {
    const row = await makeRow({ channels: ["INSTAGRAM"] });
    const at = new Date(Date.now() + 10 * 60_000).toISOString();
    const scheduled = await request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("MARKETING")).send({ mode: "SCHEDULE", scheduledAt: at });
    expect(scheduled.status).toBe(202);
    expect(scheduled.body.status).toBe("SCHEDULED");
    expect(scheduled.body.scheduledAt).toBe(at);

    // Раньше срока тик ничего не трогает.
    await runSocialVideoScheduleTick(new Date(Date.now() + 5 * 60_000));
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("SCHEDULED");

    planPublish({ INSTAGRAM: "ok" });
    const tick = await runSocialVideoScheduleTick(new Date(Date.now() + 11 * 60_000));
    expect(tick.started).toBeGreaterThanOrEqual(1);
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("PUBLISHING");
    await runSocialVideoPublish(row.id);
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("DONE");

    const second = await makeRow({ channels: ["INSTAGRAM"] });
    await request(app).post(`/api/v1/social-videos/${second.id}/publish`).set(auth("MARKETING")).send({ mode: "SCHEDULE", scheduledAt: at });
    const back = await request(app).post(`/api/v1/social-videos/${second.id}/unschedule`).set(auth("MARKETING"));
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ status: "DRAFT", scheduledAt: null });
    expect((await request(app).post(`/api/v1/social-videos/${second.id}/unschedule`).set(auth("MARKETING"))).status).toBe(409);
  });

  it("оборванная публикация (старше 45 минут) снимается с ожидания: каналы в ошибке, можно повторить", async () => {
    const row = await makeRow({
      channels: ["INSTAGRAM"],
      status: "PUBLISHING",
      startedAt: new Date(Date.now() - 2 * 60 * 60_000),
      channelResults: { INSTAGRAM: { state: "PUBLISHING", error: null, note: null, postId: null, url: null, retriable: false, attempts: 1, startedAt: null, finishedAt: null } },
    });
    const tick = await runSocialVideoScheduleTick();
    expect(tick.recovered).toBeGreaterThanOrEqual(1);
    const res = await request(app).get(`/api/v1/social-videos/${row.id}`).set(auth("MARKETING"));
    expect(res.body.status).toBe("FAILED");
    expect(res.body.results.INSTAGRAM.error).toMatch(/оборвалась/);
  });
});

// ───────────────────────────── обложки ─────────────────────────────

describe("обложка: без / своя / ИИ", () => {
  const diskOf = (publicPath: string) => path.join(uploadsDir, publicPath.slice("/uploads/".length));

  it("своя картинка → два файла (вертикаль и квадрат); ИИ заменяет и убирает старые; «убрать» чистит всё", async () => {
    const row = await makeRow();
    const png = await sharp({ create: { width: 600, height: 900, channels: 3, background: "#3366ff" } }).png().toBuffer();

    const uploaded = await request(app)
      .post(`/api/v1/social-videos/${row.id}/cover`)
      .set(auth("MARKETING"))
      .attach("cover", png, { filename: "c.png", contentType: "image/png" });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.coverMode).toBe("UPLOAD");
    expect(uploaded.body.coverUrl).toMatch(/^\/uploads\/covers\/promo-[0-9a-f-]{36}-[0-9a-z]+-cover\.jpg$/);
    const db1 = await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: row.id } });
    expect(fs.existsSync(diskOf(db1.coverPath!))).toBe(true);
    expect(fs.existsSync(diskOf(db1.coverSquarePath!))).toBe(true);
    const meta = await sharp(diskOf(db1.coverPath!)).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1920]);
    const squareMeta = await sharp(diskOf(db1.coverSquarePath!)).metadata();
    expect([squareMeta.width, squareMeta.height]).toEqual([1080, 1080]);

    mockedCoverImage.mockResolvedValue({ buffer: png, mimeType: "image/png", provider: "GEMINI", usedFrame: false, usedTrends: true });
    await new Promise((r) => setTimeout(r, 5)); // другая метка времени в имени файла
    const ai = await request(app).post(`/api/v1/social-videos/${row.id}/cover/ai`).set(auth("MARKETING")).send({ prompt: "закат над Душанбе" });
    expect(ai.status).toBe(200);
    expect(ai.body.coverMode).toBe("AI");
    // По умолчанию рисует Gemini, тренды учтены, и это видно под обложкой.
    expect(mockedCoverImage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "закат над Душанбе", provider: "GEMINI" }));
    expect(ai.body.coverMeta).toEqual({ provider: "GEMINI", usedFrame: false, usedTrends: true });
    expect(fs.existsSync(diskOf(db1.coverPath!))).toBe(false);

    const cleared = await request(app).delete(`/api/v1/social-videos/${row.id}/cover`).set(auth("MARKETING"));
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ coverMode: "NONE", coverUrl: null });
    const db2 = await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: row.id } });
    expect(db2.coverPath).toBeNull();
  });

  it("SVG под видом PNG отклоняется по содержимому, а не по заголовку клиента", async () => {
    const row = await makeRow();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="red"/></svg>');
    const res = await request(app)
      .post(`/api/v1/social-videos/${row.id}/cover`)
      .set(auth("MARKETING"))
      .attach("cover", svg, { filename: "c.png", contentType: "image/png" });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/JPEG, PNG или WebP/);
  });

  it("не картинка — отказ; ИИ без денег — 502 с текстом; опубликованному обложку менять нельзя", async () => {
    const row = await makeRow();
    const bad = await request(app)
      .post(`/api/v1/social-videos/${row.id}/cover`)
      .set(auth("MARKETING"))
      .attach("cover", Buffer.from("не картинка"), { filename: "c.png", contentType: "image/png" });
    expect(bad.status).toBe(422);

    mockedCoverImage.mockRejectedValue(new SocialVideoAiError("На счёте OpenAI закончились деньги — пополните баланс или загрузите обложку сами"));
    const ai = await request(app).post(`/api/v1/social-videos/${row.id}/cover/ai`).set(auth("MARKETING")).send({});
    expect(ai.status).toBe(502);
    expect(ai.body.error).toMatch(/закончились деньги/);

    const done = await makeRow({ status: "DONE" });
    expect((await request(app).delete(`/api/v1/social-videos/${done.id}/cover`).set(auth("MARKETING"))).status).toBe(409);
  });
});

// ───────────────────────────── ИИ-подписи ─────────────────────────────

describe("POST /social-videos/ai-caption", () => {
  it("возвращает варианты и передаёт тон, язык, каналы и уже показанное", async () => {
    mockedCaptions.mockResolvedValue(["Вариант 1", "Вариант 2", "Вариант 3"]);
    const res = await request(app)
      .post("/api/v1/social-videos/ai-caption")
      .set(auth("MARKETING"))
      .send({ brief: "Ролик про новый офис агентства", tone: "PREMIUM", language: "RU_TG", channels: ["THREADS"], avoid: ["старое"] });
    expect(res.status).toBe(200);
    expect(res.body.variants).toHaveLength(3);
    expect(mockedCaptions).toHaveBeenCalledWith(expect.objectContaining({ tone: "PREMIUM", language: "RU_TG", channels: ["THREADS"], avoid: ["старое"] }));
  });

  it("предел запросов к ИИ на сотрудника в час: сверх — 429, а не ещё один платный вызов", async () => {
    mockedCaptions.mockResolvedValue(["Вариант"]);
    // DIRECTOR отдельно от остальных тестов файла — у него свой счётчик.
    let last = 0;
    for (let i = 0; i < 41; i += 1) {
      last = (await request(app).post("/api/v1/social-videos/ai-caption").set(auth("DIRECTOR")).send({ brief: "про наш офис" })).status;
    }
    expect(last).toBe(429);
    expect(mockedCaptions).toHaveBeenCalledTimes(40);
  });

  it("слишком короткое описание — 400; ошибка ИИ — 502 понятным текстом; агенту — 403", async () => {
    expect((await request(app).post("/api/v1/social-videos/ai-caption").set(auth("MARKETING")).send({ brief: "a" })).status).toBe(400);
    mockedCaptions.mockRejectedValue(new SocialVideoAiError("ИИ сейчас недоступен"));
    const down = await request(app).post("/api/v1/social-videos/ai-caption").set(auth("MARKETING")).send({ brief: "про офис" });
    expect(down.status).toBe(502);
    expect(down.body.error).toBe("ИИ сейчас недоступен");
    expect((await request(app).post("/api/v1/social-videos/ai-caption").set(auth("AGENT")).send({ brief: "про офис" })).status).toBe(403);
  });
});

// ───────────────────────────── удаление ─────────────────────────────

describe("DELETE /social-videos/:id", () => {
  it("убирает запись и файлы; публикуемый удалить нельзя; повторное удаление — 404", async () => {
    const row = await makeRow();
    const disk = path.join(uploadsDir, row.videoPath.slice("/uploads/".length));
    expect(fs.existsSync(disk)).toBe(true);
    expect((await request(app).delete(`/api/v1/social-videos/${row.id}`).set(auth("ADMIN"))).status).toBe(204);
    expect(fs.existsSync(disk)).toBe(false);
    expect((await request(app).get(`/api/v1/social-videos/${row.id}`).set(auth("ADMIN"))).status).toBe(404);
    expect((await request(app).delete(`/api/v1/social-videos/${row.id}`).set(auth("ADMIN"))).status).toBe(404);

    const busy = await makeRow({ status: "PUBLISHING" });
    expect((await request(app).delete(`/api/v1/social-videos/${busy.id}`).set(auth("ADMIN"))).status).toBe(409);
  });

  it("список считает счётчики по статусам и не показывает удалённые", async () => {
    await makeRow({ status: "DRAFT" });
    const res = await request(app).get("/api/v1/social-videos?limit=100").set(auth("MARKETING"));
    expect(res.status).toBe(200);
    expect(res.body.counts.DRAFT).toBeGreaterThanOrEqual(1);
    expect(res.body.items.every((i: { id: string }) => typeof i.id === "string")).toBe(true);
    expect((await request(app).get("/api/v1/social-videos?status=NOPE").set(auth("MARKETING"))).status).toBe(400);
  });
});

// ───────────────────────────── выбор аккаунта: «у нас два Instagram» ─────────────────────────────

describe("адреса «канал + аккаунт»", () => {
  it("normalizeDestinations: без повторов; явный чат Telegram вытесняет «по умолчанию»; старый ролик читается по каналам", () => {
    expect(
      normalizeDestinations([
        { channel: "INSTAGRAM", accountId: null },
        { channel: "INSTAGRAM", accountId: null },
        { channel: "TELEGRAM", accountId: null },
        { channel: "TELEGRAM", accountId: "-1002" },
      ])
    ).toEqual([
      { channel: "INSTAGRAM", accountId: null },
      { channel: "TELEGRAM", accountId: "-1002" },
    ]);
    expect(parseDestinations(null, ["YOUTUBE", "INSTAGRAM", "мусор"])).toEqual([
      { channel: "INSTAGRAM", accountId: null },
      { channel: "YOUTUBE", accountId: null },
    ]);
  });

  it("публикация в два Instagram: исход у каждого аккаунта свой, повтор берёт только упавший и не задваивает вышедший", async () => {
    mockedInfos.mockResolvedValue(READY_MULTI);
    const row = await makeRow({
      channels: ["INSTAGRAM"],
      destinations: [
        { channel: "INSTAGRAM", accountId: null },
        { channel: "INSTAGRAM", accountId: "acc-info" },
      ],
    });
    planTargets({ INSTAGRAM: "ok", "INSTAGRAM:acc-info": "Meta: токен аккаунта просрочен" });
    const started = await request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("MARKETING")).send({ mode: "NOW" });
    expect(started.status).toBe(202);
    expect(Object.keys(started.body.results).sort()).toEqual(["INSTAGRAM", "INSTAGRAM:acc-info"]);
    await runSocialVideoPublish(row.id);

    const after = await request(app).get(`/api/v1/social-videos/${row.id}`).set(auth("MARKETING"));
    expect(after.body.status).toBe("PARTIAL");
    expect(after.body.results.INSTAGRAM.state).toBe("PUBLISHED");
    expect(after.body.results["INSTAGRAM:acc-info"]).toMatchObject({ state: "FAILED", error: "Meta: токен аккаунта просрочен" });
    const firstCall = mockedPublish.mock.calls[0][0];
    expect(firstCall.instagramTargets?.map((t) => t.key)).toEqual(["INSTAGRAM", "INSTAGRAM:acc-info"]);
    expect(firstCall.instagramTargets?.find((t) => t.key === "INSTAGRAM:acc-info")?.token).toBe("tok-acc-info");

    planTargets({ "INSTAGRAM:acc-info": "ok" });
    const retry = await request(app).post(`/api/v1/social-videos/${row.id}/retry`).set(auth("MARKETING")).send({ keys: ["INSTAGRAM:acc-info"] });
    expect(retry.status).toBe(202);
    await runSocialVideoPublish(row.id);
    const retryCall = mockedPublish.mock.calls[1][0];
    // Вышедший аккаунт публикатору назван в пропущенных, в работе только упавший.
    expect(retryCall.skipKeys).toContain("INSTAGRAM");
    expect(retryCall.skipKeys).not.toContain("INSTAGRAM:acc-info");

    const final = await request(app).get(`/api/v1/social-videos/${row.id}`).set(auth("MARKETING"));
    expect(final.body.status).toBe("DONE");
    expect(final.body.results["INSTAGRAM:acc-info"].state).toBe("PUBLISHED");
    expect(final.body.results.INSTAGRAM.attempts).toBe(1); // вышедший аккаунт второй раз не публиковался
  });

  it("явные чаты Telegram публикуются каждый отдельным адресом", async () => {
    mockedInfos.mockResolvedValue(READY_MULTI);
    const row = await makeRow({
      channels: ["TELEGRAM"],
      destinations: [
        { channel: "TELEGRAM", accountId: "-1001" },
        { channel: "TELEGRAM", accountId: "-1002" },
      ],
    });
    planTargets({ "TELEGRAM:-1001": "ok", "TELEGRAM:-1002": "ok" });
    await request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("MARKETING")).send({ mode: "NOW" });
    await runSocialVideoPublish(row.id);
    const res = await request(app).get(`/api/v1/social-videos/${row.id}`).set(auth("MARKETING"));
    expect(res.body.status).toBe("DONE");
    expect(Object.keys(res.body.results).sort()).toEqual(["TELEGRAM:-1001", "TELEGRAM:-1002"]);
    expect(mockedPublish.mock.calls[0][0].telegramTargets?.map((t) => t.chatId)).toEqual(["-1001", "-1002"]);
  });

  it("недоступный аккаунт блокирует публикацию причиной, а не молчаливым пропуском", async () => {
    mockedInfos.mockResolvedValue(
      READY_MULTI.map((i) =>
        i.channel === "INSTAGRAM"
          ? { ...i, accounts: i.accounts.map((a) => (a.id === "acc-info" ? { ...a, ready: false, problem: "Аккаунт отключён в Настройках → Каналы связи" } : a)) }
          : i
      )
    );
    const row = await makeRow({ channels: ["INSTAGRAM"], destinations: [{ channel: "INSTAGRAM", accountId: "acc-info" }] });
    const res = await request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("MARKETING")).send({ mode: "NOW" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Royal Home Info.*отключён/);

    const gone = await request(app)
      .patch(`/api/v1/social-videos/${row.id}`)
      .set(auth("MARKETING"))
      .send({ destinations: [{ channel: "INSTAGRAM", accountId: "нет-такого" }] });
    expect(gone.status).toBe(200);
    const res2 = await request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("MARKETING")).send({ mode: "NOW" });
    expect(res2.status).toBe(409);
    expect(res2.body.error).toMatch(/аккаунт больше не подключён/);
  });

  it("добавить сеть или аккаунт к вышедшему ролику: публикация только в новые адреса, вышедшие не трогаются", async () => {
    mockedInfos.mockResolvedValue(READY_MULTI);
    const stamp = { error: null, note: null, postId: "p", url: null, retriable: false, attempts: 1, startedAt: null, finishedAt: null };
    const row = await makeRow({
      channels: ["INSTAGRAM"],
      status: "DONE",
      destinations: [{ channel: "INSTAGRAM", accountId: null }],
      channelResults: { INSTAGRAM: { ...stamp, state: "PUBLISHED" } },
    });
    const emptyAdd = await request(app).post(`/api/v1/social-videos/${row.id}/add-destinations`).set(auth("MARKETING")).send({ destinations: [] });
    expect(emptyAdd.status).toBe(400);
    const sameAdd = await request(app)
      .post(`/api/v1/social-videos/${row.id}/add-destinations`)
      .set(auth("MARKETING"))
      .send({ destinations: [{ channel: "INSTAGRAM", accountId: null }] });
    expect(sameAdd.status).toBe(409);

    planTargets({ "INSTAGRAM:acc-info": "ok" });
    const added = await request(app)
      .post(`/api/v1/social-videos/${row.id}/add-destinations`)
      .set(auth("MARKETING"))
      .send({ destinations: [{ channel: "INSTAGRAM", accountId: "acc-info" }] });
    expect(added.status).toBe(202);
    expect(added.body.status).toBe("PUBLISHING");
    expect(added.body.results.INSTAGRAM.state).toBe("PUBLISHED");
    expect(added.body.results["INSTAGRAM:acc-info"].state).toBe("QUEUED");
    await runSocialVideoPublish(row.id);
    const call = mockedPublish.mock.calls[0][0];
    expect(call.skipKeys).toContain("INSTAGRAM");
    expect(call.skipKeys).not.toContain("INSTAGRAM:acc-info");
    const final = await request(app).get(`/api/v1/social-videos/${row.id}`).set(auth("MARKETING"));
    expect(final.body.status).toBe("DONE");
    expect(final.body.results.INSTAGRAM.attempts).toBe(1);
  });

  it("копия черновиком: тот же файл, подпись и адреса, без исходов; исходный не меняется", async () => {
    const stamp = { error: null, note: null, postId: "p", url: null, retriable: false, attempts: 1, startedAt: null, finishedAt: null };
    const row = await makeRow({
      title: "Промо",
      status: "DONE",
      caption: "Подпись копии",
      destinations: [{ channel: "INSTAGRAM", accountId: "acc-info" }],
      channels: ["INSTAGRAM"],
      channelResults: { "INSTAGRAM:acc-info": { ...stamp, state: "PUBLISHED" } },
    });
    const res = await request(app).post(`/api/v1/social-videos/${row.id}/copy`).set(auth("MARKETING"));
    expect(res.status).toBe(201);
    videoIds.push(res.body.id);
    expect(res.body.id).not.toBe(row.id);
    expect(res.body).toMatchObject({ title: "Промо (копия)", status: "DRAFT", caption: "Подпись копии", results: {} });
    expect(res.body.destinations).toEqual([{ channel: "INSTAGRAM", accountId: "acc-info" }]);
    const cleanPath = String(res.body.videoPath).split("?")[0];
    expect(cleanPath).not.toBe(row.videoPath);
    expect(fs.existsSync(path.join(uploadsDir, cleanPath.slice("/uploads/".length)))).toBe(true);
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("DONE");
  });
});

describe("Telegram: «по умолчанию» и явные чаты не накрывают друг друга", () => {
  it("вышел основной канал со всеми чатами — отдельный чат добавить нельзя (дубль), и наоборот", async () => {
    mockedInfos.mockResolvedValue(READY_MULTI);
    const stamp = { error: null, note: null, postId: "p", url: null, retriable: false, attempts: 1, startedAt: null, finishedAt: null };
    const asDefault = await makeRow({
      channels: ["TELEGRAM"],
      status: "DONE",
      destinations: [{ channel: "TELEGRAM", accountId: null }],
      channelResults: { TELEGRAM: { ...stamp, state: "PUBLISHED" } },
    });
    const addExplicit = await request(app)
      .post(`/api/v1/social-videos/${asDefault.id}/add-destinations`)
      .set(auth("MARKETING"))
      .send({ destinations: [{ channel: "TELEGRAM", accountId: "-1002" }] });
    expect(addExplicit.status).toBe(409);
    expect(addExplicit.body.error).toMatch(/задвоило/);
    expect(mockedPublish).not.toHaveBeenCalled();

    const asExplicit = await makeRow({
      channels: ["TELEGRAM"],
      status: "DONE",
      destinations: [{ channel: "TELEGRAM", accountId: "-1001" }],
      channelResults: { "TELEGRAM:-1001": { ...stamp, state: "PUBLISHED" } },
    });
    const addDefault = await request(app)
      .post(`/api/v1/social-videos/${asExplicit.id}/add-destinations`)
      .set(auth("MARKETING"))
      .send({ destinations: [{ channel: "TELEGRAM", accountId: null }] });
    expect(addDefault.status).toBe(409);
    expect(mockedPublish).not.toHaveBeenCalled();
  });

  it("ошибка публикатора без ключа адреса ложится на ВСЕ адреса канала, а не остаётся сиротой", async () => {
    mockedInfos.mockResolvedValue(READY_MULTI);
    const row = await makeRow({
      channels: ["INSTAGRAM"],
      destinations: [
        { channel: "INSTAGRAM", accountId: null },
        { channel: "INSTAGRAM", accountId: "acc-info" },
      ],
    });
    mockedPublish.mockImplementation(async () => [{ channel: "INSTAGRAM", ok: false, error: "Не настроен CRM_PUBLIC_URL" }]);
    await request(app).post(`/api/v1/social-videos/${row.id}/publish`).set(auth("MARKETING")).send({ mode: "NOW" });
    await runSocialVideoPublish(row.id);
    const res = await request(app).get(`/api/v1/social-videos/${row.id}`).set(auth("MARKETING"));
    expect(res.body.status).toBe("FAILED");
    expect(res.body.results.INSTAGRAM).toMatchObject({ state: "FAILED", error: "Не настроен CRM_PUBLIC_URL" });
    expect(res.body.results["INSTAGRAM:acc-info"]).toMatchObject({ state: "FAILED", error: "Не настроен CRM_PUBLIC_URL" });
  });
});

describe("ИИ-обложки: провайдеры и тренды", () => {
  it("переключатель: ChatGPT уходит в запрос как есть; кадр и тренды можно выключить; мусорный провайдер — 400", async () => {
    const row = await makeRow();
    const png = await sharp({ create: { width: 600, height: 900, channels: 3, background: "#118833" } }).png().toBuffer();
    mockedCoverImage.mockResolvedValue({ buffer: png, mimeType: "image/png", provider: "OPENAI", usedFrame: false, usedTrends: false });
    const res = await request(app).post(`/api/v1/social-videos/${row.id}/cover/ai`).set(auth("ADMIN")).send({ provider: "OPENAI", useFrame: false, useTrends: false });
    expect(res.status).toBe(200);
    expect(mockedCoverImage).toHaveBeenCalledWith(expect.objectContaining({ provider: "OPENAI", frameImage: null, trends: null }));
    expect(res.body.coverMeta).toEqual({ provider: "OPENAI", usedFrame: false, usedTrends: false });
    const bad = await request(app).post(`/api/v1/social-videos/${row.id}/cover/ai`).set(auth("ADMIN")).send({ provider: "СКАЗКА" });
    expect(bad.status).toBe(400);
  });

  it("справочники /ai-providers и /trends отвечают ролям маркетинга и закрыты агенту", async () => {
    expect((await request(app).get("/api/v1/social-videos/trends").set(auth("MARKETING"))).status).toBe(200);
    expect((await request(app).get("/api/v1/social-videos/trends").set(auth("AGENT"))).status).toBe(403);
    const providers = await request(app).get("/api/v1/social-videos/ai-providers").set(auth("DIRECTOR"));
    expect(providers.status).toBe(200);
    expect(providers.body.defaultProvider).toBe("GEMINI");
    expect(providers.body.providers.map((p: { provider: string }) => p.provider)).toEqual(["GEMINI", "OPENAI"]);
  });
});
