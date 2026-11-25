import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * Сбой реестра строек не роняет список объектов (ревью PR #434, 25.11.2026): значки просто не приходят, а сбой пишется в
 * журнал ошибок. Реестр здесь нарочно ломается подменой loadRegistryBriefs.
 */
vi.mock("../src/lib/constructionRegistry/view.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/constructionRegistry/view.js")>()),
  loadRegistryBriefs: vi.fn(async () => {
    throw new Error("реестр недоступен (тест)");
  }),
}));

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");

const runId = String(Date.now()).slice(-8);
const password = "testpass123";
let agentId = "";
let propertyId = "";
let token = "";

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({ data: { fullName: "Агент списка", phone: `+992973${runId}`, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) } })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект списка ${runId}`, type: "APARTMENT", areaSqm: 50, price: 40000, currency: "USD", condition: "NEW_BUILDING",
        status: "AVAILABLE", address: "улица Айни, 1", intakeAgentId: agentId, createdById: agentId, assignedAgentId: agentId,
      },
    })
  ).id;
  token = (await request(app).post("/api/v1/auth/login").send({ phone: `+992973${runId}`, password })).body.accessToken as string;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("список объектов при сбое реестра", () => {
  it("200 и объекты на месте, registry: null", async () => {
    const res = await request(app).get(`/api/v1/properties?search=${runId}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const item = (res.body.items as { id: string; registry: unknown }[]).find((p) => p.id === propertyId);
    expect(item).toBeTruthy();
    expect(item!.registry).toBeNull();
  });
});
