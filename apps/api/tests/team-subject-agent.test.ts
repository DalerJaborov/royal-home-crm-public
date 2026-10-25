import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { logTimeline } from "../src/lib/timeline.js";

/**
 * Задание Б2-КПИ (18.09.2026, docs/archive/agent-briefs/timeline-kpi-subject-agent-18-09.md):
 * GET /team — месячная сводка по сотруднику (interactions/showings) и GET
 * /team/stages — «показов назначено» фильтровали Interaction строго по agentId.
 * После Б1/Б2 показ, записанный/назначенный ботом от лица клиента, пишется с
 * agentId: null и subjectAgentId: держатель — сводка обязана его видеть.
 */

const runId = Date.now();
const password = "testpass123";
let agentId: string;
let directorToken: string;
let clientId: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const directorPhone = `+992945${runId}`;
  await prisma.agent.create({
    data: { fullName: `Директор команды-субъект ${runId}`, phone: directorPhone, role: "DIRECTOR", passwordHash },
  });
  directorToken = await login(directorPhone);

  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент команды-субъект ${runId}`, phone: `+992946${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент команды-субъект ${runId}`,
        phone: `+992947${runId}`,
        source: "WALK_IN",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;

  await logTimeline({
    clientId,
    actor: { kind: "bot", source: "test-bot-team-showing", subjectAgentId: agentId, channel: "whatsapp" },
    type: "SHOWING",
    nextActionDate: new Date(),
    showingOffCrm: true,
    showingOffCrmDetails: "Тестовый объект вне CRM, улица Проверочная 1",
    notes: `Бот записал показ команды ${runId}`,
  });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { fullName: { contains: `${runId}` } } });
  await prisma.$disconnect();
});

describe("GET /team: месячная сводка видит показ бота через subjectAgentId", () => {
  it("interactions/showings этого агента включают запись бота", async () => {
    const res = await request(app).get("/api/v1/team").set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    const row = (res.body as { id: string; month: { showings: number; interactions: number } }[]).find((r) => r.id === agentId);
    expect(row).toBeDefined();
    expect(row!.month.showings).toBeGreaterThanOrEqual(1);
    expect(row!.month.interactions).toBeGreaterThanOrEqual(1);
  });
});
