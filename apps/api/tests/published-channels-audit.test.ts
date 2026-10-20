import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ЕЖЕСУТОЧНАЯ СВЕРКА ПУБЛИКАЦИЙ (lib/publishedChannelsAudit.ts, 22.09.2026).
 *
 * Главное, что здесь проверяется, — НЕСИММЕТРИЧНАЯ цена ошибки. Отметка
 * «опубликовано» запрещает объекту получить новый ролик в этот канал
 * (videoHandoff.ts::skipChannels), поэтому фантом стоит объекту публикации.
 * Но снять отметку с ЖИВОГО поста дороже: следующий ролик уедет на публичную
 * страницу поверх уже висящего. Отсюда правило: вычёркиваем только на прямое
 * «объекта нет» от площадки, а на любое «не смогли проверить» не трогаем
 * ничего и говорим об этом в журнал.
 *
 * Сами сети подменены: тест не ходит ни в Meta, ни в YouTube.
 */

const { checkFacebookVideoExists, checkInstagramMediaExists, checkYouTubeVideoExists, logSystemError } = vi.hoisted(
  () => ({
    checkFacebookVideoExists: vi.fn(async () => ({ status: "present" }) as { status: string; reason?: string }),
    checkInstagramMediaExists: vi.fn(async () => ({ status: "present" }) as { status: string; reason?: string }),
    checkYouTubeVideoExists: vi.fn(async () => ({ status: "present" }) as { status: string; reason?: string }),
    logSystemError: vi.fn(async () => {}),
  })
);

vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  checkFacebookVideoExists,
  checkInstagramMediaExists,
  checkYouTubeVideoExists,
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
const { runPublishedChannelsAuditTick } = await import("../src/lib/publishedChannelsAudit.js");

const runId = Date.now();
const propertyIds: string[] = [];
let districtId = "";

async function seed(overrides: Record<string, unknown> = {}) {
  const property = await prisma.property.create({
    data: {
      title: `Сверка публикаций ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 54,
      floor: 3,
      price: 390000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 7",
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

/** Проход строго по своим карточкам — в общей базе рядом живут объекты других
 *  тестовых файлов, и бюджет прохода не должен от них зависеть. */
const audit = (ids: string[], now = new Date()) => runPublishedChannelsAuditTick(now, { propertyIds: ids });

const reload = (id: string) =>
  prisma.property.findUniqueOrThrow({
    where: { id },
    select: { publishedChannels: true, publishedPostIds: true, instagramUrl: true },
  });

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Сверка публикаций ${runId}` } })).id;
  await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
});

beforeEach(() => {
  checkFacebookVideoExists.mockClear().mockResolvedValue({ status: "present" });
  checkInstagramMediaExists.mockClear().mockResolvedValue({ status: "present" });
  checkYouTubeVideoExists.mockClear().mockResolvedValue({ status: "present" });
  logSystemError.mockClear();
});

afterEach(async () => {
  // Токен удаления/чтения Instagram по умолчанию не задан (прежнее поведение);
  // тесты включают его точечно и обязаны вернуть настройки как было.
  await prisma.settings.update({ where: { id: "singleton" }, data: { metaIgManageToken: null } });
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Ежесуточная сверка публикаций", () => {
  it("поста в Facebook больше нет — отметка снята, id убран, канал снова свободен", async () => {
    const property = await seed({ publishedChannels: ["FACEBOOK", "TELEGRAM"], publishedPostIds: { FACEBOOK: "fb-1", TELEGRAM: "42" } });
    checkFacebookVideoExists.mockResolvedValue({ status: "gone" });

    const result = await audit([property.id]);

    expect(result).toMatchObject({ checked: 1, cleared: 1, unknown: 0 });
    const after = await reload(property.id);
    // TELEGRAM не проверяется вовсе (Bot API не даёт спросить про сообщение) —
    // и именно поэтому обязан остаться на месте.
    expect(after.publishedChannels).toEqual(["TELEGRAM"]);
    expect(after.publishedPostIds).toMatchObject({ TELEGRAM: "42" });
    expect(after.publishedPostIds).not.toHaveProperty("FACEBOOK");
    expect(logSystemError).toHaveBeenCalledWith(
      "meta",
      expect.stringContaining("числился опубликованным в FACEBOOK"),
      expect.anything()
    );
  });

  it("пост на месте — карточка не меняется", async () => {
    const property = await seed({ publishedChannels: ["FACEBOOK", "YOUTUBE"], publishedPostIds: { FACEBOOK: "fb-1", YOUTUBE: "yt-1" } });

    const result = await audit([property.id]);

    expect(result).toMatchObject({ checked: 1, cleared: 0, unknown: 0 });
    const after = await reload(property.id);
    expect(after.publishedChannels.sort()).toEqual(["FACEBOOK", "YOUTUBE"]);
    expect(after.publishedPostIds).toMatchObject({ FACEBOOK: "fb-1", YOUTUBE: "yt-1" });
  });

  it("проверить не удалось — НИЧЕГО не снимаем, но и не молчим", async () => {
    const property = await seed();
    checkFacebookVideoExists.mockResolvedValue({ status: "unknown", reason: "HTTP 500" });

    const result = await audit([property.id]);

    expect(result).toMatchObject({ checked: 1, cleared: 0, unknown: 1 });
    expect((await reload(property.id)).publishedChannels).toEqual(["FACEBOOK"]);
    expect(logSystemError).toHaveBeenCalledWith("meta", expect.stringContaining("не удалось проверить"), expect.anything());
  });

  it("у поста Facebook два идентификатора — снимаем, только если нет обоих", async () => {
    const alive = await seed({ publishedPostIds: { FACEBOOK: "fb-1", FACEBOOK_POST: "page_fb-1" } });
    // Первый id не находится, второй — находится: пост жив, это два разных
    // объекта Graph API одного и того же поста страницы.
    checkFacebookVideoExists.mockResolvedValueOnce({ status: "gone" }).mockResolvedValueOnce({ status: "present" });

    expect(await audit([alive.id])).toMatchObject({ cleared: 0 });
    expect((await reload(alive.id)).publishedChannels).toEqual(["FACEBOOK"]);

    const dead = await seed({ publishedPostIds: { FACEBOOK: "fb-2", FACEBOOK_POST: "page_fb-2" } });
    checkFacebookVideoExists.mockResolvedValue({ status: "gone" });

    expect(await audit([dead.id])).toMatchObject({ cleared: 1 });
    const after = await reload(dead.id);
    expect(after.publishedChannels).toEqual([]);
    // Второй идентификатор — часть того же поста, а не отдельный канал:
    // остаться мёртвой строкой он не должен.
    expect(after.publishedPostIds).not.toHaveProperty("FACEBOOK_POST");
  });

  it("первый id Facebook не читается (#12, старый вид поста) — смотрим по второму", async () => {
    const readable = await seed({ publishedPostIds: { FACEBOOK: "fb-3", FACEBOOK_POST: "page_fb-3" } });
    checkFacebookVideoExists
      .mockResolvedValueOnce({ status: "unknown", reason: "(#12) singular statuses API is deprecated" })
      .mockResolvedValueOnce({ status: "present" });
    expect(await audit([readable.id])).toMatchObject({ cleared: 0, unknown: 0 });

    // «Не знаю» по первому и «нет» по второму — всё ещё «не знаю»: не снимаем.
    const unclear = await seed({ publishedPostIds: { FACEBOOK: "fb-4", FACEBOOK_POST: "page_fb-4" } });
    checkFacebookVideoExists
      .mockResolvedValueOnce({ status: "unknown", reason: "HTTP 500" })
      .mockResolvedValueOnce({ status: "gone" });
    expect(await audit([unclear.id])).toMatchObject({ cleared: 0, unknown: 1 });
    expect((await reload(unclear.id)).publishedChannels).toEqual(["FACEBOOK"]);
  });

  it("Reels больше нет — вместе с каналом гаснет и ссылка на пост", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaIgManageToken: encryptSecret("ig-manage-token") } });
    const property = await seed({
      publishedChannels: ["INSTAGRAM"],
      publishedPostIds: { INSTAGRAM: "ig-1" },
      instagramUrl: "https://instagram.com/reel/ABC123",
    });
    checkInstagramMediaExists.mockResolvedValue({ status: "gone" });

    expect(await audit([property.id])).toMatchObject({ cleared: 1 });
    const after = await reload(property.id);
    expect(after.publishedChannels).toEqual([]);
    expect(after.instagramUrl).toBeNull();
  });

  it("без токена удаления Instagram канал не проверяется и не трогается", async () => {
    const property = await seed({ publishedChannels: ["INSTAGRAM"], publishedPostIds: { INSTAGRAM: "ig-1" } });

    const result = await audit([property.id]);

    expect(checkInstagramMediaExists).not.toHaveBeenCalled();
    expect(result).toMatchObject({ cleared: 0, unknown: 0 });
    expect((await reload(property.id)).publishedChannels).toEqual(["INSTAGRAM"]);
  });

  it("канал без сохранённого id — не фантом: проверять нечем, значит не трогаем", async () => {
    const property = await seed({ publishedChannels: ["FACEBOOK", "TIKTOK"], publishedPostIds: {} });

    const result = await audit([property.id]);

    expect(checkFacebookVideoExists).not.toHaveBeenCalled();
    expect(result).toMatchObject({ cleared: 0, unknown: 0 });
    expect((await reload(property.id)).publishedChannels.sort()).toEqual(["FACEBOOK", "TIKTOK"]);
  });

  it("в те же сутки карточка второй раз не опрашивается", async () => {
    const property = await seed();
    const first = new Date();

    expect(await audit([property.id], first)).toMatchObject({ checked: 1 });
    expect(await audit([property.id], new Date(first.getTime() + 60 * 60 * 1000))).toMatchObject({ checked: 0 });
    // Сутки спустя — снова в очереди.
    expect(await audit([property.id], new Date(first.getTime() + 25 * 60 * 60 * 1000))).toMatchObject({ checked: 1 });
  });

  it("unknown и журнал считают КАРТОЧКИ, а не пробы (раньше «3 из 1»)", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaIgManageToken: encryptSecret("ig-manage-token") } });
    const property = await seed({
      publishedChannels: ["FACEBOOK", "INSTAGRAM", "YOUTUBE"],
      publishedPostIds: { FACEBOOK: "fb-1", INSTAGRAM: "ig-1", YOUTUBE: "yt-1" },
    });
    checkFacebookVideoExists.mockResolvedValue({ status: "unknown", reason: "HTTP 500" });
    checkInstagramMediaExists.mockResolvedValue({ status: "unknown", reason: "HTTP 500" });
    checkYouTubeVideoExists.mockResolvedValue({ status: "unknown", reason: "HTTP 500" });

    const result = await audit([property.id]);

    expect(result).toMatchObject({ checked: 1, unknown: 1 });
    expect(logSystemError).toHaveBeenCalledWith(
      "meta",
      expect.stringContaining("не удалось проверить 1 карточек из 1 (проб: 3)"),
      expect.anything()
    );
  });
});
