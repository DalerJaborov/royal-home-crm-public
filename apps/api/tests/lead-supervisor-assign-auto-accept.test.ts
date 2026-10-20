import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { randomInt } from "node:crypto";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Владелец 23.09.2026: «если директор или администратор назначает лид клиента
 * напрямую из CRM конкретному агенту — таймера нет, лид принят автоматически,
 * пуш агенту, а на Главной он видит, что ему назначили».
 *
 * До правки /assign ставил acceptedAt: null, и через 15 минут круг «не принял»
 * уводил лид от выбранного руководителем агента.
 */

const { push } = vi.hoisted(() => ({ push: vi.fn(async () => undefined) }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: push,
  sendPushToAgents: push,
}));

const { app } = await import("../src/app.js");
const { reassignStaleLeads } = await import("../src/services/leads/reassignment.js");

const runId = `${Date.now()}${randomInt(1000, 9999)}`;
const password = "testpass123";
const phone = () => `+99294${randomInt(1_000_000, 9_999_999)}`;
const agentIds: string[] = [];
const clientIds: string[] = [];
let agentId: string;
let agentPhone: string;
let directorPhone: string;
let directorName: string;

async function login(p: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone: p, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeLead(holder: string) {
  const lead = await prisma.client.create({
    data: {
      fullName: `Назначение ${runId} ${clientIds.length}`,
      phone: phone(),
      source: "PHONE_CALL",
      kind: "SELLER",
      status: "NEW",
      assignedAgentId: holder,
      assignedAt: new Date(Date.now() - 5 * 60_000),
      acceptedAt: null,
      reassignCount: 2,
    },
  });
  clientIds.push(lead.id);
  return lead;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 4);
  agentPhone = phone();
  directorPhone = phone();
  directorName = `Директор назначения ${runId}`;
  agentId = (await prisma.agent.create({ data: { fullName: `Агент назначения ${runId}`, phone: agentPhone, role: "AGENT", passwordHash } })).id;
  const holderId = (await prisma.agent.create({ data: { fullName: `Прежний ${runId}`, phone: phone(), role: "AGENT", passwordHash } })).id;
  const directorId = (await prisma.agent.create({ data: { fullName: directorName, phone: directorPhone, role: "DIRECTOR", passwordHash } })).id;
  agentIds.push(agentId, holderId, directorId);
});

beforeEach(() => push.mockClear());

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { OR: [{ clientId: { in: clientIds } }, { agentId: { in: agentIds } }] } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.$disconnect();
});

describe("руководитель назначил лид агенту — принят сразу", () => {
  it("acceptedAt ставится, круг «не принял» лид не трогает, агенту пуш «назначили»", async () => {
    const lead = await makeLead(agentIds[1]);
    const directorToken = await login(directorPhone);

    const res = await request(app)
      .post(`/api/v1/clients/${lead.id}/assign`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ agentId });
    expect(res.status).toBe(200);

    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(agentId);
    expect(after?.acceptedAt).not.toBeNull();
    expect(after?.assignReason).toBe("supervisor_assigned");
    expect(after?.reassignCount).toBe(0);

    const toAgent = push.mock.calls.filter((c) => (c as unknown as [string])[0] === agentId);
    expect(toAgent.map((c) => (c as unknown as [string, { title?: string }])[1]?.title)).toContain("📌 Вам назначили клиента");

    // Даже когда 15 минут давно прошли, круг его не уводит.
    await prisma.client.update({ where: { id: lead.id }, data: { assignedAt: new Date(Date.now() - 60 * 60_000) } });
    await reassignStaleLeads();
    const later = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(later?.assignedAgentId).toBe(agentId);
  });

  it("на Главной агента строка «Вам назначил руководитель» с именем, после звонка пропадает", async () => {
    const lead = await makeLead(agentIds[1]);
    const directorToken = await login(directorPhone);
    await request(app)
      .post(`/api/v1/clients/${lead.id}/assign`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ agentId })
      .expect(200);

    const agentToken = await login(agentPhone);
    const dash = await request(app).get("/api/v1/dashboard/summary").set("Authorization", `Bearer ${agentToken}`);
    expect(dash.status).toBe(200);
    const row = (dash.body.assignedBySupervisor as { id: string; byName: string | null }[]).find((r) => r.id === lead.id);
    expect(row?.byName).toBe(directorName);

    await prisma.client.update({ where: { id: lead.id }, data: { lastAgentAttemptAt: new Date() } });
    const dash2 = await request(app).get("/api/v1/dashboard/summary").set("Authorization", `Bearer ${agentToken}`);
    expect((dash2.body.assignedBySupervisor as { id: string }[]).some((r) => r.id === lead.id)).toBe(false);
  });
});
