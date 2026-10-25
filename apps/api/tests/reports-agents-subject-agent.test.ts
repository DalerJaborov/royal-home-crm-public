import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { logTimeline } from "../src/lib/timeline.js";

/**
 * Задание Б2-КПИ (18.09.2026, docs/archive/agent-briefs/timeline-kpi-subject-agent-18-09.md):
 * GET /reports/agents считал показы по агенту groupBy(["agentId"]) — после Б1/Б2
 * показ, записанный ботом от лица клиента, пишется с agentId: null и
 * subjectAgentId: держатель, groupBy по agentId такую строку теряет вовсе.
 */

const runId = Date.now();
let agentId: string;
let managerId: string;
let managerToken: string;
let clientId: string;

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент отчёта показов", phone: `+992942${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  const manager = await prisma.agent.create({
    data: { fullName: "Руководитель отчёта показов", phone: `+992943${runId}`, role: "MANAGER", passwordHash: "x" },
  });
  managerId = manager.id;
  managerToken = signAccessToken({ sub: manager.id, role: "MANAGER" });
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент отчёта показов ${runId}`,
        phone: `+992944${runId}`,
        source: "WALK_IN",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;

  await logTimeline({
    clientId,
    actor: { kind: "bot", source: "test-bot-reports-agents-showing", subjectAgentId: agentId, channel: "whatsapp" },
    type: "SHOWING",
    nextActionDate: new Date(),
    showingOffCrm: true,
    showingOffCrmDetails: "Тестовый объект вне CRM, улица Проверочная 1",
    notes: `Бот записал показ отчёта показов ${runId}`,
  });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  // Убираем по id, а не по имени с runId: имена этих двоих его не содержат, и
  // прежняя уборка не удаляла ни одного — оба оставались активными в общей базе
  // и попадали в чужие очереди раздачи (класс из CLAUDE.md, помощник
  // tests/helpers/cleanupAgents.ts).
  await deleteAgentsWithTraces([agentId, managerId]);
  await prisma.$disconnect();
});

describe("GET /reports/agents: показ бота засчитывается держателю", () => {
  it("приватные показы агента и системы не меняют обычный отчёт", async () => {
    const privateRows = await prisma.interaction.createManyAndReturn({ data: [
      { clientId, agentId, type: "SHOWING", investigationOnly: true, notes: "private authored" },
      { clientId, actorKind: "SYSTEM", subjectAgentId: agentId, type: "SHOWING", investigationOnly: true, notes: "private system" },
    ], select: { id: true } });
    try {
      const res = await request(app).get("/api/v1/reports/agents").set("Authorization", `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.find((r: { agentId: string }) => r.agentId === agentId).showings).toBe(1);
    } finally {
      await prisma.interaction.deleteMany({ where: { id: { in: privateRows.map((r) => r.id) } } });
    }
  });
  it("строка агента считает показ, записанный ботом от его лица", async () => {
    const res = await request(app).get("/api/v1/reports/agents").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const row = (res.body as { agentId: string; showings: number }[]).find((r) => r.agentId === agentId);
    expect(row).toBeDefined();
    expect(row!.showings).toBe(1);
  });
});
