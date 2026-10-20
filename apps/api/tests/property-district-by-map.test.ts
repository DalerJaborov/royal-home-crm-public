import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * РАЙОН ОБЪЕКТА ОПРЕДЕЛЯЕТ КАРТА (20.09.2026, разбор владельца).
 *
 * Живой случай: карточка «Шохмансур, улица Дехоти, 8» — улица Дехоти лежит в
 * Фирдавси и по справочнику улиц, и по границе района, но в карточке стоял
 * Шохмансур. Подсказка мастера выбирала район сравнением точки с четырьмя
 * вбитыми в код «центрами» — для этой точки ближайшим оказывался чужой район, а
 * дальше никто не проверял. Неверный район уходил боту (он читает адреса наших
 * объектов как «район известен точно»), в фильтр подбора и в заголовок
 * объявления на сайте.
 *
 * Границу тесту хватает квадратной: проверяется правило «точка внутри границы
 * сильнее выбора формы», а не качество самих полигонов города.
 */

const runId = Date.now();
const password = "testpass123";

let adminToken: string;
let adminPhone: string;
let intakeAgentId: string;
let intakeAgentPhone: string;
/** Правильный район: его граница накрывает точку, его же улица названа в адресе. */
let rightDistrictId: string;
/** Район, который «выбрал агент» — соседний, границы у него нет вовсе. */
let wrongDistrictId: string;
let streetSourceId: string;
const propertyIds: string[] = [];

const POINT = { lat: 38.5334, lng: 68.7558 };
const STREET_NAME = `улица Тестдехоти ${runId}`;
/** Квадрат ~2 км вокруг точки, как отдаёт выгрузка: POLYGON((lng lat, ...)). */
const BOUNDARY =
  "POLYGON((68.74 38.52, 68.78 38.52, 68.78 38.55, 68.74 38.55, 68.74 38.52))";

beforeAll(async () => {
  rightDistrictId = (
    await prisma.district.create({
      data: { name: `Тест-район-правильный-${runId}`, boundary: BOUNDARY, lat: POINT.lat, lng: POINT.lng },
    })
  ).id;
  wrongDistrictId = (await prisma.district.create({ data: { name: `Тест-район-чужой-${runId}` } })).id;
  streetSourceId = `test-street-${runId}`;
  await prisma.street.create({
    data: {
      sourceId: streetSourceId,
      name: STREET_NAME,
      kind: "улица",
      districtId: rightDistrictId,
      lat: POINT.lat,
      lng: POINT.lng,
    },
  });

  adminPhone = `+992956${runId.toString().slice(-6)}`;
  await prisma.agent.create({
    data: {
      fullName: "Админ районов",
      phone: adminPhone,
      role: "ADMIN",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  const res = await request(app).post("/api/v1/auth/login").send({ phone: adminPhone, password });
  adminToken = res.body.accessToken as string;

  intakeAgentPhone = `+992957${runId.toString().slice(-6)}`;
  intakeAgentId = (
    await prisma.agent.create({
      data: {
        fullName: "Агент районов",
        phone: intakeAgentPhone,
        role: "AGENT",
        passwordHash: await bcrypt.hash(password, 10),
      },
    })
  ).id;
});

afterEach(async () => {
  if (propertyIds.length === 0) return;
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  propertyIds.length = 0;
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { phone: { in: [adminPhone, intakeAgentPhone] } } });
  await prisma.street.deleteMany({ where: { sourceId: streetSourceId } });
  await prisma.district.deleteMany({ where: { id: { in: [rightDistrictId, wrongDistrictId] } } });
});

function body(extra: Record<string, unknown> = {}) {
  return {
    type: "APARTMENT",
    areaSqm: 95,
    rooms: 4,
    floor: 6,
    totalFloors: 6,
    windowCount: 4,
    price: 1030000,
    currency: "TJS",
    condition: "GOOD",
    ownerContact: `+992938${runId.toString().slice(-6)}`,
    sellerName: "Продавец",
    intakeAgentId,
    districtId: wrongDistrictId,
    address: `${STREET_NAME}, 8`,
    ...extra,
  };
}

async function districtOf(id: string): Promise<string | null> {
  return (await prisma.property.findUniqueOrThrow({ where: { id }, select: { districtId: true } })).districtId;
}

describe("Район объекта определяет карта, а не выбор в форме", () => {
  it("точка внутри границы района перебивает выбранный агентом чужой район", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(body({ lat: POINT.lat, lng: POINT.lng }));
    expect(res.status).toBe(201);
    propertyIds.push(res.body.id);
    expect(await districtOf(res.body.id)).toBe(rightDistrictId);
  });

  it("без координат район берётся по названию улицы из справочника", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(body());
    expect(res.status).toBe(201);
    propertyIds.push(res.body.id);
    expect(await districtOf(res.body.id)).toBe(rightDistrictId);
  });

  it("адрес без знакомой улицы карта не трогает — остаётся выбор человека", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(body({ address: `Неизвестная улица ${runId}, 3` }));
    expect(res.status).toBe(201);
    propertyIds.push(res.body.id);
    expect(await districtOf(res.body.id)).toBe(wrongDistrictId);
  });

  it("правка адреса в карточке переставляет район", async () => {
    const created = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(body({ address: `Неизвестная улица ${runId}, 3` }));
    expect(created.status).toBe(201);
    propertyIds.push(created.body.id);
    expect(await districtOf(created.body.id)).toBe(wrongDistrictId);

    const patched = await request(app)
      .patch(`/api/v1/properties/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ address: `${STREET_NAME}, 8` });
    expect(patched.status).toBe(200);
    expect(await districtOf(created.body.id)).toBe(rightDistrictId);
  });
});
