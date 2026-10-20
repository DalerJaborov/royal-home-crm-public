import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { changeClientAgent } from "../src/lib/changeClientAgent.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Пачка 16 (11.09.2026, docs/archive/agent-briefs/ownership-security-11-09.md):
 * GET /clients/:id агенту, у которого клиента забрали (`lastAgentId` — он же),
 * отдаёт 200 с `access.readOnly` вместо 403 — карточка ещё нужна ему, чтобы
 * понять, кому клиента передали и почему (routes/clients/card.ts,
 * loadTransferAccess). Случайному агенту без всякой истории с клиентом
 * 403 остаётся как было.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentAId: string; // прежний владелец — тот, у кого клиента забрали
let agentBId: string; // новый владелец
let agentCId: string; // посторонний, никогда не имел отношения к клиенту
let clientId: string;
let clientShortId: number;
let propertyId: string;
let dealId: string;

let agentAToken: string;
let agentBToken: string;
let agentCToken: string;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  const agent = await prisma.agent.findUnique({ where: { phone }, select: { id: true } });
  if (agent) grantElevation(agent.id);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);

  const district = await prisma.district.create({ data: { name: `Тест-район-перенос-${runId}` } });
  districtId = district.id;

  const agentA = await prisma.agent.create({
    data: { fullName: "Прежний агент", phone: `+992970${runId}`, role: "AGENT", passwordHash },
  });
  agentAId = agentA.id;

  const agentB = await prisma.agent.create({
    data: { fullName: "Новый агент", phone: `+992971${runId}`, role: "AGENT", passwordHash },
  });
  agentBId = agentB.id;

  const agentC = await prisma.agent.create({
    data: { fullName: "Посторонний агент", phone: `+992972${runId}`, role: "AGENT", passwordHash },
  });
  agentCId = agentC.id;

  const client = await prisma.client.create({
    data: {
      fullName: "Клиент на передачу",
      phone: `+992973${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentAId,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
  clientShortId = client.shortId;

  // Передача через единый вход — ровно то, что делают declineLead/reassignStaleLeads/
  // freeze/handover и т.д. (см. шапку lib/changeClientAgent.ts). Пишет lastAgentId,
  // Interaction[SYSTEM] и AuditLog(CLIENT_AGENT_CHANGE) — три поля, которые и читает
  // loadTransferAccess в routes/clients/card.ts.
  await changeClientAgent({
    clientId,
    toAgentId: agentBId,
    reason: "лид просрочен, передан руководителем",
    actorId: null,
    source: "test.transfer",
  });

  // Сделка нового владельца с комиссией (находка №122, ночная проверка
  // 24.09.2026): бывший владелец должен видеть карточку (access.readOnly), но
  // не эту чужую сделку — ни саму сделку, ни тем более комиссию по ней.
  const property = await prisma.property.create({
    data: {
      title: `Объект переноса ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "AVAILABLE",
    },
  });
  propertyId = property.id;
  const deal = await prisma.deal.create({
    data: { clientId, propertyId, agentId: agentBId, commissionAmount: 3000, soldPrice: 40000 },
  });
  dealId = deal.id;

  agentAToken = await login(agentA.phone);
  agentBToken = await login(agentB.phone);
  agentCToken = await login(agentC.phone);
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: dealId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.auditLog.deleteMany({ where: { entityType: "Client", entityId: clientId } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await deleteAgentsWithTraces([agentAId, agentBId, agentCId]);
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("GET /clients/:id — карточка переданного клиента", () => {
  it("новый агент видит карточку как обычно, без access", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientShortId}`)
      .set("Authorization", `Bearer ${agentBToken}`);
    expect(res.status).toBe(200);
    expect(res.body.assignedAgentId).toBe(agentBId);
    expect(res.body.access).toBeUndefined();
  });

  it("прежний агент получает 200 с access.readOnly вместо 403", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientShortId}`)
      .set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.access).toEqual({
      readOnly: true,
      transferredTo: { id: agentBId, fullName: "Новый агент" },
      transferredAt: expect.any(String),
      reason: "лид просрочен, передан руководителем",
    });
  });

  it("прежний агент не видит в карточке чужую сделку нового владельца (находка №122)", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientShortId}`)
      .set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.deals.find((d: { id: string }) => d.id === dealId)).toBeUndefined();
  });

  it("новый агент видит свою сделку в карточке с комиссией", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientShortId}`)
      .set("Authorization", `Bearer ${agentBToken}`);
    expect(res.status).toBe(200);
    const deal = res.body.deals.find((d: { id: string }) => d.id === dealId);
    expect(deal).toBeDefined();
    expect(deal.commissionAmount).toBe(3000);
  });

  it("посторонний агент без истории с клиентом по-прежнему получает 403", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientShortId}`)
      .set("Authorization", `Bearer ${agentCToken}`);
    expect(res.status).toBe(403);
  });

  it("прежний агент всё равно не может писать в карточку (foreignWriteDenied)", async () => {
    const res = await request(app)
      .patch(`/api/v1/clients/${clientId}`)
      .set("Authorization", `Bearer ${agentAToken}`)
      .send({ fullName: "Попытка переименовать" });
    expect(res.status).toBe(403);
  });
});
