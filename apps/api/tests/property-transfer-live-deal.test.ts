import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ПЕРЕДАЧА ОБЪЕКТА В РЕЗЕРВЕ НЕ ОТНИМАЕТ ЕГО У РИЕЛТОРА СДЕЛКИ
 * (глубокая проверка 02.10.2026, D9; то же — находка О10 соседней проверки).
 *
 * Сделка ставит объекту `assignedAgentId` = риелтор покупателя. «Передать
 * объект» (и «Передача дел» тем же путём) переписывал оба поля хозяина на
 * нового агента: риелтор сделки терял доступ к объекту своей сделки, а отмена
 * сделки (routes/deals.ts) снимала риелтора по `assignedAgentId: Deal.agentId`
 * и уже не находила его. Передаётся сторона продавца (intake), а риелтор
 * живой сделки остаётся на месте.
 */

const runId = Date.now();
const tail = String(runId).slice(-6);
const password = "testpass123";
const agentIds: string[] = [];
let directorToken = "";
let intakeId = "";
let realtorId = "";
let newOwnerId = "";
let clientId = "";
let propertyId = "";

async function agent(n: number, role: "AGENT" | "DIRECTOR") {
  const passwordHash = await bcrypt.hash(password, 10);
  const a = await prisma.agent.create({
    data: { fullName: `Передача в резерве ${runId}-${n}`, phone: `+992905${tail}${n}`, role, passwordHash },
  });
  agentIds.push(a.id);
  return a;
}

beforeAll(async () => {
  const director = await agent(0, "DIRECTOR");
  intakeId = (await agent(1, "AGENT")).id;
  realtorId = (await agent(2, "AGENT")).id;
  newOwnerId = (await agent(3, "AGENT")).id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(login.status).toBe(200);
  directorToken = login.body.accessToken as string;

  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Покупатель резерва ${runId}`,
        phone: `+992906${tail}1`,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: realtorId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект в резерве ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        condition: "GOOD",
        status: "RESERVED",
        reservedAt: new Date(),
        reservedForClientId: clientId,
        intakeAgentId: intakeId,
        assignedAgentId: realtorId,
        createdById: intakeId,
      },
    })
  ).id;
  await prisma.deal.create({ data: { clientId, propertyId, agentId: realtorId, stage: "NEGOTIATION" } });
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { propertyId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.auditLog.deleteMany({ where: { entityId: propertyId } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("D9: передача объекта с живой сделкой", () => {
  it("меняется хозяин-продавец, риелтор сделки остаётся", async () => {
    const res = await request(app)
      .post(`/api/v1/properties/${propertyId}/transfer`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ toAgentId: newOwnerId, reason: "Агент уволился, объект передан" });
    expect(res.status).toBe(200);

    const after = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(after.intakeAgentId).toBe(newOwnerId);
    expect(after.assignedAgentId).toBe(realtorId);
    expect(after.reservedForClientId).toBe(clientId);
  });
});
