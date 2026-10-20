import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ОРИЕНТИР ОБЪЕКТА (пункт 10 владельца, 23.09.2026) — короткая фраза вроде
 * «рядом с ТЦ Садбарг», «за Овиром»: помогает покупателю и сотрудникам понять
 * расположение объекта, когда точного адреса недостаточно. Необязательное
 * свободное поле, максимум 120 символов, очищается через null (тот же приём,
 * что и у ownerContact/documents — см. property-clear-fields.test.ts).
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let adminId: string;
let adminToken: string;
// ADMIN не может назначить интейкером сам себя (assignableAgentError,
// routes/properties/shared.ts) — при создании от лица руководителя
// intakeAgentId обязателен и должен указывать на действующего AGENT
// (см. тот же приём в property-history.test.ts).
let intakeAgentId: string;
let propertyId: string;

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-ориентир-${runId}` } })).id;
  const passwordHash = await bcrypt.hash(password, 10);
  const phone = `+992944${runId.toString().slice(-6)}`;

  adminId = (
    await prisma.agent.create({
      data: { fullName: "Админ ориентира", phone, role: "ADMIN", passwordHash },
    })
  ).id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone, password });
  adminToken = login.body.accessToken;

  intakeAgentId = (
    await prisma.agent.create({
      data: {
        fullName: "Интейкер ориентира",
        phone: `+992945${runId.toString().slice(-6)}`,
        role: "AGENT",
        passwordHash,
      },
    })
  ).id;
});

afterAll(async () => {
  if (propertyId) {
    await prisma.propertyPhoto.deleteMany({ where: { propertyId } });
    await prisma.property.deleteMany({ where: { id: propertyId } });
  }
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, intakeAgentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

function baseBody(overrides: Record<string, unknown> = {}) {
  return {
    type: "APARTMENT",
    areaSqm: 55,
    rooms: 2,
    floor: 3,
    totalFloors: 9,
    windowCount: 3,
    price: 350000,
    currency: "TJS",
    districtId,
    address: "Тестовая ориентир, 1",
    condition: "GOOD",
    ownerContact: `+992937${runId.toString().slice(-6)}`,
    intakeAgentId,
    ...overrides,
  };
}

describe("Ориентир объекта — создание", () => {
  it("создаётся с ориентиром", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(baseBody({ landmark: "рядом с ТЦ Садбарг" }));
    expect(res.status).toBe(201);
    expect(res.body.landmark).toBe("рядом с ТЦ Садбарг");
    propertyId = res.body.id;

    const saved = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, select: { landmark: true } });
    expect(saved.landmark).toBe("рядом с ТЦ Садбарг");
  });

  it("создаётся и без ориентира — поле необязательно", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(baseBody({ ownerContact: `+992938${runId.toString().slice(-6)}`, address: "Тестовая ориентир, 2" }));
    expect(res.status).toBe(201);
    expect(res.body.landmark ?? null).toBeNull();
    // Второй объект теста не нужен дальше — убираем сразу, чтобы не плодить
    // сирот при повторном прогоне файла.
    await prisma.property.deleteMany({ where: { id: res.body.id } });
  });

  it("ориентир длиннее 120 символов отклоняется с 400", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(baseBody({ ownerContact: `+992939${runId.toString().slice(-6)}`, landmark: "а".repeat(121) }));
    expect(res.status).toBe(400);
  });
});

describe("Ориентир объекта — правка", () => {
  it("PATCH меняет ориентир", async () => {
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ landmark: "за Овиром" });
    expect(res.status).toBe(200);
    expect(res.body.landmark).toBe("за Овиром");

    const saved = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, select: { landmark: true } });
    expect(saved.landmark).toBe("за Овиром");
  });

  it("PATCH с landmark: null очищает поле", async () => {
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ landmark: null });
    expect(res.status).toBe(200);
    expect(res.body.landmark ?? null).toBeNull();

    const saved = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, select: { landmark: true } });
    expect(saved.landmark).toBeNull();
  });

  it("PATCH с ориентиром длиннее 120 символов отклоняется с 400", async () => {
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ landmark: "б".repeat(121) });
    expect(res.status).toBe(400);
  });
});
