import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * GET /properties/map — три поломки карты объектов (24.09.2026, Dan: «16
 * известных поломок карты все закончи и исправь»):
 *
 *  1. описание места (`describePlace`) перечитывало справочники на КАЖДЫЙ
 *     объект — 1500-2400 запросов на открытие карты, и один отказ ронял всю
 *     карту в 500;
 *  2. объект, который агент попросил удалить, пропадал у него из каталога, но
 *     оставался на карте;
 *  3. объекты без точки входили в счёт и «от …» кружков-кластеров, хотя
 *     клиент их не рисует.
 */

const request = (await import("supertest")).default;
const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { describePlace, loadPlaceContext } = await import("../src/lib/landmarkPick.js");

const runId = Date.now();
const tail = String(runId).slice(-6);
const password = "testpass123";
const sourcePrefix = `test-map-route-${runId}`;

// Точка в Душанбе, в стороне от точек других тестов ориентиров
// (landmark-prominence.test.ts берёт 38.4911, 68.9123).
const POINT = { lat: 38.5733, lng: 68.8021 };
const BAZAR = { lat: POINT.lat + 0.0036, lng: POINT.lng }; // ~400 м
// Окраина без ориентиров: строка держится на улице, найденной расширением
// радиуса (500 → 1500 → 3000 м). Справочник улиц в тестовой базе пуст —
// заводим свои, иначе ветка улиц не проверяется вовсе.
const OUTSKIRT = { lat: 38.4702, lng: 68.6891 };

let districtId = "";
const agentIds: string[] = [];
const propertyIds: string[] = [];
let adminToken = "";
let agentToken = "";
let otherAgentToken = "";
let agentId = "";

async function makeAgent(n: number, role: "ADMIN" | "AGENT") {
  const phone = `+992368${n}${tail}`;
  await prisma.agent.deleteMany({ where: { phone } });
  const agent = await prisma.agent.create({
    data: { fullName: `Карта ${n} ${runId}`, phone, role, passwordHash: await bcrypt.hash(password, 10) },
  });
  agentIds.push(agent.id);
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return { id: agent.id, token: res.body.accessToken as string };
}

async function makeProperty(data: {
  price: number;
  lat?: number;
  lng?: number;
  status?: "AVAILABLE" | "SOLD" | "WITHDRAWN";
}) {
  const property = await prisma.property.create({
    data: {
      title: `Объект карты ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: data.price,
      currency: "TJS",
      districtId,
      address: `Тест карты ${runId}`,
      condition: "GOOD",
      status: data.status ?? "AVAILABLE",
      lat: data.lat ?? null,
      lng: data.lng ?? null,
    },
  });
  propertyIds.push(property.id);
  return property;
}

function getMap(token: string) {
  return request(app).get(`/api/v1/properties/map?districtId=${districtId}`).set("Authorization", `Bearer ${token}`);
}

let pointed: { id: string } = { id: "" };
let pointless: { id: string } = { id: "" };

beforeAll(async () => {
  districtId = (
    await prisma.district.create({ data: { name: `Карта-объектов-${runId}`, lat: POINT.lat, lng: POINT.lng } })
  ).id;
  await prisma.landmark.create({
    data: { sourceId: `${sourcePrefix}-bazar`, name: `Бозори карта ${runId}`, category: "Базар", lat: BAZAR.lat, lng: BAZAR.lng },
  });
  // Выключенный ориентир ближе и «важнее» — не должен попасть ни в один путь.
  await prisma.landmark.create({
    data: {
      sourceId: `${sourcePrefix}-off`,
      name: `Выключенный карта ${runId}`,
      category: "Аэропорт",
      weight: 100,
      enabled: false,
      lat: POINT.lat + 0.0005,
      lng: POINT.lng,
    },
  });
  await prisma.street.createMany({
    data: [
      { sourceId: `${sourcePrefix}-s1`, name: `улица Карты ${runId}`, kind: "street", lat: OUTSKIRT.lat + 0.009, lng: OUTSKIRT.lng },
      { sourceId: `${sourcePrefix}-s2`, name: `проспект Карты ${runId}`, kind: "street", lat: OUTSKIRT.lat + 0.03, lng: OUTSKIRT.lng },
    ],
  });
  adminToken = (await makeAgent(1, "ADMIN")).token;
  const agent = await makeAgent(2, "AGENT");
  agentId = agent.id;
  agentToken = agent.token;
  otherAgentToken = (await makeAgent(3, "AGENT")).token;

  pointed = await makeProperty({ price: 500_000, lat: POINT.lat, lng: POINT.lng });
  // Без точки и заметно дешевле — раньше именно он давал кластеру «от 100 000».
  pointless = await makeProperty({ price: 100_000 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.propertyDeleteRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.landmark.deleteMany({ where: { sourceId: { startsWith: sourcePrefix } } });
  await prisma.street.deleteMany({ where: { sourceId: { startsWith: sourcePrefix } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Карта объектов: описание места", () => {
  it("строка та же, что у describePlace, а справочники читаются один раз на запрос", async () => {
    const landmarkSpy = vi.spyOn(prisma.landmark, "findMany");
    const streetSpy = vi.spyOn(prisma.street, "findMany");
    const livingAreaSpy = vi.spyOn(prisma.livingArea, "findMany");

    const res = await getMap(adminToken);
    expect(res.status).toBe(200);

    // Раньше — по вызову на каждый объект окна (до 300) и до четырёх на
    // улицы; теперь по одному на весь запрос, сколько бы объектов ни было.
    expect(landmarkSpy).toHaveBeenCalledTimes(1);
    expect(streetSpy).toHaveBeenCalledTimes(1);
    expect(livingAreaSpy).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();

    const item = res.body.properties.find((p: { id: string }) => p.id === pointed.id);
    const expected = await describePlace(POINT.lat, POINT.lng);
    expect(item.placeDescription).toBe(expected.text);
    expect(item.placeDescription).toContain(`Бозори карта ${runId}`);
  });

  it("из заранее загруженных справочников — та же строка, что из базы (ориентир, улица, одна область)", async () => {
    const ctx = await loadPlaceContext();
    const points = [
      POINT,
      OUTSKIRT,
      { lat: OUTSKIRT.lat + 0.036, lng: OUTSKIRT.lng }, // ~670 м до второй улицы
      { lat: 38.5598, lng: 68.787 },
      { lat: 38.6081, lng: 68.8452 },
    ];
    for (const pt of points) {
      const fromDb = await describePlace(pt.lat, pt.lng);
      const fromCtx = await describePlace(pt.lat, pt.lng, ctx);
      expect(fromCtx).toEqual(fromDb);
    }
    // Сами ветки действительно отработали, а не совпали пустыми строками.
    expect((await describePlace(POINT.lat, POINT.lng, ctx)).landmark?.name).toBe(`Бозори карта ${runId}`);
    expect((await describePlace(OUTSKIRT.lat, OUTSKIRT.lng, ctx)).text).toContain(`улица Карты ${runId}`);
    expect((await describePlace(OUTSKIRT.lat + 0.036, OUTSKIRT.lng, ctx)).text).toContain(`проспект Карты ${runId}`);
  });

  it("справочник не прочитался — карта открывается, описание пустое", async () => {
    vi.spyOn(prisma.landmark, "findMany").mockRejectedValueOnce(new Error("тест: справочник недоступен"));

    const res = await getMap(adminToken);
    expect(res.status).toBe(200);
    const item = res.body.properties.find((p: { id: string }) => p.id === pointed.id);
    expect(item).toBeTruthy();
    expect(item.placeDescription).toBe("");
  });
});

describe("Карта объектов: заявка на удаление", () => {
  it("прячет объект только у автора заявки, как каталог", async () => {
    const property = await makeProperty({ price: 300_000, lat: POINT.lat, lng: POINT.lng });
    await prisma.propertyDeleteRequest.create({
      data: { propertyId: property.id, requestedById: agentId, reason: "TEST_CARD", status: "PENDING" },
    });

    const ids = (res: { body: { properties: { id: string }[] } }) => res.body.properties.map((p) => p.id);

    const own = await getMap(agentToken);
    expect(own.status).toBe(200);
    expect(ids(own)).not.toContain(property.id);
    expect(ids(own)).toContain(pointed.id);

    const other = await getMap(otherAgentToken);
    expect(other.status).toBe(200);
    expect(ids(other)).toContain(property.id);

    const admin = await getMap(adminToken);
    expect(ids(admin)).toContain(property.id);

    // Тот же ответ, что у каталога, — правило одно.
    const catalogue = await request(app)
      .get(`/api/v1/properties?districtId=${districtId}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(catalogue.status).toBe(200);
    const catalogueIds = (catalogue.body.items as { id: string }[]).map((p: { id: string }) => p.id);
    expect(catalogueIds).not.toContain(property.id);

    await prisma.propertyDeleteRequest.deleteMany({ where: { propertyId: property.id } });
    await prisma.property.delete({ where: { id: property.id } });
    propertyIds.splice(propertyIds.indexOf(property.id), 1);
  });
});

describe("Карта объектов: кластеры и объекты без точки", () => {
  it("кластер считает только нарисованные объекты, остальные — в withoutPoint", async () => {
    const res = await getMap(adminToken);
    expect(res.status).toBe(200);

    expect(res.body.withoutPoint).toBe(1);
    expect(res.body.total).toBe(2);
    // Объект без точки по-прежнему в выдаче (клиент его просто не рисует).
    expect(res.body.properties.map((p: { id: string }) => p.id)).toContain(pointless.id);

    const clusters = res.body.clusters as { count: number; minPrice: number }[];
    expect(clusters.reduce((sum, c) => sum + c.count, 0)).toBe(1);
    expect(Math.min(...clusters.map((c) => c.minPrice))).toBe(500_000);
  });
});

describe("Карта объектов: ступени цены и проданные (25.09.2026)", () => {
  it("ступени цвета считаются только по объектам с точкой", async () => {
    const res = await getMap(adminToken);
    expect(res.status).toBe(200);
    // Нарисован один объект: 500 000 / 50 м² = 10 000 за метр. Объект без точки
    // (2 000 за метр) раньше опускал нижнюю ступень до себя.
    expect(res.body.priceScale).toEqual({ low: 10_000, high: 10_000 });
  });

  it("проданные и снятые не на карте, пока статус не спросили прямо", async () => {
    const sold = await makeProperty({ price: 200_000, lat: POINT.lat, lng: POINT.lng, status: "SOLD" });
    const withdrawn = await makeProperty({ price: 250_000, lat: POINT.lat, lng: POINT.lng, status: "WITHDRAWN" });
    const ids = (res: { body: { properties: { id: string }[] } }) => res.body.properties.map((p) => p.id);

    const plain = await getMap(adminToken);
    expect(plain.status).toBe(200);
    expect(ids(plain)).not.toContain(sold.id);
    expect(ids(plain)).not.toContain(withdrawn.id);
    expect(ids(plain)).toContain(pointed.id);
    expect(plain.body.total).toBe(2);

    const asked = await request(app)
      .get(`/api/v1/properties/map?districtId=${districtId}&status=SOLD`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(asked.status).toBe(200);
    expect(ids(asked)).toEqual([sold.id]);

    await prisma.property.deleteMany({ where: { id: { in: [sold.id, withdrawn.id] } } });
    propertyIds.splice(propertyIds.indexOf(sold.id), 1);
    propertyIds.splice(propertyIds.indexOf(withdrawn.id), 1);
  });
});
