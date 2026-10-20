import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

const { sendPushToAgent, hook } = vi.hoisted(() => ({
  sendPushToAgent: vi.fn(async () => undefined),
  /** Что выполнить внутри getDealPayout, между проверкой стадии в роуте и записью выплаты. */
  hook: { run: null as null | (() => Promise<void>) },
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));
vi.mock("../src/lib/dealDocumentsDb.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/dealDocumentsDb.js")>();
  return {
    ...actual,
    getDealPayout: async (dealId: string) => {
      const row = await actual.getDealPayout(dealId);
      // Роут уже прочитал стадию COMPLETED; ровно в это окно встаёт аннулирование.
      if (hook.run) await hook.run();
      return row;
    },
  };
});

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { grantElevation } = await import("../src/lib/stepUp.js");
const { annulDeal } = await import("../src/lib/dealAnnul.js");
const { getDealPayout } = await import("../src/lib/dealDocumentsDb.js");

/**
 * ВЫПЛАТА НЕ ПРОХОДИТ ПО АННУЛИРОВАННОЙ СДЕЛКЕ (аудит Codex 04.10.2026, №9).
 *
 * Роут проверял stage === COMPLETED отдельным чтением, а UPDATE в setDealPayout
 * условия на стадию не имел: аннулирование (CANCELLED), пришедшее между ними,
 * не мешало записи, и агенту уходил пуш «Комиссия выплачена» по аннулированной
 * сделке. Условие stage/annulledAt теперь в самом UPDATE.
 */

const runId = Date.now();
let directorId: string;
let agentId: string;
let districtId: string;
let token: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

async function makeClosedDeal() {
  const n = dealIds.length;
  const property = await prisma.property.create({
    data: {
      title: `Объект выплата-аннулирование ${runId}-${n}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, выплата",
      condition: "GOOD",
      status: "SOLD",
      soldAt: new Date(),
      soldPrice: 98000,
      assignedAgentId: agentId,
    },
  });
  propertyIds.push(property.id);
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент выплата-аннулирование ${runId}-${n}`,
      phone: `+99294${n}${runId}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      status: "DEAL_CLOSED",
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
      stage: "COMPLETED",
      soldPrice: 98000,
      commissionAmount: 2940,
      commissionRealtorAmount: 1470,
      commissionCompanyAmount: 1470,
      closedAt: new Date(),
    },
  });
  dealIds.push(deal.id);
  return deal;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-выплата-аннулирование-${runId}` } })).id;
  const director = await prisma.agent.create({
    data: { fullName: `Директор выплата ${runId}`, phone: `+99295${runId}1`, role: "DIRECTOR", passwordHash: "x" },
  });
  const agent = await prisma.agent.create({
    data: { fullName: `Агент выплата ${runId}`, phone: `+99295${runId}2`, role: "AGENT", passwordHash: "x" },
  });
  directorId = director.id;
  agentId = agent.id;
  grantElevation(directorId);
  token = signAccessToken({ sub: directorId, role: "DIRECTOR" });
});

afterAll(async () => {
  hook.run = null;
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await deleteAgentsWithTraces([directorId, agentId]);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("POST /deals/:id/payout против аннулирования", () => {
  it("аннулирование между проверкой стадии и записью: 409, выплата не записана, пуша нет", async () => {
    const deal = await makeClosedDeal();
    sendPushToAgent.mockClear();
    hook.run = async () => {
      hook.run = null;
      await annulDeal({ dealId: deal.id, actorId: directorId, reason: "Гонка выплаты" });
    };

    const res = await request(app)
      .post(`/api/v1/deals/${deal.id}/payout`)
      .set("Authorization", `Bearer ${token}`)
      .send({ note: "перевод" });

    expect(res.status).toBe(409);
    const stored = await getDealPayout(deal.id);
    expect(stored?.realtorPayoutAt).toBeNull();
    expect(sendPushToAgent).not.toHaveBeenCalled();
    const after = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(after?.stage).toBe("CANCELLED");
  });

  it("обычная выплата по закрытой сделке по-прежнему проходит и шлёт пуш агенту", async () => {
    const deal = await makeClosedDeal();
    sendPushToAgent.mockClear();
    const res = await request(app)
      .post(`/api/v1/deals/${deal.id}/payout`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(sendPushToAgent).toHaveBeenCalledTimes(1);
  });
});
