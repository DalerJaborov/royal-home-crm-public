import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * Гонка «Вернуть на доработку» и «Одобрить» (глубокая проверка 02.10.2026, C9).
 *
 * Решение о переходе принимается по сделке, прочитанной ДО транзакции, а запись
 * защищала только версия — которую «Одобрить» с пульта не шлёт. Если возврат на
 * доработку успел между чтением и записью одобрения, сделка становилась
 * COMPLETED с обнулёнными ценой и долями, объект — SOLD. Теперь запись идёт с
 * условием «стадия та же, что прочитали», иначе 409.
 */

const runId = Date.now();
const password = "testpass123";
let directorId = "";
let agentId = "";
let token = "";
let districtId = "";
let propertyId = "";
let clientId = "";
let dealId = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const director = await prisma.agent.create({
    data: { fullName: "Директор гонка", phone: `+992942${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  agentId = (
    await prisma.agent.create({ data: { fullName: "Агент гонка", phone: `+992941${runId}`, role: "AGENT", passwordHash } })
  ).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  grantElevation(directorId);
  token = res.body.accessToken as string;
  districtId = (await prisma.district.create({ data: { name: `Район гонка ${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект гонка ${runId}`,
        type: "APARTMENT",
        areaSqm: 40,
        price: 100000,
        currency: "TJS",
        districtId,
        address: "Тестовая, гонка",
        condition: "GOOD",
        status: "RESERVED",
        reservedAt: new Date(),
        assignedAgentId: agentId,
      },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: { fullName: `Клиент гонка ${runId}`, phone: `+992940${runId}`, source: "PHONE_CALL", assignedAgentId: agentId },
    })
  ).id;
  await prisma.interaction.create({
    data: { clientId, propertyId, agentId, type: "SHOWING", notes: "Показ", completedAt: new Date() },
  });
  dealId = (
    await prisma.deal.create({
      data: {
        clientId,
        propertyId,
        agentId,
        stage: "PENDING_APPROVAL",
        soldPrice: 100000,
        commissionAmount: 2000,
        commissionRealtorAmount: 1000,
        commissionCompanyAmount: 1000,
        currency: "TJS",
      },
    })
  ).id;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.deal.deleteMany({ where: { id: dealId } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
});

describe("C9: одобрение поверх только что возвращённой на доработку сделки", () => {
  it("409, сделка остаётся на доработке, объект не продан", async () => {
    const original = prisma.deal.findUnique.bind(prisma.deal);
    const spy = vi.spyOn(prisma.deal, "findUnique").mockImplementationOnce((async (args: Parameters<typeof original>[0]) => {
      const read = await original(args);
      // Второй руководитель успел «Вернуть на доработку» сразу после нашего чтения.
      await prisma.deal.update({
        where: { id: dealId },
        data: {
          stage: "CONTRACT_SIGNED",
          soldPrice: null,
          commissionAmount: null,
          commissionRealtorAmount: null,
          commissionCompanyAmount: null,
          version: { increment: 1 },
        },
      });
      return read;
    }) as never);

    const res = await request(app).patch(`/api/v1/deals/${dealId}`).set("Authorization", `Bearer ${token}`).send({ stage: "COMPLETED" });
    spy.mockRestore();

    expect(res.status).toBe(409);
    const deal = await prisma.deal.findUnique({ where: { id: dealId } });
    expect(deal?.stage).toBe("CONTRACT_SIGNED");
    const property = await prisma.property.findUnique({ where: { id: propertyId } });
    expect(property?.status).toBe("RESERVED");
  });
});
