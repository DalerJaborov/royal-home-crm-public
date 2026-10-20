import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * ИСПРАВЛЕНИЕ УЖЕ ВЫПУЩЕННОГО РОЛИКА (lib/publishedVideoFix.ts, 19.09.2026;
 * удаление Instagram и «объекта уже нет» добавлены 20.09.2026).
 *
 * Появилось после разбора перемешанных описаний двух квартир одного продавца
 * (docs/video-text-mixup-19-09.md): к моменту, когда ошибку заметили, ролики
 * висели во всех соцсетях, а единственным ответом было «позовите
 * администратора». Владелец: «чтобы не проходить весь путь заново и не
 * заполнять карточку второй раз».
 *
 * ЧТО ЗДЕСЬ ВАЖНЕЕ ВСЕГО ПРОВЕРИТЬ — что код не врёт про сделанное. TikTok
 * по-прежнему не даёт удалить вышедший пост, и «убрали отовсюду» при живом
 * ролике хуже, чем честные две строки: неверное видео осталось бы висеть, а в
 * CRM было бы написано, что его нет. Ровно то же правило теперь проверяется и
 * в обратную сторону — «объекта уже нет» (случай №112) не должно застревать в
 * failed навсегда.
 *
 * Сами сети подменены: тест не ходит ни в Meta, ни в YouTube, ни в Telegram.
 */

const {
  deleteFacebookVideo,
  deleteInstagramMedia,
  findInstagramMediaIdByPermalink,
  resolveInstagramBusinessAccountId,
  deleteYouTubeVideo,
  deleteChannelMessage,
  editMessageCaption,
  updateFacebookVideoDescription,
  updateYouTubeDescription,
  logSystemError,
} = vi.hoisted(() => ({
  deleteFacebookVideo: vi.fn(async () => ({ ok: true })),
  deleteInstagramMedia: vi.fn(async () => ({ ok: true })),
  // По умолчанию — «лента дочитана до конца, поста нет» (not_found), а НЕ
  // «не смогли дочитать»: большинство тестов этого файла не про обход ленты
  // Instagram вовсе, и молчаливый not_found — самое частое реальное поведение
  // (лента маленькая, дочитывается за одну страницу).
  findInstagramMediaIdByPermalink: vi.fn(
    async () => ({ status: "not_found" }) as import("../src/lib/socialPublish.js").InstagramPermalinkSearchResult
  ),
  resolveInstagramBusinessAccountId: vi.fn(async () => "ig-user-1" as string | null),
  deleteYouTubeVideo: vi.fn(async () => ({ ok: true })),
  deleteChannelMessage: vi.fn(async () => {}),
  editMessageCaption: vi.fn(async () => {}),
  updateFacebookVideoDescription: vi.fn(async () => ({ ok: true })),
  updateYouTubeDescription: vi.fn(async () => ({ ok: true })),
  logSystemError: vi.fn(async () => {}),
}));

vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  deleteFacebookVideo,
  deleteInstagramMedia,
  findInstagramMediaIdByPermalink,
  resolveInstagramBusinessAccountId,
  deleteYouTubeVideo,
  updateFacebookVideoDescription,
  updateYouTubeDescription,
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  deleteChannelMessage,
  editMessageCaption,
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  loadCredentials: async () => ({ pageToken: "page-token", pageId: "page-1", igToken: "ig-token" }),
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

const { prisma } = await import("../src/db.js");
const { encryptSecret } = await import("../src/crypto.js");
const { removeFromSocial, sendBackToMontajer, openForManualFinalVideo, refreshPublishedCaptions } = await import(
  "../src/lib/publishedVideoFix.js"
);

const { videoHandoffPublishDedupeKey, VIDEO_HANDOFF_PUBLISH_JOB_TYPE, settleBackgroundHandoffDispatches } = await import(
  "../src/lib/videoHandoff.js"
);
const { tiktokPublishRetryDedupeKey, TIKTOK_PUBLISH_RETRY_JOB_TYPE } = await import("../src/jobs/tiktokPublishRetryPolicy.js");

const runId = Date.now();
const propertyIds: string[] = [];
let districtId = "";
let agentId = "";
let savedTelegramChannel: string | null = null;

async function seedPublished(overrides: Record<string, unknown> = {}) {
  const property = await prisma.property.create({
    data: {
      title: `Починка ролика ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 58,
      floor: 5,
      price: 450000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 11",
      condition: "GOOD",
      status: "AVAILABLE",
      instagramUrl: "https://instagram.com/reel/ABC123",
      reelsCaption: "Старая подпись",
      publishedChannels: ["INSTAGRAM", "FACEBOOK", "TELEGRAM", "YOUTUBE", "TIKTOK"],
      publishedPostIds: { FACEBOOK: "fb-1", TELEGRAM: "4242", YOUTUBE: "yt-1" },
      ...overrides,
    } as never,
  });
  propertyIds.push(property.id);
  return property;
}

/** Сырой ролик объекта — без него «вернуть монтажёру» отвечает отказом, и это
 *  обычный случай: исходники удаляются уборкой после выхода в продажу. */
async function addRawVideo(propertyId: string) {
  return prisma.propertyVideo.create({
    data: {
      propertyId,
      storageKey: `${propertyId}/${randomUUID()}.mp4`,
      filename: "obhod.mp4",
      sizeBytes: 1024,
      uploadedById: agentId,
    },
  });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Починка ролика ${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент починки ${runId}`, phone: `+992938${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { telegramChannelId: true },
  });
  savedTelegramChannel = settings.telegramChannelId;
  await prisma.settings.update({ where: { id: "singleton" }, data: { telegramChannelId: "@rh-test-channel" } });
});

beforeEach(() => {
  deleteFacebookVideo.mockClear().mockResolvedValue({ ok: true });
  deleteInstagramMedia.mockClear().mockResolvedValue({ ok: true });
  findInstagramMediaIdByPermalink.mockClear().mockResolvedValue({ status: "not_found" });
  resolveInstagramBusinessAccountId.mockClear().mockResolvedValue("ig-user-1");
  deleteYouTubeVideo.mockClear().mockResolvedValue({ ok: true });
  deleteChannelMessage.mockClear().mockResolvedValue(undefined);
  editMessageCaption.mockClear().mockResolvedValue(undefined);
  updateFacebookVideoDescription.mockClear().mockResolvedValue({ ok: true });
  updateYouTubeDescription.mockClear().mockResolvedValue({ ok: true });
  logSystemError.mockClear();
});

afterEach(async () => {
  // Токен удаления Instagram — по умолчанию не задан (прежнее поведение), тесты
  // ниже включают его точечно и обязаны вернуть settings в исходное состояние,
  // иначе последующий тест этого файла молча унаследует чужой токен. То же
  // самое про имя автора TikTok: из него собирается ссылка на ролик.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { metaIgManageToken: null, tiktokCreatorUsername: null },
  });
});

afterAll(async () => {
  await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { telegramChannelId: savedTelegramChannel } });
  await prisma.$disconnect();
});

describe("Убрать ролик из соцсетей", () => {
  it("снимает Facebook, YouTube и Telegram и ЧЕСТНО оставляет Instagram и TikTok человеку", async () => {
    const property = await seedPublished();

    const result = await removeFromSocial(property.id);

    expect(result.removed.sort()).toEqual(["FACEBOOK", "TELEGRAM", "YOUTUBE"]);
    expect(result.failed).toEqual([]);
    // Главное утверждение всего файла: про Instagram и TikTok сказано прямо, а
    // не умолчано. Ссылка на пост Instagram у нас есть — отдаём её, чтобы
    // человеку не пришлось искать ролик руками.
    expect(result.manual.map((m) => m.channel).sort()).toEqual(["INSTAGRAM", "TIKTOK"]);
    expect(result.manual.find((m) => m.channel === "INSTAGRAM")?.url).toBe("https://instagram.com/reel/ABC123");

    expect(deleteFacebookVideo).toHaveBeenCalledWith("fb-1", "page-token");
    expect(deleteChannelMessage).toHaveBeenCalledWith("@rh-test-channel", 4242);
  });

  it("TikTok отдаёт прямую ссылку на ролик — удалить нельзя, но искать руками больше не надо", async () => {
    // Обе половины ссылки у нас уже были и просто не встречались: id ролика
    // приходит при публикации (publicaly_available_post_id) и лежит в
    // publishedPostIds.TIKTOK, имя автора сохраняется при подключении кабинета.
    await prisma.settings.update({ where: { id: "singleton" }, data: { tiktokCreatorUsername: "@royalhome" } });
    const property = await seedPublished({
      publishedPostIds: { FACEBOOK: "fb-1", TELEGRAM: "4242", YOUTUBE: "yt-1", TIKTOK: "tt-777" },
    });

    const result = await removeFromSocial(property.id);

    const tiktok = result.manual.find((m) => m.channel === "TIKTOK");
    expect(tiktok?.url).toBe("https://www.tiktok.com/@royalhome/video/tt-777");
    // Причина не изменилась: удалять TikTok по-прежнему не даёт.
    expect(tiktok?.reason).toMatch(/только в приложении/);
  });

  it("без id ролика или без имени автора ссылки нет — честный null вместо выдуманной", async () => {
    // Ссылка, собранная наугад, ведёт в никуда и хуже её отсутствия: человек
    // идёт по ней, попадает на чужой ролик или на ошибку и теряет доверие к
    // списку целиком.
    const noId = await seedPublished();
    await prisma.settings.update({ where: { id: "singleton" }, data: { tiktokCreatorUsername: "@royalhome" } });
    expect((await removeFromSocial(noId.id)).manual.find((m) => m.channel === "TIKTOK")?.url).toBeNull();

    await prisma.settings.update({ where: { id: "singleton" }, data: { tiktokCreatorUsername: null } });
    const noName = await seedPublished({
      publishedPostIds: { FACEBOOK: "fb-1", TELEGRAM: "4242", YOUTUBE: "yt-1", TIKTOK: "tt-777" },
    });
    expect((await removeFromSocial(noName.id)).manual.find((m) => m.channel === "TIKTOK")?.url).toBeNull();
  });

  it("снятые каналы вычёркиваются — иначе следующий ролик туда бы не поехал", async () => {
    const property = await seedPublished();

    await removeFromSocial(property.id);

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    // Публикация пропускает каналы из publishedChannels (skipChannels), поэтому
    // невычеркнутый канал означал бы, что заменяющий ролик туда никогда не уйдёт.
    expect((after.publishedChannels ?? []).sort()).toEqual(["INSTAGRAM", "TIKTOK"]);
    expect(after.publishedPostIds).toEqual({});
    // Ссылка на Instagram остаётся: пост там реально висит, а на этой ссылке
    // держится одно из условий выхода объекта в продажу.
    expect(after.instagramUrl).toBe("https://instagram.com/reel/ABC123");
  });

  it("канал, который снять не удалось, из списка НЕ вычёркивается", async () => {
    const property = await seedPublished();
    deleteYouTubeVideo.mockResolvedValueOnce({ ok: false, error: "квота исчерпана" });

    const result = await removeFromSocial(property.id);

    expect(result.failed).toEqual([{ channel: "YOUTUBE", error: "квота исчерпана" }]);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    // Иначе второй ролик встал бы в YouTube РЯДОМ с первым вместо замены.
    expect(after.publishedChannels).toContain("YOUTUBE");
    expect((after.publishedPostIds as Record<string, string>).YOUTUBE).toBe("yt-1");
  });

  it("канал в списке, а id в publishedPostIds нет — честная запись в failed и в журнале, а не молчание (тот же класс, что был у Instagram №112)", async () => {
    const property = await seedPublished({ publishedPostIds: { TELEGRAM: "4242", YOUTUBE: "yt-1" } }); // FACEBOOK без id

    const result = await removeFromSocial(property.id);

    expect(result.failed).toContainEqual({ channel: "FACEBOOK", error: "в карточке нет сохранённого id поста Facebook — снять нечем" });
    expect(result.removed).not.toContain("FACEBOOK");
    expect(logSystemError).toHaveBeenCalled();
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.publishedChannels).toContain("FACEBOOK");
  });

  describe("Instagram (20.09.2026, токен через Facebook Login)", () => {
    it("токен задан, media id уже сохранён — снимается, канал и ссылка вычёркиваются", async () => {
      await prisma.settings.update({ where: { id: "singleton" }, data: { metaIgManageToken: encryptSecret("ig-manage-token") } });
      const property = await seedPublished({ publishedPostIds: { FACEBOOK: "fb-1", TELEGRAM: "4242", YOUTUBE: "yt-1", INSTAGRAM: "ig-media-1" } });

      const result = await removeFromSocial(property.id);

      expect(result.removed.sort()).toEqual(["FACEBOOK", "INSTAGRAM", "TELEGRAM", "YOUTUBE"]);
      // Media id был уже в publishedPostIds — искать по permalink не должны были.
      expect(deleteInstagramMedia).toHaveBeenCalledWith("ig-media-1", "ig-manage-token");
      expect(findInstagramMediaIdByPermalink).not.toHaveBeenCalled();
      // Единственный оставшийся честный ручной пункт — TikTok.
      expect(result.manual.map((m) => m.channel)).toEqual(["TIKTOK"]);

      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      expect(after.publishedChannels).not.toContain("INSTAGRAM");
      expect((after.publishedPostIds as Record<string, string>).INSTAGRAM).toBeUndefined();
      // Иначе следующая публикация решила бы, что Instagram всё ещё занят.
      expect(after.instagramUrl).toBeNull();
    });

    it("токен задан, media id не сохранён — ищем по ссылке в ленте аккаунта", async () => {
      await prisma.settings.update({ where: { id: "singleton" }, data: { metaIgManageToken: encryptSecret("ig-manage-token") } });
      findInstagramMediaIdByPermalink.mockResolvedValueOnce({ status: "found", mediaId: "ig-media-found" });
      // Без INSTAGRAM в publishedPostIds — старая публикация, id никогда не писался.
      const property = await seedPublished({ publishedPostIds: { FACEBOOK: "fb-1", TELEGRAM: "4242", YOUTUBE: "yt-1" } });

      const result = await removeFromSocial(property.id);

      expect(resolveInstagramBusinessAccountId).toHaveBeenCalledWith("ig-manage-token", "page-1");
      expect(findInstagramMediaIdByPermalink).toHaveBeenCalledWith("ig-user-1", "ig-manage-token", "https://instagram.com/reel/ABC123");
      expect(deleteInstagramMedia).toHaveBeenCalledWith("ig-media-found", "ig-manage-token");
      expect(result.removed).toContain("INSTAGRAM");
    });

    it("токен не задан — прежнее поведение: честный ручной список, ни один запрос не уходит, журнал молчит", async () => {
      // metaIgManageToken НЕ трогаем — остаётся null (сброшен afterEach).
      const property = await seedPublished();

      const result = await removeFromSocial(property.id);

      expect(deleteInstagramMedia).not.toHaveBeenCalled();
      expect(findInstagramMediaIdByPermalink).not.toHaveBeenCalled();
      expect(result.manual.map((m) => m.channel).sort()).toEqual(["INSTAGRAM", "TIKTOK"]);
      expect(result.manual.find((m) => m.channel === "INSTAGRAM")?.reason).toBe(
        "Instagram не даёт удалять и переписывать вышедшие Reels через программу — только в приложении."
      );
      expect(result.failed.find((f) => f.channel === "INSTAGRAM")).toBeUndefined();
      // Это НЕ ошибка — токена просто нет, журнал молчать обязан.
      expect(logSystemError).not.toHaveBeenCalled();
    });

    it("токен задан, лента дочитана до конца, поста нет — вычёркиваем как фантом, failed пусто", async () => {
      await prisma.settings.update({ where: { id: "singleton" }, data: { metaIgManageToken: encryptSecret("ig-manage-token") } });
      findInstagramMediaIdByPermalink.mockResolvedValueOnce({ status: "not_found" });
      const property = await seedPublished({ publishedPostIds: { FACEBOOK: "fb-1", TELEGRAM: "4242", YOUTUBE: "yt-1" } });

      const result = await removeFromSocial(property.id);

      expect(deleteInstagramMedia).not.toHaveBeenCalled();
      expect(result.removed).toContain("INSTAGRAM");
      expect(result.failed.find((f) => f.channel === "INSTAGRAM")).toBeUndefined();
      expect(result.notes).toContainEqual({ channel: "INSTAGRAM", note: "поста уже не было" });
      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      expect(after.publishedChannels).not.toContain("INSTAGRAM");
      expect(after.instagramUrl).toBeNull();
    });

    it("токен задан, обход ленты оборвался (не дочитали) — канал НЕ вычёркиваем, причина в failed и в журнале, честный текст человеку", async () => {
      await prisma.settings.update({ where: { id: "singleton" }, data: { metaIgManageToken: encryptSecret("ig-manage-token") } });
      findInstagramMediaIdByPermalink.mockResolvedValueOnce({ status: "incomplete", reason: "Graph API HTTP 500" });
      const property = await seedPublished({ publishedPostIds: { FACEBOOK: "fb-1", TELEGRAM: "4242", YOUTUBE: "yt-1" } });

      const result = await removeFromSocial(property.id);

      // «Не нашли» ≠ «точно нет» — ГЛАВНОЕ правило задачи.
      expect(result.removed).not.toContain("INSTAGRAM");
      expect(result.failed).toContainEqual({ channel: "INSTAGRAM", error: "Graph API HTTP 500" });
      expect(result.notes.find((n) => n.channel === "INSTAGRAM")).toBeUndefined();
      const manualIg = result.manual.find((m) => m.channel === "INSTAGRAM");
      expect(manualIg).toBeDefined();
      // Честный текст — НЕ старое «Instagram не даёт удалять» (оно есть, мы
      // просто не проверили этот конкретный пост).
      expect(manualIg?.reason).not.toBe(
        "Instagram не даёт удалять и переписывать вышедшие Reels через программу — только в приложении."
      );
      expect(manualIg?.reason).toContain("не нашли этот пост в ленте аккаунта");
      expect(logSystemError).toHaveBeenCalled();
      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      expect(after.publishedChannels).toContain("INSTAGRAM");
      expect(after.instagramUrl).not.toBeNull();
    });

    it("токен задан, в карточке нет ссылки на Instagram и id не сохранён — нечем искать, канал не вычёркиваем, честная причина", async () => {
      await prisma.settings.update({ where: { id: "singleton" }, data: { metaIgManageToken: encryptSecret("ig-manage-token") } });
      const property = await seedPublished({
        instagramUrl: null,
        publishedPostIds: { FACEBOOK: "fb-1", TELEGRAM: "4242", YOUTUBE: "yt-1" },
      });

      const result = await removeFromSocial(property.id);

      expect(findInstagramMediaIdByPermalink).not.toHaveBeenCalled();
      expect(result.removed).not.toContain("INSTAGRAM");
      expect(result.failed.find((f) => f.channel === "INSTAGRAM")).toBeDefined();
      expect(logSystemError).toHaveBeenCalled();
    });

    it("«объекта не существует» — вычёркивается как обычный успех, с честной пометкой, а не как отказ (случай №112)", async () => {
      await prisma.settings.update({ where: { id: "singleton" }, data: { metaIgManageToken: encryptSecret("ig-manage-token") } });
      deleteInstagramMedia.mockResolvedValueOnce({ ok: true, ghost: true });
      const property = await seedPublished({ publishedPostIds: { FACEBOOK: "fb-1", TELEGRAM: "4242", YOUTUBE: "yt-1", INSTAGRAM: "ig-media-gone" } });

      const result = await removeFromSocial(property.id);

      expect(result.removed).toContain("INSTAGRAM");
      expect(result.failed.find((f) => f.channel === "INSTAGRAM")).toBeUndefined();
      expect(result.notes).toContainEqual({ channel: "INSTAGRAM", note: "поста уже не было" });
    });

    it("настоящий отказ (нет прав/сеть) — канал НЕ вычёркивается", async () => {
      await prisma.settings.update({ where: { id: "singleton" }, data: { metaIgManageToken: encryptSecret("ig-manage-token") } });
      deleteInstagramMedia.mockResolvedValueOnce({ ok: false, error: "токен просрочен" });
      const property = await seedPublished({ publishedPostIds: { FACEBOOK: "fb-1", TELEGRAM: "4242", YOUTUBE: "yt-1", INSTAGRAM: "ig-media-1" } });

      const result = await removeFromSocial(property.id);

      expect(result.removed).not.toContain("INSTAGRAM");
      expect(result.failed).toContainEqual({ channel: "INSTAGRAM", error: "токен просрочен" });
      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      // Не снятый канал остаётся занятым — иначе второй ролик лёг бы поверх первого.
      expect(after.publishedChannels).toContain("INSTAGRAM");
      expect(after.instagramUrl).not.toBeNull();
    });
  });

  describe("Facebook — запасной идентификатор и «объекта не существует» (случай №112)", () => {
    it("video id отказал — пробуем post id (FACEBOOK_POST), снимается", async () => {
      deleteFacebookVideo
        .mockResolvedValueOnce({ ok: false, error: "video id не найден" })
        .mockResolvedValueOnce({ ok: true });
      const property = await seedPublished({
        publishedPostIds: { FACEBOOK: "fb-video-1", FACEBOOK_POST: "fb-post-1", TELEGRAM: "4242", YOUTUBE: "yt-1" },
      });

      const result = await removeFromSocial(property.id);

      expect(deleteFacebookVideo).toHaveBeenNthCalledWith(1, "fb-video-1", "page-token");
      expect(deleteFacebookVideo).toHaveBeenNthCalledWith(2, "fb-post-1", "page-token");
      expect(result.removed).toContain("FACEBOOK");
      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      // Оба идентификатора одного и того же поста должны уйти из карточки вместе.
      expect((after.publishedPostIds as Record<string, string>).FACEBOOK).toBeUndefined();
      expect((after.publishedPostIds as Record<string, string>).FACEBOOK_POST).toBeUndefined();
    });

    it("«объекта не существует» — канал вычёркивается, а не остаётся занятым навсегда", async () => {
      deleteFacebookVideo.mockResolvedValueOnce({ ok: true, ghost: true });
      const property = await seedPublished({ publishedPostIds: { FACEBOOK: "fb-ghost", TELEGRAM: "4242", YOUTUBE: "yt-1" } });

      const result = await removeFromSocial(property.id);

      expect(result.removed).toContain("FACEBOOK");
      expect(result.failed.find((f) => f.channel === "FACEBOOK")).toBeUndefined();
      expect(result.notes).toContainEqual({ channel: "FACEBOOK", note: "поста уже не было" });
      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      expect(after.publishedChannels).not.toContain("FACEBOOK");
    });
  });
});

/**
 * «ПОСТА УЖЕ НЕТ» НА ВСЕХ ПЛОЩАДКАХ (23.09.2026). Facebook и Instagram умели
 * это с 20.09.2026 (случай №112); Telegram считал удалённое руками сообщение
 * отказом и навсегда держал канал «занятым», YouTube писал «удалено» о том, чего
 * не было. Обратная сторона: «поста нет» по запасному id Facebook, когда само
 * видео отказало, — не повод вычеркнуть канал.
 */
describe("Пост уже удалён руками — на каждой площадке", () => {
  it("Telegram: «message to delete not found» — канал вычёркивается с честной пометкой", async () => {
    deleteChannelMessage.mockRejectedValueOnce(
      new Error("Telegram API deleteMessage: Bad Request: message to delete not found")
    );
    const property = await seedPublished();

    const result = await removeFromSocial(property.id);

    expect(result.removed).toContain("TELEGRAM");
    expect(result.failed.find((f) => f.channel === "TELEGRAM")).toBeUndefined();
    expect(result.notes).toContainEqual({ channel: "TELEGRAM", note: "сообщения уже не было" });
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.publishedChannels).not.toContain("TELEGRAM");
  });

  it("Telegram: «message can't be deleted» — настоящий отказ, канал остаётся", async () => {
    deleteChannelMessage.mockRejectedValueOnce(
      new Error("Telegram API deleteMessage: Bad Request: message can't be deleted")
    );
    const property = await seedPublished();

    const result = await removeFromSocial(property.id);

    expect(result.removed).not.toContain("TELEGRAM");
    expect(result.failed.find((f) => f.channel === "TELEGRAM")).toBeDefined();
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.publishedChannels).toContain("TELEGRAM");
  });

  it("YouTube: видео уже нет (404) — вычёркивается, но с пометкой «уже не было», а не «удалено»", async () => {
    deleteYouTubeVideo.mockResolvedValueOnce({ ok: true, ghost: true } as never);
    const property = await seedPublished();

    const result = await removeFromSocial(property.id);

    expect(result.removed).toContain("YOUTUBE");
    expect(result.notes).toContainEqual({ channel: "YOUTUBE", note: "видео уже не было" });
  });

  it("Facebook: видео отказало, а по запасному id поста нет — канал НЕ вычёркивается, причина — отказ видео", async () => {
    deleteFacebookVideo
      .mockResolvedValueOnce({ ok: false, error: "(#200) Permissions error" } as never)
      .mockResolvedValueOnce({ ok: true, ghost: true } as never);
    const property = await seedPublished({
      publishedPostIds: { FACEBOOK: "fb-video-2", FACEBOOK_POST: "fb-post-2", TELEGRAM: "4242", YOUTUBE: "yt-1" },
    });

    const result = await removeFromSocial(property.id);

    expect(result.removed).not.toContain("FACEBOOK");
    expect(result.failed).toContainEqual({ channel: "FACEBOOK", error: "(#200) Permissions error" });
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.publishedChannels).toContain("FACEBOOK");
  });
});

/**
 * ДОПОЛНИТЕЛЬНЫЕ ЧАТЫ TELEGRAM (26.09.2026, «ролик уходит в несколько
 * Telegram-групп и каналов») — publishedPostIds.TELEGRAM_EXTRA, вложенный
 * объект { chatId: messageId }, а не отдельный канал. Снимаются вместе с
 * основным каналом (deleteChannelMessage на каждый chatId), отказ одного не
 * мешает остальным, ключ TELEGRAM_EXTRA убирается после снятия.
 */
describe("removeFromSocial — дополнительные чаты Telegram", () => {
  it("снимает основной канал и оба дополнительных чата, стирает TELEGRAM_EXTRA", async () => {
    const property = await seedPublished({
      publishedPostIds: {
        FACEBOOK: "fb-1",
        TELEGRAM: "4242",
        YOUTUBE: "yt-1",
        TELEGRAM_EXTRA: { "-100extra1": "111", "-100extra2": "222" },
      },
    });

    const result = await removeFromSocial(property.id);

    expect(result.removed).toContain("TELEGRAM");
    expect(deleteChannelMessage).toHaveBeenCalledWith("@rh-test-channel", 4242);
    expect(deleteChannelMessage).toHaveBeenCalledWith("-100extra1", 111);
    expect(deleteChannelMessage).toHaveBeenCalledWith("-100extra2", 222);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect((after.publishedPostIds as Record<string, unknown>).TELEGRAM_EXTRA).toBeUndefined();
  });

  it("отказ одного дополнительного чата не мешает снятию основного канала и остальных", async () => {
    deleteChannelMessage.mockImplementation(async (chatId: string) => {
      if (chatId === "-100extra1") throw new Error("Telegram API deleteMessage: CHAT_ADMIN_REQUIRED");
    });
    const property = await seedPublished({
      publishedPostIds: {
        FACEBOOK: "fb-1",
        TELEGRAM: "4242",
        YOUTUBE: "yt-1",
        TELEGRAM_EXTRA: { "-100extra1": "111", "-100extra2": "222" },
      },
    });

    const result = await removeFromSocial(property.id);

    // Основной пост и второй чат сняты несмотря на отказ первого дополнительного
    // (его отказ не обрывает остальное), но канал честно остаётся с id упавшего чата
    // и попадает в failed: «снято» при живом сообщении в чате было бы неправдой
    // (аудит 04.10.2026, PUB06 — раньше канал вычёркивался, а id терялся).
    expect(deleteChannelMessage).toHaveBeenCalledWith("@rh-test-channel", 4242);
    expect(deleteChannelMessage).toHaveBeenCalledWith("-100extra2", 222);
    expect(result.removed).not.toContain("TELEGRAM");
    expect(result.failed.find((f) => f.channel === "TELEGRAM")?.error).toContain("-100extra1");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect((after.publishedPostIds as Record<string, unknown>).TELEGRAM_EXTRA).toEqual({ "-100extra1": "111" });
    expect(after.publishedChannels).toContain("TELEGRAM");
    expect(logSystemError).toHaveBeenCalledWith(
      "telegram",
      expect.stringContaining("Снятие из дополнительного чата Telegram -100extra1")
    );
  });

  it("основной канал не был настроен (только доп. чаты) — снимается без честного отказа «нечем снять»", async () => {
    const property = await seedPublished({
      publishedChannels: ["TELEGRAM"],
      publishedPostIds: { TELEGRAM_EXTRA: { "-100extra1": "111" } },
    });

    const result = await removeFromSocial(property.id);

    expect(result.removed).toContain("TELEGRAM");
    expect(result.failed.find((f) => f.channel === "TELEGRAM")).toBeUndefined();
    expect(deleteChannelMessage).toHaveBeenCalledWith("-100extra1", 111);
  });
});

describe("Вернуть объект монтажёру", () => {
  it("объект уходит монтажёру, и ни одно поле карточки не меняется", async () => {
    const property = await seedPublished({ videoHandoffStatus: "RECEIVED" });
    await addRawVideo(property.id);
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { videoHandoffEnabled: true, videoMontajerAgentId: agentId },
    });

    const result = await sendBackToMontajer(property.id, agentId, "POOR_EDIT");

    expect(result).toMatchObject({ ok: true });
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(["QUEUED", "SENT_TO_EDITOR"]).toContain(after.videoHandoffStatus);
    // Ради этого всё и делалось: карточку второй раз не заполняют.
    expect(after.rooms).toBe(property.rooms);
    expect(after.areaSqm?.toString()).toBe(property.areaSqm?.toString());
    expect(after.address).toBe(property.address);
    expect(after.price?.toString()).toBe(property.price?.toString());
    // Причина возврата теперь обязательна — заявка и счётчик заведены (проверка
    // подробностей — apps/api/tests/video-remake.test.ts).
    expect(after.videoRemakeCount).toBe(1);
  });

  it("исходники уже убрала уборка — понятный отказ, а не молчаливая пустая отправка", async () => {
    const property = await seedPublished({ videoHandoffStatus: "RECEIVED" });

    const result = await sendBackToMontajer(property.id, agentId, "POOR_EDIT");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("Загрузите новый исходник");
  });

  it("замена исходника: старые ролики удаляются, новый остаётся, объект уходит монтажёру", async () => {
    const property = await seedPublished({ videoHandoffStatus: "RECEIVED" });
    const oldVideo = await addRawVideo(property.id);
    const newVideo = await addRawVideo(property.id);
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { videoHandoffEnabled: true, videoMontajerAgentId: agentId },
    });

    const result = await sendBackToMontajer(property.id, agentId, "POOR_EDIT", null, [newVideo.id]);

    expect(result).toMatchObject({ ok: true });
    const left = await prisma.propertyVideo.findMany({ where: { propertyId: property.id }, select: { id: true } });
    expect(left.map((v) => v.id)).toEqual([newVideo.id]);
    expect(left.map((v) => v.id)).not.toContain(oldVideo.id);
  });

  it("замена исходника чужим id — отказ, старые ролики на месте", async () => {
    const property = await seedPublished({ videoHandoffStatus: "RECEIVED" });
    const other = await seedPublished({ videoHandoffStatus: "RECEIVED" });
    const oldVideo = await addRawVideo(property.id);
    const foreign = await addRawVideo(other.id);

    const result = await sendBackToMontajer(property.id, agentId, "POOR_EDIT", null, [foreign.id]);

    expect(result.ok).toBe(false);
    const left = await prisma.propertyVideo.findMany({ where: { propertyId: property.id }, select: { id: true } });
    expect(left.map((v) => v.id)).toEqual([oldVideo.id]);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.videoRemakeCount).toBe(0);
  });

  it("объект уже у монтажёра — второй раз не отправляем", async () => {
    const property = await seedPublished({ videoHandoffStatus: "SENT_TO_EDITOR" });
    await addRawVideo(property.id);

    const result = await sendBackToMontajer(property.id, agentId, "POOR_EDIT");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("уже у монтажёра");
  });

  /**
   * ЗАДАНИЕ F (24.09.2026, аудит «монтажёр ↔ CRM ↔ соцсети»): раньше функция
   * смотрела только на videoHandoffStatus, не на судьбу объекта — проданный
   * или снятый с продажи объект можно было отправить на перемонтаж как живой.
   * Маршрут /:id/send-back-to-montajer превращает ok:false в 409 без правок
   * здесь — см. routes/properties/videos.ts.
   */
  it("объект продан — отказ, а не тихая отправка на перемонтаж", async () => {
    const property = await seedPublished({ videoHandoffStatus: "RECEIVED", status: "SOLD" });
    await addRawVideo(property.id);
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { videoHandoffEnabled: true, videoMontajerAgentId: agentId },
    });

    const result = await sendBackToMontajer(property.id, agentId, "POOR_EDIT");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("продан");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.videoHandoffStatus).toBe("RECEIVED");
    expect(after.videoRemakeCount).toBe(0);
  });

  it("объект снят с продажи — тот же отказ", async () => {
    const property = await seedPublished({ videoHandoffStatus: "RECEIVED", status: "WITHDRAWN" });
    await addRawVideo(property.id);
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { videoHandoffEnabled: true, videoMontajerAgentId: agentId },
    });

    const result = await sendBackToMontajer(property.id, agentId, "POOR_EDIT");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("снят с продажи");
  });

  /* Б6 (25.09.2026, пачка «Перезалив честно»): старый слот, ждущие задания
     публикации/повтора TikTok и недоделанный Reels гаснут вместе с возвратом. */
  it("возврат сбрасывает слот и ждущие задания, файл прежнего ролика остаётся", async () => {
    const at = new Date(Date.now() + 5 * 3600_000);
    const property = await seedPublished({
      videoHandoffStatus: "RECEIVED",
      videoHandoffFinalPath: "/uploads/handoff/old-final.mp4",
      publishedChannels: ["YOUTUBE"],
      scheduledPublishAt: at,
      scheduledPublishReason: "Час пик",
    });
    await addRawVideo(property.id);
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { videoHandoffEnabled: true, videoMontajerAgentId: agentId },
    });
    const keys = [videoHandoffPublishDedupeKey(property.id), tiktokPublishRetryDedupeKey(property.id)];
    await prisma.backgroundJob.createMany({
      data: keys.map((dedupeKey, i) => ({
        type: i === 0 ? VIDEO_HANDOFF_PUBLISH_JOB_TYPE : TIKTOK_PUBLISH_RETRY_JOB_TYPE,
        payload: { propertyId: property.id },
        status: "PENDING" as const,
        runAt: at,
        maxAttempts: 6,
        dedupeKey,
      })),
    });
    const container = await prisma.pendingInstagramContainer.create({
      data: { propertyId: property.id, containerId: `c-${runId}-${randomUUID()}`, kind: "REEL" },
    });

    try {
      const result = await sendBackToMontajer(property.id, agentId, "POOR_EDIT");
      await settleBackgroundHandoffDispatches();

      expect(result.ok).toBe(true);
      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      expect(after.scheduledPublishAt).toBeNull();
      expect(after.scheduledPublishReason).toBeNull();
      expect(after.videoHandoffFinalPath).toBe("/uploads/handoff/old-final.mp4");
      expect(["QUEUED", "SENT_TO_EDITOR"]).toContain(after.videoHandoffStatus);
      expect(await prisma.backgroundJob.count({ where: { dedupeKey: { in: keys } } })).toBe(0);
      expect((await prisma.pendingInstagramContainer.findUniqueOrThrow({ where: { id: container.id } })).status).toBe("CANCELLED");
    } finally {
      await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: keys } } });
      await prisma.pendingInstagramContainer.deleteMany({ where: { id: container.id } });
    }
  });

  it("идёт публикация — возврат отказывает (Б3), ничего не тронуто", async () => {
    const property = await seedPublished({ videoHandoffStatus: "RECEIVED", publishedChannels: ["YOUTUBE"] });
    await addRawVideo(property.id);
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { videoHandoffEnabled: true, videoMontajerAgentId: agentId },
    });
    const dedupeKey = videoHandoffPublishDedupeKey(property.id);
    await prisma.backgroundJob.create({
      data: { type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE, payload: { propertyId: property.id }, status: "RUNNING", runAt: new Date(), maxAttempts: 6, dedupeKey },
    });

    try {
      const result = await sendBackToMontajer(property.id, agentId, "POOR_EDIT", null, null, { removeFromSocial: true });

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/идёт публикация/);
      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      expect(after.videoHandoffStatus).toBe("RECEIVED");
      expect(after.videoRemakeCount).toBe(0);
      expect(deleteYouTubeVideo).not.toHaveBeenCalled();
    } finally {
      await prisma.backgroundJob.deleteMany({ where: { dedupeKey } });
    }
  });
});

describe("Убрать из соцсетей во время публикации (Б3)", () => {
  it("RUNNING-задание публикации — снятие не начинается, причина в blocked", async () => {
    const property = await seedPublished();
    const dedupeKey = videoHandoffPublishDedupeKey(property.id);
    await prisma.backgroundJob.create({
      data: { type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE, payload: { propertyId: property.id }, status: "RUNNING", runAt: new Date(), maxAttempts: 6, dedupeKey },
    });
    try {
      const result = await removeFromSocial(property.id);

      expect(result.blocked).toMatch(/идёт публикация/);
      expect(result.removed).toEqual([]);
      expect(deleteFacebookVideo).not.toHaveBeenCalled();
      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      expect(after.publishedChannels).toEqual(property.publishedChannels);
    } finally {
      await prisma.backgroundJob.deleteMany({ where: { dedupeKey } });
    }
  });

  it("удалённый объект — снятие не начинается", async () => {
    const property = await seedPublished({ deletedAt: new Date() });

    const result = await removeFromSocial(property.id);

    expect(result.blocked).toBeTruthy();
    expect(deleteFacebookVideo).not.toHaveBeenCalled();
  });
});

describe("Ручная загрузка готового ролика", () => {
  it("объект, который ничего не ждёт, открывается под приём файла", async () => {
    const property = await seedPublished({ videoHandoffStatus: "RECEIVED" });

    const result = await openForManualFinalVideo(property.id);

    expect(result.ok).toBe(true);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    // Время ожидания обязано быть проставлено: по нему бот выбирает, к какому
    // объекту привязать входящий файл.
    expect(after.videoHandoffSentAt).not.toBeNull();
  });

  it("удалённый объект под приём не открывается", async () => {
    const property = await seedPublished({ deletedAt: new Date() });

    const result = await openForManualFinalVideo(property.id);

    expect(result.ok).toBe(false);
  });
});

describe("Обновить подписи в вышедших постах", () => {
  it("подпись пересобирается из полей карточки и уезжает туда, где её можно поменять", async () => {
    const property = await seedPublished();

    const result = await refreshPublishedCaptions(property.id);

    expect(result.updated.sort()).toEqual(["FACEBOOK", "TELEGRAM", "YOUTUBE"]);
    // Instagram и TikTok правке не поддаются — про них снова сказано прямо.
    expect(result.manual.map((m) => m.channel).sort()).toEqual(["INSTAGRAM", "TIKTOK"]);
    // Новая подпись собрана из карточки, а не оставлена прежней.
    expect(result.caption).not.toBe("Старая подпись");
    expect(result.caption.length).toBeGreaterThan(0);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.reelsCaption).toBe(result.caption);
    expect(editMessageCaption).toHaveBeenCalledWith("@rh-test-channel", 4242, result.caption);
  });

  it("отказ одной сети не отменяет успех остальных и попадает в журнал", async () => {
    const property = await seedPublished();
    updateFacebookVideoDescription.mockResolvedValueOnce({ ok: false, error: "токен протух" });

    const result = await refreshPublishedCaptions(property.id);

    expect(result.updated.sort()).toEqual(["TELEGRAM", "YOUTUBE"]);
    expect(result.failed).toEqual([{ channel: "FACEBOOK", error: "токен протух" }]);
    expect(logSystemError).toHaveBeenCalled();
  });

  it("нет права у ключа YouTube — понятная причина в карточке, общая строка с рецептом, а не строка на объект (25.09.2026)", async () => {
    const property = await seedPublished();
    updateYouTubeDescription.mockResolvedValueOnce({ ok: false, error: "Request had insufficient authentication scopes." });

    const result = await refreshPublishedCaptions(property.id);

    expect(result.updated.sort()).toEqual(["FACEBOOK", "TELEGRAM"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].channel).toBe("YOUTUBE");
    expect(result.failed[0].error).toMatch(/перевыпустить ключ/);
    // Строка про объект не пишется вовсе (остальное прошло) — только общая про ключ.
    const messages = logSystemError.mock.calls.map((c: unknown[]) => String(c[1]));
    expect(messages.some((m: string) => m.includes(`Объект ${property.id}`))).toBe(false);
    expect(messages.some((m: string) => m.includes("youtube.force-ssl"))).toBe(true);
  });

  it("канал в списке, а id в publishedPostIds нет — честная запись в failed, а не молчаливый пропуск", async () => {
    const property = await seedPublished({ publishedPostIds: { TELEGRAM: "4242", YOUTUBE: "yt-1" } }); // FACEBOOK без id

    const result = await refreshPublishedCaptions(property.id);

    expect(result.updated).not.toContain("FACEBOOK");
    expect(result.failed).toContainEqual({
      channel: "FACEBOOK",
      error: "в карточке нет сохранённого id поста Facebook — подпись обновить нечем",
    });
    expect(logSystemError).toHaveBeenCalled();
  });
});
