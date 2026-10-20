import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * Снятый с продажи объект агент возвращает через проверку (аудит 23.09.2026, №60).
 * Сервер этот переход принимает, а прямой возврат в продажу — только маркетингу.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
let agentId = "";
let districtId = "";
let propertyId = "";
let token = "";

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({ data: { fullName: `Агент снятого ${runId}`, phone: `+99294${tail}`, role: "AGENT", passwordHash: "x" } })
  ).id;
  token = signAccessToken({ sub: agentId, role: "AGENT" });
  districtId = (await prisma.district.create({ data: { name: `Район снятого ${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Снятый объект ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая снятого, 1",
        condition: "GOOD",
        status: "WITHDRAWN",
        intakeAgentId: agentId,
        createdById: agentId,
        assignedAgentId: agentId,
      } as never,
    })
  ).id;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("Снятый объект у агента", () => {
  it("прямо в продажу — нельзя", async () => {
    const res = await request(app).patch(`/api/v1/properties/${propertyId}`).set("Authorization", `Bearer ${token}`).send({ status: "AVAILABLE" });
    expect(res.status).toBe(403);
  });
  it("на проверку — можно", async () => {
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "PENDING_REVIEW" });
    expect(res.status).toBeLessThan(300);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: propertyId } })).status).toBe("PENDING_REVIEW");
  });
});
