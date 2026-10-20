import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "./helpers/waitFor.js";
import { prisma } from "../src/db.js";
import { refreshPropertyStatus } from "../src/lib/propertyAutoStatus.js";
import { publishPropertyPhotoPost } from "../src/lib/photoPosts.js";
import { photoPostPublishJob } from "../src/jobs/photoPostPublish.js";

/**
 * «Проданный объект» (аудит 02.10.2026): объект ушёл с продажи НЕ через PATCH
 * статуса (ночная сверка по закрытой сделке) — посты, повторы и будущие показы
 * всё равно гасятся; отложенный фото-пост не выходит у проданного объекта.
 */

const runId = Date.now();
let districtId: string;
let agentId: string;
let clientId: string;
const propertyIds: string[] = [];
const clientIds: string[] = [];

async function makeProperty(status: "AVAILABLE" | "SOLD" | "WITHDRAWN" = "AVAILABLE") {
  const p = await prisma.property.create({
    data: {
      title: `Продан-тест ${propertyIds.length}-${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 50000,
      currency: "TJS",
      districtId,
      address: `Тестовая, ${60 + propertyIds.length}`,
      condition: "GOOD",
      status,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function seedScheduled(propertyId: string) {
  const at = new Date(Date.now() + 6 * 3_600_000);
  await prisma.propertyPhotoPost.createMany({
    data: ["INSTAGRAM", "FACEBOOK", "TELEGRAM"].map((channel) => ({ propertyId, channel, status: "SCHEDULED", scheduledAt: at })),
  });
  await prisma.propertySocialRepost.create({
    data: { propertyId, round: 1, hook: "x", channel: "TELEGRAM", status: "SCHEDULED", scheduledAt: at },
  });
}

async function makeShowing(propertyId: string, nextActionDate: Date) {
  return prisma.interaction.create({
    data: {
      clientId,
      agentId,
      propertyId,
      type: "SHOWING",
      notes: "показ",
      nextAction: "показ",
      nextActionDate,
    },
  });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Продан-район-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Продан Агент ${runId}`, phone: `+992930${String(runId).slice(-8)}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  const c = await prisma.client.create({
    data: { fullName: `Продан-клиент ${runId}`, phone: `+992931${String(runId).slice(-8)}`, source: "WEBSITE", assignedAgentId: agentId, acceptedAt: new Date() },
  });
  clientId = c.id;
  clientIds.push(c.id);
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.deal.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("ночная сверка: объект стал проданным по закрытой сделке", () => {
  it("ждущие слоты постов и повторов гасятся, будущий показ снят, прошедший остался", async () => {
    const property = await makeProperty("AVAILABLE");
    await seedScheduled(property.id);
    const future = await makeShowing(property.id, new Date(Date.now() + 2 * 86_400_000));
    const past = await makeShowing(property.id, new Date(Date.now() - 3_600_000));
    await prisma.deal.create({
      data: { clientId, propertyId: property.id, agentId, stage: "COMPLETED", closedAt: new Date() },
    });

    expect(await refreshPropertyStatus(property.id)).toBe("SOLD");

    await waitFor(
      async () => (await prisma.propertyPhotoPost.count({ where: { propertyId: property.id, status: "REMOVED" } })) === 3,
      { label: "фото-посты сняты" }
    );
    await waitFor(
      async () => (await prisma.propertySocialRepost.count({ where: { propertyId: property.id, status: "REMOVED" } })) === 1,
      { label: "повтор снят" }
    );
    const futureAfter = await waitFor(async () => {
      const row = await prisma.interaction.findUnique({ where: { id: future.id } });
      return row?.nextAction === null ? row : null;
    });
    expect(futureAfter.declinedAt).not.toBeNull();
    expect(futureAfter.notes).toContain("продан");
    const pastAfter = await prisma.interaction.findUnique({ where: { id: past.id } });
    expect(pastAfter?.nextAction).toBe("показ");
    expect(pastAfter?.declinedAt).toBeNull();
  });
});

describe("отложенный фото-пост у объекта, ушедшего с продажи", () => {
  it("publishPropertyPhotoPost отказывает и гасит слоты (даже с force)", async () => {
    const property = await makeProperty("SOLD");
    await seedScheduled(property.id);
    const summary = await publishPropertyPhotoPost(property.id, { force: true });
    expect(summary.ok).toBe(false);
    expect(summary.reason).toContain("не в продаже");
    expect(await prisma.propertyPhotoPost.count({ where: { propertyId: property.id, status: "SCHEDULED" } })).toBe(0);
    expect(await prisma.propertyPhotoPost.count({ where: { propertyId: property.id, status: "PUBLISHED" } })).toBe(0);
  });

  it("задание публикации у снятого объекта выходит тихо и гасит слоты", async () => {
    const property = await makeProperty("WITHDRAWN");
    await seedScheduled(property.id);
    await photoPostPublishJob.run({ propertyId: property.id } as never, {} as never);
    expect(await prisma.propertyPhotoPost.count({ where: { propertyId: property.id, status: "SCHEDULED" } })).toBe(0);
  });
});
