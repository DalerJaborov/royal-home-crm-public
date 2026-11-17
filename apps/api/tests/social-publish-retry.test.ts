import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * META НЕ СМОГЛА СКАЧАТЬ РОЛИК — ПОВТОР ЧЕРЕЗ НЕСКОЛЬКО МИНУТ (18.11.2026, объект
 * №208). Публикация совпала с автовыкатом: nginx, который раздаёт /uploads/,
 * перезапускался полторы минуты, и Facebook ответил «Unable to fetch video file
 * from URL.». Раньше это был окончательный отказ — канал не выходил никогда.
 *
 * Здесь вся цепочка на настоящей базе, с подменённым fetch: признак доезжает из
 * ответа Graph API, публикация объекта ставит задание повтора на канал, задание
 * публикует ровно этот канал и пишет его в карточку, не трогает уже вышедший и
 * бросает (для лесенки очереди), пока Meta всё ещё не может скачать файл.
 */

const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));

process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY ?? "7e58774a6ca3f8f094b302efc65290b09ba8d51dacebdb60e8e693452f1ab810";

const { prisma } = await import("../src/db.js");
const { publishApprovedPost } = await import("../src/lib/socialPublish.js");
const { publishHandoffResult, isHandoffPublishRunning } = await import("../src/lib/videoHandoff.js");
const { socialPublishRetryJob } = await import("../src/jobs/socialPublishRetry.js");
const { SOCIAL_PUBLISH_RETRY_JOB_TYPE, socialPublishRetryDedupeKey, socialPublishRetryDedupeKeys, socialPublishRetryBackoffMs } =
  await import("../src/jobs/socialPublishRetryPolicy.js");
const { encryptSecret } = await import("../src/crypto.js");
const { uploadsDir } = await import("../src/upload.js");

const runId = Date.now();
const VIDEO_PUBLIC_PATH = `/uploads/handoff/meta-retry-${runId}.mp4`;
const videoDiskPath = path.join(uploadsDir, VIDEO_PUBLIC_PATH.slice("/uploads/".length));
const PAGE_ID = `page-${runId}`;

let districtId: string;
let propertyId: string;
let savedSettings: Record<string, unknown>;

type FacebookAnswer = "fetch-failed" | "token-dead" | "ok";

/** Подмена Graph API Facebook: `/videos` отвечает по сценарию, всё прочее — пустым успехом. */
function facebookFetchMock(answer: FacebookAnswer) {
  return vi.fn(async (url: string) => {
    const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as unknown as Response;
    if (url.includes(`/${PAGE_ID}/videos`)) {
      if (answer === "fetch-failed") {
        return json({ error: { message: "Unable to fetch video file from URL.", type: "OAuthException", code: 389 } }, false, 400);
      }
      if (answer === "token-dead") {
        return json({ error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 } }, false, 400);
      }
      return json({ id: `fbvideo-${runId}` });
    }
    if (url.includes(`fbvideo-${runId}`)) return json({ post_id: `${PAGE_ID}_post` });
    return json({}, false, 404);
  });
}

function facebookPostCalls(fetchMock: ReturnType<typeof facebookFetchMock>) {
  return fetchMock.mock.calls.filter((c) => String(c[0]).includes(`/${PAGE_ID}/videos`));
}

async function retryJobs(target: "FACEBOOK" | "INSTAGRAM_STORIES" = "FACEBOOK") {
  return prisma.backgroundJob.findMany({ where: { dedupeKey: socialPublishRetryDedupeKey(propertyId, target) } });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-meta-retry-${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект Meta повтор ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая повтора Meta, 1",
        condition: "GOOD",
      },
    })
  ).id;
  await fs.mkdir(path.dirname(videoDiskPath), { recursive: true });
  await fs.writeFile(videoDiskPath, "fake mp4 bytes");

  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedSettings = {
    metaIgToken: current.metaIgToken,
    metaPageToken: current.metaPageToken,
    metaPageId: current.metaPageId,
    telegramChannelId: current.telegramChannelId,
    telegramExtraChatIds: current.telegramExtraChatIds,
    youtubeRefreshToken: current.youtubeRefreshToken,
    tiktokRefreshToken: current.tiktokRefreshToken,
    threadsAccessToken: current.threadsAccessToken,
    autoPublishEnabled: current.autoPublishEnabled,
  };
  // Настроен ТОЛЬКО Facebook — остальные каналы молча пропускаются.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      metaIgToken: null,
      metaPageToken: encryptSecret("page-token"),
      metaPageId: PAGE_ID,
      telegramChannelId: null,
      telegramExtraChatIds: null,
      youtubeRefreshToken: null,
      tiktokRefreshToken: null,
      threadsAccessToken: null,
      autoPublishEnabled: true,
    },
  });
});

beforeEach(async () => {
  await prisma.property.update({
    where: { id: propertyId },
    data: {
      publishedChannels: [],
      publishedPostIds: {},
      status: "EDITING",
      videoHandoffFinalPath: VIDEO_PUBLIC_PATH,
      clipReviewStatus: "NONE",
      reelsCaption: "Подпись объекта",
    },
  });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: socialPublishRetryDedupeKeys(propertyId) } } });
  logSystemError.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: socialPublishRetryDedupeKeys(propertyId) } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await fs.rm(videoDiskPath, { force: true });
  await prisma.$disconnect();
});

describe("Лесенка повтора Meta", () => {
  it("идёт минутами и укладывается в окно серии историй (два часа)", () => {
    expect(socialPublishRetryBackoffMs(1)).toBe(15 * 60_000);
    expect(socialPublishRetryBackoffMs(2)).toBe(30 * 60_000);
    expect(socialPublishRetryBackoffMs(3)).toBe(45 * 60_000);
    expect(socialPublishRetryBackoffMs(9)).toBe(45 * 60_000);
    // Первая попытка через 5 минут плюс три паузы — меньше двух часов.
    expect(5 + 15 + 30 + 45).toBeLessThan(120);
  });

  it("срок одной попытки меньше подбора зависших RUNNING (15 минут)", () => {
    expect(socialPublishRetryJob.timeoutMs ?? 60_000).toBeLessThan(15 * 60_000);
    expect(socialPublishRetryJob.timeoutMs ?? 60_000).toBeGreaterThan(5 * 60_000);
  });
});

describe("Facebook не смог скачать ролик", () => {
  it("отказ помечен «повторить позже», журнал говорит «отложена», а не «не удалась»", async () => {
    vi.stubGlobal("fetch", facebookFetchMock("fetch-failed"));

    const results = await publishApprovedPost({ propertyId, localVideoPath: VIDEO_PUBLIC_PATH, caption: "Подпись" });

    const facebook = results.find((r) => r.channel === "FACEBOOK");
    expect(facebook?.ok).toBe(false);
    expect(facebook?.retriable).toBe(true);
    const messages = logSystemError.mock.calls.map((c) => String(c[1]));
    // Начало «Публикация в Facebook (объект …)» — по нему карточка находит канал.
    expect(messages.some((m) => m.startsWith(`Публикация в Facebook (объект ${propertyId}) отложена`))).toBe(true);
  });

  it("токен умер — повторять нечего, признака нет", async () => {
    vi.stubGlobal("fetch", facebookFetchMock("token-dead"));

    const results = await publishApprovedPost({ propertyId, localVideoPath: VIDEO_PUBLIC_PATH, caption: "Подпись" });

    const facebook = results.find((r) => r.channel === "FACEBOOK");
    expect(facebook?.ok).toBe(false);
    expect(facebook?.retriable).toBeFalsy();
  });
});

describe("Публикация объекта ставит повтор сама", () => {
  it("Facebook не скачал файл — задание повтора на этот канал через ~5 минут, канал не «сломан»", async () => {
    vi.stubGlobal("fetch", facebookFetchMock("fetch-failed"));

    const summary = await publishHandoffResult(propertyId, VIDEO_PUBLIC_PATH);

    expect(summary.failedChannels.map((f) => f.channel)).not.toContain("FACEBOOK");
    expect(summary.pendingChannels.map((p) => p.channel)).toContain("FACEBOOK");
    const jobs = await retryJobs("FACEBOOK");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe(SOCIAL_PUBLISH_RETRY_JOB_TYPE);
    expect(jobs[0].payload).toMatchObject({ propertyId, channel: "FACEBOOK" });
    // Не сразу: выкат с перезапуском nginx длится минуты.
    expect(jobs[0].runAt.getTime()).toBeGreaterThan(Date.now() + 3 * 60_000);
    // Прежняя запись «публикация потеряна» больше не пишется.
    expect(logSystemError.mock.calls.some((c) => String(c[1]).includes("публикация потеряна"))).toBe(false);
  });

  it("второй такой же отказ не плодит второе задание", async () => {
    vi.stubGlobal("fetch", facebookFetchMock("fetch-failed"));

    await publishHandoffResult(propertyId, VIDEO_PUBLIC_PATH);
    await publishHandoffResult(propertyId, VIDEO_PUBLIC_PATH);

    expect(await retryJobs("FACEBOOK")).toHaveLength(1);
  });

  it("токен умер — задания нет, канал в отказах", async () => {
    vi.stubGlobal("fetch", facebookFetchMock("token-dead"));

    const summary = await publishHandoffResult(propertyId, VIDEO_PUBLIC_PATH);

    expect(summary.failedChannels.map((f) => f.channel)).toContain("FACEBOOK");
    expect(await retryJobs("FACEBOOK")).toHaveLength(0);
  });

  it("идущий повтор виден как «идёт публикация» — кнопки карточки не наедут на него", async () => {
    await prisma.backgroundJob.create({
      data: {
        type: SOCIAL_PUBLISH_RETRY_JOB_TYPE,
        payload: { propertyId, channel: "FACEBOOK" },
        maxAttempts: 4,
        dedupeKey: socialPublishRetryDedupeKey(propertyId, "FACEBOOK"),
        status: "RUNNING",
      },
    });
    expect(await isHandoffPublishRunning(propertyId)).toBe(true);
  });
});

describe("Само задание повтора", () => {
  it("файл снова отдаётся — Facebook выходит, канал и id поста в карточке", async () => {
    const fetchMock = facebookFetchMock("ok");
    vi.stubGlobal("fetch", fetchMock);

    await socialPublishRetryJob.run({ propertyId, channel: "FACEBOOK" }, { attempt: 1 });

    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.publishedChannels).toContain("FACEBOOK");
    expect((property.publishedPostIds as Record<string, string>).FACEBOOK).toBe(`fbvideo-${runId}`);
    expect(facebookPostCalls(fetchMock)).toHaveLength(1);
  });

  it("Facebook уже вышел — повтор никуда не ходит (иначе второй пост в ленте)", async () => {
    await prisma.property.update({ where: { id: propertyId }, data: { publishedChannels: ["FACEBOOK"] } });
    const fetchMock = facebookFetchMock("ok");
    vi.stubGlobal("fetch", fetchMock);

    await socialPublishRetryJob.run({ propertyId, channel: "FACEBOOK" }, { attempt: 1 });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Meta всё ещё не может скачать — задание бросает, чтобы очередь повторила его", async () => {
    vi.stubGlobal("fetch", facebookFetchMock("fetch-failed"));

    await expect(socialPublishRetryJob.run({ propertyId, channel: "FACEBOOK" }, { attempt: 1 })).rejects.toThrow(/не смог скачать/);

    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.publishedChannels).not.toContain("FACEBOOK");
  });

  it("на повторе умер токен — не бросает (повторять нечего), одна понятная строка в журнал", async () => {
    vi.stubGlobal("fetch", facebookFetchMock("token-dead"));

    await expect(socialPublishRetryJob.run({ propertyId, channel: "FACEBOOK" }, { attempt: 1 })).resolves.toBeUndefined();

    const ours = logSystemError.mock.calls.filter((c) => String(c[1]).includes("при отложенном повторе"));
    expect(ours).toHaveLength(1);
  });

  it("основная публикация объекта идёт прямо сейчас — повтор ждёт, а не публикует параллельно", async () => {
    const { videoHandoffPublishDedupeKey } = await import("../src/lib/videoHandoff.js");
    const main = await prisma.backgroundJob.create({
      data: { type: "video-handoff-publish", payload: { propertyId }, maxAttempts: 6, dedupeKey: videoHandoffPublishDedupeKey(propertyId), status: "RUNNING" },
    });
    const fetchMock = facebookFetchMock("ok");
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(socialPublishRetryJob.run({ propertyId, channel: "FACEBOOK" }, { attempt: 1 })).rejects.toThrow(/основная публикация/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await prisma.backgroundJob.delete({ where: { id: main.id } });
    }
  });

  it.each(["SOLD", "WITHDRAWN", "RESERVED"] as const)("объект %s — без публикации, задание завершается", async (status) => {
    await prisma.property.update({ where: { id: propertyId }, data: { status } });
    const fetchMock = facebookFetchMock("ok");
    vi.stubGlobal("fetch", fetchMock);

    await expect(socialPublishRetryJob.run({ propertyId, channel: "FACEBOOK" }, { attempt: 1 })).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("новый ролик ждёт модератора — повтор старой попытки ничего не публикует", async () => {
    await prisma.property.update({ where: { id: propertyId }, data: { clipReviewStatus: "PENDING" } });
    const fetchMock = facebookFetchMock("ok");
    vi.stubGlobal("fetch", fetchMock);

    await socialPublishRetryJob.run({ propertyId, channel: "FACEBOOK" }, { attempt: 1 });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("истории: повтор опоздал за окно серии — ничего не публикует, честно сдаётся строкой в журнал", async () => {
    const fetchMock = facebookFetchMock("ok");
    vi.stubGlobal("fetch", fetchMock);

    await socialPublishRetryJob.run(
      { propertyId, channel: "INSTAGRAM_STORIES", notAfter: new Date(Date.now() - 60_000).toISOString() },
      { attempt: 1 }
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logSystemError.mock.calls.some((c) => String(c[1]).includes("повтор опоздал"))).toBe(true);
  });

  it("попытки кончились — строка «Публикация в Facebook (объект …) не удалась» для карточки", async () => {
    await socialPublishRetryJob.onGiveUp({ propertyId, channel: "FACEBOOK" });

    const messages = logSystemError.mock.calls.map((c) => String(c[1]));
    expect(messages.some((m) => m.startsWith(`Публикация в Facebook (объект ${propertyId}) не удалась`))).toBe(true);
  });
});
