import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * АУДИТ CODEX 04.10.2026, пакет E:
 *
 * PUB06: неудачное удаление дополнительного Telegram-поста теряло его id — весь
 *        TELEGRAM_EXTRA удалялся вместе с каналом, а ответ говорил «снято».
 * PUB07: сверка соцсетей (и снятие, и запись результата публикации) писала ЦЕЛИКОМ
 *        устаревший снимок publishedChannels/publishedPostIds: id, сохранённый
 *        параллельной публикацией во время долгой внешней пробы, пропадал.
 *
 * Сети подменены, управляемая задержка (deferred) стоит между чтением и записью.
 */

const { checkFacebookVideoExists, checkInstagramMediaExists, checkYouTubeVideoExists, deleteFacebookVideo, deleteChannelMessage, logSystemError } =
  vi.hoisted(() => ({
    checkFacebookVideoExists: vi.fn(async () => ({ status: "present" }) as { status: string; reason?: string }),
    checkInstagramMediaExists: vi.fn(async () => ({ status: "present" }) as { status: string; reason?: string }),
    checkYouTubeVideoExists: vi.fn(async () => ({ status: "present" }) as { status: string; reason?: string }),
    deleteFacebookVideo: vi.fn(async () => ({ ok: true })),
    deleteChannelMessage: vi.fn(async () => {}),
    logSystemError: vi.fn(async () => {}),
  }));

vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  checkFacebookVideoExists,
  checkInstagramMediaExists,
  checkYouTubeVideoExists,
  deleteFacebookVideo,
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  deleteChannelMessage,
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  loadCredentials: async () => ({ pageToken: "page-token", pageId: "page-1", igToken: "ig-token" }),
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));

const { prisma } = await import("../src/db.js");
const { runPublishedChannelsAuditTick } = await import("../src/lib/publishedChannelsAudit.js");
const { removeFromSocial } = await import("../src/lib/publishedVideoFix.js");
const { applySucceededPublishResults } = await import("../src/lib/videoHandoff.js");
const { updatePublishedMarks } = await import("../src/lib/publishedMarks.js");

const runId = Date.now();
const propertyIds: string[] = [];
let districtId = "";
let savedTelegramChannel: string | null = null;

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function seed(overrides: Record<string, unknown> = {}) {
  const property = await prisma.property.create({
    data: {
      title: `Пометки каналов ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 54,
      floor: 3,
      price: 390000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 9",
      condition: "GOOD",
      status: "AVAILABLE",
      publishedChannels: ["FACEBOOK"],
      publishedPostIds: { FACEBOOK: "fb-1" },
      ...overrides,
    } as never,
  });
  propertyIds.push(property.id);
  return property;
}

const reload = (id: string) =>
  prisma.property.findUniqueOrThrow({ where: { id }, select: { publishedChannels: true, publishedPostIds: true, instagramUrl: true } });

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Пометки каналов ${runId}` } })).id;
  const s = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" }, select: { telegramChannelId: true } });
  savedTelegramChannel = s.telegramChannelId;
  await prisma.settings.update({ where: { id: "singleton" }, data: { telegramChannelId: "@rh-test-channel" } });
});

beforeEach(() => {
  checkFacebookVideoExists.mockReset().mockResolvedValue({ status: "present" });
  checkInstagramMediaExists.mockReset().mockResolvedValue({ status: "present" });
  checkYouTubeVideoExists.mockReset().mockResolvedValue({ status: "present" });
  deleteFacebookVideo.mockReset().mockResolvedValue({ ok: true });
  deleteChannelMessage.mockReset().mockResolvedValue(undefined);
  logSystemError.mockClear();
});

afterEach(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { metaIgManageToken: null } });
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { telegramChannelId: savedTelegramChannel } });
  await prisma.$disconnect();
});

describe("updatePublishedMarks: условная запись", () => {
  it("пометки изменились между чтением и записью — попытка отвергнута и посчитана заново от свежих", async () => {
    const p = await seed({ publishedChannels: ["FACEBOOK"], publishedPostIds: { FACEBOOK: "fb-1" } });
    // Параллельная запись ровно между чтением хелпера и его условным обновлением.
    const realFindUnique = prisma.property.findUnique.bind(prisma.property);
    let injected = false;
    const spy = vi.spyOn(prisma.property, "findUnique").mockImplementation(((args: never) => {
      const read = realFindUnique(args);
      if (injected) return read;
      injected = true;
      return read.then(async (row: unknown) => {
        await prisma.property.update({
          where: { id: p.id },
          data: { publishedChannels: ["FACEBOOK", "YOUTUBE"], publishedPostIds: { FACEBOOK: "fb-1", YOUTUBE: "yt-1" } },
        });
        return row;
      });
    }) as never);
    let calls = 0;
    try {
      const result = await updatePublishedMarks(p.id, (current) => {
        calls++;
        return { channels: [...current.channels, "TIKTOK"], postIds: { ...current.postIds, TIKTOK: "tt-1" } };
      });
      expect(result.applied).toBe(true);
    } finally {
      spy.mockRestore();
    }
    // Первая попытка отвергнута (пометки уже другие), вторая посчитана от свежих.
    expect(calls).toBe(2);
    const after = await reload(p.id);
    expect(after.publishedChannels).toEqual(["FACEBOOK", "YOUTUBE", "TIKTOK"]);
    expect(after.publishedPostIds).toEqual({ FACEBOOK: "fb-1", YOUTUBE: "yt-1", TIKTOK: "tt-1" });
  });

  it("compute вернула null — запись не выполняется", async () => {
    const p = await seed({ publishedChannels: ["FACEBOOK"], publishedPostIds: { FACEBOOK: "fb-1" } });
    const result = await updatePublishedMarks(p.id, () => null);
    expect(result.applied).toBe(false);
    expect((await reload(p.id)).publishedChannels).toEqual(["FACEBOOK"]);
  });
});
describe("PUB07: сверка не затирает id параллельной публикации", () => {
  it("пока идёт проба, YouTube сохраняет новый id — после сверки он на месте, метка сверки поставлена", async () => {
    const p = await seed({ publishedChannels: ["FACEBOOK"], publishedPostIds: { FACEBOOK: "fb-1" } });
    const probe = deferred<{ status: string }>();
    checkFacebookVideoExists.mockImplementation(() => probe.promise);

    const run = runPublishedChannelsAuditTick(new Date(), { propertyIds: [p.id] });
    await vi.waitFor(() => expect(checkFacebookVideoExists).toHaveBeenCalled());
    // Параллельная публикация дописывает YouTube, пока проба Facebook висит.
    await applySucceededPublishResults(p.id, [{ channel: "YOUTUBE", postId: "yt-new" }], null, { finalize: false });
    probe.resolve({ status: "present" });
    await run;

    const after = await reload(p.id);
    const ids = after.publishedPostIds as Record<string, string>;
    expect(after.publishedChannels).toEqual(expect.arrayContaining(["FACEBOOK", "YOUTUBE"]));
    expect(ids.YOUTUBE).toBe("yt-new");
    expect(ids.FACEBOOK).toBe("fb-1");
    expect(ids.AUDIT_CHECKED_AT).toBeTruthy();
  });

  it("Facebook «gone», а за время пробы сохранён YouTube — Facebook вычеркнут, YouTube и его канал остались", async () => {
    const p = await seed({ publishedChannels: ["FACEBOOK"], publishedPostIds: { FACEBOOK: "fb-1" } });
    const probe = deferred<{ status: string }>();
    checkFacebookVideoExists.mockImplementation(() => probe.promise);

    const run = runPublishedChannelsAuditTick(new Date(), { propertyIds: [p.id] });
    await vi.waitFor(() => expect(checkFacebookVideoExists).toHaveBeenCalled());
    await applySucceededPublishResults(p.id, [{ channel: "YOUTUBE", postId: "yt-new" }], null, { finalize: false });
    probe.resolve({ status: "gone" });
    await run;

    const after = await reload(p.id);
    const ids = after.publishedPostIds as Record<string, string>;
    expect(after.publishedChannels).toEqual(["YOUTUBE"]);
    expect(ids.FACEBOOK).toBeUndefined();
    expect(ids.YOUTUBE).toBe("yt-new");
  });

  it("Facebook «gone» про СТАРЫЙ id, а параллельная публикация уже записала новый — канал не вычёркивается", async () => {
    const p = await seed({ publishedChannels: ["FACEBOOK"], publishedPostIds: { FACEBOOK: "fb-old" } });
    const probe = deferred<{ status: string }>();
    checkFacebookVideoExists.mockImplementation(() => probe.promise);

    const run = runPublishedChannelsAuditTick(new Date(), { propertyIds: [p.id] });
    await vi.waitFor(() => expect(checkFacebookVideoExists).toHaveBeenCalled());
    await applySucceededPublishResults(p.id, [{ channel: "FACEBOOK", postId: "fb-new", secondaryPostId: "fb-new-post" }], null, { finalize: false });
    probe.resolve({ status: "gone" });
    await run;

    const after = await reload(p.id);
    const ids = after.publishedPostIds as Record<string, string>;
    expect(after.publishedChannels).toContain("FACEBOOK");
    expect(ids.FACEBOOK).toBe("fb-new");
  });
});

describe("PUB07: запись результата публикации и снятие не теряют друг друга", () => {
  it("два applySucceededPublishResults одновременно — оба канала и оба id сохранены", async () => {
    const p = await seed({ publishedChannels: [], publishedPostIds: {} });
    await Promise.all([
      applySucceededPublishResults(p.id, [{ channel: "YOUTUBE", postId: "yt-1" }], null, { finalize: false }),
      applySucceededPublishResults(p.id, [{ channel: "TIKTOK", postId: "tt-1" }], null, { finalize: false }),
    ]);
    const after = await reload(p.id);
    const ids = after.publishedPostIds as Record<string, string>;
    expect(after.publishedChannels.sort()).toEqual(["TIKTOK", "YOUTUBE"]);
    expect(ids.YOUTUBE).toBe("yt-1");
    expect(ids.TIKTOK).toBe("tt-1");
  });

  it("removeFromSocial: пока идёт снятие Facebook, TikTok сохраняет id — после снятия он на месте", async () => {
    const p = await seed({ publishedChannels: ["FACEBOOK"], publishedPostIds: { FACEBOOK: "fb-1" } });
    const gate = deferred<{ ok: boolean }>();
    deleteFacebookVideo.mockImplementation(() => gate.promise);

    const run = removeFromSocial(p.id);
    await vi.waitFor(() => expect(deleteFacebookVideo).toHaveBeenCalled());
    await applySucceededPublishResults(p.id, [{ channel: "TIKTOK", postId: "tt-new" }], null, { finalize: false });
    gate.resolve({ ok: true });
    const result = await run;

    expect(result.removed).toContain("FACEBOOK");
    const after = await reload(p.id);
    const ids = after.publishedPostIds as Record<string, string>;
    expect(after.publishedChannels).toEqual(["TIKTOK"]);
    expect(ids.FACEBOOK).toBeUndefined();
    expect(ids.TIKTOK).toBe("tt-new");
  });
});

describe("PUB06: дополнительный Telegram-чат не теряет id при неудачном удалении", () => {
  it("основной снят, чат extra ответил 429 — failed содержит TELEGRAM, в TELEGRAM_EXTRA остался id упавшего чата, канал не вычеркнут", async () => {
    deleteChannelMessage.mockImplementation(async (chatId: string) => {
      if (chatId === "-100extra1") throw new Error("Telegram API deleteMessage: 429 Too Many Requests");
    });
    const p = await seed({
      publishedChannels: ["TELEGRAM"],
      publishedPostIds: { TELEGRAM: "4242", TELEGRAM_EXTRA: { "-100extra1": "111", "-100extra2": "222" } },
    });

    const result = await removeFromSocial(p.id);

    expect(result.failed.find((f) => f.channel === "TELEGRAM")?.error).toContain("-100extra1");
    expect(result.removed).not.toContain("TELEGRAM");
    const after = await reload(p.id);
    const ids = after.publishedPostIds as unknown as Record<string, unknown>;
    expect(after.publishedChannels).toContain("TELEGRAM");
    // Снятые чаты и основной пост из карточки убраны, упавший остался.
    expect(ids.TELEGRAM_EXTRA).toEqual({ "-100extra1": "111" });
    expect(ids.TELEGRAM).toBeUndefined();
  });

  it("повторное снятие находит упавший чат и добивает его, после чего канал вычёркивается", async () => {
    deleteChannelMessage.mockImplementation(async (chatId: string) => {
      if (chatId === "-100extra1") throw new Error("Telegram API deleteMessage: 429 Too Many Requests");
    });
    const p = await seed({
      publishedChannels: ["TELEGRAM"],
      publishedPostIds: { TELEGRAM: "4242", TELEGRAM_EXTRA: { "-100extra1": "111", "-100extra2": "222" } },
    });
    await removeFromSocial(p.id);

    deleteChannelMessage.mockReset().mockResolvedValue(undefined);
    const second = await removeFromSocial(p.id);

    expect(second.failed).toEqual([]);
    expect(second.removed).toContain("TELEGRAM");
    expect(deleteChannelMessage).toHaveBeenCalledTimes(1);
    expect(deleteChannelMessage).toHaveBeenCalledWith("-100extra1", 111);
    const after = await reload(p.id);
    expect(after.publishedChannels).not.toContain("TELEGRAM");
    expect((after.publishedPostIds as unknown as Record<string, unknown>).TELEGRAM_EXTRA).toBeUndefined();
  });
});
