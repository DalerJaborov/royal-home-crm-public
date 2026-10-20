import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ТОЧКА, ПОСТАВЛЕННАЯ ЧЕЛОВЕКОМ, НЕ ЗАТИРАЕТСЯ АВТОГЕОКОДЕРОМ (12.09.2026).
 *
 * `jobs/geocode.ts` обновляет координаты по условию
 * `OR: [{ lat: null }, { geocodedAt: { not: null } }]` — и сам себе объясняет это
 * так: «у ручных координат geocodedAt пуст — их не трогаем». А `routes/properties/
 * crud.ts` на ручной пин ставил `geocodedAt: new Date()`. То есть единственный
 * читатель поля и все его писатели понимали отметку по-разному, и защита не
 * работала: агент ставил точку на карте, пока задание геокодера ждало бэкоффа
 * (лесенка 2 → 8 → 18 → 32 минуты), задание просыпалось, видело непустой
 * `geocodedAt` и меняло точку на догадку Nominatim по строке адреса. На экране
 * это выглядит как «объект сам уехал на соседнюю улицу» — ни ошибки, ни записи
 * в журнале.
 *
 * Отметка теперь значит ровно одно: «координаты поставил автогеокодер». Ручной пин
 * (и координаты, пришедшие с сайта вебхуком) её ГАСЯТ — не просто не ставят, а
 * обнуляют: объект мог быть геокодирован раньше, и оставшаяся отметка снова
 * разрешила бы затирание.
 *
 * Тест держит инвариант на границе API, не дёргая Nominatim: проверяется значение
 * `geocodedAt` в базе после создания и после PATCH — именно оно решает, сработает
 * защита в джобе или нет.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let adminToken: string;
let adminPhone: string;
let intakeAgentId: string;
let intakeAgentPhone: string;
const propertyIds: string[] = [];

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-пин-${runId}` } })).id;
  adminPhone = `+992952${runId.toString().slice(-6)}`;
  await prisma.agent.create({
    data: {
      fullName: "Админ пина",
      phone: adminPhone,
      role: "ADMIN",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  const res = await request(app).post("/api/v1/auth/login").send({ phone: adminPhone, password });
  adminToken = res.body.accessToken as string;

  intakeAgentPhone = `+992953${runId.toString().slice(-6)}`;
  intakeAgentId = (
    await prisma.agent.create({
      data: {
        fullName: "Агент приёма пина",
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
  await prisma.district.deleteMany({ where: { id: districtId } });
});

async function createProperty(coords?: { lat: number; lng: number }) {
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
      address: `Тестовая пина, ${propertyIds.length}`,
      condition: "GOOD",
      // Не сидовый номер (staffPhoneGuard, 17.09.2026) — контакт владельца здесь не важен для теста.
      ownerContact: `+992937${runId.toString().slice(-6)}`,
      intakeAgentId,
      ...(coords ?? {}),
    });
  expect(res.status).toBe(201);
  propertyIds.push(res.body.id);
  return res.body.id as string;
}

/** Ровно то условие, по которому джоб решает, можно ли переписать координаты. */
async function geocoderWouldOverwrite(propertyId: string) {
  const found = await prisma.property.findFirst({
    where: {
      id: propertyId,
      deletedAt: null,
      OR: [{ lat: null }, { geocodedAt: { not: null } }],
    },
    select: { id: true },
  });
  return found !== null;
}

describe("Ручной пин на карте и автогеокодер", () => {
  it("объект создан с координатами руками — отметка автогеокодера пуста", async () => {
    const propertyId = await createProperty({ lat: 38.5598, lng: 68.787 });

    const saved = await prisma.property.findUniqueOrThrow({
      where: { id: propertyId },
      select: { lat: true, lng: true, geocodedAt: true },
    });
    expect(Number(saved.lat)).toBeCloseTo(38.5598, 4);
    expect(saved.geocodedAt).toBeNull();
    expect(await geocoderWouldOverwrite(propertyId)).toBe(false);
  });

  it("пин поставлен PATCH-ем поверх координат геокодера — отметка гаснет, затирания не будет", async () => {
    const propertyId = await createProperty();
    // Как если бы джоб уже отработал по адресу до того, как человек уточнил точку.
    await prisma.property.update({
      where: { id: propertyId },
      data: { lat: 38.5, lng: 68.7, geocodedAt: new Date() },
    });
    expect(await geocoderWouldOverwrite(propertyId)).toBe(true);

    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ lat: 38.5598, lng: 68.787 });
    expect(res.status).toBe(200);

    const saved = await prisma.property.findUniqueOrThrow({
      where: { id: propertyId },
      select: { lat: true, lng: true, geocodedAt: true },
    });
    expect(Number(saved.lat)).toBeCloseTo(38.5598, 4);
    expect(Number(saved.lng)).toBeCloseTo(68.787, 4);
    expect(saved.geocodedAt).toBeNull();
    expect(await geocoderWouldOverwrite(propertyId)).toBe(false);
  });

  it("объект без координат вообще — джоб обязан их поставить", async () => {
    const propertyId = await createProperty();

    const saved = await prisma.property.findUniqueOrThrow({
      where: { id: propertyId },
      select: { lat: true, geocodedAt: true },
    });
    expect(saved.lat).toBeNull();
    expect(saved.geocodedAt).toBeNull();
    // Защита ручного пина не должна превратиться в запрет геокодировать вообще.
    expect(await geocoderWouldOverwrite(propertyId)).toBe(true);
  });
});
