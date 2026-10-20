import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Тот же класс, что Ф5 аудита фона 02.10.2026 (фото-посты), у повторных показов:
 *
 * - Публикация круга не запустилась (объект продали, пока круг ждал слота) —
 *   три строки SCHEDULED оставались навсегда, и объект больше никогда не
 *   становился кандидатом: фильтр расстановки исключает SCHEDULED.
 * - Круг упал целиком — показ не состоялся, lastSocialShowAt прежний, и
 *   часовой тик заводил тот же круг заново: три новые строки каждый час.
 */

vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn(async () => {}),
}));

const { prisma } = await import("../src/db.js");
const { socialRepostPublishJob } = await import("../src/jobs/socialRepostPublish.js");
const { scheduleRepostsTick } = await import("../src/lib/socialReposts.js");

const runId = Date.now().toString(36);
let districtId: string;
const propertyIds: string[] = [];
let settingsBefore: { repostsEnabled: boolean; repostAfterDays: number; repostMaxRounds: number } | null = null;

async function makeProperty(status: "AVAILABLE" | "SOLD") {
  const p = await prisma.property.create({
    data: {
      title: `Повтор застрял ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 60,
      price: 55000,
      currency: "USD",
      districtId,
      address: "Тестовая, 5",
      condition: "GOOD",
      status,
      publishedOnSite: true,
    },
  });
  propertyIds.push(p.id);
  await prisma.propertyPhoto.create({ data: { propertyId: p.id, url: "/uploads/нет.webp", thumbUrl: "/uploads/нет.webp", order: 0 } });
  // Показан давно — lastSocialShowAt старше repostAfterDays.
  await prisma.propertyPhotoPost.create({
    data: { propertyId: p.id, channel: "INSTAGRAM", status: "PUBLISHED", publishedAt: new Date(Date.now() - 60 * 86_400_000), mediaId: "old" },
  });
  return p;
}

function rows(propertyId: string, status: string) {
  return prisma.propertySocialRepost.createMany({
    data: ["INSTAGRAM", "FACEBOOK", "TELEGRAM"].map((channel) => ({ propertyId, round: 1, hook: "тест", channel, status, scheduledAt: new Date() })),
  });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район-повтор-застрял-${runId}` } })).id;
  settingsBefore = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { repostsEnabled: true, repostAfterDays: true, repostMaxRounds: true },
  });
  await prisma.settings.update({ where: { id: "singleton" }, data: { repostsEnabled: true, repostAfterDays: 21, repostMaxRounds: 3 } });
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: propertyIds.map((id) => `social-repost-publish:${id}:1`) } } });
  await prisma.propertySocialRepost.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyPhotoPost.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await prisma.$disconnect();
});

describe("повторный показ: застрявшие SCHEDULED и круг, упавший целиком", () => {
  it("объект продан, пока круг ждал слота, — строки SCHEDULED закрываются с причиной", async () => {
    const p = await makeProperty("SOLD");
    await rows(p.id, "SCHEDULED");
    await socialRepostPublishJob.run({ propertyId: p.id, round: 1 });
    expect(await prisma.propertySocialRepost.count({ where: { propertyId: p.id, status: "SCHEDULED" } })).toBe(0);
  });

  it("задание сдалось — строки SCHEDULED круга закрываются", async () => {
    const p = await makeProperty("AVAILABLE");
    await rows(p.id, "SCHEDULED");
    await socialRepostPublishJob.onGiveUp({ propertyId: p.id, round: 1 });
    expect(await prisma.propertySocialRepost.count({ where: { propertyId: p.id, status: "SCHEDULED" } })).toBe(0);
  });

  it("круг упал целиком только что — часовой тик не заводит его заново", async () => {
    const p = await makeProperty("AVAILABLE");
    await rows(p.id, "FAILED");
    await scheduleRepostsTick();
    expect(await prisma.propertySocialRepost.count({ where: { propertyId: p.id, status: "SCHEDULED" } })).toBe(0);
  });
});
