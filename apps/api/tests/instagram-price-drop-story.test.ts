import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ИСТОРИЯ «ЦЕНА СНИЖЕНА» (21.09.2026) — lib/instagramStories.ts::publishPropertyPriceDropStory.
 * Сеть (Graph API) и рендер картинки подменены — тест не ходит в реальную Meta
 * и не гоняет настоящий sharp/фото. Проверяем то, что решает наш код:
 *  - рубильник выключен — публикации не было вовсе;
 *  - рубильник включён, историй по объекту ещё не было — картинка публикуется,
 *    в PropertyStoryPost остаётся строка с kind="PRICE_DROP";
 *  - повтор в течение суток по тому же объекту — не публикуем второй раз;
 *  - прошли сутки с прошлой истории «цена снижена» — публикуем снова;
 *  - объект без фото (generateStoryCard отказала) — не падаем исключением,
 *    честный отказ в summary, PropertyStoryPost не создаётся.
 */

const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

const { publishInstagramStoryImage } = vi.hoisted(() => ({
  publishInstagramStoryImage: vi.fn(async () => ({ channel: "INSTAGRAM" as const, ok: true, postId: "drop-story-1" })),
}));
vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  publishInstagramStoryImage,
}));

const { instagramTokenIdentity } = vi.hoisted(() => ({
  instagramTokenIdentity: vi.fn(async () => ({ ok: true as const, id: "ig-user-1" })),
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  instagramTokenIdentity,
}));

const { generateStoryCard } = vi.hoisted(() => ({
  generateStoryCard: vi.fn(async () => ({ ok: true as const, image: Buffer.from("fake-jpeg"), error: null })),
}));
vi.mock("../src/lib/video/storyCard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/video/storyCard.js")>()),
  generateStoryCard,
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  writeFile: vi.fn(async () => {}),
  unlink: vi.fn(async () => {}),
}));

process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";

const { prisma } = await import("../src/db.js");
const { publishPropertyPriceDropStory } = await import("../src/lib/instagramStories.js");
const { encryptSecret } = await import("../src/crypto.js");

const runId = Date.now();
let districtId: string;
let propertyId: string;
let savedSettings: { metaIgToken: string | null; instagramStoriesEnabled: boolean };

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-снижение-${runId}` } })).id;
  const property = await prisma.property.create({
    data: {
      title: `Тест-объект-снижение-${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 280000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 2",
      condition: "GOOD",
    },
  });
  propertyId = property.id;

  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedSettings = { metaIgToken: current.metaIgToken, instagramStoriesEnabled: current.instagramStoriesEnabled };
});

beforeEach(async () => {
  logSystemError.mockClear();
  publishInstagramStoryImage.mockClear();
  publishInstagramStoryImage.mockResolvedValue({ channel: "INSTAGRAM", ok: true, postId: "drop-story-1" });
  instagramTokenIdentity.mockClear();
  instagramTokenIdentity.mockResolvedValue({ ok: true, id: "ig-user-1" });
  generateStoryCard.mockClear();
  generateStoryCard.mockResolvedValue({ ok: true, image: Buffer.from("fake-jpeg"), error: null });
  await prisma.propertyStoryPost.deleteMany({ where: { propertyId } });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { metaIgToken: encryptSecret("fake-ig-token"), instagramStoriesEnabled: false },
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

describe("publishPropertyPriceDropStory", () => {
  it("рубильник выключен — публикации не было вовсе", async () => {
    const summary = await publishPropertyPriceDropStory(propertyId, "280 000 с.");
    expect(summary.attempted).toBe(false);
    expect(publishInstagramStoryImage).not.toHaveBeenCalled();
    expect(generateStoryCard).not.toHaveBeenCalled();
    expect((await prisma.propertyStoryPost.findMany({ where: { propertyId } })).length).toBe(0);
  });

  it("рубильник включён, историй ещё не было — картинка публикуется, kind=PRICE_DROP", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { instagramStoriesEnabled: true } });

    const summary = await publishPropertyPriceDropStory(propertyId, "280 000 с.");

    expect(summary.attempted).toBe(true);
    expect(summary.publishedParts).toBe(1);
    expect(generateStoryCard).toHaveBeenCalledWith(propertyId, { priceWasText: "280 000 с." });
    expect(publishInstagramStoryImage).toHaveBeenCalledTimes(1);
    // (propertyId, igUserId, token, imageUrl) — propertyId добавлен 21.09.2026
    // (случай №111), чтобы отложенный контейнер можно было сохранить на дозавершение.
    const [, , , imageUrl] = publishInstagramStoryImage.mock.calls[0];
    expect(imageUrl).toMatch(/^https:\/\/crm-test\.royalhome\.tj\/uploads\/handoff\//);

    const rows = await prisma.propertyStoryPost.findMany({ where: { propertyId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "INSTAGRAM", mediaId: "drop-story-1", partIndex: 0, kind: "PRICE_DROP" });
  });

  it("повтор в течение суток по тому же объекту — не публикуем второй раз", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { instagramStoriesEnabled: true } });
    await prisma.propertyStoryPost.create({
      data: { propertyId, channel: "INSTAGRAM", mediaId: "drop-story-0", partIndex: 0, kind: "PRICE_DROP", publishedAt: new Date() },
    });

    const summary = await publishPropertyPriceDropStory(propertyId, "270 000 с.");

    expect(summary.attempted).toBe(false);
    expect(publishInstagramStoryImage).not.toHaveBeenCalled();
    expect((await prisma.propertyStoryPost.findMany({ where: { propertyId } })).length).toBe(1);
  });

  it("прошли сутки с прошлой истории «цена снижена» — публикуем снова", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { instagramStoriesEnabled: true } });
    const overADayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await prisma.propertyStoryPost.create({
      data: { propertyId, channel: "INSTAGRAM", mediaId: "drop-story-0", partIndex: 0, kind: "PRICE_DROP", publishedAt: overADayAgo },
    });

    const summary = await publishPropertyPriceDropStory(propertyId, "260 000 с.");

    expect(summary.attempted).toBe(true);
    expect(summary.publishedParts).toBe(1);
    expect((await prisma.propertyStoryPost.findMany({ where: { propertyId } })).length).toBe(2);
  });

  it("видео-историю (kind=VIDEO) не считает за историю «цена снижена» — не блокирует повтор", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { instagramStoriesEnabled: true } });
    await prisma.propertyStoryPost.create({
      data: { propertyId, channel: "INSTAGRAM", mediaId: "video-story-0", partIndex: 0, kind: "VIDEO", publishedAt: new Date() },
    });

    const summary = await publishPropertyPriceDropStory(propertyId, "250 000 с.");

    expect(summary.attempted).toBe(true);
    expect(summary.publishedParts).toBe(1);
  });

  it("объект без фото (generateStoryCard отказала) — честный отказ, без исключения, без записи в журнал публикаций", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { instagramStoriesEnabled: true } });
    generateStoryCard.mockResolvedValue({ ok: false, image: null, error: "У объекта нет ни одной фотографии" });

    const summary = await publishPropertyPriceDropStory(propertyId, "280 000 с.");

    expect(summary.attempted).toBe(true);
    expect(summary.publishedParts).toBe(0);
    expect(summary.error).toContain("фотограф");
    expect(publishInstagramStoryImage).not.toHaveBeenCalled();
    expect((await prisma.propertyStoryPost.findMany({ where: { propertyId } })).length).toBe(0);
  });

  it("Meta отказала на публикации — logSystemError вызван, исключение не вылетает", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { instagramStoriesEnabled: true } });
    publishInstagramStoryImage.mockResolvedValue({ channel: "INSTAGRAM", ok: false, error: "Media type is invalid" });

    const summary = await publishPropertyPriceDropStory(propertyId, "280 000 с.");

    expect(summary.attempted).toBe(true);
    expect(summary.publishedParts).toBe(0);
    expect(summary.error).toBe("Media type is invalid");
    expect(logSystemError).toHaveBeenCalledWith("meta", expect.stringContaining(`объект ${propertyId}`));
    expect((await prisma.propertyStoryPost.findMany({ where: { propertyId } })).length).toBe(0);
  });
});
