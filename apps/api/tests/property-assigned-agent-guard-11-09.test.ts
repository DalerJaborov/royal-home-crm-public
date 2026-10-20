import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * «Свой объект = свой клиент, без оговорок» — Дополнение к Пачке 1 (11.09.2026,
 * проверено 11.09), п.8-9.
 *
 * п.8: `routes/properties/crud.ts` PATCH проверял право доступа СВЕРЯЯ его с
 * НОВЫМ значением `assignedAgentId` — любой агент с доступом к объекту
 * (интейкер/риелтор/создатель) мог прислать `{assignedAgentId: <себя>}` и
 * перехватить «ведёт сделку» без решения руководителя. Смена `assignedAgentId`
 * теперь требует `properties.editForeign`, самоназначение запрещено так же, как
 * назначение коллеги.
 *
 * п.9: сервер не проверял, что `intakeAgentId`/`assignedAgentId` указывает на
 * активного, незамороженного агента с ролью AGENT — только клиентский фильтр в
 * форме. Добавлена серверная проверка с понятным текстом (400).
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let adminToken: string;
let agentToken: string;
let ownerAgentId: string; // владеет карточкой (intakeAgentId) — обычный агент
let coworkerAgentId: string; // третье лицо, не связано с объектом
let firedAgentId: string;
let frozenAgentId: string;
let managerAgentId: string; // роль не AGENT
const agentIds: string[] = [];
const propertyIds: string[] = [];

async function makeAgent(opts: {
  fullName: string;
  role?: "AGENT" | "ADMIN" | "MANAGER";
  isActive?: boolean;
  frozenAt?: Date | null;
}) {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: {
      fullName: opts.fullName,
      phone: `+992907${agentIds.length}${runId.toString().slice(-5)}`,
      role: opts.role ?? "AGENT",
      passwordHash,
      isActive: opts.isActive ?? true,
      frozenAt: opts.frozenAt ?? null,
    },
  });
  agentIds.push(agent.id);
  return agent.id;
}

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  return res.body.accessToken as string;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-владение-${runId}` } })).id;

  const admin = await prisma.agent.create({
    data: {
      fullName: "Админ владения",
      phone: `+992951${runId.toString().slice(-6)}`,
      role: "ADMIN",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  adminToken = await login(admin.phone);

  ownerAgentId = await makeAgent({ fullName: "Хозяин карточки" });
  agentToken = await login((await prisma.agent.findUniqueOrThrow({ where: { id: ownerAgentId } })).phone);
  coworkerAgentId = await makeAgent({ fullName: "Коллега" });
  firedAgentId = await makeAgent({ fullName: "Уволенный", isActive: false });
  frozenAgentId = await makeAgent({ fullName: "Заморожен", frozenAt: new Date() });
  managerAgentId = await makeAgent({ fullName: "Руководитель как объект", role: "MANAGER" });
});

afterEach(async () => {
  if (propertyIds.length === 0) return;
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  propertyIds.length = 0;
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: [...agentIds] } } });
  await prisma.agent.deleteMany({ where: { phone: `+992951${runId.toString().slice(-6)}` } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

async function createProperty(intakeAgentId: string) {
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
      address: `Тестовая владение, ${propertyIds.length}`,
      condition: "GOOD",
      ownerContact: `+992937${runId.toString().slice(-6)}`, // не сидовый номер (staffPhoneGuard, 17.09.2026)
      intakeAgentId,
    });
  expect(res.status).toBe(201);
  propertyIds.push(res.body.id);
  return res.body.id as string;
}

describe("п.8 — самоназначение assignedAgentId запрещено рядовому агенту", () => {
  it("агент с доступом к объекту не может назначить СЕБЯ ведущим сделку", async () => {
    const propertyId = await createProperty(ownerAgentId);

    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ assignedAgentId: ownerAgentId });

    expect(res.status).toBe(200); // PATCH не отвергается целиком — поле молча игнорируется
    expect(res.body.assignedAgentId ?? null).not.toBe(ownerAgentId);
  });

  it("агент не может назначить и коллегу — поле тоже молча игнорируется", async () => {
    const propertyId = await createProperty(ownerAgentId);

    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ assignedAgentId: coworkerAgentId });

    expect(res.status).toBe(200);
    expect(res.body.assignedAgentId ?? null).not.toBe(coworkerAgentId);
  });

  it("руководитель (properties.editForeign) может назначить ведущего сделку", async () => {
    const propertyId = await createProperty(ownerAgentId);

    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ assignedAgentId: coworkerAgentId });

    expect(res.status).toBe(200);
    expect(res.body.assignedAgentId).toBe(coworkerAgentId);
  });
});

describe("п.9 — intakeAgentId/assignedAgentId должны указывать на живого действующего агента", () => {
  it("создание объекта руководителем с уволенным intakeAgentId — 400", async () => {
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
        address: `Тестовая владение уволен, ${propertyIds.length}`,
        condition: "GOOD",
        ownerContact: `+992937${runId.toString().slice(-6)}`, // не сидовый номер (staffPhoneGuard, 17.09.2026)
        intakeAgentId: firedAgentId,
      });
    expect(res.status).toBe(400);
    if (res.body?.id) propertyIds.push(res.body.id);
  });

  it("PATCH intakeAgentId руководителем на замороженного — 400", async () => {
    const propertyId = await createProperty(ownerAgentId);
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ intakeAgentId: frozenAgentId });
    expect(res.status).toBe(400);
  });

  it("PATCH assignedAgentId руководителем на роль не-AGENT — 400", async () => {
    const propertyId = await createProperty(ownerAgentId);
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ assignedAgentId: managerAgentId });
    expect(res.status).toBe(400);
  });

  it("PATCH рядовым агентом чужого intakeAgentId на уволенного — молча игнорируется, не 400", async () => {
    const propertyId = await createProperty(ownerAgentId);
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ intakeAgentId: firedAgentId });
    // У рядового агента нет properties.editForeign — поле дропается ДО проверки
    // валидности, значит ошибки валидности он не увидит (как и раньше, тихо).
    expect(res.status).toBe(200);
    expect(res.body.intakeAgentId).toBe(ownerAgentId);
  });

  it("руководитель может назначить живого активного агента — 200", async () => {
    const propertyId = await createProperty(ownerAgentId);
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ assignedAgentId: coworkerAgentId });
    expect(res.status).toBe(200);
    expect(res.body.assignedAgentId).toBe(coworkerAgentId);
  });
});
