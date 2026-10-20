import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ЦЕНА ПРОДАННОГО ОБЪЕКТА — ТОЛЬКО РУКОВОДСТВУ (глубокая проверка 02.10.2026, D12).
 *
 * Выгрузка бухгалтерии берёт `Property.soldPrice ?? price` и `Property.currency`.
 * Агент после закрытия сделки правил «цену продажи» или валюту в карточке — сумма
 * в выгрузке менялась, а сделка (Deal.soldPrice) оставалась прежней.
 */

const runId = Date.now();
const tail = String(runId).slice(-6);
const agentIds: string[] = [];
let agentId = "";
let agentToken = "";
let directorToken = "";
let propertyId = "";

async function login(n: number, role: "AGENT" | "DIRECTOR") {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  const a = await prisma.agent.create({ data: { fullName: `Цена продажи ${runId}-${n}`, phone: `+992966${tail}${n}`, role, passwordHash } });
  agentIds.push(a.id);
  const res = await request(app).post("/api/v1/auth/login").send({ phone: a.phone, password: "testpass123" });
  expect(res.status).toBe(200);
  return { id: a.id, token: res.body.accessToken as string };
}

beforeAll(async () => {
  const agent = await login(1, "AGENT");
  agentId = agent.id;
  agentToken = agent.token;
  directorToken = (await login(2, "DIRECTOR")).token;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Проданный ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 400000,
        soldPrice: 390000,
        soldAt: new Date(),
        currency: "TJS",
        condition: "GOOD",
        status: "SOLD",
        intakeAgentId: agentId,
        createdById: agentId,
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("PATCH /properties/:id у проданного объекта", () => {
  it("агент не меняет цену продажи и валюту — 403, данные прежние", async () => {
    for (const body of [{ soldPrice: 100000 }, { currency: "USD" }, { price: 1 }]) {
      const res = await request(app).patch(`/api/v1/properties/${propertyId}`).set("Authorization", `Bearer ${agentToken}`).send(body);
      expect(res.status).toBe(403);
    }
    const after = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(Number(after.soldPrice)).toBe(390000);
    expect(after.currency).toBe("TJS");
    expect(Number(after.price)).toBe(400000);
  });

  it("описание проданного объекта агент не правит — после публикации замок (07.10.2026), руководитель может", async () => {
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ description: "Продано, спасибо покупателю" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PROPERTY_EDIT_LOCKED");
    const byDirector = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ description: "Продано, спасибо покупателю" });
    expect(byDirector.status).toBe(200);
  });

  it("руководитель исправляет цену продажи", async () => {
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ soldPrice: 385000 });
    expect(res.status).toBe(200);
    expect(Number((await prisma.property.findUniqueOrThrow({ where: { id: propertyId } })).soldPrice)).toBe(385000);
  });
});
