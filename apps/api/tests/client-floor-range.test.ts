import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * clientUpdateSchema проверял диапазон бюджета, но не диапазон этажа — тот же
 * refine, что есть у clientCreateSchema, туда не попал. PATCH с
 * desiredFloorMin > desiredFloorMax проходил молча, и подбор объектов переставал
 * находить что-либо по этому клиенту без видимой причины.
 */

const runId = Date.now();
const password = "testpass123";
let agentId: string;
let token: string;
const clientIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент этажей", phone: `+992968${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: `+992968${runId}`, password });
  token = login.body.accessToken;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Диапазон этажа при правке клиента", () => {
  it("PATCH с desiredFloorMin больше desiredFloorMax отклоняется", async () => {
    const created = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: `Этажи ${runId}`, phone: `+99290${runId}4`, source: "PHONE_CALL" });
    clientIds.push(created.body.id);

    const patched = await request(app)
      .patch(`/api/v1/clients/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ desiredFloorMin: 9, desiredFloorMax: 2 });
    expect(patched.status).toBe(400);
  });

  it("PATCH с корректным диапазоном проходит", async () => {
    const created = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: `Этажи норм ${runId}`, phone: `+99290${runId}5`, source: "PHONE_CALL" });
    clientIds.push(created.body.id);

    const patched = await request(app)
      .patch(`/api/v1/clients/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ desiredFloorMin: 2, desiredFloorMax: 9 });
    expect(patched.status).toBe(200);
    expect(patched.body.desiredFloorMin).toBe(2);
    expect(patched.body.desiredFloorMax).toBe(9);
  });
});
