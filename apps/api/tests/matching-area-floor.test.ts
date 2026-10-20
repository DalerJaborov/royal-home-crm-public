import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { findMatchingClients } from "../src/routes/matching.js";

/**
 * Подбор по площади и этажу — спецификация владельца от 31.07.2026.
 *
 * До 03.08 этих полей не существовало вовсе: пожелания «не первый и не последний»
 * и «хотя бы 60 квадратов» агент писал в свободные заметки, а подбор их не видел —
 * и предлагал человеку ровно то, от чего тот отказался на первом же звонке.
 */

const runId = Date.now().toString(36);
let districtId = "";
let propertyId = "";
const clientIds: string[] = [];

/** Объект: 3 комнаты, 70 м², 1-й этаж пятиэтажки. */
beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-подбор-${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект подбора ${runId}`,
        type: "APARTMENT",
        rooms: 3,
        areaSqm: 70,
        floor: 1,
        totalFloors: 5,
        price: 400000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
        status: "AVAILABLE",
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

async function makeClient(label: string, desires: Record<string, number | null>) {
  const c = await prisma.client.create({
    data: {
      fullName: `${label}-${runId}`,
      phone: `+9929${String(Date.now()).slice(-8)}${clientIds.length}`,
      status: "NEW",
      kind: "BUYER",
      source: "WEBSITE",
      desiredDistrictId: districtId,
      desiredRooms: 3,
      budgetMin: 300000,
      budgetMax: 500000,
      currency: "TJS",
      ...desires,
    },
  });
  clientIds.push(c.id);
  return c;
}

async function matches(clientId: string): Promise<boolean> {
  // 17.09.2026: findMatchingClients возвращает { items, total }, не голый массив.
  const { items } = await findMatchingClients(propertyId, 300);
  return items.some((m) => m.id === clientId);
}

describe("Этаж клиента учитывается при подборе", () => {
  it("просил не первый — первый этаж ему не предлагается", async () => {
    const client = await makeClient("этаж-от-2", { desiredFloorMin: 2 });
    expect(await matches(client.id)).toBe(false);
  });

  it("просил не выше третьего — первый этаж подходит", async () => {
    const client = await makeClient("этаж-до-3", { desiredFloorMax: 3 });
    expect(await matches(client.id)).toBe(true);
  });

  it("этажность дома выше желаемой — объект не подходит", async () => {
    // Дом пятиэтажный, клиент согласен максимум на четырёхэтажный.
    const client = await makeClient("этажность-4", { desiredTotalFloors: 4 });
    expect(await matches(client.id)).toBe(false);
  });
});

describe("Площадь клиента учитывается при подборе", () => {
  it("просил от 100 м² — объект в 70 м² не предлагается", async () => {
    const client = await makeClient("площадь-100", { desiredAreaMin: 100 });
    expect(await matches(client.id)).toBe(false);
  });

  it("просил от 75 м² — 70 проходит: допуск 10%, как у бюджета", async () => {
    // «Хотя бы 75 квадратов» и 70 — для живого человека одно и то же.
    const client = await makeClient("площадь-75", { desiredAreaMin: 75 });
    expect(await matches(client.id)).toBe(true);
  });

  it("пожеланий нет — подбор работает как раньше", async () => {
    const client = await makeClient("без-пожеланий", {});
    expect(await matches(client.id)).toBe(true);
  });
});
