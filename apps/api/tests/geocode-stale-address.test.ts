import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { geocodeJob } from "../src/jobs/geocode.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * АДРЕС ПОМЕНЯЛИ — ТОЧКА НЕ ОСТАЁТСЯ СТАРОЙ (24.09.2026, «16 известных поломок
 * карты»).
 *
 * 1. Задание геокодера держит ключ `geocode:{id}`, пока ждёт или идёт по лесенке
 *    повторов, и вторая постановка в это время — пустая операция. Раньше адрес
 *    лежал в payload первой постановки, и задание геокодировало СТАРЫЙ адрес.
 *    Теперь адрес читается из базы в момент исполнения.
 * 2. Смена адреса оставляла на карте точку прежнего адреса; не нашёлся новый —
 *    навсегда и молча. Теперь автоточка стирается вместе со сменой адреса, а
 *    «не нашлось» пишется в журнал.
 *
 * Nominatim подменён: отвечает по тому, что спросили, и запоминает вопросы.
 */

const runId = Date.now();
const password = "testpass123";
const NOMINATIM_POINT = { lat: 38.5712, lng: 68.7911 };

let districtId: string;
let adminToken: string;
let adminPhone: string;
let agentId: string;
let intakeAgentId: string;
let intakeAgentPhone: string;
const propertyIds: string[] = [];
/** Что спрашивали у Nominatim (строка q) и что ему отвечать. */
const nominatimQueries: string[] = [];
let nominatimAnswer: { lat: string; lon: string }[] = [];

const realFetch = globalThis.fetch;

beforeAll(async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("nominatim.openstreetmap.org")) return realFetch(input, init);
    nominatimQueries.push(new URL(url).searchParams.get("q") ?? "");
    return new Response(JSON.stringify(nominatimAnswer), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  districtId = (await prisma.district.create({ data: { name: `Тест-район-адрес-${runId}` } })).id;
  adminPhone = `+992958${runId.toString().slice(-6)}`;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Админ адреса", phone: adminPhone, role: "ADMIN", passwordHash: await bcrypt.hash(password, 10) },
    })
  ).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: adminPhone, password });
  adminToken = res.body.accessToken as string;
  intakeAgentPhone = `+992959${runId.toString().slice(-6)}`;
  intakeAgentId = (
    await prisma.agent.create({
      data: { fullName: "Агент адреса", phone: intakeAgentPhone, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) },
    })
  ).id;
});

afterEach(() => {
  nominatimQueries.length = 0;
  nominatimAnswer = [];
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: propertyIds.map((id) => `geocode:${id}`) } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, intakeAgentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

async function makeProperty(data: { address: string; lat?: number; lng?: number; geocodedAt?: Date | null }) {
  const p = await prisma.property.create({
    data: {
      title: `Объект адреса ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      condition: "GOOD",
      status: "AVAILABLE",
      districtId,
      intakeAgentId: agentId,
      createdById: agentId,
      ...data,
    },
  });
  propertyIds.push(p.id);
  return p;
}

describe("Задание геокодера читает адрес из базы, а не из постановки", () => {
  it("адрес поменяли, пока задание ждало, — геокодируется НОВЫЙ адрес", async () => {
    const property = await makeProperty({ address: `Старая улица ${runId}, 1` });
    nominatimAnswer = [{ lat: String(NOMINATIM_POINT.lat), lon: String(NOMINATIM_POINT.lng) }];
    // Как в жизни: первая постановка унесла старый адрес в payload, вторая отбита ключом.
    await prisma.property.update({ where: { id: property.id }, data: { address: `Новая улица ${runId}, 2` } });

    await geocodeJob.run({ propertyId: property.id, address: `Старая улица ${runId}, 1`, districtName: "Любой" });

    expect(nominatimQueries).toHaveLength(1);
    expect(nominatimQueries[0]).toContain(`Новая улица ${runId}, 2`);
    expect(nominatimQueries[0]).not.toContain("Старая улица");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(Number(after.lat)).toBeCloseTo(NOMINATIM_POINT.lat, 4);
    expect(after.geocodedAt).not.toBeNull();
  });

  it("новая постановка несёт только id объекта", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "APARTMENT",
        areaSqm: 50,
        rooms: 2,
        floor: 3,
        totalFloors: 9,
        windowCount: 3,
        price: 300000,
        currency: "TJS",
        districtId,
        address: `Постановочная ${runId}, 5`,
        condition: "GOOD",
        ownerContact: `+992939${runId.toString().slice(-6)}`,
        intakeAgentId,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    propertyIds.push(res.body.id);
    // Задание ставится «в отрыве» (geocodeInBackground → void enqueue) — ждём запись, а не читаем сразу.
    const job = await waitFor(
      () => prisma.backgroundJob.findUnique({ where: { dedupeKey: `geocode:${res.body.id}` } }),
      { timeoutMs: 10_000, label: "задание геокодера после создания объекта" },
    );
    expect(job?.payload).toEqual({ propertyId: res.body.id });
  });

  it("объект удалён — Nominatim не спрашиваем", async () => {
    const property = await makeProperty({ address: `Удалённая ${runId}, 3` });
    await prisma.property.update({ where: { id: property.id }, data: { deletedAt: new Date() } });
    await geocodeJob.run({ propertyId: property.id });
    expect(nominatimQueries).toHaveLength(0);
  });

  it("ручной пин — Nominatim не спрашиваем и точку не трогаем", async () => {
    const property = await makeProperty({ address: `Ручная ${runId}, 4`, lat: 38.55, lng: 68.78, geocodedAt: null });
    nominatimAnswer = [{ lat: String(NOMINATIM_POINT.lat), lon: String(NOMINATIM_POINT.lng) }];
    await geocodeJob.run({ propertyId: property.id });
    expect(nominatimQueries).toHaveLength(0);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(Number(after.lat)).toBeCloseTo(38.55, 4);
  });

  it("адрес не нашёлся — одна запись в журнале, координаты пустые", async () => {
    const property = await makeProperty({ address: `Ненаходимая ${runId}, 9` });
    nominatimAnswer = [];
    await geocodeJob.run({ propertyId: property.id });
    const logged = await prisma.errorLog.count({
      where: { source: "geocode", message: { contains: `№${property.shortId} не найден` } },
    });
    expect(logged).toBe(1);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.lat).toBeNull();
    await prisma.errorLog.deleteMany({ where: { source: "geocode", message: { contains: `№${property.shortId} не найден` } } });
  });
});

describe("Смена адреса в карточке стирает автоточку прежнего адреса", () => {
  it("точка автогеокодера — стирается сразу, до ответа задания", async () => {
    const property = await makeProperty({ address: `Прежняя ${runId}, 1`, lat: 38.56, lng: 68.77, geocodedAt: new Date() });
    const res = await request(app)
      .patch(`/api/v1/properties/${property.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ address: `Переехавшая ${runId}, 7` });
    expect(res.status).toBe(200);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.lat).toBeNull();
    expect(after.lng).toBeNull();
    expect(after.geocodedAt).toBeNull();
    // И задание на новый адрес поставлено.
    const job = await waitFor(
      () => prisma.backgroundJob.findUnique({ where: { dedupeKey: `geocode:${property.id}` } }),
      { timeoutMs: 10_000, label: "задание геокодера после смены адреса" },
    );
    expect(job).not.toBeNull();
  });

  it("ручной пин при смене адреса не стирается", async () => {
    const property = await makeProperty({ address: `Прежняя ручная ${runId}, 1`, lat: 38.56, lng: 68.77, geocodedAt: null });
    const res = await request(app)
      .patch(`/api/v1/properties/${property.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ address: `Переехавшая ручная ${runId}, 7` });
    expect(res.status).toBe(200);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(Number(after.lat)).toBeCloseTo(38.56, 4);
  });

  it("правка без смены адреса автоточку не трогает", async () => {
    const property = await makeProperty({ address: `Та же ${runId}, 1`, lat: 38.56, lng: 68.77, geocodedAt: new Date() });
    const res = await request(app)
      .patch(`/api/v1/properties/${property.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ address: `Та же ${runId}, 1`, price: 41000 });
    expect(res.status).toBe(200);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(Number(after.lat)).toBeCloseTo(38.56, 4);
  });
});
