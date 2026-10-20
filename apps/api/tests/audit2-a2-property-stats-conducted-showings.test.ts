import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { dushanbeDayStartDaysAgo, loadHealthBatch, loadPropertyStats } from "../src/lib/propertyStats.js";

/**
 * APROP02 (аудит 04.10.2026): воронка «Пришли на показ» и светофор объекта считали
 * любую запись SHOWING, в том числе назначенную на будущий день и отменённую
 * (declinedAt). Единое определение проведённого показа живёт в
 * lib/conductedShowing.ts. Остальные сигналы (три контакта, просмотры, фото,
 * площадка) выставлены так, чтобы единственной проблемой светофора оставалось
 * «Пишут, но не доходят до показа».
 */
const runId = Date.now();
let districtId = "";
let agentId = "";
let propertyId = "";
const clientIds: string[] = [];
const DAY = 24 * 60 * 60 * 1000;

async function makeClient(i: number) {
  const c = await prisma.client.create({
    data: { fullName: `Клиент показа ${i} ${runId}`, phone: `+99291${i}${runId}`, source: "PHONE_CALL", assignedAgentId: agentId },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  agentId = (await prisma.agent.create({ data: { fullName: `Агент статистики ${runId}`, phone: `+992922${String(runId).slice(-8)}`, role: "AGENT", passwordHash: "x" } })).id;
  districtId = (await prisma.district.create({ data: { name: `Район статистики показов ${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект статистики ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 8",
        condition: "GOOD",
        status: "AVAILABLE",
        stageEnteredAt: new Date(Date.now() - 20 * DAY),
        publishedChannels: ["INSTAGRAM"],
        intakeAgentId: agentId,
        createdById: agentId,
      },
    })
  ).id;
  await prisma.propertyPhoto.createMany({
    data: Array.from({ length: 6 }, (_, i) => ({ propertyId, url: `/uploads/s${i}.jpg`, thumbUrl: `/uploads/st${i}.jpg`, order: i })),
  });
  // Просмотры сайта, чтобы не загорался «мало смотрят».
  await prisma.sitePropertyDay.create({ data: { propertyId, day: dushanbeDayStartDaysAgo(0, new Date()), views: 20, visitors: 15 } });
  // Три разных клиента написали по объекту.
  for (let i = 0; i < 3; i++) {
    const c = await makeClient(i);
    await prisma.interaction.create({ data: { clientId: c.id, agentId, propertyId, type: "CALL", notes: "Интерес к объекту" } });
  }
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.sitePropertyDay.deleteMany({ where: { propertyId } });
  await prisma.propertyPhoto.deleteMany({ where: { propertyId } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

const showingStep = async () => (await loadPropertyStats(propertyId))!.funnel.find((s) => s.key === "showing")!;

describe("воронка и светофор: проведённые показы (APROP02)", () => {
  it("назначенный на будущее и отменённый показы не считаются: «Пришли на показ» 0, подсказка «не доходят до показа»", async () => {
    const [c0, c1] = [clientIds[0], clientIds[1]];
    await prisma.interaction.create({
      data: { clientId: c0, agentId, propertyId, type: "SHOWING", notes: "Назначен", nextActionDate: new Date(Date.now() + DAY) },
    });
    await prisma.interaction.create({
      data: { clientId: c1, agentId, propertyId, type: "SHOWING", notes: "Отменён", declinedAt: new Date(), nextActionDate: new Date(Date.now() - DAY) },
    });

    expect((await showingStep()).count).toBe(0);
    const stats = (await loadPropertyStats(propertyId))!;
    expect(stats.health.headline).toBe("Пишут, но не доходят до показа");
    const batch = (await loadHealthBatch([propertyId])).get(propertyId)!;
    expect(batch.headline).toBe("Пишут, но не доходят до показа");
  });

  it("проведённый показ (completedAt) засчитывается и гасит подсказку", async () => {
    await prisma.interaction.create({
      data: { clientId: clientIds[2], agentId, propertyId, type: "SHOWING", notes: "Состоялся", completedAt: new Date(), nextActionDate: new Date(Date.now() - DAY) },
    });
    expect((await showingStep()).count).toBe(1);
    const stats = (await loadPropertyStats(propertyId))!;
    expect(stats.health.headline).not.toBe("Пишут, но не доходят до показа");
    const batch = (await loadHealthBatch([propertyId])).get(propertyId)!;
    expect(batch.headline).not.toBe("Пишут, но не доходят до показа");
  });
});
