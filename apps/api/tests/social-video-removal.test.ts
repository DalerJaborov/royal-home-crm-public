import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  deleteFacebookVideo: vi.fn(),
  deleteInstagramMedia: vi.fn(),
  deleteYouTubeVideo: vi.fn(),
  deleteThreadsPost: vi.fn(),
}));
vi.mock("../src/lib/publishedVideoFix.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/publishedVideoFix.js")>()),
  instagramManageToken: vi.fn(),
  youtubeCredentials: vi.fn(async () => ({ clientId: "c", clientSecret: "s", refreshToken: "r" })),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  deleteChannelMessage: vi.fn(),
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  loadCredentials: vi.fn(async () => ({ pageToken: "page-token", pageId: "p1", igToken: null })),
}));

import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { uploadsDir } from "../src/upload.js";
import { deleteFacebookVideo, deleteInstagramMedia, deleteYouTubeVideo } from "../src/lib/socialPublish.js";
import { instagramManageToken } from "../src/lib/publishedVideoFix.js";
import { deleteChannelMessage } from "../src/telegram/api.js";
import { resetPostStatsCache } from "../src/lib/postStats.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Свободные ролики (12.10.2026), вторая очередь: снятие поста из соцсетей кнопкой, проверка «этот файл уже
 * загружали», появление свободных роликов в статистике, ленте и расписании «Маркетинга».
 * Сети нет: вызовы удаления подменены (с importOriginal - остальные имена модулей настоящие).
 */

const runId = Date.now();
const password = "testpass123";
const mockedFb = vi.mocked(deleteFacebookVideo);
const mockedIg = vi.mocked(deleteInstagramMedia);
const mockedYt = vi.mocked(deleteYouTubeVideo);
const mockedTg = vi.mocked(deleteChannelMessage);
const mockedManageToken = vi.mocked(instagramManageToken);

const agentIds: string[] = [];
const videoIds: string[] = [];
const tokens: Record<string, string> = {};
const tmpFiles: string[] = [];
const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });

const ffmpegOk = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Вышедший ролик: исход по адресам и метки «где висит» записаны так же, как их пишет публикация. */
async function makePublished(opts: {
  keys: Record<string, { postId: string; url?: string | null }>;
  status?: string;
  extraPostIds?: Record<string, unknown>;
}) {
  const id = crypto.randomUUID();
  const results: Record<string, unknown> = {};
  const postIds: Record<string, unknown> = { ...(opts.extraPostIds ?? {}) };
  const channels = new Set<string>();
  for (const [key, v] of Object.entries(opts.keys)) {
    results[key] = {
      state: "PUBLISHED", error: null, note: null, postId: v.postId, url: v.url ?? null,
      retriable: false, attempts: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    };
    postIds[key] = v.postId;
    channels.add(key.split(":")[0]);
  }
  const destinations = Object.keys(opts.keys).map((key) => {
    const [channel, accountId] = key.split(":");
    return { channel, accountId: accountId ?? null };
  });
  const row = await prisma.socialVideoPost.create({
    data: {
      id,
      title: `Снятие ${runId}`,
      caption: "п",
      videoPath: `/uploads/handoff/promo-${id}.mp4`,
      originalName: "t.mp4",
      sizeBytes: 4,
      durationSec: 30,
      channels: [...channels],
      destinations,
      status: opts.status ?? "DONE",
      finishedAt: new Date(),
      channelResults: results as never,
      publishedChannels: [...channels],
      publishedPostIds: postIds as never,
    },
  });
  videoIds.push(row.id);
  return row;
}

const remove = (id: string, body: unknown = {}) => request(app).post(`/api/v1/social-videos/${id}/remove-from-socials`).set(auth("MARKETING")).send(body as object);

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  for (const [role, prefix] of [["AGENT", "984"], ["MARKETING", "986"]] as const) {
    const agent = await prisma.agent.create({ data: { fullName: `Тест-снятие-${role}`, phone: `+992${prefix}${runId}`, role: role as never, passwordHash } });
    agentIds.push(agent.id);
    const res = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
    expect(res.status).toBe(200);
    tokens[role] = res.body.accessToken as string;
  }
});

beforeEach(() => {
  for (const m of [mockedFb, mockedIg, mockedYt, mockedTg, mockedManageToken]) m.mockReset();
  mockedManageToken.mockResolvedValue(null);
  resetPostStatsCache();
});

afterAll(async () => {
  const rows = await prisma.socialVideoPost.findMany({ where: { id: { in: videoIds } }, select: { videoPath: true } });
  for (const row of rows) await fs.promises.rm(path.join(uploadsDir, row.videoPath.slice("/uploads/".length)), { force: true });
  await prisma.socialVideoPost.deleteMany({ where: { id: { in: videoIds } } });
  await deleteAgentsWithTraces(agentIds);
  for (const file of tmpFiles) await fs.promises.rm(file, { force: true });
});

describe("POST /social-videos/:id/remove-from-socials", () => {
  it("агент без доступа к маркетингу получает 403", async () => {
    const row = await makePublished({ keys: { FACEBOOK: { postId: "fb1" } } });
    const res = await request(app).post(`/api/v1/social-videos/${row.id}/remove-from-socials`).set(auth("AGENT")).send({});
    expect(res.status).toBe(403);
    expect(mockedFb).not.toHaveBeenCalled();
  });

  it("снимает Facebook, YouTube и чат Telegram, чистит метки и ставит статус «Снят»", async () => {
    mockedFb.mockResolvedValue({ ok: true });
    mockedYt.mockResolvedValue({ ok: true });
    mockedTg.mockResolvedValue(undefined);
    const row = await makePublished({
      keys: { FACEBOOK: { postId: "fb1" }, YOUTUBE: { postId: "yt1" }, "TELEGRAM:-1002": { postId: "777" } },
      extraPostIds: { FACEBOOK_POST: "fbpost1" },
    });
    const res = await remove(row.id);
    expect(res.status).toBe(200);
    expect(res.body.outcome.removed.map((r: { key: string }) => r.key).sort()).toEqual(["FACEBOOK", "TELEGRAM:-1002", "YOUTUBE"]);
    expect(res.body.outcome.failed).toEqual([]);
    expect(res.body.item.status).toBe("REMOVED");
    expect(res.body.item.results.FACEBOOK.state).toBe("REMOVED");
    expect(mockedFb).toHaveBeenCalledWith("fb1", "page-token");
    expect(mockedYt).toHaveBeenCalledWith(expect.anything(), "yt1");
    expect(mockedTg).toHaveBeenCalledWith("-1002", 777);

    const after = await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.publishedChannels).toEqual([]);
    expect(after.publishedPostIds).toEqual({});
  });

  it("часть не вышла: этот адрес остаётся опубликованным с причиной, ролик - «частично», снятые метки убраны", async () => {
    mockedFb.mockResolvedValue({ ok: true });
    mockedYt.mockResolvedValue({ ok: false, error: "YouTube не настроен" });
    const row = await makePublished({ keys: { FACEBOOK: { postId: "fb2" }, YOUTUBE: { postId: "yt2" } } });
    const res = await remove(row.id);
    expect(res.status).toBe(200);
    expect(res.body.outcome.removed).toHaveLength(1);
    expect(res.body.outcome.failed).toEqual([expect.objectContaining({ key: "YOUTUBE", error: "YouTube не настроен" })]);
    expect(res.body.item.status).toBe("PARTIAL");
    expect(res.body.item.results.YOUTUBE.state).toBe("PUBLISHED");
    expect(res.body.item.results.YOUTUBE.note).toContain("Снять не вышло");
    const after = await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.publishedChannels).toEqual(["YOUTUBE"]);
    expect(after.publishedPostIds).toEqual({ YOUTUBE: "yt2" });
  });

  it("«поста уже не было» - тоже успех, с честной пометкой", async () => {
    mockedFb.mockResolvedValue({ ok: true, ghost: true });
    const row = await makePublished({ keys: { FACEBOOK: { postId: "fb3" } } });
    const res = await remove(row.id);
    expect(res.body.outcome.removed[0].note).toBe("поста уже не было");
  });

  it("TikTok и второй Instagram снять нельзя - они в списке «руками»; отметка вручную закрывает их", async () => {
    const row = await makePublished({ keys: { TIKTOK: { postId: "tt1" }, "INSTAGRAM:acc-info": { postId: "ig9", url: "https://www.instagram.com/reel/x/" } } });
    const res = await remove(row.id);
    expect(res.status).toBe(200);
    expect(res.body.outcome.removed).toEqual([]);
    expect(res.body.outcome.manual.map((m: { key: string }) => m.key).sort()).toEqual(["INSTAGRAM:acc-info", "TIKTOK"]);
    expect(res.body.outcome.manual.find((m: { key: string }) => m.key === "INSTAGRAM:acc-info").url).toBe("https://www.instagram.com/reel/x/");
    expect(res.body.item.status).toBe("DONE");

    const marked = await request(app).post(`/api/v1/social-videos/${row.id}/mark-removed`).set(auth("MARKETING")).send({ keys: ["TIKTOK", "INSTAGRAM:acc-info"] });
    expect(marked.status).toBe(200);
    expect(marked.body.status).toBe("REMOVED");
    expect(marked.body.results.TIKTOK.note).toBe("убрано вручную");
  });

  it("основной Instagram снимается при ключе удаления и уходит «руками» без него", async () => {
    mockedIg.mockResolvedValue({ ok: true });
    mockedManageToken.mockResolvedValue("manage-token");
    const withToken = await makePublished({ keys: { INSTAGRAM: { postId: "ig1" } } });
    const ok = await remove(withToken.id);
    expect(ok.body.outcome.removed.map((r: { key: string }) => r.key)).toEqual(["INSTAGRAM"]);
    expect(mockedIg).toHaveBeenCalledWith("ig1", "manage-token");

    mockedManageToken.mockResolvedValue(null);
    const without = await makePublished({ keys: { INSTAGRAM: { postId: "ig2" } } });
    const manual = await remove(without.id);
    expect(manual.body.outcome.manual.map((m: { key: string }) => m.key)).toEqual(["INSTAGRAM"]);
  });

  it("выбранные адреса: остальные не трогаем", async () => {
    mockedFb.mockResolvedValue({ ok: true });
    const row = await makePublished({ keys: { FACEBOOK: { postId: "fb4" }, YOUTUBE: { postId: "yt4" } } });
    const res = await remove(row.id, { keys: ["FACEBOOK"] });
    expect(res.body.outcome.removed.map((r: { key: string }) => r.key)).toEqual(["FACEBOOK"]);
    expect(mockedYt).not.toHaveBeenCalled();
    expect(res.body.item.results.YOUTUBE.state).toBe("PUBLISHED");
  });

  it("публикуется или не опубликован - 409, ничего не вызываем", async () => {
    const publishing = await makePublished({ keys: { FACEBOOK: { postId: "fb5" } }, status: "PUBLISHING" });
    expect((await remove(publishing.id)).status).toBe(409);
    const draft = await makePublished({ keys: { FACEBOOK: { postId: "fb6" } }, status: "DRAFT" });
    expect((await remove(draft.id)).status).toBe(409);
    expect(mockedFb).not.toHaveBeenCalled();
  });
});

describe("«этот файл уже загружали»", () => {
  it.skipIf(!ffmpegOk)("второй такой же файл получает duplicateOf со ссылкой на первый и тем, куда он вышел", async () => {
    const src = path.join(os.tmpdir(), `sv-dup-${runId}.mp4`);
    tmpFiles.push(src);
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=360x640:rate=30", "-f", "lavfi", "-i", "sine=frequency=330:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src,
    ], { stdio: "ignore" });
    const upload = () =>
      request(app)
        .post("/api/v1/social-videos")
        .set(auth("MARKETING"))
        .field("title", `Дубль ${runId}`)
        .field("caption", "п")
        .field("channels", JSON.stringify(["TELEGRAM"]))
        .attach("video", src, { filename: "dup.mp4", contentType: "video/mp4" });

    const first = await upload();
    expect(first.status).toBe(201);
    videoIds.push(first.body.id);
    expect(first.body.duplicateOf).toBeNull();
    // Первый ролик «вышел» в Telegram.
    await prisma.socialVideoPost.update({
      where: { id: first.body.id },
      data: {
        status: "DONE",
        channelResults: { TELEGRAM: { state: "PUBLISHED", error: null, note: null, postId: "1", url: null, retriable: false, attempts: 1, startedAt: null, finishedAt: null } },
      },
    });

    const second = await upload();
    expect(second.status).toBe(201);
    videoIds.push(second.body.id);
    expect(second.body.duplicateOf).toMatchObject({ id: first.body.id, status: "DONE", publishedTo: ["Telegram"] });
    // Предупреждение, а не запрет: второй ролик создан.
    expect(second.body.id).not.toBe(first.body.id);
  });
});

describe("свободные ролики в «Маркетинге»", () => {
  it("статистика, лента и расписание отдают свободные ролики", async () => {
    const published = await makePublished({ keys: { INSTAGRAM: { postId: "ig-stat" }, TELEGRAM: { postId: "5" } } });
    const stats = await request(app).get("/api/v1/marketing/post-stats?refresh=1").set(auth("MARKETING"));
    expect(stats.status).toBe(200);
    const free = stats.body.freeVideos.find((v: { id: string }) => v.id === published.id);
    expect(free).toBeTruthy();
    expect(free.stats.map((s: { channel: string }) => s.channel).sort()).toEqual(["INSTAGRAM", "TELEGRAM"]);
    // Свободный ролик не попадает в список роликов объектов (разбор «почему взлетели» привязан к карточке).
    expect(stats.body.posts.some((p: { propertyId: string }) => String(p.propertyId).startsWith("free:"))).toBe(false);

    const feed = await request(app).get("/api/v1/marketing/recently-published").set(auth("MARKETING"));
    expect(feed.status).toBe(200);
    expect(feed.body.freeVideos.some((v: { id: string }) => v.id === published.id)).toBe(true);

    const scheduledAt = new Date(Date.now() + 3 * 3600_000);
    const scheduled = await prisma.socialVideoPost.create({
      data: { title: `Расписание ${runId}`, videoPath: "/uploads/handoff/promo-none.mp4", originalName: "s.mp4", sizeBytes: 4, channels: ["TELEGRAM"], status: "SCHEDULED", scheduledAt },
    });
    videoIds.push(scheduled.id);
    const schedule = await request(app).get("/api/v1/marketing/publish-schedule").set(auth("MARKETING"));
    expect(schedule.status).toBe(200);
    expect(schedule.body.freeUpcoming).toEqual(expect.arrayContaining([expect.objectContaining({ id: scheduled.id, channels: ["TELEGRAM"], overdue: false })]));
  });
});
