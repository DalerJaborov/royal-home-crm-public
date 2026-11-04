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
  publishPropertyPriceDropStory,
} = vi.hoisted(() => ({
  editMessageCaption: vi.fn<typeof import("../src/telegram/api.js").editMessageCaption>(async () => {}),
  updateFacebookVideoDescription: vi.fn<typeof import("../src/lib/socialPublish.js").updateFacebookVideoDescription>(async () => ({ ok: true })),
  updateYouTubeDescription: vi.fn(async () => ({ ok: true })),
  loadCredentials: vi.fn(async () => ({ pageToken: "fb-token", pageId: "123", igToken: "ig-token" })),
  logSystemError: vi.fn(async () => {}),
  publishPropertyPriceDropStory: vi.fn(async () => ({ attempted: true, publishedParts: 1, totalParts: 1 })),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  editMessageCaption,
  isTelegramEnabled: () => true,
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
// История «цена снижена» (21.09.2026) — своя логика (рубильник, суточный кулдаун,
// рендер картинки, Graph API) уже покрыта instagram-price-drop-story.test.ts;
// здесь проверяем только то, что publishedListingSync ЗОВЁТ её с правильным
// решением «снижение/рост», не второй копией сравнения цен.
vi.mock("../src/lib/instagramStories.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/instagramStories.js")>()),
  publishPropertyPriceDropStory,
}));

const { prisma } = await import("../src/db.js");
const { reportPublishedPriceChange, stagePublishedPriceChange } = await import("../src/lib/publishedListingSync.js");
const { runPriceCaptionDeliveryTick } = await import("../src/lib/priceCaptionDelivery.js");
const { applySucceededPublishResults } = await import("../src/lib/videoHandoff.js");
const realSocial = await vi.importActual<typeof import("../src/lib/socialPublish.js")>("../src/lib/socialPublish.js");
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
  editMessageCaption.mockReset();
  editMessageCaption.mockResolvedValue(undefined);
  updateFacebookVideoDescription.mockReset();
  updateFacebookVideoDescription.mockResolvedValue({ ok: true });
  updateYouTubeDescription.mockClear();
  updateYouTubeDescription.mockResolvedValue({ ok: true });
  loadCredentials.mockClear();
  logSystemError.mockClear();
  publishPropertyPriceDropStory.mockClear();
  publishPropertyPriceDropStory.mockResolvedValue({ attempted: true, publishedParts: 1, totalParts: 1 });
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { telegramChannelId: "-100999", youtubeClientId: "test-client", youtubeClientSecret: "test-secret", youtubeRefreshToken: "test-refresh" },
    create: { id: "singleton", telegramChannelId: "-100999", youtubeClientId: "test-client", youtubeClientSecret: "test-secret", youtubeRefreshToken: "test-refresh" },
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (propertyIds.length) {
    await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
    propertyIds.length = 0;
  }
});

afterAll(async () => {
  if (districtId) await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
});

async function changePrice(propertyId: string, price: number) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.property.findUniqueOrThrow({ where: { id: propertyId } });
    const after = await tx.property.update({
      where: { id: propertyId },
      data: { price, version: { increment: 1 } },
    });
    const stage = await stagePublishedPriceChange(tx, before, after);
    return { before, after, stage };
  });
}

async function changeAndDeliver(propertyId: string, price: number) {
  const change = await changePrice(propertyId, price);
  await reportPublishedPriceChange(change.before, change.after, change.stage);
  await runPriceCaptionDeliveryTick();
  return change.stage;
}

function ledger(propertyId: string) {
  return prisma.publicationMetadataSync.findMany({ where: { propertyId }, orderBy: { createdAt: "asc" } });
}

describe("published price caption delivery", () => {
  it("цена поменялась — новый текст уходит в FB/Telegram/YouTube, Instagram — в журнал", async () => {
    const property = await seedProperty();
    await changeAndDeliver(property.id, 250000);

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.reelsCaption).toContain(price250k);
    expect(after.reelsCaption).not.toContain(price300k);
    expect(editMessageCaption).toHaveBeenCalledWith("-100999", 42, expect.stringContaining(formatPrice(250000, "TJS")), undefined, true);
    expect(updateFacebookVideoDescription).toHaveBeenCalledWith("fb-1", "fb-token", expect.stringContaining(formatPrice(250000, "TJS")), true);
    expect(updateYouTubeDescription).toHaveBeenCalled();
    // Instagram не редактируется — только честная запись в журнал, без обращения к Meta за это.
    expect(logSystemError).toHaveBeenCalledWith("meta", expect.stringContaining("INSTAGRAM"));
  });

  it("подпись правили руками, старой цены в ней дословно нет — ничего не трогаем", async () => {
    const property = await seedProperty({ reelsCaption: "Ручной текст монтажёра без блока фактов." });
    await changeAndDeliver(property.id, 250000);

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.reelsCaption).toBe("Ручной текст монтажёра без блока фактов.");
    expect(editMessageCaption).not.toHaveBeenCalled();
    expect(updateFacebookVideoDescription).not.toHaveBeenCalled();
  });

  it("цена не менялась (тот же формат) — тихо ничего не делает", async () => {
    const property = await seedProperty();

    await changeAndDeliver(property.id, 300000);

    expect(editMessageCaption).not.toHaveBeenCalled();
    expect(updateFacebookVideoDescription).not.toHaveBeenCalled();
    expect(updateYouTubeDescription).not.toHaveBeenCalled();
  });

  it("объект ещё нигде не опубликован — ничего не вызывается", async () => {
    const property = await seedProperty({ publishedChannels: [], publishedPostIds: null });
    await changeAndDeliver(property.id, 250000);

    expect(editMessageCaption).not.toHaveBeenCalled();
    expect(updateFacebookVideoDescription).not.toHaveBeenCalled();
  });

  describe("описание на сайте (владелец, второй заход: «описание на сайте не меняется»)", () => {
    it("объект опубликован на сайте — цена в тексте описания записывается вместе с правкой", async () => {
      const property = await seedProperty({
        publishedChannels: [],
        publishedPostIds: null,
        publishedOnSite: true,
        description: `Просторная квартира в центре. Цена ${formatPrice(300000, "TJS")}. Звоните.`,
      });
      const stage = await changeAndDeliver(property.id, 250000);
      expect(stage.descriptionChanged).toBe(true);

      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      expect(after.description).toContain(formatPrice(250000, "TJS"));
      expect(after.description).not.toContain(formatPrice(300000, "TJS"));

    });

    it("объект НЕ опубликован на сайте — описание не трогаем, досылка не идёт", async () => {
      const property = await seedProperty({
        publishedChannels: [],
        publishedPostIds: null,
        publishedOnSite: false,
        description: `Квартира. Цена ${formatPrice(300000, "TJS")}.`,
      });
      await changeAndDeliver(property.id, 250000);

      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      expect(after.description).toContain(formatPrice(300000, "TJS"));

    });

    it("описание правили руками, старой цены в нём дословно нет — не трогаем, не досылаем", async () => {
      const property = await seedProperty({
        publishedChannels: [],
        publishedPostIds: null,
        publishedOnSite: true,
        description: "Ручной текст без блока цены вообще.",
      });
      await changeAndDeliver(property.id, 250000);

      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      expect(after.description).toBe("Ручной текст без блока цены вообще.");

    });
  });

  describe("история «цена снижена» (владелец, 21.09.2026)", () => {
    it("цена снизилась — зовёт publishPropertyPriceDropStory со старой ценой", async () => {
      const property = await seedProperty({ publishedChannels: [], publishedPostIds: null });
      await changeAndDeliver(property.id, 250000);

      expect(publishPropertyPriceDropStory).toHaveBeenCalledWith(property.id, expect.stringContaining(formatPrice(300000, "TJS")));
    });

    it("цена ВЫРОСЛА — историю не публикуем, рост не новость для покупателя", async () => {
      const property = await seedProperty({ publishedChannels: [], publishedPostIds: null });
      await changeAndDeliver(property.id, 350000);

      expect(publishPropertyPriceDropStory).not.toHaveBeenCalled();
    });

    it("цена не менялась — историю не публикуем", async () => {
      const property = await seedProperty();

      await changeAndDeliver(property.id, 300000);

      expect(publishPropertyPriceDropStory).not.toHaveBeenCalled();
    });

    it("объект не в продаже (резерв, снят, подготовка, продан) — истории «цена снижена» нет (№194)", async () => {
      for (const status of ["RESERVED", "WITHDRAWN", "PENDING_REVIEW", "SOLD"]) {
        publishPropertyPriceDropStory.mockClear();
        const property = await seedProperty({ status, publishedChannels: [], publishedPostIds: null });
        await changeAndDeliver(property.id, 250000);

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
      await changeAndDeliver(property.id, 250000);

      expect(publishPropertyPriceDropStory).toHaveBeenCalledTimes(1);
    });
  });
});

describe("persistent price caption outcomes", () => {
  const firstPrice = 250000;
  const secondPrice = 225000;
  const nextTick = () => runPriceCaptionDeliveryTick(new Date(Date.now() + 70_000));

  it("повторяет ответ Facebook 503 без повторной отправки в Telegram и без новой Stories", async () => {
    const property = await seedProperty({
      status: "AVAILABLE",
      publishedChannels: ["FACEBOOK", "TELEGRAM"],
      publishedPostIds: { FACEBOOK: "fb-1", TELEGRAM: "42", TELEGRAM_EXTRA: { "-100555": "43" } },
    });
    const fetchMeta = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Temporary outage" } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMeta);
    updateFacebookVideoDescription.mockImplementation(realSocial.updateFacebookVideoDescription);

    const change = await changePrice(property.id, firstPrice);
    expect(fetchMeta).not.toHaveBeenCalled();
    await reportPublishedPriceChange(change.before, change.after, change.stage);
    await runPriceCaptionDeliveryTick();
    expect((await ledger(property.id)).map(({ channel, status }) => [channel, status]).sort()).toEqual([
      ["FACEBOOK", "RETRY"], ["TELEGRAM", "APPLIED"], ["TELEGRAM", "APPLIED"],
    ]);

    await nextTick();
    expect(fetchMeta).toHaveBeenCalledTimes(2);
    expect(editMessageCaption).toHaveBeenCalledTimes(2);
    expect(publishPropertyPriceDropStory).toHaveBeenCalledTimes(1);
    expect((await ledger(property.id)).every(({ status }) => status === "APPLIED")).toBe(true);
  });

  it.each([true, false])("новая цена переживает старый сетевой запрос (ответ старого успешен: %s)", async (oldAccepted) => {
    const property = await seedProperty({
      publishedChannels: ["FACEBOOK", "TELEGRAM"],
      publishedPostIds: { FACEBOOK: "fb-1", TELEGRAM: "42" },
    });
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let visibleCaption = "";
    updateFacebookVideoDescription.mockImplementationOnce(async (_postId, _token, caption) => {
      entered.resolve();
      await released.promise;
      if (oldAccepted) {
        visibleCaption = caption;
        return { ok: true };
      }
      return { ok: false, delivery: "RETRYABLE" };
    }).mockImplementation(async (_postId, _token, caption) => {
      visibleCaption = caption;
      return { ok: true };
    });

    await changePrice(property.id, firstPrice);
    const firstTick = runPriceCaptionDeliveryTick();
    try {
      await entered.promise;
      await changePrice(property.id, secondPrice);
      await nextTick();
      expect(updateFacebookVideoDescription).toHaveBeenCalledTimes(1);
      expect(editMessageCaption).toHaveBeenLastCalledWith("-100999", 42, expect.stringContaining(formatPrice(secondPrice, "TJS")), undefined, true);
    } finally {
      released.resolve();
      await firstTick;
    }

    await nextTick();
    expect(updateFacebookVideoDescription).toHaveBeenCalledTimes(2);
    expect(visibleCaption).toContain(formatPrice(secondPrice, "TJS"));
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).reelsCaption).toBe(visibleCaption);
    await runPriceCaptionDeliveryTick(new Date(Date.now() + 21 * 60_000));
    expect(updateFacebookVideoDescription).toHaveBeenCalledTimes(2);
  });

  it("сохраняет неизвестный исход через рестарт и даёт обновиться другим адресатам", async () => {
    const property = await seedProperty({
      publishedChannels: ["FACEBOOK", "TELEGRAM"],
      publishedPostIds: { FACEBOOK: "fb-1", TELEGRAM: "42" },
    });
    await changePrice(property.id, firstPrice);
    const facebook = (await ledger(property.id)).find(({ channel }) => channel === "FACEBOOK")!;
    await prisma.publicationMetadataSync.update({
      where: { id: facebook.id },
      data: { status: "EXECUTING", startedAt: new Date(Date.now() - 11 * 60_000), result: { attempts: 1 } },
    });
    await changePrice(property.id, secondPrice);

    await nextTick();
    expect(updateFacebookVideoDescription).not.toHaveBeenCalled();
    expect(editMessageCaption).toHaveBeenCalledTimes(1);
    expect((await prisma.publicationMetadataSync.findUniqueOrThrow({ where: { id: facebook.id } })).status).toBe("UNKNOWN");

    // Outcome already verified and entered by a director via the existing reconcile route.
    await prisma.publicationMetadataSync.update({ where: { id: facebook.id }, data: { status: "APPLIED_MANUAL" } });
    await nextTick();
    expect(updateFacebookVideoDescription).toHaveBeenCalledOnce();
    expect(updateFacebookVideoDescription).toHaveBeenCalledWith("fb-1", "fb-token", expect.stringContaining(formatPrice(secondPrice, "TJS")), true);
  });

  it.each([
    { httpStatus: 403, body: JSON.stringify({ error: { message: "Access denied" } }), expected: "FAILED" },
    { httpStatus: 502, body: "<html>Bad Gateway</html>", expected: "UNKNOWN" },
  ])("сохраняет исход $expected для HTTP $httpStatus без слепого повтора", async ({ httpStatus, body, expected }) => {
    const property = await seedProperty({ publishedChannels: ["FACEBOOK"], publishedPostIds: { FACEBOOK: "fb-1" } });
    const fetchMeta = vi.fn().mockResolvedValue(new Response(body, { status: httpStatus }));
    vi.stubGlobal("fetch", fetchMeta);
    updateFacebookVideoDescription.mockImplementation(realSocial.updateFacebookVideoDescription);
    await changePrice(property.id, firstPrice);
    await runPriceCaptionDeliveryTick();
    await nextTick();
    expect(fetchMeta).toHaveBeenCalledOnce();
    expect((await ledger(property.id))[0].status).toBe(expected);
  });
});

it("ставит свежую цену для поста, подтверждённого после правки, без повторной публикации", async () => {
  const property = await seedProperty({ publishedChannels: [], publishedPostIds: null });
  await changePrice(property.id, 250000);
  await runPriceCaptionDeliveryTick();
  expect(editMessageCaption).not.toHaveBeenCalled();

  const receipt = [{ channel: "TELEGRAM" as const, postId: "42" }];
  const options = { finalize: false, publishedPrice: { price: 300000, currency: "TJS" } };
  await applySucceededPublishResults(property.id, receipt, null, options);
  await applySucceededPublishResults(property.id, receipt, null, options);

  expect((await ledger(property.id)).map(({ status }) => status)).toEqual(["PENDING"]);
  await runPriceCaptionDeliveryTick();
  expect(editMessageCaption).toHaveBeenCalledTimes(1);
  expect(editMessageCaption).toHaveBeenCalledWith("-100999", 42, expect.stringContaining(formatPrice(250000, "TJS")), undefined, true);
});
