import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Ф5 (аудит фона 02.10.2026): фото-посты застревали и не повторялись.
 *
 * - Публикация не запустилась вовсе (у объекта появился ролик, нет подходящих
 *   фото) — три строки SCHEDULED оставались навсегда: кандидатом объект больше
 *   не становится именно из-за них, а в карточке вечное «запланировано».
 * - Один канал упал по сети, другой вышел — задание всё равно DONE: лестница
 *   повторов для отказа канала недостижима.
 * - Все три канала упали — каждый час новый круг из трёх строк, без предела.
 */

const publishMock = vi.fn();
vi.mock("../src/lib/photoPosts.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/photoPosts.js")>();
  return { ...real, publishPropertyPhotoPost: (...args: unknown[]) => publishMock(...args) };
});
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn(async () => {}),
}));

const { prisma } = await import("../src/db.js");
const { photoPostPublishJob } = await import("../src/jobs/photoPostPublish.js");
const { schedulePhotoPostsTick } = await import("../src/lib/photoPosts.js");

const runId = Date.now().toString(36);
let districtId: string;
const propertyIds: string[] = [];
let settingsBefore: { photoPostsEnabled: boolean; photoPostAfterHours: number } | null = null;

async function makeProperty() {
  const p = await prisma.property.create({
    data: {
      title: `Фото-пост застрял ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 60,
      price: 55000,
      currency: "USD",
      districtId,
      address: "Тестовая, 3",
      condition: "GOOD",
      status: "AVAILABLE",
      publishedOnSite: true,
      postApprovedAt: new Date(Date.now() - 48 * 3_600_000),
    },
  });
  propertyIds.push(p.id);
  await prisma.propertyPhoto.create({ data: { propertyId: p.id, url: "/uploads/нет.webp", thumbUrl: "/uploads/нет.webp", order: 0 } });
  return p;
}

async function scheduledRows(propertyId: string) {
  await prisma.propertyPhotoPost.createMany({
    data: ["INSTAGRAM", "FACEBOOK", "TELEGRAM"].map((channel) => ({
      propertyId,
      channel,
      status: "SCHEDULED",
      scheduledAt: new Date(),
    })),
  });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район-фото-застрял-${runId}` } })).id;
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { photoPostsEnabled: true, photoPostAfterHours: true } });
  settingsBefore = s;
  await prisma.settings.update({ where: { id: "singleton" }, data: { photoPostsEnabled: true, photoPostAfterHours: 24 } });
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: propertyIds.map((id) => `photo-post-publish:${id}`) } } });
  await prisma.propertyPhotoPost.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await prisma.$disconnect();
});

describe("фото-пост: застрявшие SCHEDULED и повтор упавшего канала", () => {
  it("публикация не запустилась (у объекта появился ролик) — строки SCHEDULED закрываются с причиной", async () => {
    const p = await makeProperty();
    await scheduledRows(p.id);
    publishMock.mockResolvedValueOnce({ ok: false, results: {}, skipped: [], reason: "У объекта есть ролик (или он в работе) — фото-пост не нужен" });
    await photoPostPublishJob.run({ propertyId: p.id });
    const left = await prisma.propertyPhotoPost.count({ where: { propertyId: p.id, status: "SCHEDULED" } });
    expect(left).toBe(0);
  });

  it("один канал вышел, другой упал по сети — задание уходит в повтор", async () => {
    const p = await makeProperty();
    publishMock.mockResolvedValueOnce({
      ok: true,
      results: { INSTAGRAM: { ok: true }, FACEBOOK: { ok: false, error: "HTTP 500 от Graph API" }, TELEGRAM: { ok: true } },
      skipped: [],
    });
    await expect(photoPostPublishJob.run({ propertyId: p.id })).rejects.toThrow(/Facebook/);
  });

  it("канал не настроен — повторять нечего, задание завершается", async () => {
    const p = await makeProperty();
    publishMock.mockResolvedValueOnce({
      ok: true,
      results: { INSTAGRAM: { ok: true }, FACEBOOK: { ok: false, error: "Facebook не подключён в Настройках" }, TELEGRAM: { ok: true } },
      skipped: [],
    });
    await expect(photoPostPublishJob.run({ propertyId: p.id })).resolves.toBeUndefined();
  });

  it("все каналы упали только что — следующий часовой тик не заводит новый круг", async () => {
    const p = await makeProperty();
    await prisma.propertyPhotoPost.createMany({
      data: ["INSTAGRAM", "FACEBOOK", "TELEGRAM"].map((channel) => ({ propertyId: p.id, channel, status: "FAILED", error: "сбой" })),
    });
    await schedulePhotoPostsTick();
    expect(await prisma.propertyPhotoPost.count({ where: { propertyId: p.id, status: "SCHEDULED" } })).toBe(0);
  });
});
