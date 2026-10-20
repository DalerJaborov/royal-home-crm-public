import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

/**
 * МЕНЕДЖЕР НЕ ВИДИТ ДЕНЬГИ СДЕЛКИ (ночная проверка 24.09.2026, №159/М4).
 *
 * Подпись пресета MANAGER в permissions.ts обещает «...но без денег» —
 * владелец подтвердил это дословно: менеджер работает без денег. У пресета
 * при этом было право deals.setCommission, а сервер отдавал ему суммы
 * комиссии в каждой сделке ничем не отличаясь от директора. Три вещи разом:
 * 1) deals.setCommission убран из пресета MANAGER;
 * 2) GET /deals (список и создание/правка) — commissionAmount и другие
 *    денежные поля сделки отдаются только с finance.view или на своей сделке;
 * 3) PATCH с commissionAmount от менеджера — 403 (это уже ловил canSetCommission,
 *    но только после того, как право реально убрано из пресета).
 */

const runId = Date.now();

let directorId: string;
let managerId: string;
let agentId: string;
let directorToken: string;
let managerToken: string;
let agentToken: string;
let districtId: string;
let clientId: string;
let propertyId: string;
let dealId: string;

beforeAll(async () => {
  const district = await prisma.district.create({ data: { name: `Тест-район-деньги-менеджера-${runId}` } });
  districtId = district.id;

  const director = await prisma.agent.create({
    data: { fullName: `Директор деньги ${runId}`, phone: `+99296${runId}1`, role: "DIRECTOR", passwordHash: "x" },
  });
  const manager = await prisma.agent.create({
    data: { fullName: `Менеджер деньги ${runId}`, phone: `+99296${runId}2`, role: "MANAGER", passwordHash: "x" },
  });
  const agent = await prisma.agent.create({
    data: { fullName: `Агент деньги ${runId}`, phone: `+99296${runId}3`, role: "AGENT", passwordHash: "x" },
  });
  directorId = director.id;
  managerId = manager.id;
  agentId = agent.id;
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });
  managerToken = signAccessToken({ sub: manager.id, role: "MANAGER" });
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });

  const property = await prisma.property.create({
    data: {
      title: `Объект деньги менеджера ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, деньги менеджера",
      condition: "GOOD",
      intakeAgentId: agentId,
    },
  });
  propertyId = property.id;

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент деньги менеджера ${runId}`,
      phone: `+99297${runId}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;

  const created = await request(app)
    .post("/api/v1/deals")
    .set("Authorization", `Bearer ${agentToken}`)
    .send({ clientId, propertyId, agentId });
  expect(created.status).toBe(201);
  dealId = created.body.id;
  // Сделка создаётся с автоматически посчитанной комиссией (по Настройкам) —
  // без этого весь тест проверял бы поле, которого и так нет ни у кого.
  expect(created.body.commissionAmount).toBeTruthy();
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: dealId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await deleteAgentsWithTraces([directorId, managerId, agentId]);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Деньги сделки — по finance.view, а не по team.viewFull/deals.viewAll", () => {
  it("менеджер получает сделку в списке БЕЗ commissionAmount", async () => {
    const res = await request(app).get("/api/v1/deals").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const deal = (res.body as { id: string; commissionAmount?: unknown }[]).find((d) => d.id === dealId);
    expect(deal).toBeTruthy();
    expect(deal!.commissionAmount).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(deal, "commissionAmount")).toBe(false);
  });

  it("директор получает ту же сделку С commissionAmount", async () => {
    const res = await request(app).get("/api/v1/deals").set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    const deal = (res.body as { id: string; commissionAmount?: unknown }[]).find((d) => d.id === dealId);
    expect(deal).toBeTruthy();
    expect(typeof deal!.commissionAmount).toBe("number");
  });

  it("агент видит commissionAmount на своей же сделке", async () => {
    const res = await request(app).get("/api/v1/deals").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    const deal = (res.body as { id: string; commissionAmount?: unknown }[]).find((d) => d.id === dealId);
    expect(deal).toBeTruthy();
    expect(typeof deal!.commissionAmount).toBe("number");
  });

  it("PATCH commissionAmount от менеджера — 403", async () => {
    const res = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ commissionAmount: 5000 });
    expect(res.status).toBe(403);
  });
});
