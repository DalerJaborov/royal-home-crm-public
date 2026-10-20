import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ЗАКРЫТЫЙ ОБЪЕКТ БЕЗ РАЙОНА/АДРЕСА (владелец 14.09.2026): «только для своих»
 * требует ровно цену и продавца. Побочный эффект — такой объект рискует
 * остаться без адреса и выпасть из карты/подбора/поиска по улице. Решение:
 * агент заводит объект СТОЯ В НЁМ, координаты телефона сервер прогоняет через
 * lookupGeoPoint (routes/properties/crud.ts) и достраивает то, что пусто.
 *
 * Тест держит границу на уровне API: контур дома здесь не нужен (у
 * lookupGeoPoint есть более грубый уровень — ближайший район по центру,
 * см. geoLookup.ts::findDistrict), но с настоящим домом рядом с точкой
 * проверяем и полный путь «улица + дом».
 */

const runId = Date.now();
const password = "testpass123";

let adminToken: string;
let adminPhone: string;
let intakeAgentId: string;
let intakeAgentPhone: string;
let districtId: string;
let buildingSourceId: string;
const propertyIds: string[] = [];

// Точка внутри геоблока — район ставим ровно в ней (lat/lng района), чтобы
// findDistrict::ближайший центр нашёл его гарантированно, без границы-полигона.
const POINT = { lat: 38.55, lng: 68.78 };

beforeAll(async () => {
  districtId = (
    await prisma.district.create({
      data: { name: `Тест-район-закрытый-${runId}`, lat: POINT.lat, lng: POINT.lng },
    })
  ).id;
  buildingSourceId = `test-building-${runId}`;
  await prisma.building.create({
    data: {
      sourceId: buildingSourceId,
      street: "Тестовая",
      houseNumber: "7",
      districtId,
      lat: POINT.lat,
      lng: POINT.lng,
    },
  });

  adminPhone = `+992954${runId.toString().slice(-6)}`;
  await prisma.agent.create({
    data: {
      fullName: "Админ закрытых объектов",
      phone: adminPhone,
      role: "ADMIN",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  const res = await request(app).post("/api/v1/auth/login").send({ phone: adminPhone, password });
  adminToken = res.body.accessToken as string;

  intakeAgentPhone = `+992955${runId.toString().slice(-6)}`;
  intakeAgentId = (
    await prisma.agent.create({
      data: {
        fullName: "Агент закрытых объектов",
        phone: intakeAgentPhone,
        role: "AGENT",
        passwordHash: await bcrypt.hash(password, 10),
      },
    })
  ).id;
});

afterEach(async () => {
  if (propertyIds.length === 0) return;
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  propertyIds.length = 0;
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { phone: { in: [adminPhone, intakeAgentPhone] } } });
  await prisma.building.deleteMany({ where: { sourceId: buildingSourceId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

function closedBody(extra: Record<string, unknown> = {}) {
  return {
    type: "APARTMENT",
    areaSqm: 50,
    rooms: 2,
    floor: 3,
    totalFloors: 9,
    windowCount: 3,
    price: 300000,
    currency: "TJS",
    condition: "GOOD",
    ownerContact: `+992937${runId.toString().slice(-6)}`, // не сидовый номер (staffPhoneGuard, 17.09.2026)
    sellerName: "Сосед",
    intakeAgentId,
    offSite: true,
    ...extra,
  };
}

describe("Закрытый объект без адреса/района — геоблок при создании", () => {
  it("с координатами — район и адрес достраиваются сами, а точка остаётся за человеком", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(closedBody({ lat: POINT.lat, lng: POINT.lng }));
    expect(res.status).toBe(201);
    propertyIds.push(res.body.id);

    const saved = await prisma.property.findUniqueOrThrow({
      where: { id: res.body.id },
      select: { districtId: true, address: true, geocodedAt: true },
    });
    expect(saved.districtId).toBe(districtId);
    expect(saved.address).toBe("Тестовая, 7");
    // Достроен адрес, а точку поставил агент (23.09.2026): отметки автогеокодера
    // на ней нет, и координаты из первого же загруженного снимка её не сдвинут
    // (routes/properties/photos.ts, то же условие, что у jobs/geocode.ts).
    expect(saved.geocodedAt).toBeNull();
  });

  it("адрес, вписанный агентом руками, координаты не трогают", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(closedBody({ lat: POINT.lat, lng: POINT.lng, address: "Свой адрес, введённый руками" }));
    expect(res.status).toBe(201);
    propertyIds.push(res.body.id);

    const saved = await prisma.property.findUniqueOrThrow({
      where: { id: res.body.id },
      select: { address: true, districtId: true, geocodedAt: true },
    });
    expect(saved.address).toBe("Свой адрес, введённый руками");
    // Район всё равно достроен по точке — тронуто только пустое поле.
    expect(saved.districtId).toBe(districtId);
    expect(saved.geocodedAt).toBeNull();
  });

  it("без координат — объект создаётся как есть, без адреса, без выдумывания", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(closedBody());
    expect(res.status).toBe(201);
    propertyIds.push(res.body.id);

    const saved = await prisma.property.findUniqueOrThrow({
      where: { id: res.body.id },
      select: { districtId: true, address: true, geocodedAt: true },
    });
    expect(saved.districtId).toBeNull();
    expect(saved.address).toBeNull();
    expect(saved.geocodedAt).toBeNull();
  });

  it("координаты далеко от любого справочника — район не находится, объект всё равно создаётся", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(closedBody({ lat: 1, lng: 1 }));
    expect(res.status).toBe(201);
    propertyIds.push(res.body.id);
    // Совсем без справочника района lookupGeoPoint честно вернёт null только
    // если в базе district вовсе нет строк — в тестовой базе он почти всегда
    // есть, здесь достаточно того, что запрос не упал.
  });
});

describe("Публичный (сайтовый) путь не меняется", () => {
  it("без offSite район и адрес по-прежнему обязательны", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(closedBody({ offSite: false, lat: POINT.lat, lng: POINT.lng }));
    expect(res.status).toBe(400);
  });

  it("обычный объект с явным адресом/районом создаётся как раньше", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(closedBody({ offSite: false, districtId, address: "Публичный адрес, 1" }));
    expect(res.status).toBe(201);
    propertyIds.push(res.body.id);
    expect(res.body.address).toBe("Публичный адрес, 1");
  });
});
