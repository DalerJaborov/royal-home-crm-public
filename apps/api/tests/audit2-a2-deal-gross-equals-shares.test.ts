import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * CRM-01 (аудит 04.10.2026): PATCH закрытой сделки с commissionAmount и обеими
 * долями сохранял как есть: общая 4000 против долей 1000 + 2000 (3000). Пустая
 * ветка «доли введены руками вместе с переоценкой» обходила пересчёт. Доли
 * остаются истиной (решение 26.08.2026), общая комиссия равна их сумме.
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
    data: { fullName: "Директор CRM-01", phone: `+992936${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  agentId = (
    await prisma.agent.create({ data: { fullName: "Агент CRM-01", phone: `+992935${runId}`, role: "AGENT", passwordHash } })
  ).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  grantElevation(directorId);
  token = res.body.accessToken as string;
  districtId = (await prisma.district.create({ data: { name: `Район CRM-01 ${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект CRM-01 ${runId}`,
        type: "APARTMENT",
        areaSqm: 40,
        price: 100000,
        currency: "TJS",
        districtId,
        address: "Тестовая, CRM-01",
        condition: "GOOD",
        status: "SOLD",
      },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: { fullName: `Клиент CRM-01 ${runId}`, phone: `+992934${runId}`, source: "PHONE_CALL", assignedAgentId: agentId },
    })
  ).id;
  dealId = (
    await prisma.deal.create({
      data: {
        clientId,
        propertyId,
        agentId,
        stage: "COMPLETED",
        closedAt: new Date(),
        soldPrice: 100000,
        commissionAmount: 1500,
        commissionRealtorAmount: 500,
        commissionCompanyAmount: 1000,
        currency: "TJS",
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.deal.deleteMany({ where: { id: dealId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
});

describe("правка закрытой сделки: общая комиссия равна сумме долей (CRM-01)", () => {
  it("commissionAmount=4000 при долях 1000+2000 сохраняется как 3000, процент от цены пересчитан", async () => {
    const res = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ commissionAmount: 4000, commissionRealtorAmount: 1000, commissionCompanyAmount: 2000 });
    expect(res.status).toBe(200);

    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
    expect(Number(deal.commissionRealtorAmount)).toBe(1000);
    expect(Number(deal.commissionCompanyAmount)).toBe(2000);
    expect(Number(deal.commissionAmount)).toBe(3000);
    expect(Number(deal.commissionPercent)).toBe(3);
  });

  it("только commissionAmount без долей: прежнее поведение, снапшот масштабируется", async () => {
    const res = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ commissionAmount: 6000 });
    expect(res.status).toBe(200);
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
    expect(Number(deal.commissionAmount)).toBe(6000);
    expect(Number(deal.commissionRealtorAmount) + Number(deal.commissionCompanyAmount)).toBe(6000);
  });
});
