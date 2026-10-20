import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ГЛУБОКАЯ ПРОВЕРКА 02.10.2026, A3 — «видеть все сделки» не значит «писать в них».
 *
 * Служба безопасности по пресету видит клиентов и сделки целиком (clients.viewAll,
 * deals.viewAll), «но ничего не меняет». Владение в PATCH /deals/:id решал один
 * scopeDealsToOwnAgent, а он пропускает любого с deals.viewAll: сотрудник СБ мог
 * отменить чужую живую сделку (объект продавца молча снимался с брони). POST
 * /deals пропускал его через canBindClient по clients.viewAll — сделка на чужого
 * покупателя, объект в брони.
 *
 * Для клиентов тот же класс закрыт правилом foreignWriteDenied (clients/shared.ts):
 * писать в чужое может тот, кто распределяет (clients.assign), а не тот, кто смотрит.
 */

const runId = `${Date.now()}`.slice(-7);
const password = "testpass123";

const agentIds: string[] = [];
let districtId: string;
let agentId: string;
let buyerId: string;
let reservedPropertyId: string;
let freePropertyId: string;
let dealId: string;
let securityToken: string;
let managerToken: string;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

function propertyData(title: string, status: "AVAILABLE" | "RESERVED") {
  return {
    title,
    type: "APARTMENT" as const,
    areaSqm: 60,
    price: 100000,
    currency: "USD" as const,
    districtId,
    address: `Тест ${runId}`,
    condition: "GOOD" as const,
    status,
  };
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `СБ-сделки-${runId}` } })).id;
  const agent = await prisma.agent.create({
    data: { fullName: `Агент сделки A3 ${runId}`, phone: `+992981${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  agentIds.push(agent.id);
  const security = await prisma.agent.create({
    data: { fullName: `СБ A3 ${runId}`, phone: `+992982${runId}`, role: "SECURITY", passwordHash },
  });
  agentIds.push(security.id);
  const manager = await prisma.agent.create({
    data: { fullName: `Руководитель A3 ${runId}`, phone: `+992983${runId}`, role: "MANAGER", passwordHash },
  });
  agentIds.push(manager.id);

  buyerId = (
    await prisma.client.create({
      data: {
        fullName: `Покупатель A3 ${runId}`,
        phone: `+992984${runId}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agent.id,
        acceptedAt: new Date(),
      },
    })
  ).id;
  reservedPropertyId = (
    await prisma.property.create({ data: { ...propertyData(`Бронь A3 ${runId}`, "RESERVED"), assignedAgentId: agent.id, reservedForClientId: buyerId } })
  ).id;
  freePropertyId = (await prisma.property.create({ data: propertyData(`Свободный A3 ${runId}`, "AVAILABLE") })).id;
  dealId = (
    await prisma.deal.create({ data: { clientId: buyerId, propertyId: reservedPropertyId, agentId: agent.id, stage: "NEGOTIATION" } })
  ).id;

  securityToken = await login(security.phone);
  managerToken = await login(manager.phone);
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { clientId: buyerId } });
  await prisma.property.deleteMany({ where: { id: { in: [reservedPropertyId, freePropertyId] } } });
  await prisma.interaction.deleteMany({ where: { clientId: buyerId } });
  await prisma.client.deleteMany({ where: { id: buyerId } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("A3: служба безопасности сделки только смотрит", () => {
  it("видит чужую сделку в списке", async () => {
    const res = await request(app).get("/api/v1/deals").set("Authorization", `Bearer ${securityToken}`);
    expect(res.status).toBe(200);
    const items = (Array.isArray(res.body) ? res.body : res.body.items) as { id: string }[];
    expect(items.some((d) => d.id === dealId)).toBe(true);
  });

  it("не может отменить чужую сделку — 403, бронь объекта цела", async () => {
    const res = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${securityToken}`)
      .send({ stage: "CANCELLED", rejectReason: "проверка" });
    expect(res.status).toBe(403);
    const deal = await prisma.deal.findUnique({ where: { id: dealId } });
    expect(deal?.stage).toBe("NEGOTIATION");
    const property = await prisma.property.findUnique({ where: { id: reservedPropertyId } });
    expect(property?.status).toBe("RESERVED");
  });

  it("не может править заметки чужой сделки — 403", async () => {
    const res = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${securityToken}`)
      .send({ notes: "переписано СБ" });
    expect(res.status).toBe(403);
  });

  it("не может завести сделку на чужого покупателя — 403, объект свободен", async () => {
    const res = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${securityToken}`)
      .send({ clientId: buyerId, propertyId: freePropertyId });
    expect(res.status).toBe(403);
    const property = await prisma.property.findUnique({ where: { id: freePropertyId } });
    expect(property?.status).toBe("AVAILABLE");
  });

  it("руководитель (clients.assign, deals.complete) по-прежнему правит чужую сделку", async () => {
    const res = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ notes: "заметка руководителя" });
    expect(res.status).toBe(200);
  });
});

/**
 * A8 (та же проверка) — выплата по сделке закрывалась правом на ДОКУМЕНТЫ.
 * dealDocumentsRouter вешал `requirePermission("deals.manageDocuments")` через
 * `.use`, а смонтирован на /deals раньше dealPayoutRouter — значит мидлвар
 * срабатывал и на /:id/payout. Служба безопасности (deals.viewAll, без права на
 * документы) получала 403 на чтение выплаты, которое ей положено своим правом.
 */
describe("A8: выплата проверяется своими правами, а не правом на документы", () => {
  it("служба безопасности читает выплату чужой сделки", async () => {
    const res = await request(app).get(`/api/v1/deals/${dealId}/payout`).set("Authorization", `Bearer ${securityToken}`);
    expect(res.status).toBe(200);
    expect(res.body.stage).toBeDefined();
  });

  it("а документы сделки ей по-прежнему закрыты", async () => {
    const res = await request(app).get(`/api/v1/deals/${dealId}/documents`).set("Authorization", `Bearer ${securityToken}`);
    expect(res.status).toBe(403);
  });
});
