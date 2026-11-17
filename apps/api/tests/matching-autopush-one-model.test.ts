import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { findMatchingClients } from "../src/routes/matching.js";
import { notifyWaitingBuyersOfNewProperty } from "../src/lib/propertyMatchFilter.js";

/**
 * АВТОПУШ ⊆ ЕДИНАЯ МОДЕЛЬ (ревью подбора 2.0, 10.11.2026). У автопуша новым
 * объектам была своя копия правила: клиент с ориентиром без района получал пуш о
 * каждом объекте, участок уходил просившему комнаты, «не первый этаж» из заметок
 * не читался. Сторож — на наборе пар, а не по именам функций: кого уведомил
 * автопуш, тот обязан быть в «Кому подходит», а заведомо неподходящие — нет.
 */
const runId = Date.now();
const suffix = runId.toString().slice(-6);
let districtId: string;
let agentId: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];

async function makeClient(name: string, data: Record<string, unknown>) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name}-${runId}`, phone: `+99292${suffix}${clientIds.length}`, status: "CONTACTED", kind: "BUYER",
      source: "WEBSITE", lastContactAt: new Date(), assignedAgentId: agentId, currency: "TJS", budgetMax: 600_000, ...data,
    } as never,
  });
  clientIds.push(c.id);
  return c;
}
async function makeProperty(data: Record<string, unknown>) {
  const p = await prisma.property.create({
    data: {
      title: `Автопуш ${runId} ${propertyIds.length}`, type: "APARTMENT", areaSqm: 70, rooms: 2, floor: 1, totalFloors: 9,
      price: 550_000, currency: "TJS", districtId, address: "Тестовая, 3", condition: "GOOD", status: "AVAILABLE",
      lat: 38.55, lng: 68.78, ...data,
    } as never,
  });
  propertyIds.push(p.id);
  return p;
}
const notified = async (propertyId: string) => new Set((await prisma.interaction.findMany({
  where: { propertyId, type: "SYSTEM", matchNotifiedPriceTjs: { not: null } }, select: { clientId: true },
})).map((row) => row.clientId));

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Автопуш-${runId}` } })).id;
  agentId = (await prisma.agent.create({ data: {
    fullName: `Агент автопуша ${runId}`, phone: `+99293${suffix}9`, role: "AGENT", passwordHash: await bcrypt.hash("testpass123", 4),
  } })).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("автопуш новым объектам — то же правило, что «Кому подходит»", () => {
  it("уведомляет только тех, кому объект подходит по единой модели", async () => {
    const fits = await makeClient("Подходит", { desiredDistrictId: districtId, desiredRooms: 2 });
    // Ориентир без района, объект в 10 км: раньше автопуш звал его о каждом объекте.
    const farPlace = await makeClient("Ориентир-далеко", { desiredRooms: 2,
      desiredPlaces: { create: [{ lat: 38.64, lng: 68.78, radiusM: 1000, label: "Далеко" }] } });
    // «Не первый этаж» в заметках, объект на первом.
    const notFirst = await makeClient("Не-первый", { desiredDistrictId: districtId, desiredRooms: 2, requirementsNotes: "Только не первый этаж" });
    const property = await makeProperty({});
    const land = await makeProperty({ type: "LAND", rooms: null, floor: null, totalFloors: null, areaSqm: 600 });

    await notifyWaitingBuyersOfNewProperty(property);
    await notifyWaitingBuyersOfNewProperty(land);

    const pushed = await notified(property.id);
    const matching = new Set((await findMatchingClients(property.id, 100)).items.map((c) => c.id));
    for (const id of pushed) expect(matching.has(id), `автопуш вне «Кому подходит»: ${id}`).toBe(true);
    expect(pushed.has(fits.id)).toBe(true);
    expect(pushed.has(farPlace.id)).toBe(false);
    expect(pushed.has(notFirst.id)).toBe(false);
    // Участок просившему 2 комнаты не уходит.
    expect((await notified(land.id)).has(fits.id)).toBe(false);
  });
});
