import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Цена изменилась на уже опубликованном объекте (владелец, 16.09.2026) —
 * правим текст в уже вышедших постах вместо повторной публикации.
 * lib/publishedListingSync.ts. Внешние вызовы (Telegram/Facebook/YouTube)
 * подменены — тот же приём, что в остальных social-publish-*.test.ts.
 */

const {
  editMessageCaption,
  updateFacebookVideoDescription,
  updateYouTubeDescription,
  loadCredentials,
  logSystemError,
  resyncPhotosIfPublished,
  publishPropertyPriceDropStory,
} = vi.hoisted(() => ({
  editMessageCaption: vi.fn(async () => {}),
  updateFacebookVideoDescription: vi.fn(async () => ({ ok: true })),
  updateYouTubeDescription: vi.fn(async () => ({ ok: true })),
  loadCredentials: vi.fn(async () => ({ pageToken: "fb-token", pageId: "123", igToken: "ig-token" })),
  logSystemError: vi.fn(async () => {}),
  resyncPhotosIfPublished: vi.fn(async () => {}),
  publishPropertyPriceDropStory: vi.fn(async () => ({ attempted: true, publishedParts: 1, totalParts: 1 })),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  editMessageCaption,
}));
vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  updateFacebookVideoDescription,
  updateYouTubeDescription,
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  loadCredentials,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));
vi.mock("../src/lib/siteSync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/siteSync.js")>()),
  resyncPhotosIfPublished,
}));
// История «цена снижена» (21.09.2026) — своя логика (рубильник, суточный кулдаун,
// рендер картинки, Graph API) уже покрыта instagram-price-drop-story.test.ts;
// здесь проверяем только то, что publishedListingSync ЗОВЁТ её с правильным
// решением «снижение/рост», не второй копией сравнения цен.
vi.mock("../src/lib/instagramStories.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/instagramStories.js")>()),
  publishPropertyPriceDropStory,
}));

const { prisma } = await import("../src/db.js");
const { syncPublishedPriceChange } = await import("../src/lib/publishedListingSync.js");
const { formatPrice } = await import("../src/ai/seoGenerator.js");

/** formatPrice ставит между тысячами U+00A0 (неразрывный пробел, ru-RU
 *  toLocaleString), не обычный — строка в подписи строится тем же вызовом,
 *  а не литералом "300 000", иначе сравнение молча не совпадает. */
const price300k = `✅Цена: ${formatPrice(300000, "TJS")}`;
const price250k = `✅Цена: ${formatPrice(250000, "TJS")}`;

const runId = Date.now();
let districtId: string;
const propertyIds: string[] = [];

async function seedProperty(overrides: Record<string, unknown> = {}) {
  const property = await prisma.property.create({
    data: {
      title: `Синхрон цены-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 300000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 5",
      condition: "GOOD",
      reelsCaption: `Хук.\n\n✅Район: Тест\n${price300k}\n\nЗвоните.`,
      publishedChannels: ["INSTAGRAM", "FACEBOOK", "TELEGRAM", "YOUTUBE"],
      publishedPostIds: { FACEBOOK: "fb-1", TELEGRAM: "42", YOUTUBE: "yt-1" },
      ...overrides,
    },
  });
  propertyIds.push(property.id);
  return property;
}

beforeEach(async () => {
  if (!districtId) {
    districtId = (await prisma.district.create({ data: { name: `Синхрон цены-${runId}` } })).id;
  }
  editMessageCaption.mockClear();
  updateFacebookVideoDescription.mockClear();
  updateFacebookVideoDescription.mockResolvedValue({ ok: true });
  updateYouTubeDescription.mockClear();
  updateYouTubeDescription.mockResolvedValue({ ok: true });
  loadCredentials.mockClear();
  logSystemError.mockClear();
  resyncPhotosIfPublished.mockClear();
  publishPropertyPriceDropStory.mockClear();
  publishPropertyPriceDropStory.mockResolvedValue({ attempted: true, publishedParts: 1, totalParts: 1 });
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { telegramChannelId: "-100999" },
    create: { id: "singleton", telegramChannelId: "-100999" },
  });
});

afterEach(async () => {
  if (propertyIds.length) {
    await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
    propertyIds.length = 0;
  }
});

afterAll(async () => {
  if (districtId) await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
});

describe("syncPublishedPriceChange", () => {
  it("цена поменялась — новый текст уходит в FB/Telegram/YouTube, Instagram — в журнал", async () => {
    const property = await seedProperty();
    await prisma.property.update({ where: { id: property.id }, data: { price: 250000 } });

    await syncPublishedPriceChange(property.id, 300000, "TJS");

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.reelsCaption).toContain(price250k);
    expect(after.reelsCaption).not.toContain(price300k);
    expect(editMessageCaption).toHaveBeenCalledWith("-100999", 42, expect.stringContaining(formatPrice(250000, "TJS")));
    expect(updateFacebookVideoDescription).toHaveBeenCalledWith("fb-1", "fb-token", expect.stringContaining(formatPrice(250000, "TJS")));
    expect(updateYouTubeDescription).toHaveBeenCalled();
    // Instagram не редактируется — только честная запись в журнал, без обращения к Meta за это.
    expect(logSystemError).toHaveBeenCalledWith("meta", expect.stringContaining("Instagram"));
  });

  it("подпись правили руками, старой цены в ней дословно нет — ничего не трогаем", async () => {
    const property = await seedProperty({ reelsCaption: "Ручной текст монтажёра без блока фактов." });
    await prisma.property.update({ where: { id: property.id }, data: { price: 250000 } });

    await syncPublishedPriceChange(property.id, 300000, "TJS");

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.reelsCaption).toBe("Ручной текст монтажёра без блока фактов.");
    expect(editMessageCaption).not.toHaveBeenCalled();
    expect(updateFacebookVideoDescription).not.toHaveBeenCalled();
  });

  it("цена не менялась (тот же формат) — тихо ничего не делает", async () => {
    const property = await seedProperty();

    await syncPublishedPriceChange(property.id, 300000, "TJS");

    expect(editMessageCaption).not.toHaveBeenCalled();
    expect(updateFacebookVideoDescription).not.toHaveBeenCalled();
    expect(updateYouTubeDescription).not.toHaveBeenCalled();
  });

  it("объект ещё нигде не опубликован — ничего не вызывается", async () => {
    const property = await seedProperty({ publishedChannels: [], publishedPostIds: null });
    await prisma.property.update({ where: { id: property.id }, data: { price: 250000 } });

    await syncPublishedPriceChange(property.id, 300000, "TJS");

    expect(editMessageCaption).not.toHaveBeenCalled();
    expect(updateFacebookVideoDescription).not.toHaveBeenCalled();
  });

  describe("описание на сайте (владелец, второй заход: «описание на сайте не меняется»)", () => {
    it("объект опубликован на сайте — цена в тексте описания пересчитывается, досылка на сайт", async () => {
      const property = await seedProperty({
        publishedChannels: [],
        publishedPostIds: null,
        publishedOnSite: true,
        description: `Просторная квартира в центре. Цена ${formatPrice(300000, "TJS")}. Звоните.`,
      });
      await prisma.property.update({ where: { id: property.id }, data: { price: 250000 } });

      await syncPublishedPriceChange(property.id, 300000, "TJS");

      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      expect(after.description).toContain(formatPrice(250000, "TJS"));
      expect(after.description).not.toContain(formatPrice(300000, "TJS"));
      expect(resyncPhotosIfPublished).toHaveBeenCalledWith(property.id, expect.any(String));
    });

    it("объект НЕ опубликован на сайте — описание не трогаем, досылка не идёт", async () => {
      const property = await seedProperty({
        publishedChannels: [],
        publishedPostIds: null,
        publishedOnSite: false,
        description: `Квартира. Цена ${formatPrice(300000, "TJS")}.`,
      });
      await prisma.property.update({ where: { id: property.id }, data: { price: 250000 } });

      await syncPublishedPriceChange(property.id, 300000, "TJS");

      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      expect(after.description).toContain(formatPrice(300000, "TJS"));
      expect(resyncPhotosIfPublished).not.toHaveBeenCalled();
    });

    it("описание правили руками, старой цены в нём дословно нет — не трогаем, не досылаем", async () => {
      const property = await seedProperty({
        publishedChannels: [],
        publishedPostIds: null,
        publishedOnSite: true,
        description: "Ручной текст без блока цены вообще.",
      });
      await prisma.property.update({ where: { id: property.id }, data: { price: 250000 } });

      await syncPublishedPriceChange(property.id, 300000, "TJS");

      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      expect(after.description).toBe("Ручной текст без блока цены вообще.");
      expect(resyncPhotosIfPublished).not.toHaveBeenCalled();
    });
  });

  describe("история «цена снижена» (владелец, 21.09.2026)", () => {
    it("цена снизилась — зовёт publishPropertyPriceDropStory со старой ценой", async () => {
      const property = await seedProperty({ publishedChannels: [], publishedPostIds: null });
      await prisma.property.update({ where: { id: property.id }, data: { price: 250000 } });

      await syncPublishedPriceChange(property.id, 300000, "TJS");

      expect(publishPropertyPriceDropStory).toHaveBeenCalledWith(property.id, expect.stringContaining(formatPrice(300000, "TJS")));
    });

    it("цена ВЫРОСЛА — историю не публикуем, рост не новость для покупателя", async () => {
      const property = await seedProperty({ publishedChannels: [], publishedPostIds: null });
      await prisma.property.update({ where: { id: property.id }, data: { price: 350000 } });

      await syncPublishedPriceChange(property.id, 300000, "TJS");

      expect(publishPropertyPriceDropStory).not.toHaveBeenCalled();
    });

    it("цена не менялась — историю не публикуем", async () => {
      const property = await seedProperty();

      await syncPublishedPriceChange(property.id, 300000, "TJS");

      expect(publishPropertyPriceDropStory).not.toHaveBeenCalled();
    });

    it("объект не в продаже (резерв, снят, подготовка, продан) — истории «цена снижена» нет (№194)", async () => {
      for (const status of ["RESERVED", "WITHDRAWN", "PENDING_REVIEW", "SOLD"]) {
        publishPropertyPriceDropStory.mockClear();
        const property = await seedProperty({ status, publishedChannels: [], publishedPostIds: null });
        await prisma.property.update({ where: { id: property.id }, data: { price: 250000 } });

        await syncPublishedPriceChange(property.id, 300000, "TJS");

        expect(publishPropertyPriceDropStory, status).not.toHaveBeenCalled();
      }
    });

    it("работает и для объекта без reelsCaption/публикаций в соцсетях — не второй сторож цены, независимая ветка", async () => {
      const property = await seedProperty({
        publishedChannels: [],
        publishedPostIds: null,
        reelsCaption: null,
        publishedOnSite: false,
      });
      await prisma.property.update({ where: { id: property.id }, data: { price: 250000 } });

      await syncPublishedPriceChange(property.id, 300000, "TJS");

      expect(publishPropertyPriceDropStory).toHaveBeenCalledTimes(1);
    });
  });
});
