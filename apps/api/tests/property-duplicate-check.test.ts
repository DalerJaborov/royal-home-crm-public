import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { normalizePropertyAddress } from "../src/routes/properties/shared.js";

/**
 * GET /properties/duplicate-check — «этот адрес уже заведён» на шаге «Где»
 * мастера объекта (владелец 15.09.2026: «Один объект от двух агентов — самая
 * частая грязь в базе»; уточнение того же дня — «пусть механизм будет быстрым
 * и правильным, чтобы от себя не придумывал, что это дубль»).
 *
 * Проверяем ровно контракт из уточнения: точное совпадение канонного адреса +
 * района + площадь ±1 м², без похожести «на глаз», удалённые не считаются,
 * чужой агент виден, предел выборки соблюдён.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let otherDistrictId: string;
let agentToken: string;
let otherAgentId: string;

const propertyIds: string[] = [];
const agentIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  return res.body.accessToken as string;
}

async function makeProperty(overrides: Partial<{
  address: string;
  areaSqm: number;
  floor: number | null;
  totalFloors: number | null;
  districtId: string;
  intakeAgentId: string;
  deletedAt: Date | null;
  lat: number | null;
  lng: number | null;
  status: "AVAILABLE" | "SOLD" | "WITHDRAWN";
  rooms: number | null;
  windowCount: number | null;
  landAreaSotka: number | null;
}>) {
  const p = await prisma.property.create({
    data: {
      title: `Тест дубль ${runId}`,
      type: "APARTMENT",
      price: 500_000,
      currency: "TJS",
      areaSqm: overrides.areaSqm ?? 62,
      rooms: overrides.rooms === undefined ? 3 : overrides.rooms,
      floor: overrides.floor === undefined ? 3 : overrides.floor,
      totalFloors: overrides.totalFloors === undefined ? 9 : overrides.totalFloors,
      windowCount: overrides.windowCount ?? null,
      landAreaSotka: overrides.landAreaSotka ?? null,
      condition: "GOOD",
      address: overrides.address ?? `ул. Садбарг, дом 46, ${runId}`,
      // Тот же путь, что и создание объекта через API (routes/properties/crud.ts) —
      // канонный адрес считается normalizePropertyAddress один раз при записи.
      canonicalAddress: normalizePropertyAddress(overrides.address ?? `ул. Садбарг, дом 46, ${runId}`),
      districtId: overrides.districtId ?? districtId,
      intakeAgentId: overrides.intakeAgentId ?? otherAgentId,
      createdById: otherAgentId,
      status: overrides.status ?? "AVAILABLE",
      lat: overrides.lat ?? null,
      lng: overrides.lng ?? null,
      deletedAt: overrides.deletedAt ?? null,
    },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-дубли-район-${runId}` } })).id;
  otherDistrictId = (await prisma.district.create({ data: { name: `Тест-дубли-другой-район-${runId}` } })).id;

  const agent = await prisma.agent.create({
    data: {
      fullName: "Агент проверки дублей",
      phone: `+992907${runId.toString().slice(-6)}`,
      role: "AGENT",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  agentIds.push(agent.id);
  agentToken = await login(agent.phone);

  const other = await prisma.agent.create({
    data: {
      fullName: "Чужой агент",
      phone: `+992908${runId.toString().slice(-6)}`,
      role: "AGENT",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  agentIds.push(other.id);
  otherAgentId = other.id;
});

afterEach(async () => {
  if (propertyIds.length === 0) return;
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  propertyIds.length = 0;
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.district.deleteMany({ where: { id: { in: [districtId, otherDistrictId] } } });
});

function checkDup(query: Record<string, string | number>) {
  return request(app)
    .get("/api/v1/properties/duplicate-check")
    .query(query)
    .set("Authorization", `Bearer ${agentToken}`);
}

describe("совпадение находится", () => {
  it("тот же район + тот же адрес (с иным написанием) + та же площадь — совпадение", async () => {
    const existing = await makeProperty({ address: "ул. Садбарг, д.46" });

    const res = await checkDup({ districtId, address: "улица Садбарг 46", areaSqm: 62 });

    expect(res.status).toBe(200);
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0].id).toBe(existing.id);
    expect(res.body.matches[0].shortId).toBe(existing.shortId);
  });

  it("формулировка — факт: поле status/address/areaSqm приходят как есть, без оценки похожести", async () => {
    await makeProperty({ address: "Садбарг 46", areaSqm: 62 });
    const res = await checkDup({ districtId, address: "садбарг 46", areaSqm: 62.5 });
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0]).not.toHaveProperty("similarity");
  });
});

describe("слишком далёкая площадь не находится", () => {
  it("площадь за пределами ±1 м² не считается совпадением", async () => {
    await makeProperty({ address: "Садбарг 46", areaSqm: 62 });
    const res = await checkDup({ districtId, address: "Садбарг 46", areaSqm: 63.5 });
    expect(res.body.matches).toHaveLength(0);
  });

  it("площадь ровно на границе (±1 м²) всё ещё совпадение", async () => {
    await makeProperty({ address: "Садбарг 46", areaSqm: 62 });
    const res = await checkDup({ districtId, address: "Садбарг 46", areaSqm: 63 });
    expect(res.body.matches).toHaveLength(1);
  });
});

describe("не похожесть, а точное совпадение адреса", () => {
  it("другой дом на той же улице не считается дублем", async () => {
    await makeProperty({ address: "Садбарг 46", areaSqm: 62 });
    const res = await checkDup({ districtId, address: "Садбарг 48", areaSqm: 62 });
    expect(res.body.matches).toHaveLength(0);
  });

  it("другой район с тем же адресом и площадью не считается дублем", async () => {
    await makeProperty({ address: "Садбарг 46", areaSqm: 62, districtId });
    const res = await checkDup({ districtId: otherDistrictId, address: "Садбарг 46", areaSqm: 62 });
    expect(res.body.matches).toHaveLength(0);
  });

  it("этаж и этажность усиливают совпадение: разный этаж при заполненных обеих сторон — не дубль", async () => {
    await makeProperty({ address: "Садбарг 46", areaSqm: 62, floor: 3, totalFloors: 9 });
    const res = await checkDup({ districtId, address: "Садбарг 46", areaSqm: 62, floor: 5, totalFloors: 9 });
    expect(res.body.matches).toHaveLength(0);
  });

  it("этаж не задан в запросе (шаг «Где» ещё до шага «Параметры») — не мешает найти совпадение", async () => {
    await makeProperty({ address: "Садбарг 46", areaSqm: 62, floor: 3, totalFloors: 9 });
    const res = await checkDup({ districtId, address: "Садбарг 46", areaSqm: 62 });
    expect(res.body.matches).toHaveLength(1);
  });
});

describe("удалённый объект не считается дублем", () => {
  it("объект в Корзине (deletedAt) не всплывает", async () => {
    await makeProperty({ address: "Садбарг 46", areaSqm: 62, deletedAt: new Date() });
    const res = await checkDup({ districtId, address: "Садбарг 46", areaSqm: 62 });
    expect(res.body.matches).toHaveLength(0);
  });
});

describe("чужой агент виден", () => {
  it("объект другого агента находится тоже — в этом и смысл проверки", async () => {
    const existing = await makeProperty({ address: "Садбарг 46", areaSqm: 62, intakeAgentId: otherAgentId });
    const res = await checkDup({ districtId, address: "Садбарг 46", areaSqm: 62 });
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0].id).toBe(existing.id);
  });

  it("объект не отдаёт контакт продавца/владельца — только адрес/площадь/статус", async () => {
    await makeProperty({ address: "Садбарг 46", areaSqm: 62 });
    const res = await checkDup({ districtId, address: "Садбарг 46", areaSqm: 62 });
    expect(res.body.matches[0]).not.toHaveProperty("ownerContact");
    expect(res.body.matches[0]).not.toHaveProperty("sellerClientId");
  });
});

describe("предела выборки хватает", () => {
  it("больше объектов, чем предел выборки — ответ всё равно ограничен потолком", async () => {
    for (let i = 0; i < 8; i++) {
      // Разные площади (62±1), чтобы каждый проходил фильтр площади независимо
      // от округления, но один и тот же канонный адрес.
      await makeProperty({ address: "Садбарг 46", areaSqm: 62 });
    }
    const res = await checkDup({ districtId, address: "Садбарг 46", areaSqm: 62 });
    expect(res.body.matches.length).toBeLessThanOrEqual(5);
  });
});

describe("исключение собственного объекта при правке", () => {
  it("excludePropertyId не даёт объекту найти самого себя", async () => {
    const existing = await makeProperty({ address: "Садбарг 46", areaSqm: 62 });
    const res = await checkDup({
      districtId,
      address: "Садбарг 46",
      areaSqm: 62,
      excludePropertyId: existing.id,
    });
    expect(res.body.matches).toHaveLength(0);
  });
});

describe("валидация входа", () => {
  it("districtId не UUID — 400", async () => {
    const res = await checkDup({ districtId: "not-a-uuid", address: "Садбарг 46", areaSqm: 62 });
    expect(res.status).toBe(400);
  });

  it("пустой адрес — 400", async () => {
    const res = await checkDup({ districtId, address: "", areaSqm: 62 });
    expect(res.status).toBe(400);
  });

  it("без авторизации — 401", async () => {
    const res = await request(app)
      .get("/api/v1/properties/duplicate-check")
      .query({ districtId, address: "Садбарг 46", areaSqm: 62 });
    expect(res.status).toBe(401);
  });
});

// ── По точке (02.10.2026): адрес записан иначе, но дом тот же ──────────────────
// Центр Душанбе; 0.00018° широты ≈ 20 м, 0.0009° ≈ 100 м.
const LAT = 38.5598;
const LNG = 68.787;

describe("дубль по точке — все параметры сверяются", () => {
  it("другое написание адреса, объект в 20 м, параметры те же — ловится по точке", async () => {
    const existing = await makeProperty({
      address: "проспект Рудаки, дом 177",
      areaSqm: 62,
      floor: 5,
      totalFloors: 9,
      lat: LAT + 0.00018,
      lng: LNG,
    });
    const res = await checkDup({
      districtId,
      address: "Рудаки 177 (другая запись)",
      areaSqm: 62,
      rooms: 3,
      floor: 5,
      totalFloors: 9,
      type: "APARTMENT",
      lat: LAT,
      lng: LNG,
    });
    expect(res.status).toBe(200);
    expect(res.body.matches).toHaveLength(1);
    const m = res.body.matches[0];
    expect(m.id).toBe(existing.id);
    expect(m.matchedBy).toBe("point");
    expect(m.distanceM).toBeGreaterThan(15);
    expect(m.distanceM).toBeLessThan(25);
    expect(m.checks.map((c: { field: string }) => c.field)).toEqual(["areaSqm", "rooms", "floor", "totalFloors", "type"]);
    expect(m.checks.every((c: { equal: boolean }) => c.equal)).toBe(true);
    expect(m).not.toHaveProperty("ownerContact");
  });

  it("найден и адресом, и точкой — matchedBy both, без повтора", async () => {
    await makeProperty({ address: "Садбарг 46", areaSqm: 62, lat: LAT + 0.00009, lng: LNG });
    const res = await checkDup({ districtId, address: "Садбарг 46", areaSqm: 62, lat: LAT, lng: LNG });
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0].matchedBy).toBe("both");
  });

  it("тот же дом, но другая площадь — не ловится", async () => {
    await makeProperty({ address: "Рудаки 177", areaSqm: 62, lat: LAT + 0.00018, lng: LNG });
    const res = await checkDup({ districtId, address: "Другой адрес", areaSqm: 80, lat: LAT, lng: LNG });
    expect(res.body.matches).toHaveLength(0);
  });

  it("тот же дом, но другой этаж — не ловится", async () => {
    await makeProperty({ address: "Рудаки 177", areaSqm: 62, floor: 5, totalFloors: 9, lat: LAT + 0.00018, lng: LNG });
    const res = await checkDup({ districtId, address: "Другой адрес", areaSqm: 62, floor: 7, totalFloors: 9, lat: LAT, lng: LNG });
    expect(res.body.matches).toHaveLength(0);
  });

  it("другое число комнат — не ловится", async () => {
    await makeProperty({ address: "Рудаки 177", areaSqm: 62, rooms: 3, lat: LAT + 0.00018, lng: LNG });
    const res = await checkDup({ districtId, address: "Другой адрес", areaSqm: 62, rooms: 2, lat: LAT, lng: LNG });
    expect(res.body.matches).toHaveLength(0);
  });

  it("объект в 100 м — не ловится", async () => {
    await makeProperty({ address: "Рудаки 177", areaSqm: 62, lat: LAT + 0.0009, lng: LNG });
    const res = await checkDup({ districtId, address: "Другой адрес", areaSqm: 62, lat: LAT, lng: LNG });
    expect(res.body.matches).toHaveLength(0);
  });

  it("проданный и снятый по точке — не ловятся", async () => {
    await makeProperty({ address: "Рудаки 177", areaSqm: 62, status: "SOLD", lat: LAT + 0.00018, lng: LNG });
    await makeProperty({ address: "Рудаки 177", areaSqm: 62, status: "WITHDRAWN", lat: LAT + 0.00018, lng: LNG });
    const res = await checkDup({ districtId, address: "Другой адрес", areaSqm: 62, lat: LAT, lng: LNG });
    expect(res.body.matches).toHaveLength(0);
  });

  it("проданный с тем же адресом ловится по адресу, как и прежде", async () => {
    await makeProperty({ address: "Рудаки 177", areaSqm: 62, status: "SOLD", lat: LAT, lng: LNG });
    const res = await checkDup({ districtId, address: "Рудаки 177", areaSqm: 62, lat: LAT, lng: LNG });
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0].matchedBy).toBe("address");
  });

  it("без точки в запросе ответ как прежде: матч по адресу, matchedBy address, расстояния нет", async () => {
    await makeProperty({ address: "Садбарг 46", areaSqm: 62, lat: LAT, lng: LNG });
    const res = await checkDup({ districtId, address: "Садбарг 46", areaSqm: 62 });
    expect(res.body.matches[0].matchedBy).toBe("address");
    expect(res.body.matches[0].distanceM).toBeNull();
  });
});

describe("число окон, участок и предел выборки", () => {
  it("другое число окон — не дубль; то же — дубль", async () => {
    await makeProperty({ address: "Садбарг 46", areaSqm: 62, windowCount: 8 });
    const other = await checkDup({ districtId, address: "Садбарг 46", areaSqm: 62, windowCount: 6 });
    expect(other.body.matches).toHaveLength(0);
    const same = await checkDup({ districtId, address: "Садбарг 46", areaSqm: 62, windowCount: 8 });
    expect(same.body.matches).toHaveLength(1);
  });

  it("участок сверяется с допуском в одну сотку", async () => {
    await makeProperty({ address: "Садбарг 46", areaSqm: 62, landAreaSotka: 6 });
    const far = await checkDup({ districtId, address: "Садбарг 46", areaSqm: 62, landAreaSotka: 9 });
    expect(far.body.matches).toHaveLength(0);
    const near = await checkDup({ districtId, address: "Садбарг 46", areaSqm: 62, landAreaSotka: 6.8 });
    expect(near.body.matches).toHaveLength(1);
  });

  it("шесть объектов того же адреса с другой площадью не вытесняют настоящий дубль", async () => {
    for (let i = 0; i < 6; i++) await makeProperty({ address: "Садбарг 46", areaSqm: 90 + i });
    const target = await makeProperty({ address: "Садбарг 46", areaSqm: 62 });
    const res = await checkDup({ districtId, address: "Садбарг 46", areaSqm: 62 });
    expect(res.body.matches.map((m: { id: string }) => m.id)).toEqual([target.id]);
  });
});
