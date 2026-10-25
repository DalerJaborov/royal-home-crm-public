import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { logTimeline } from "../src/lib/timeline.js";

/**
 * Задание Б2-КПИ (18.09.2026, docs/archive/agent-briefs/timeline-kpi-subject-agent-18-09.md):
 * GET /dashboard/summary — воронка личного дашборда агента (showingsThisWeek/
 * showingsThisMonth/contactedClientIds) фильтровала Interaction строго по
 * agentId. После Б1/Б2 показ и контакт, записанные ботом от лица клиента,
 * пишутся с agentId: null и subjectAgentId: держатель — воронка обязана
 * по-прежнему их видеть.
 */

const runId = Date.now();
let agentId: string;
let agentToken: string;
let clientId: string;

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент воронки", phone: `+992940${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  agentToken = signAccessToken({ sub: agentId, role: "AGENT" });
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент воронки ${runId}`,
        phone: `+992941${runId}`,
        source: "WALK_IN",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;

  // Показ и звонок — оба от лица бота, agentId: null, subjectAgentId: держатель.
  await logTimeline({
    clientId,
    actor: { kind: "bot", source: "test-bot-summary-showing", subjectAgentId: agentId, channel: "whatsapp" },
    type: "SHOWING",
    nextActionDate: new Date(),
    showingOffCrm: true,
    showingOffCrmDetails: "Тестовый объект вне CRM, улица Проверочная 1",
    notes: `Бот записал показ воронки ${runId}`,
  });
  await logTimeline({
    clientId,
    actor: { kind: "bot", source: "test-bot-summary-call", subjectAgentId: agentId, channel: "whatsapp" },
    type: "CALL",
    notes: `Бот записал звонок воронки ${runId}`,
  });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("GET /dashboard/summary: воронка агента видит записи бота", () => {
  it("показ и контакт бота от лица держателя карточки попадают в воронку недели/месяца", async () => {
    const res = await request(app).get("/api/v1/dashboard/summary").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    const showingsStep = res.body.funnel.find((f: { key: string }) => f.key === "showings");
    const contactedStep = res.body.funnel.find((f: { key: string }) => f.key === "contacted");
    expect(showingsStep.count).toBeGreaterThanOrEqual(1);
    expect(contactedStep.count).toBeGreaterThanOrEqual(1);
  });
});
