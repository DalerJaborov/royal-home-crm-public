import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { geocodeJob } from "../src/jobs/geocode.js";
import { resetDistrictReferenceCache } from "../src/lib/propertyDistrict.js";

/**
 * РАЙОН НЕ ПЕРЕПРЫГИВАЕТ САМ (24.09.2026, «16 известных поломок карты»).
 *
 * PATCH без координат спрашивал карту по СОХРАНЁННОЙ точке на каждую правку:
 * агент правил цену — и выбранный им руками район переставлялся по старой
 * автоточке. Теперь район выводится из точки, только когда точку прислали новую
 * или когда района нет вовсе. Задание геокодера пишет район по новой точке
 * тоже только в пустое поле.
 *
 * Граница — квадрат в углу городской рамки, где нет ни настоящих районов, ни
 * квадратов соседних тестов (property-district-by-map.test.ts стоит в центре).
 */

const runId = Date.now();
const password = "testpass123";
const INSIDE = { lat: 38.41, lng: 68.91 };
const BOUNDARY = "POLYGON((68.905 38.405, 68.915 38.405, 68.915 38.415, 68.905 38.415, 68.905 38.405))";

let adminToken: string;
let adminPhone: string;
let agentId: string;
/** Район, в границу которого попадает точка. */
let mapDistrictId: string;
/** Район, выбранный агентом руками. */
let chosenDistrictId: string;
const propertyIds: string[] = [];
let nominatimAnswer: { lat: string; lon: string }[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("nominatim.openstreetmap.org")) return realFetch(input, init);
    return new Response(JSON.stringify(nominatimAnswer), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  mapDistrictId = (
    await prisma.district.create({ data: { name: `Тест-район-граница-${runId}`, boundary: BOUNDARY, lat: INSIDE.lat, lng: INSIDE.lng } })
  ).id;
  chosenDistrictId = (await prisma.district.create({ data: { name: `Тест-район-выбран-${runId}` } })).id;
  resetDistrictReferenceCache();

  adminPhone = `+992961${runId.toString().slice(-6)}`;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Админ района", phone: adminPhone, role: "ADMIN", passwordHash: await bcrypt.hash(password, 10) },
    })
  ).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: adminPhone, password });
  adminToken = res.body.accessToken as string;
});

afterEach(() => {
  nominatimAnswer = [];
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: { in: [mapDistrictId, chosenDistrictId] } } });
});

async function makeProperty(data: { districtId: string | null; lat?: number; lng?: number; geocodedAt?: Date | null }) {
  const p = await prisma.property.create({
    data: {
      title: `Объект района ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      condition: "GOOD",
      status: "AVAILABLE",
      address: `Безымянная ${runId}, ${propertyIds.length + 1}`,
      intakeAgentId: agentId,
      createdById: agentId,
      ...data,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function patch(id: string, body: Record<string, unknown>) {
  const res = await request(app).patch(`/api/v1/properties/${id}`).set("Authorization", `Bearer ${adminToken}`).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function districtOf(id: string) {
  return (await prisma.property.findUniqueOrThrow({ where: { id }, select: { districtId: true } })).districtId;
}

describe("PATCH не переставляет выбранный район по старой точке", () => {
  it("правка цены — район агента остаётся, хотя автоточка лежит в другом районе", async () => {
    const p = await makeProperty({ districtId: chosenDistrictId, ...INSIDE, geocodedAt: new Date() });
    await patch(p.id, { price: 41000 });
    expect(await districtOf(p.id)).toBe(chosenDistrictId);
  });

  it("форма прислала ту же точку вместе с правкой цены — это не новая точка, район остаётся", async () => {
    const p = await makeProperty({ districtId: chosenDistrictId, ...INSIDE, geocodedAt: null });
    await patch(p.id, { price: 42000, lat: INSIDE.lat, lng: INSIDE.lng });
    expect(await districtOf(p.id)).toBe(chosenDistrictId);
  });

  it("смена адреса без новой точки — старую точку для района не спрашиваем", async () => {
    const p = await makeProperty({ districtId: chosenDistrictId, ...INSIDE, geocodedAt: new Date() });
    await patch(p.id, { address: `Другая безымянная ${runId}, 5` });
    expect(await districtOf(p.id)).toBe(chosenDistrictId);
  });

  it("прислана НОВАЯ точка внутри границы — район по карте (прежнее правило живо)", async () => {
    const p = await makeProperty({ districtId: chosenDistrictId });
    await patch(p.id, { lat: INSIDE.lat, lng: INSIDE.lng });
    expect(await districtOf(p.id)).toBe(mapDistrictId);
  });

  it("района нет вовсе — берётся по сохранённой точке", async () => {
    const p = await makeProperty({ districtId: null, ...INSIDE, geocodedAt: new Date() });
    await patch(p.id, { price: 43000 });
    expect(await districtOf(p.id)).toBe(mapDistrictId);
  });
});

describe("Задание геокодера пишет район только в пустое поле", () => {
  it("района нет — ставит по новой точке", async () => {
    const p = await makeProperty({ districtId: null });
    nominatimAnswer = [{ lat: String(INSIDE.lat), lon: String(INSIDE.lng) }];
    await geocodeJob.run({ propertyId: p.id });
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(Number(after.lat)).toBeCloseTo(INSIDE.lat, 4);
    expect(after.districtId).toBe(mapDistrictId);
  });

  it("район выбран агентом — точку пишет, район не трогает", async () => {
    const p = await makeProperty({ districtId: chosenDistrictId });
    nominatimAnswer = [{ lat: String(INSIDE.lat), lon: String(INSIDE.lng) }];
    await geocodeJob.run({ propertyId: p.id });
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(Number(after.lat)).toBeCloseTo(INSIDE.lat, 4);
    expect(after.districtId).toBe(chosenDistrictId);
  });
});
