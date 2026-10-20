import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * АУДИТ CODEX 04.10.2026, PUB08: подборка игнорировала выданное ей время публикации.
 *
 * nextPublishSlot выбирает слот в БУДУЩЕМ (занятый слот, закрытое окно), строки
 * SOCIAL_DIGEST получали этот scheduledAt, но publishDigest вызывался сразу:
 * подборка уходила в момент тика и нарушала minGap и окно публикации, а
 * scheduledAt в таблице врал. Теперь: слот в будущем и не force — не публикуем,
 * строки ждут; следующий тик доводит due-подборки; force публикует сразу и пишет
 * scheduledAt = сейчас.
 *
 * Сеть (Meta, Telegram) и подготовка картинок подменены; база настоящая.
 */

const m = vi.hoisted(() => ({
  slotAt: null as Date | null,
  publishInstagramCarousel: vi.fn(async () => ({ ok: true, mediaId: "ig-1", permalink: "https://instagram.com/p/x" })),
  publishFacebookPhotoPost: vi.fn(async () => ({ ok: true, mediaId: "fb-1", permalink: "https://facebook.com/x" })),
  publishTelegramPhotoPost: vi.fn(async () => ({ ok: true, secondaryId: "tg-1" })),
  logSystemError: vi.fn(async () => {}),
}));

vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: m.logSystemError,
}));
vi.mock("../src/lib/photoPosts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/photoPosts.js")>()),
  preparePhotoPostImages: vi.fn(async (id: string) => ({ paths: [`/tmp/${id}.jpg`], urls: [`https://crm.test/uploads/photo-posts/${id}.jpg`] })),
  publishInstagramCarousel: m.publishInstagramCarousel,
  publishFacebookPhotoPost: m.publishFacebookPhotoPost,
  publishTelegramPhotoPost: m.publishTelegramPhotoPost,
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  loadCredentials: vi.fn(async () => ({ igToken: "ig", pageToken: "pg", pageId: "page-1" })),
  instagramTokenIdentity: vi.fn(async () => ({ ok: true as const, id: "ig-user-1" })),
}));
vi.mock("../src/lib/publishSchedule.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/publishSchedule.js")>();
  return {
    ...real,
    // Управляемый слот: null — настоящий расчёт, дата — «слот в будущем».
    nextPublishSlot: (...args: Parameters<typeof real.nextPublishSlot>) =>
      m.slotAt ? { ...real.nextPublishSlot(...args), at: m.slotAt } : real.nextPublishSlot(...args),
  };
});

const { prisma } = await import("../src/db.js");
const { runSocialDigestsTick, DIGEST_KINDS } = await import("../src/lib/socialDigests.js");
const { dushanbeWallClock } = await import("../src/lib/dushanbeTime.js");

const runId = Date.now().toString(36);
const WEEK_MS = 7 * 86_400_000;
let districtId: string;
const propertyIds: string[] = [];
let settingsBefore: Record<string, unknown> | null = null;

/** Полдень среды недели, чей индекс даёт NEW_THIS_WEEK; ближайшей к сегодняшней, чтобы чужие объекты не мешали. */
function nowForNewThisWeek(): Date {
  let k = Math.floor(Date.now() / WEEK_MS);
  while (k % DIGEST_KINDS.length !== DIGEST_KINDS.indexOf("NEW_THIS_WEEK")) k++;
  return new Date(k * WEEK_MS + 3 * 86_400_000 + 12 * 3_600_000);
}
const NOW = nowForNewThisWeek();

async function makeProperty() {
  const p = await prisma.property.create({
    data: {
      title: `Тест-слот-подборки-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 60,
      price: 400_000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 12",
      condition: "GOOD",
      status: "AVAILABLE",
      offSite: false,
      publishedOnSite: true,
      // Самые свежие в окне «последние 7 дней» — именно они войдут в подборку.
      postApprovedAt: new Date(NOW.getTime() - 60_000 - propertyIds.length * 1000),
    },
  });
  propertyIds.push(p.id);
  await prisma.propertyPhoto.create({ data: { propertyId: p.id, url: `/uploads/slot-${p.id}.webp`, thumbUrl: `/uploads/slot-${p.id}.webp`, order: 0 } });
  return p;
}

async function enableDigests() {
  const wall = dushanbeWallClock(NOW);
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { digestsEnabled: true, digestWeekday: wall.getUTCDay(), digestHourDushanbe: wall.getUTCHours(), digestLastRunAt: null, telegramChannelId: "-100test" },
  });
}

const rowsOf = () => prisma.socialDigestPost.findMany({ where: { propertyIds: { hasSome: propertyIds } }, orderBy: { channel: "asc" } });
const resetRows = () => prisma.socialDigestPost.deleteMany({ where: { propertyIds: { hasSome: propertyIds } } });

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район-слот-подборки-${runId}` } })).id;
  settingsBefore = (await prisma.settings.findUnique({ where: { id: "singleton" } })) as unknown as Record<string, unknown>;
  for (let i = 0; i < 3; i++) await makeProperty();
});

afterAll(async () => {
  await resetRows();
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  if (settingsBefore) {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        digestsEnabled: settingsBefore.digestsEnabled as boolean,
        digestWeekday: settingsBefore.digestWeekday as number,
        digestHourDushanbe: settingsBefore.digestHourDushanbe as number,
        digestLastRunAt: settingsBefore.digestLastRunAt as Date | null,
        telegramChannelId: settingsBefore.telegramChannelId as string | null,
      },
    });
  }
  await prisma.$disconnect();
});

beforeEach(async () => {
  m.slotAt = null;
  m.publishInstagramCarousel.mockClear();
  m.publishFacebookPhotoPost.mockClear();
  m.publishTelegramPhotoPost.mockClear();
  m.logSystemError.mockClear();
  await resetRows();
  await enableDigests();
});

describe("подборка соблюдает выданный слот", () => {
  it("слот в будущем — публикации сейчас нет, три строки SCHEDULED с этим временем", async () => {
    const future = new Date(NOW.getTime() + 30 * 60_000);
    m.slotAt = future;

    const result = await runSocialDigestsTick(NOW);

    expect(result.ran).toBe(true);
    expect(result.published).toBe(0);
    expect(result.reason).toContain("отложен");
    expect(m.publishInstagramCarousel).not.toHaveBeenCalled();
    expect(m.publishFacebookPhotoPost).not.toHaveBeenCalled();
    expect(m.publishTelegramPhotoPost).not.toHaveBeenCalled();
    const rows = await rowsOf();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "SCHEDULED" && r.scheduledAt?.getTime() === future.getTime())).toBe(true);
  });

  it("слот наступил — следующий тик публикует отложенную подборку, строки PUBLISHED, метка «публикуется» не остаётся", async () => {
    m.slotAt = new Date(NOW.getTime() + 30 * 60_000);
    await runSocialDigestsTick(NOW);
    m.slotAt = null;

    const later = new Date(NOW.getTime() + 31 * 60_000);
    const result = await runSocialDigestsTick(later);

    expect(result.ran).toBe(true);
    expect(result.published).toBe(3);
    expect(m.publishInstagramCarousel).toHaveBeenCalledTimes(1);
    expect(m.publishFacebookPhotoPost).toHaveBeenCalledTimes(1);
    expect(m.publishTelegramPhotoPost).toHaveBeenCalledTimes(1);
    const rows = await rowsOf();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "PUBLISHED" && r.error === null)).toBe(true);
  });

  it("два тика одновременно — подборка выходит один раз", async () => {
    m.slotAt = new Date(NOW.getTime() + 30 * 60_000);
    await runSocialDigestsTick(NOW);
    m.slotAt = null;

    const later = new Date(NOW.getTime() + 31 * 60_000);
    await Promise.all([runSocialDigestsTick(later), runSocialDigestsTick(later)]);

    expect(m.publishInstagramCarousel).toHaveBeenCalledTimes(1);
    expect(m.publishTelegramPhotoPost).toHaveBeenCalledTimes(1);
    expect((await rowsOf()).every((r) => r.status === "PUBLISHED")).toBe(true);
  });

  it("force (кнопка) при слоте в будущем — публикуем сейчас и пишем scheduledAt = сейчас, а не выданное будущее", async () => {
    const future = new Date(NOW.getTime() + 30 * 60_000);
    m.slotAt = future;
    const before = Date.now();

    const result = await runSocialDigestsTick(NOW, { force: true });

    expect(result.published).toBe(3);
    const rows = await rowsOf();
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.status).toBe("PUBLISHED");
      expect(r.scheduledAt!.getTime()).toBeLessThan(future.getTime());
      expect(r.scheduledAt!.getTime()).toBeLessThanOrEqual(NOW.getTime() + 1000);
    }
    expect(before).toBeGreaterThan(0);
  });

  it("слот давно прошёл мимо (подборка устарела больше чем на 6 часов) — не публикуем, строки закрыты с причиной", async () => {
    m.slotAt = new Date(NOW.getTime() + 30 * 60_000);
    await runSocialDigestsTick(NOW);
    m.slotAt = null;

    await runSocialDigestsTick(new Date(NOW.getTime() + 7 * 3_600_000));

    expect(m.publishInstagramCarousel).not.toHaveBeenCalled();
    const rows = await rowsOf();
    expect(rows.every((r) => r.status === "FAILED" && /устарел/.test(r.error ?? ""))).toBe(true);
  });

  it("слот наступил сразу — публикуем в тот же тик, как и раньше", async () => {
    m.slotAt = NOW; // слот «сейчас» (окно открыто, место свободно)
    const result = await runSocialDigestsTick(NOW);

    expect(result.published).toBe(3);
    expect(m.publishInstagramCarousel).toHaveBeenCalledTimes(1);
    expect((await rowsOf()).every((r) => r.status === "PUBLISHED" && r.error === null)).toBe(true);
  });
});
