import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * УДАЛЁННЫЙ ОБЪЕКТ НЕ ВОСКРЕСАЕТ ПУБЛИКАЦИЕЙ (22.09.2026).
 *
 * `applySucceededPublishResults` (lib/videoHandoff.ts) — общая точка записи
 * результата для ВСЕХ путей публикации: живого, фонового задания
 * (jobs/videoHandoffPublish.ts) и дозавершения отложенного контейнера Instagram
 * (lib/instagramPendingContainers.ts). Контейнер живёт у Meta до суток, и всё
 * это время объект можно удалить из CRM. Удаление мягкое (`deletedAt`), поэтому
 * `onDelete: Cascade` у PendingInstagramContainer не срабатывает и запись
 * объекта остаётся на месте — без явной проверки дозавершение дописывало каналы
 * удалённому объекту и выводило его обратно в «Продаётся».
 *
 * Проверяем по настоящей базе: удалённый объект после вызова остаётся ровно
 * таким, каким был.
 */

const { publishAfterEditingComplete } = vi.hoisted(() => ({
  publishAfterEditingComplete: vi.fn(async () => ({ updated: {} })),
}));
vi.mock("../src/lib/publishedListingSync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/publishedListingSync.js")>()),
  publishAfterEditingComplete,
}));

const { prisma } = await import("../src/db.js");
const { applySucceededPublishResults } = await import("../src/lib/videoHandoff.js");

const runId = Date.now();
let districtId: string;
const propertyIds: string[] = [];

async function seedProperty(deleted: boolean) {
  const property = await prisma.property.create({
    data: {
      title: `Удалённый объект-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 40,
      price: 250000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 12",
      condition: "GOOD",
      status: "EDITING",
      ...(deleted ? { deletedAt: new Date() } : {}),
    },
  });
  propertyIds.push(property.id);
  return property;
}

beforeAll(async () => {
  const district = await prisma.district.create({ data: { name: `Удалённый объект-${runId}` } });
  districtId = district.id;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("applySucceededPublishResults и удалённый объект", () => {
  it("объект удалён — каналы не дописываются, статус не меняется, сайт не трогаем", async () => {
    const property = await seedProperty(true);
    publishAfterEditingComplete.mockClear();

    const result = await applySucceededPublishResults(
      property.id,
      [{ channel: "INSTAGRAM", postId: "ig-post-1" }],
      "https://instagram.com/reel/deleted"
    );

    expect(result).toEqual({ instagramUrl: null, wentAvailable: false, blockers: [] });
    expect(publishAfterEditingComplete).not.toHaveBeenCalled();

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.publishedChannels).toEqual([]);
    expect(after.instagramUrl).toBeNull();
    expect(after.status).toBe("EDITING");
  });

  it("живой объект — записывается как прежде (проверка не задела обычный путь)", async () => {
    const property = await seedProperty(false);

    const result = await applySucceededPublishResults(
      property.id,
      [{ channel: "INSTAGRAM", postId: "ig-post-2" }],
      "https://instagram.com/reel/alive"
    );

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.publishedChannels).toContain("INSTAGRAM");
    expect(after.instagramUrl).toBe("https://instagram.com/reel/alive");
    expect(result.instagramUrl).toBe("https://instagram.com/reel/alive");
  });
});
