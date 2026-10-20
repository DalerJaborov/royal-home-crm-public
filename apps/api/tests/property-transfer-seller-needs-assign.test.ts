import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ГЛУБОКАЯ ПРОВЕРКА 02.10.2026, A4 — передача объекта уводила продавца мимо
 * clients.assign.
 *
 * POST /properties/:id/transfer закрыт правом properties.editForeign, а оно есть у
 * маркетинга и монтажёра (правят чужие карточки объектов по конвейеру). Вместе с
 * объектом уезжает и карточка продавца (lib/propertyTransferWithSeller.ts →
 * changeClientAgent) — то есть смена держателя КЛИЕНТА, которая везде в CRM
 * требует clients.assign. Маркетолог по известному id агента передавал продавца
 * с телефоном и перепиской другому агенту, а у клиента сбрасывалось «принято».
 *
 * Правило: если продавец едет вместе с объектом — передаёт тот, кто распределяет
 * клиентов (clients.assign). Руководитель передаёт как раньше.
 */

const runId = `${Date.now()}`.slice(-7);
const password = "testpass123";

const agentIds: string[] = [];
let districtId: string;
let fromAgentId: string;
let toAgentId: string;
let sellerId: string;
let propertyId: string;
let marketingToken: string;
let managerToken: string;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Передача-A4-${runId}` } })).id;
  const from = await prisma.agent.create({
    data: { fullName: `Агент-хозяин A4 ${runId}`, phone: `+992991${runId}`, role: "AGENT", passwordHash },
  });
  fromAgentId = from.id;
  const to = await prisma.agent.create({
    data: { fullName: `Агент-получатель A4 ${runId}`, phone: `+992992${runId}`, role: "AGENT", passwordHash },
  });
  toAgentId = to.id;
  const marketing = await prisma.agent.create({
    data: { fullName: `Маркетолог A4 ${runId}`, phone: `+992993${runId}`, role: "MARKETING", passwordHash },
  });
  const manager = await prisma.agent.create({
    data: { fullName: `Руководитель A4 ${runId}`, phone: `+992994${runId}`, role: "MANAGER", passwordHash },
  });
  agentIds.push(from.id, to.id, marketing.id, manager.id);

  sellerId = (
    await prisma.client.create({
      data: {
        fullName: `Продавец A4 ${runId}`,
        phone: `+992995${runId}`,
        source: "PHONE_CALL",
        kind: "SELLER",
        assignedAgentId: from.id,
        acceptedAt: new Date(),
      },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект A4 ${runId}`,
        type: "APARTMENT",
        areaSqm: 55,
        price: 70000,
        currency: "USD",
        districtId,
        address: `Тест ${runId}`,
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId: from.id,
        assignedAgentId: from.id,
        sellerClientId: sellerId,
      },
    })
  ).id;

  marketingToken = await login(marketing.phone);
  managerToken = await login(manager.phone);
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.interaction.deleteMany({ where: { clientId: sellerId } });
  await prisma.client.deleteMany({ where: { id: sellerId } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("A4: объект с продавцом передаёт только тот, кто распределяет клиентов", () => {
  it("маркетолог (editForeign без clients.assign) — 403, ни объект, ни продавец не уехали", async () => {
    const res = await request(app)
      .post(`/api/v1/properties/${propertyId}/transfer`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ toAgentId, reason: "проверка передачи" });
    expect(res.status).toBe(403);
    const seller = await prisma.client.findUnique({ where: { id: sellerId } });
    expect(seller?.assignedAgentId).toBe(fromAgentId);
    expect(seller?.acceptedAt).not.toBeNull();
    const property = await prisma.property.findUnique({ where: { id: propertyId } });
    expect(property?.intakeAgentId).toBe(fromAgentId);
  });

  it("руководитель передаёт объект вместе с продавцом, как раньше", async () => {
    const res = await request(app)
      .post(`/api/v1/properties/${propertyId}/transfer`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ toAgentId, reason: "проверка передачи" });
    expect(res.status).toBe(200);
    expect(res.body.sellerMoved).toBe(true);
    const seller = await prisma.client.findUnique({ where: { id: sellerId } });
    expect(seller?.assignedAgentId).toBe(toAgentId);
  });
});
