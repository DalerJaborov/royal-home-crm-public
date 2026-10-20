import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { grantElevation } = await import("../src/lib/stepUp.js");

/**
 * Разведка 07.09.2026 (класс «осиротевшие спутники»): «Предложение реактивации»
 * держится за конкретного агента. Заморозка и увольнение (DELETE /agents/:id)
 * — те же места, что уже гасят PendingSummary (см. соседние тесты) — раньше
 * никак не трогали reactivationOfferedToAgentId, и предложение оставалось
 * висеть на учётке, решать по которой больше некому.
 */

const runId = Date.now();
const password = "testpass123";
let directorToken = "";
let directorId = "";
const agentIds: string[] = [];
const clientIds: string[] = [];

async function makeAgent(name: string) {
  const passwordHash = await bcrypt.hash(password, 10);
  const a = await prisma.agent.create({
    data: { fullName: `${name} ${runId}`, phone: `+992970${agentIds.length}${String(runId).slice(-6)}`, role: "AGENT", passwordHash },
  });
  agentIds.push(a.id);
  return a;
}

async function makeOfferedClient(agentId: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `Предложенный клиент ${runId}-${clientIds.length}`,
      phone: `+992971${clientIds.length}${String(runId).slice(-6)}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      workStatus: "INACTIVE",
      lastAgentId: agentId,
      reactivationOfferedToAgentId: agentId,
      reactivationOfferedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const director = await prisma.agent.create({
    data: { fullName: `Директор заморозки ${runId}`, phone: `+992969${String(runId).slice(-6)}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(res.status).toBe(200);
  grantElevation(director.id);
  directorToken = res.body.accessToken;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [...agentIds, directorId] } } });
  await prisma.$disconnect();
});

describe("POST /agents/:id/freeze снимает его предложения реактивации", () => {
  it("предложение уходит другому агенту, а не остаётся на замороженном", async () => {
    const agent = await makeAgent("Заморозка");
    const client = await makeOfferedClient(agent.id);

    const res = await request(app)
      .post(`/api/v1/agents/${agent.id}/freeze`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ reason: "Тест снятия предложения реактивации" });
    expect(res.status).toBe(200);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(after.reactivationOfferedToAgentId).toBeNull();
    expect(after.assignedAgentId).not.toBe(agent.id);
  });
});

describe("DELETE /agents/:id снимает предложения реактивации перед раздачей дел", () => {
  it("предложение снимается независимо от того, удалился агент физически или был деактивирован", async () => {
    const agent = await makeAgent("Увольнение");
    const client = await makeOfferedClient(agent.id);
    // История взаимодействий держит FK без каскада — физический delete упрётся
    // в него и уйдёт по ветке «деактивируем вместо удаления» (P2003), где
    // строка агента ОСТАЁТСЯ и без явного снятия предложение осталось бы висеть.
    await prisma.interaction.create({
      data: { clientId: client.id, agentId: agent.id, type: "SYSTEM", notes: "История, блокирующая физическое удаление" },
    });

    const res = await request(app)
      .delete(`/api/v1/agents/${agent.id}`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect([200]).toContain(res.status);
    expect(res.body.deactivatedInsteadOfDeleted).toBe(true);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(after.reactivationOfferedToAgentId).toBeNull();
    expect(after.assignedAgentId).not.toBe(agent.id);
  });
});
