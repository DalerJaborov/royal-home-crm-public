import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { randomInt } from "node:crypto";

const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { grantElevation } = await import("../src/lib/stepUp.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

/**
 * Отключение сотрудника не бросает его лиды (23.09.2026, проверка раздачи,
 * пункт 16). Заморозка и удаление разбирали работу, а PATCH isActive=false —
 * нет: непринятые лиды оставались на учётке, в которую никто не войдёт.
 */

const runId = `${Date.now()}${randomInt(100, 999)}`;
const phone = () => `+99298${randomInt(1_000_000, 9_999_999)}`;
const password = "testpass123";
let directorToken = "";
let directorId = "";
const agentIds: string[] = [];
const clientIds: string[] = [];

async function makeAgent(name: string) {
  const a = await prisma.agent.create({
    data: { fullName: `${name} ${runId}`, phone: phone(), role: "AGENT", passwordHash: await bcrypt.hash(password, 4) },
  });
  agentIds.push(a.id);
  return a;
}

async function makeClient(
  agentId: string,
  accepted: boolean,
  status: "NEW" | "CONTACTED" | "HOT" | "COLD" | "UNRESPONSIVE" | "LOST" | "DEAL_CLOSED" = "NEW"
) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент отключённого ${runId}-${clientIds.length}`,
      phone: phone(),
      source: "PHONE_CALL",
      kind: "BUYER",
      status,
      assignedAgentId: agentId,
      assignedAt: new Date(),
      acceptedAt: accepted ? new Date() : null,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const director = await prisma.agent.create({
    data: { fullName: `Директор отключения ${runId}`, phone: phone(), role: "DIRECTOR", passwordHash: await bcrypt.hash(password, 4) },
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
  await deleteAgentsWithTraces([...agentIds, directorId]);
  await prisma.$disconnect();
});

describe("PATCH /agents/:id isActive=false", () => {
  it("непринятый лид уходит в очередь, клиент в работе остаётся, руководитель узнаёт о нём", async () => {
    const agent = await makeAgent("Отключаемый");
    const lead = await makeClient(agent.id, false);
    const working = await makeClient(agent.id, true);
    sendPushToAgents.mockClear();

    const res = await request(app)
      .patch(`/api/v1/agents/${agent.id}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.releasedLeads).toBe(1);
    expect(res.body.clientsLeft).toBe(1);

    expect((await prisma.client.findUniqueOrThrow({ where: { id: lead.id } })).assignedAgentId).toBeNull();
    expect((await prisma.client.findUniqueOrThrow({ where: { id: working.id } })).assignedAgentId).toBe(agent.id);

    const pushed = sendPushToAgents.mock.calls.find(
      (c) => (c as unknown as [string[], { tag?: string }])[1]?.tag === `agent-deactivate-${agent.id}`
    ) as unknown as [string[], { body: string }] | undefined;
    expect(pushed?.[0]).toContain(directorId);
    expect(pushed?.[1].body).toContain("передайте дела");
  });

  /**
   * №143 (ночная проверка 24.09): снимались только непринятые NEW/CONTACTED.
   * Непринятый HOT/COLD/UNRESPONSIVE (отказной, переданный руководителем,
   * розданный из портфеля) оставался на учётке, в которую никто не войдёт, с
   * висящим пушем «Новый лид». Правило «продавец не уходит никогда» — о
   * ПРИНЯТЫХ клиентах: непринятый лид человек ещё не брал. Закрытые карточки
   * (LOST, DEAL_CLOSED) в очередь не возвращаются — работать там нечего.
   */
  it("непринятый лид уходит в очередь при любом рабочем статусе, закрытые остаются", async () => {
    const agent = await makeAgent("Отключаемый со статусами");
    const hot = await makeClient(agent.id, false, "HOT");
    const cold = await makeClient(agent.id, false, "COLD");
    const silent = await makeClient(agent.id, false, "UNRESPONSIVE");
    const lost = await makeClient(agent.id, false, "LOST");
    const closed = await makeClient(agent.id, false, "DEAL_CLOSED");

    const res = await request(app)
      .patch(`/api/v1/agents/${agent.id}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.releasedLeads).toBe(3);

    for (const c of [hot, cold, silent]) {
      expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).assignedAgentId).toBeNull();
    }
    for (const c of [lost, closed]) {
      expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).assignedAgentId).toBe(agent.id);
    }
  });

  it("повторное «отключить» уже отключённого ничего не снимает", async () => {
    const agent = await makeAgent("Уже отключён");
    await prisma.agent.update({ where: { id: agent.id }, data: { isActive: false } });
    const res = await request(app)
      .patch(`/api/v1/agents/${agent.id}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.releasedLeads).toBeUndefined();
  });
});
