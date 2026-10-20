import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

/**
 * ОДОБРЯЮЩИЙ ВИДИТ СУММЫ ТОЙ СДЕЛКИ, КОТОРУЮ ОДОБРЯЕТ (глубокая проверка
 * 02.10.2026, C15; решение владельца «да, по советам»).
 *
 * Менеджер (deals.complete, без finance.view) нажимал «Одобрить» не видя ни
 * цены, ни комиссии. Теперь сделка «Ждёт одобрения» приходит ему с суммами;
 * остальные сделки — без денег, как раньше (deal-manager-no-money.test.ts).
 * Служба безопасности видит все сделки, но одобрять не вправе — суммы ей
 * не открываются.
 */

const runId = Date.now();

let managerId: string;
let securityId: string;
let agentId: string;
let managerToken: string;
let securityToken: string;
let districtId: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

async function makeDeal(stage: "NEGOTIATION" | "PENDING_APPROVAL" | "COMPLETED") {
  const n = dealIds.length;
  const property = await prisma.property.create({
    data: {
      title: `Объект одобряющего ${runId}-${n}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, одобряющий",
      condition: "GOOD",
    },
  });
  propertyIds.push(property.id);
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент одобряющего ${runId}-${n}`,
      phone: `+99295${n}${runId}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(client.id);
  const deal = await prisma.deal.create({
    data: {
      clientId: client.id,
      propertyId: property.id,
      agentId,
      stage,
      soldPrice: 95000,
      commissionAmount: 2850,
      commissionRealtorAmount: 1425,
      commissionCompanyAmount: 1425,
      closedAt: stage === "COMPLETED" ? new Date() : null,
    },
  });
  dealIds.push(deal.id);
  return deal;
}

type MoneyDeal = { id: string; soldPrice?: unknown; commissionAmount?: unknown; commissionRealtorAmount?: unknown };

async function listAs(token: string): Promise<MoneyDeal[]> {
  const res = await request(app).get("/api/v1/deals").set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body as MoneyDeal[];
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-одобряющий-${runId}` } })).id;
  const manager = await prisma.agent.create({
    data: { fullName: `Менеджер одобряет ${runId}`, phone: `+99294${runId}1`, role: "MANAGER", passwordHash: "x" },
  });
  const security = await prisma.agent.create({
    data: { fullName: `Безопасность ${runId}`, phone: `+99294${runId}2`, role: "SECURITY", passwordHash: "x" },
  });
  const agent = await prisma.agent.create({
    data: { fullName: `Агент сделки ${runId}`, phone: `+99294${runId}3`, role: "AGENT", passwordHash: "x" },
  });
  managerId = manager.id;
  securityId = security.id;
  agentId = agent.id;
  managerToken = signAccessToken({ sub: manager.id, role: "MANAGER" });
  securityToken = signAccessToken({ sub: security.id, role: "SECURITY" });
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await deleteAgentsWithTraces([managerId, securityId, agentId]);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Суммы сделки на одобрении — тому, кто одобряет (C15)", () => {
  it("менеджер видит цену и комиссию сделки «Ждёт одобрения»", async () => {
    const pending = await makeDeal("PENDING_APPROVAL");
    const res = await request(app)
      .get("/api/v1/deals?stage=PENDING_APPROVAL")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const deal = (res.body as MoneyDeal[]).find((d) => d.id === pending.id);
    expect(deal).toBeTruthy();
    expect(deal!.soldPrice).toBe(95000);
    expect(deal!.commissionAmount).toBe(2850);
    expect(deal!.commissionRealtorAmount).toBe(1425);
  });

  it("остальные сделки (в работе и закрытые) — по-прежнему без денег", async () => {
    const working = await makeDeal("NEGOTIATION");
    const closed = await makeDeal("COMPLETED");
    const list = await listAs(managerToken);
    for (const id of [working.id, closed.id]) {
      const deal = list.find((d) => d.id === id);
      expect(deal).toBeTruthy();
      expect(Object.prototype.hasOwnProperty.call(deal, "commissionAmount")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(deal, "soldPrice")).toBe(false);
    }
  });

  it("служба безопасности видит сделку на одобрении, но без денег — одобрять она не вправе", async () => {
    const pending = await makeDeal("PENDING_APPROVAL");
    const deal = (await listAs(securityToken)).find((d) => d.id === pending.id);
    expect(deal).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(deal, "commissionAmount")).toBe(false);
  });
});
