import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * ДЕНЬГИ В ОТЧЁТАХ — ТОЛЬКО С ПРАВОМ НА ФИНАНСЫ (аудит 23.09.2026, №44).
 *
 * Отчёты открыты правом reports.view службе безопасности, у которой нет права
 * на финансы. Воронка, таблица агентов и месячный отчёт при этом отдавали
 * комиссию и расходы компании.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { withoutMoney } = await import("../src/routes/reports.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const agentIds: string[] = [];
let securityToken = "";
let directorToken = "";

beforeAll(async () => {
  const security = await prisma.agent.create({
    data: { fullName: `СБ отчёты ${runId}`, phone: `+99297${tail}`, role: "SECURITY", passwordHash: "x" },
  });
  const director = await prisma.agent.create({
    data: { fullName: `Директор отчёты ${runId}`, phone: `+99298${tail}`, role: "DIRECTOR", passwordHash: "x" },
  });
  agentIds.push(security.id, director.id);
  securityToken = signAccessToken({ sub: security.id, role: "SECURITY" });
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("Служба безопасности в отчётах", () => {
  it("воронка без комиссии", async () => {
    const res = await request(app).get("/api/v1/reports/funnel").set("Authorization", `Bearer ${securityToken}`);
    expect(res.status).toBe(200);
    const deals = res.body.funnel.find((s: { key: string }) => s.key === "deals");
    expect(deals.commission).toBeNull();
  });

  it("таблица агентов без комиссии", async () => {
    const res = await request(app).get("/api/v1/reports/agents").set("Authorization", `Bearer ${securityToken}`);
    expect(res.status).toBe(200);
    for (const row of res.body as { commission: unknown }[]) expect(row.commission).toBeNull();
  });

  it("директор комиссию видит", async () => {
    const res = await request(app).get("/api/v1/reports/funnel").set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    const deals = res.body.funnel.find((s: { key: string }) => s.key === "deals");
    expect(typeof deals.commission).toBe("number");
  });
});

describe("Месячный отчёт без денег", () => {
  it("комиссия, расходы и комиссия по агентам убраны, остальное на месте", () => {
    const stripped = withoutMoney({
      commission: 1200,
      expenses: 300,
      dealsCompleted: 2,
      agents: [{ agentId: "a", fullName: "А", leads: 1, showings: 2, deals: 1, commission: 600 }],
    }) as Record<string, unknown>;
    expect(stripped.commission).toBeNull();
    expect(stripped.expenses).toBeNull();
    expect(stripped.dealsCompleted).toBe(2);
    expect(stripped.agents).toEqual([{ agentId: "a", fullName: "А", leads: 1, showings: 2, deals: 1, commission: null }]);
  });
});
