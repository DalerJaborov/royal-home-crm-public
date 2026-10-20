import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * «Пульс компании» — фаза 4 (план 31.08.2026, §6 п.7/8): лидерборд недели в
 * зонной сетке и «Вопрос к данным». Мокаем ai/client.js (тот же приём, что
 * ai-scoring.test.ts) — реальный вызов Gemini здесь не нужен, важно, что роут
 * собирает данные, зовёт модель и честно отдаёт отказ при её молчании.
 */

let aiReply: { answer?: string } | null = { answer: "Тестовый ответ по данным." };
const aiCalls: { user: string }[] = [];
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: async (params: { user?: string }) => {
    aiCalls.push({ user: params.user ?? "" });
    return aiReply;
  },
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
let agentToken = "";
let adminToken = "";
let managerToken = "";
let agentId = "";
let adminId = "";
let managerId = "";
let scoreAgentId = "";

async function missionControl(token: string) {
  return request(app).get("/api/v1/dashboard/mission-control").set("Authorization", `Bearer ${token}`);
}
async function ask(token: string, question: string) {
  return request(app)
    .post("/api/v1/dashboard/mission-control/ask")
    .set("Authorization", `Bearer ${token}`)
    .send({ question });
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент MC4 ${runId}`, phone: `+99274${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  const admin = await prisma.agent.create({
    data: { fullName: `Админ MC4 ${runId}`, phone: `+99275${String(runId).slice(-7)}`, role: "ADMIN", passwordHash: "x" },
  });
  const manager = await prisma.agent.create({
    data: { fullName: `Менеджер MC4 ${runId}`, phone: `+99276${String(runId).slice(-7)}`, role: "MANAGER", passwordHash: "x" },
  });
  const scoreAgent = await prisma.agent.create({
    data: { fullName: `Лидер недели ${runId}`, phone: `+99277${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
  adminId = admin.id;
  managerId = manager.id;
  scoreAgentId = scoreAgent.id;
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });
  adminToken = signAccessToken({ sub: admin.id, role: "ADMIN" });
  managerToken = signAccessToken({ sub: manager.id, role: "MANAGER" });

  // Очко KpiDailyScore за сегодня — должно попасть в лидерборд недели. Счёт
  // намеренно огромный: база общая с другими параллельными прогонами тестов
  // (см. CLAUDE.md про воркеры), топ-5 капается в lib/leaderboard.ts, и
  // обычный балл рисковал не попасть в выборку из-за чужих данных.
  await prisma.kpiDailyScore.create({
    data: { agentId: scoreAgentId, date: new Date(new Date().toISOString().slice(0, 10)), score: 999_999 },
  });
});

afterAll(async () => {
  await prisma.kpiDailyScore.deleteMany({ where: { agentId: scoreAgentId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, adminId, managerId, scoreAgentId] } } });
  await prisma.$disconnect();
});

describe("GET /dashboard/mission-control — лидерборд недели", () => {
  it("присутствует в ответе и содержит агента с сегодняшним очком", async () => {
    const res = await missionControl(adminToken);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("leaderboard");
    expect(Array.isArray(res.body.leaderboard.agents)).toBe(true);
    const entry = res.body.leaderboard.agents.find((a: { id: string }) => a.id === scoreAgentId);
    expect(entry).toBeTruthy();
    expect(entry.score).toBe(999_999);
    expect(entry.place).toBeGreaterThan(0);
  });
});

describe("POST /dashboard/mission-control/ask", () => {
  it("рядовому агенту закрыт — нет dashboard.analytics", async () => {
    const res = await ask(agentToken, "сколько лидов сегодня?");
    expect(res.status).toBe(403);
  });

  it("отклоняет слишком короткий вопрос", async () => {
    const res = await ask(adminToken, "ку");
    expect(res.status).toBe(400);
  });

  it("отклоняет слишком длинный вопрос", async () => {
    const res = await ask(adminToken, "а".repeat(301));
    expect(res.status).toBe(400);
  });

  it("админу и менеджеру отвечает ответом модели, собранным по данным", async () => {
    const res = await ask(adminToken, "сколько лидов сегодня?");
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe("Тестовый ответ по данным.");
    expect(aiCalls.length).toBeGreaterThan(0);
    expect(aiCalls.at(-1)?.user).toContain("сколько лидов сегодня?");

    const resManager = await ask(managerToken, "сколько лидов сегодня?");
    expect(resManager.status).toBe(200);
  });

  it("модель промолчала — 502, а не зависшая страница", async () => {
    aiReply = null;
    try {
      const res = await ask(adminToken, "сколько сделок у команды в этом месяце?");
      expect(res.status).toBe(502);
      expect(res.body).toHaveProperty("error");
    } finally {
      aiReply = { answer: "Тестовый ответ по данным." };
    }
  });
});
