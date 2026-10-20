import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * ПОКАЗ ПО ОБЪЕКТУ ИЗ КОРЗИНЫ СНИМАЕТСЯ (аудит 23.09.2026, №46).
 *
 * Объект убрали в Корзину — назначенный показ оставался в календаре: клиенту
 * уходило подтверждение, агенту — «Итог показа» о встрече, которой не будет.
 */

const { prisma } = await import("../src/db.js");
const { trashProperty } = await import("../src/lib/trashProperty.js");
const { COUNTED_SHOWING_WHERE } = await import("../src/lib/tasks.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
let agentId = "";
let districtId = "";
let propertyId = "";
let clientId = "";
let showingId = "";
let pastShowingId = "";

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({ data: { fullName: `Агент показа ${runId}`, phone: `+99299${tail}`, role: "AGENT", passwordHash: "x" } })
  ).id;
  districtId = (await prisma.district.create({ data: { name: `Район показа ${runId}` } })).id;
  await prisma.client.deleteMany({ where: { phone: `+99290${tail}` } });
  clientId = (
    await prisma.client.create({
      data: { fullName: `Покупатель ${runId}`, phone: `+99290${tail}`, source: "INSTAGRAM", assignedAgentId: agentId, acceptedAt: new Date() },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект показа ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая показа, 1",
        condition: "GOOD",
        status: "AVAILABLE",
        assignedAgentId: agentId,
      },
    })
  ).id;
  showingId = (
    await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        propertyId,
        type: "SHOWING",
        notes: "Показ",
        nextAction: "Показ",
        nextActionDate: new Date(Date.now() + 86_400_000),
      },
    })
  ).id;
  // Прошедший, уже проведённый показ — история, её трогать нельзя.
  pastShowingId = (
    await prisma.interaction.create({
      data: { clientId, agentId, propertyId, type: "SHOWING", notes: "Был показ", completedAt: new Date() },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("Объект убрали в Корзину", () => {
  it("назначенный показ снят с календаря и считается отменённым", async () => {
    const result = await trashProperty(propertyId, agentId);
    expect(result.ok).toBe(true);

    const showing = await prisma.interaction.findUniqueOrThrow({ where: { id: showingId } });
    expect(showing.nextAction).toBeNull();
    expect(showing.declinedAt).not.toBeNull();
    expect(showing.notes).toContain("Корзину");
    const counted = await prisma.interaction.count({ where: { id: showingId, ...COUNTED_SHOWING_WHERE } });
    expect(counted).toBe(0);
  });

  it("проведённый показ остаётся в истории как был", async () => {
    const past = await prisma.interaction.findUniqueOrThrow({ where: { id: pastShowingId } });
    expect(past.declinedAt).toBeNull();
    expect(past.notes).toBe("Был показ");
  });
});
