import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * A12 (глубокая проверка 02.10.2026), решение владельца 02.10 «да, по советам»:
 * служба безопасности НЕ заводит объекты.
 *
 * Раньше у СБ не было properties.editForeign, и POST /properties вёл её по
 * агентской ветке: сама себе приёмщик, очки «Объект добавлен» в рейтинге
 * агентов. Теперь — отказ, ничего не создано. Смотреть объекты СБ по-прежнему
 * может (карточка открывается, контакт собственника виден по viewOwners).
 */

const runId = `${Date.now()}`.slice(-7);
const password = "testpass123";
const agentIds: string[] = [];
const propertyIds: string[] = [];
let districtId = "";
let securityId = "";
let securityToken = "";
let agentToken = "";

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

function body(tag: string, ownerPrefix: string) {
  return {
    type: "APARTMENT",
    areaSqm: 50,
    rooms: 2,
    floor: 3,
    totalFloors: 9,
    windowCount: 3,
    price: 300000,
    currency: "TJS",
    districtId,
    address: `СБ-объект ${tag} ${runId}`,
    condition: "GOOD",
    ownerContact: `${ownerPrefix}${runId.slice(-6)}`,
  };
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Район СБ-A12 ${runId}` } })).id;
  const security = await prisma.agent.create({
    data: { fullName: `СБ A12 ${runId}`, phone: `+992981${runId}`, role: "SECURITY", passwordHash },
  });
  const agent = await prisma.agent.create({
    data: { fullName: `Агент A12 ${runId}`, phone: `+992982${runId}`, role: "AGENT", passwordHash },
  });
  securityId = security.id;
  agentIds.push(security.id, agent.id);
  securityToken = await login(security.phone);
  agentToken = await login(agent.phone);
});

afterAll(async () => {
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("A12: служба безопасности не заводит объекты", () => {
  it("POST /properties от СБ — 403, объекта нет, очков нет", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${securityToken}`)
      .send(body("сб", "+992937"));
    if (res.body?.id) propertyIds.push(res.body.id);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Служба безопасности/);
    const created = await prisma.property.count({ where: { OR: [{ intakeAgentId: securityId }, { createdById: securityId }] } });
    expect(created).toBe(0);
  });

  it("агент заводит объект как раньше — 201", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${agentToken}`)
      .send(body("агент", "+992938"));
    if (res.body?.id) propertyIds.push(res.body.id);
    expect(res.status).toBe(201);
  });

  it("СБ по-прежнему открывает карточку объекта и видит собственника", async () => {
    const propertyId = propertyIds.at(-1);
    expect(propertyId).toBeTruthy();
    const res = await request(app)
      .get(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${securityToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ownerContact).toBe(`+992938${runId.slice(-6)}`);
  });
});
