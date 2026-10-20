import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ИСТОРИИ INSTAGRAM (21.09.2026) — lib/instagramStories.ts::publishPropertyInstagramStories.
 * Сеть (Graph API) и ffmpeg подменены — тест не ходит в реальную Meta и не
 * зовёт настоящий ffmpeg/ffprobe. Проверяем то, что решает наш код:
 *  - рубильник выключен и вызов не форсированный — публикации не было вовсе;
 *  - ролик короче 60 секунд — одна история, без нарезки;
 *  - ролик длиннее 60 секунд — режется на части и публикуется несколькими
 *    последовательными историями, каждая своей строкой PropertyStoryPost;
 *  - отказ Meta логируется через logSystemError и не бросает исключение
 *    (не роняет вызывающий код — тот же принцип, что у publishApprovedPost);
 *  - Property.publishedChannels НИКОГДА не меняется — история не публикация
 *    в ленту.
 */

const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

const { publishInstagramStory, checkInstagramPublishingLimit, publishFacebookStoryVideo } = vi.hoisted(() => ({
  publishInstagramStory: vi.fn(async () => ({ channel: "INSTAGRAM" as const, ok: true, postId: "story-1" })),
  checkInstagramPublishingLimit: vi.fn(async () => ({ ok: true as const, remaining: 50 })),
  publishFacebookStoryVideo: vi.fn(async () => ({ channel: "FACEBOOK" as const, ok: true, postId: "fb-story-1" })),
}));
vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  publishInstagramStory,
  checkInstagramPublishingLimit,
  publishFacebookStoryVideo,
}));

const { instagramTokenIdentity } = vi.hoisted(() => ({
  instagramTokenIdentity: vi.fn(async () => ({ ok: true as const, id: "ig-user-1" })),
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  instagramTokenIdentity,
}));

const { probeVideoDimensions, cutVideoSegment } = vi.hoisted(() => ({
  probeVideoDimensions: vi.fn(async () => ({ width: 1078, height: 1920, durationSec: 22 })),
  cutVideoSegment: vi.fn(async () => true),
}));
vi.mock("../src/lib/ffmpeg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ffmpeg.js")>()),
  probeVideoDimensions,
  cutVideoSegment,
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  unlink: vi.fn(async () => {}),
}));

process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";

const { prisma } = await import("../src/db.js");
const { publishPropertyInstagramStories } = await import("../src/lib/instagramStories.js");
const { encryptSecret } = await import("../src/crypto.js");

const runId = Date.now();
let districtId: string;
let propertyId: string;
let savedSettings: {
  metaIgToken: string | null;
  instagramStoriesEnabled: boolean;
  facebookStoriesEnabled: boolean;
  metaPageId: string | null;
  metaPageToken: string | null;
};

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-историй-${runId}` } })).id;
  const property = await prisma.property.create({
    data: {
      title: `Тест-объект-историй-${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      publishedChannels: ["YOUTUBE", "FACEBOOK"],
      videoHandoffFinalPath: "/uploads/handoff/test-story-video.mp4",
    },
  });
  propertyId = property.id;

  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedSettings = {
    metaIgToken: current.metaIgToken,
    instagramStoriesEnabled: current.instagramStoriesEnabled,
    facebookStoriesEnabled: current.facebookStoriesEnabled,
    metaPageId: current.metaPageId,
    metaPageToken: current.metaPageToken,
  };
});

beforeEach(async () => {
  logSystemError.mockClear();
  publishInstagramStory.mockClear();
  checkInstagramPublishingLimit.mockClear();
  publishFacebookStoryVideo.mockClear();
  probeVideoDimensions.mockClear();
  cutVideoSegment.mockClear();
  instagramTokenIdentity.mockClear();
  instagramTokenIdentity.mockResolvedValue({ ok: true, id: "ig-user-1" });
  publishInstagramStory.mockResolvedValue({ channel: "INSTAGRAM", ok: true, postId: "story-1" });
  checkInstagramPublishingLimit.mockResolvedValue({ ok: true, remaining: 50 });
  publishFacebookStoryVideo.mockResolvedValue({ channel: "FACEBOOK", ok: true, postId: "fb-story-1" });
  probeVideoDimensions.mockResolvedValue({ width: 1078, height: 1920, durationSec: 22 });
  cutVideoSegment.mockResolvedValue(true);
  await prisma.propertyStoryPost.deleteMany({ where: { propertyId } });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      metaIgToken: encryptSecret("fake-ig-token"),
      instagramStoriesEnabled: false,
      facebookStoriesEnabled: false,
      metaPageId: null,
      metaPageToken: null,
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await prisma.propertyStoryPost.deleteMany({ where: { propertyId } });
  await prisma.property.delete({ where: { id: propertyId } }).catch(() => {});
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.$disconnect();
});

describe("publishPropertyInstagramStories", () => {
  it("рубильник выключен, вызов не форсирован — публикации не было вовсе", async () => {
    const summary = await publishPropertyInstagramStories(propertyId, "/uploads/handoff/test-story-video.mp4");
    expect(summary).toEqual({ attempted: false, publishedParts: 0, totalParts: 0 });
    expect(publishInstagramStory).not.toHaveBeenCalled();
    expect((await prisma.propertyStoryPost.findMany({ where: { propertyId } })).length).toBe(0);
  });

  it("ролик короче 60 секунд, рубильник включён — одна история, без нарезки", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { instagramStoriesEnabled: true } });

    const summary = await publishPropertyInstagramStories(propertyId, "/uploads/handoff/test-story-video.mp4");

    expect(summary.attempted).toBe(true);
    expect(summary.publishedParts).toBe(1);
    expect(summary.totalParts).toBe(1);
    expect(cutVideoSegment).not.toHaveBeenCalled();
    expect(publishInstagramStory).toHaveBeenCalledTimes(1);

    const rows = await prisma.propertyStoryPost.findMany({ where: { propertyId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "INSTAGRAM", mediaId: "story-1", partIndex: 0 });
  });

  it("ролик длиннее 60 секунд, вызов форсирован кнопкой — режется на части и публикуется несколькими историями", async () => {
    probeVideoDimensions.mockResolvedValue({ width: 1078, height: 1920, durationSec: 67.5 });

    const summary = await publishPropertyInstagramStories(propertyId, "/uploads/handoff/test-story-video.mp4", { force: true });

    expect(summary.attempted).toBe(true);
    expect(summary.totalParts).toBe(2);
    expect(summary.publishedParts).toBe(2);
    expect(cutVideoSegment).toHaveBeenCalledTimes(2);
    expect(publishInstagramStory).toHaveBeenCalledTimes(2);

    const rows = await prisma.propertyStoryPost.findMany({ where: { propertyId }, orderBy: { partIndex: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.partIndex)).toEqual([0, 1]);
  });

  it("Meta отказала на первой части — logSystemError вызван, исключение НЕ вылетает, уже опубликованное остаётся", async () => {
    probeVideoDimensions.mockResolvedValue({ width: 1078, height: 1920, durationSec: 67.5 });
    publishInstagramStory
      .mockResolvedValueOnce({ channel: "INSTAGRAM", ok: false, error: "Video is too short" })
      .mockResolvedValueOnce({ channel: "INSTAGRAM", ok: true, postId: "story-2" });

    const summary = await publishPropertyInstagramStories(propertyId, "/uploads/handoff/test-story-video.mp4", { force: true });

    expect(summary.attempted).toBe(true);
    expect(summary.publishedParts).toBe(0);
    expect(summary.error).toBe("Video is too short");
    // Останавливается на первой неудаче — вторая часть не пытается публиковаться.
    expect(publishInstagramStory).toHaveBeenCalledTimes(1);
    expect(logSystemError).toHaveBeenCalledWith("meta", expect.stringContaining(`объект ${propertyId}`));
  });

  it("лимит публикаций исчерпан — не долбим Graph API, честный отказ в журнал", async () => {
    checkInstagramPublishingLimit.mockResolvedValue({ ok: true, remaining: 0 });

    const summary = await publishPropertyInstagramStories(propertyId, "/uploads/handoff/test-story-video.mp4", { force: true });

    expect(summary.attempted).toBe(true);
    expect(summary.publishedParts).toBe(0);
    expect(summary.error).toContain("лимит публикаций");
    expect(publishInstagramStory).not.toHaveBeenCalled();
    expect(logSystemError).toHaveBeenCalled();
  });

  it("publishedChannels объекта не меняется публикацией истории", async () => {
    await publishPropertyInstagramStories(propertyId, "/uploads/handoff/test-story-video.mp4", { force: true });
    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.publishedChannels.sort()).toEqual(["FACEBOOK", "YOUTUBE"]);
  });
});

/**
 * ОБОРВАННАЯ СЕРИЯ (22.09.2026, класс «страховка ставится ПОСЛЕ окна, которое
 * должна страховать»). Серия из нескольких частей идёт минутами; перезапуск
 * процесса посреди (автовыкат — на каждый мерж в main) обрывал её насовсем и
 * молча: часть 1 в Instagram, часть 2 нет, повтор задания в истории уже не
 * заходил. Теперь повтор доделывает недостающие части и не публикует заново то,
 * что уже вышло.
 */
describe("publishPropertyInstagramStories — продолжение оборванной серии", () => {
  /** Часть, «успевшая уйти» до обрыва: ровно то, что пишет успешный путь. */
  async function seedPublishedPart(partIndex: number, publishedAt = new Date()) {
    await prisma.propertyStoryPost.create({
      data: { propertyId, channel: "INSTAGRAM", mediaId: `story-was-${partIndex}`, partIndex, publishedAt },
    });
  }

  it("часть 1 из 2 уже вышла — публикуется только вторая, первая не дублируется", async () => {
    probeVideoDimensions.mockResolvedValue({ width: 1078, height: 1920, durationSec: 67.5 });
    await seedPublishedPart(0);

    const summary = await publishPropertyInstagramStories(propertyId, "/uploads/handoff/test-story-video.mp4", { force: true });

    expect(summary).toMatchObject({ attempted: true, publishedParts: 2, totalParts: 2 });
    expect(publishInstagramStory).toHaveBeenCalledTimes(1);
    // Недостающая часть — вторая: последний аргумент publishInstagramStory это partIndex.
    expect(publishInstagramStory.mock.calls[0].at(-1)).toBe(1);
    // Нарезали тоже только её — лишний проход ffmpeg по чужой части не нужен.
    expect(cutVideoSegment).toHaveBeenCalledTimes(1);
    const rows = await prisma.propertyStoryPost.findMany({ where: { propertyId }, orderBy: { partIndex: "asc" } });
    expect(rows.map((r) => r.partIndex)).toEqual([0, 1]);
  });

  it("resumeOnly: серия не начиналась — не публикует НИЧЕГО (иначе повтор задания выложил бы истории сам по себе)", async () => {
    probeVideoDimensions.mockResolvedValue({ width: 1078, height: 1920, durationSec: 67.5 });
    await prisma.settings.update({ where: { id: "singleton" }, data: { instagramStoriesEnabled: true } });

    const summary = await publishPropertyInstagramStories(propertyId, "/uploads/handoff/test-story-video.mp4", { resumeOnly: true });

    expect(summary).toEqual({ attempted: false, publishedParts: 0, totalParts: 0 });
    expect(publishInstagramStory).not.toHaveBeenCalled();
    expect(instagramTokenIdentity).not.toHaveBeenCalled();
  });

  it("resumeOnly: серия оборвалась — доделывает недостающую часть", async () => {
    probeVideoDimensions.mockResolvedValue({ width: 1078, height: 1920, durationSec: 67.5 });
    await prisma.settings.update({ where: { id: "singleton" }, data: { instagramStoriesEnabled: true } });
    await seedPublishedPart(0);

    const summary = await publishPropertyInstagramStories(propertyId, "/uploads/handoff/test-story-video.mp4", { resumeOnly: true });

    expect(summary).toMatchObject({ attempted: true, publishedParts: 2, totalParts: 2 });
    expect(publishInstagramStory).toHaveBeenCalledTimes(1);
  });

  it("вчерашняя серия по тому же объекту — не продолжение, выкладывается заново целиком", async () => {
    probeVideoDimensions.mockResolvedValue({ width: 1078, height: 1920, durationSec: 67.5 });
    await seedPublishedPart(0, new Date(Date.now() - 20 * 60 * 60 * 1000));

    const summary = await publishPropertyInstagramStories(propertyId, "/uploads/handoff/test-story-video.mp4", { force: true });

    expect(summary).toMatchObject({ attempted: true, publishedParts: 2, totalParts: 2 });
    expect(publishInstagramStory).toHaveBeenCalledTimes(2);
  });

  it("серия уже полная — сеть не трогаем вовсе, лимит не спрашиваем", async () => {
    probeVideoDimensions.mockResolvedValue({ width: 1078, height: 1920, durationSec: 67.5 });
    await seedPublishedPart(0);
    await seedPublishedPart(1);

    const summary = await publishPropertyInstagramStories(propertyId, "/uploads/handoff/test-story-video.mp4", { force: true });

    expect(summary).toMatchObject({ attempted: true, publishedParts: 2, totalParts: 2 });
    expect(publishInstagramStory).not.toHaveBeenCalled();
    expect(checkInstagramPublishingLimit).not.toHaveBeenCalled();
  });
});

/**
 * FACEBOOK ПОВЕРХ INSTAGRAM (28.09.2026) — Facebook выключен по умолчанию
 * (beforeEach выше), значит все тесты ВЫШЕ уже подтверждают «поведение как
 * раньше», ничего дополнительно повторять не нужно. Эти проверяют сам факт
 * добавки: включённый тумблер даёт вторую запись PropertyStoryPost, а отказ
 * Facebook не портит результат Instagram.
 */
describe("publishPropertyInstagramStories — Facebook поверх Instagram", () => {
  beforeEach(async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { facebookStoriesEnabled: true, metaPageId: "page-1", metaPageToken: encryptSecret("fake-page-token") },
    });
  });

  it("Facebook выключен — ведёт себя как раньше, publishFacebookStoryVideo не зовётся", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { facebookStoriesEnabled: false } });

    await publishPropertyInstagramStories(propertyId, "/uploads/handoff/test-story-video.mp4", { force: true });

    expect(publishFacebookStoryVideo).not.toHaveBeenCalled();
    const rows = await prisma.propertyStoryPost.findMany({ where: { propertyId } });
    expect(rows.every((r) => r.channel === "INSTAGRAM")).toBe(true);
  });

  it("Facebook включён и настроен — вторая запись PropertyStoryPost с channel FACEBOOK, тем же partIndex", async () => {
    const summary = await publishPropertyInstagramStories(propertyId, "/uploads/handoff/test-story-video.mp4", { force: true });

    expect(summary.publishedParts).toBe(1); // Facebook не входит в счёт Instagram.
    expect(publishFacebookStoryVideo).toHaveBeenCalledTimes(1);
    const rows = await prisma.propertyStoryPost.findMany({ where: { propertyId } });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.channel === "INSTAGRAM")).toMatchObject({ mediaId: "story-1", partIndex: 0 });
    expect(rows.find((r) => r.channel === "FACEBOOK")).toMatchObject({ mediaId: "fb-story-1", partIndex: 0 });
  });

  it("Facebook отказал — результат Instagram не портится, только запись в журнал ошибок", async () => {
    publishFacebookStoryVideo.mockResolvedValue({ channel: "FACEBOOK", ok: false, error: "Video processing failed" });

    const summary = await publishPropertyInstagramStories(propertyId, "/uploads/handoff/test-story-video.mp4", { force: true });

    expect(summary).toMatchObject({ attempted: true, publishedParts: 1, totalParts: 1 });
    expect(summary.error).toBeUndefined();
    const rows = await prisma.propertyStoryPost.findMany({ where: { propertyId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe("INSTAGRAM");
    expect(logSystemError).toHaveBeenCalledWith("meta", expect.stringContaining("Сторис Facebook"));
    // НЕ префикс «Публикация в» (тот же принцип, что у pending Instagram).
    const messages = logSystemError.mock.calls.map((c) => c[1] as string);
    expect(messages.some((m) => m.startsWith("Публикация в"))).toBe(false);
  });
});
