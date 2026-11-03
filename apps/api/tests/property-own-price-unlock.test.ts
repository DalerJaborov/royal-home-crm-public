import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ЦЕНА СВОЕГО ОПУБЛИКОВАННОГО ОБЪЕКТА (владелец 03.11.2026): замок публикации (07.10.2026) на неё
 * не действует для ведущего/приёмщика/создателя; остальные поля и чужие объекты — по-прежнему замок.
 */
const runId = Date.now();
const tail = String(runId).slice(-6);
const agentIds: string[] = [];
const propertyIds: string[] = [];
let ownerToken = "";
let strangerToken = "";
let ownerId = "";

async function login(n: number) {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  const a = await prisma.agent.create({ data: { fullName: `Свой-цена ${runId}-${n}`, phone: `+992955${tail}${n}`, role: "AGENT", passwordHash } });
  agentIds.push(a.id);
  const res = await request(app).post("/api/v1/auth/login").send({ phone: a.phone, password: "testpass123" });
  expect(res.status).toBe(200);
  return { id: a.id, token: res.body.accessToken as string };
}
const seed = async (status = "AVAILABLE") => {
  const p = await prisma.property.create({
    data: { title: `Опубликован ${runId}`, type: "APARTMENT", areaSqm: 50, price: 400000, currency: "TJS", condition: "GOOD", status: status as never, intakeAgentId: ownerId, createdById: ownerId, assignedAgentId: ownerId },
  });
  propertyIds.push(p.id);
  return p.id;
};
const patch = (id: string, token: string, body: object) =>
  request(app).patch(`/api/v1/properties/${id}`).set("Authorization", `Bearer ${token}`).send(body);

beforeAll(async () => {
  const owner = await login(1);
  ownerId = owner.id;
  ownerToken = owner.token;
  strangerToken = (await login(2)).token;
});
afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("замок публикации и цена своего объекта", () => {
  it("хозяин меняет цену опубликованного объекта сам; другие поля — по-прежнему 409", async () => {
    const id = await seed();
    const ok = await patch(id, ownerToken, { price: 390000 });
    expect(ok.status).toBeLessThan(300);
    expect(Number((await prisma.property.findUniqueOrThrow({ where: { id } })).price)).toBe(390000);
    const locked = await patch(id, ownerToken, { areaSqm: 61 });
    expect(locked.status).toBe(409);
    const mixed = await patch(id, ownerToken, { price: 380000, areaSqm: 62 });
    expect(mixed.status).toBe(409);
    expect(Number((await prisma.property.findUniqueOrThrow({ where: { id } })).price)).toBe(390000);
  });

  it("чужой агент цену не меняет (замок)", async () => {
    const id = await seed();
    const res = await patch(id, strangerToken, { price: 1 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(Number((await prisma.property.findUniqueOrThrow({ where: { id } })).price)).toBe(400000);
  });

  it("резерв (открытая сделка) — цену хозяин сам не меняет", async () => {
    const id = await seed("RESERVED");
    expect((await patch(id, ownerToken, { price: 1 })).status).toBe(403);
  });

  it("проданный — цену по-прежнему только руководство", async () => {
    const id = await seed("SOLD");
    expect((await patch(id, ownerToken, { price: 1 })).status).toBe(403);
  });
});
