import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * ОТВЕТЫ PATCH ОТЧЁТОВ ЗАКРЫТЫ ТЕМИ ЖЕ МАСКАМИ, ЧТО И GET
 * (аудит Codex 04.10.2026, ACCESS-04).
 *
 * Так было: GET /reports/monthly прятал комиссию и расходы без finance.view, а
 * GET /reports/problems маскировал номера в ссылках без clients.viewPhone, но
 * PATCH заметок возвращал строку отчёта целиком, сырой. Аналитик без права на
 * деньги и номера «правил заметку» и получал всё закрытое.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const DIGITS = "900001122";
const agentIds: string[] = [];
let monthlyId = "";
let problemId = "";
let blindToken = "";
let seeingToken = "";
// Давно прошедший период: уникальный periodStart не пересечётся с отчётами других тестов.
const periodStart = new Date(Date.UTC(2000, 0, 1) + (runId % 1_000) * 86_400_000);

beforeAll(async () => {
  const mk = async (phone: string, permissions: unknown) =>
    (
      await prisma.agent.create({
        data: { fullName: `Аналитик ${phone}`, phone, role: "MANAGER", passwordHash: "x", permissions: permissions as never },
      })
    ).id;
  const blind = await mk(`+99271${tail}`, {
    granted: ["reports.view", "dashboard.analytics"],
    revoked: ["finance.view", "clients.viewPhone"],
  });
  const seeing = await mk(`+99272${tail}`, {
    granted: ["reports.view", "dashboard.analytics", "finance.view", "clients.viewPhone"],
    revoked: [],
  });
  agentIds.push(blind, seeing);
  blindToken = signAccessToken({ sub: blind, role: "MANAGER" });
  seeingToken = signAccessToken({ sub: seeing, role: "MANAGER" });

  monthlyId = (
    await prisma.monthlyReport.create({
      data: {
        periodStart,
        metrics: { dealsCompleted: 2, commission: 123456, expenses: 7890, agents: [{ agentId: blind, fullName: "А", commission: 777 }] },
      },
    })
  ).id;
  problemId = (
    await prisma.problemReport.create({
      data: {
        period: "week",
        periodStart,
        periodEnd: new Date(periodStart.getTime() + 7 * 86_400_000),
        metrics: {
          period: "week",
          periodStart: periodStart.toISOString(),
          periodEnd: new Date(periodStart.getTime() + 7 * 86_400_000).toISOString(),
          headline: "x",
          sections: [
            {
              key: "calls",
              title: "Разговоры",
              headline: "x",
              total: 1,
              previousTotal: 1,
              direction: "same",
              metrics: [],
              links: [{ label: `Входящий +992${DIGITS}`, hint: `клиент сказал: мой номер +992${DIGITS}`, href: "/clients/1" }],
              breakdown: null,
            },
          ],
        },
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.monthlyReport.deleteMany({ where: { id: monthlyId } });
  await prisma.problemReport.deleteMany({ where: { id: problemId } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

describe("PATCH /reports/monthly/:id", () => {
  it("без finance.view в ответе нет денег", async () => {
    const res = await request(app)
      .patch(`/api/v1/reports/monthly/${monthlyId}`)
      .set("Authorization", `Bearer ${blindToken}`)
      .send({ notes: "заметка без денег" });
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe("заметка без денег");
    expect(res.body.metrics.commission).toBeNull();
    expect(res.body.metrics.expenses).toBeNull();
    expect(res.body.metrics.agents[0].commission).toBeNull();
    expect(res.body.metrics.dealsCompleted).toBe(2);
  });

  it("с finance.view ответ полный", async () => {
    const res = await request(app)
      .patch(`/api/v1/reports/monthly/${monthlyId}`)
      .set("Authorization", `Bearer ${seeingToken}`)
      .send({ notes: "заметка с деньгами" });
    expect(res.status).toBe(200);
    expect(res.body.metrics.commission).toBe(123456);
  });
});

describe("PATCH /reports/problems/:id", () => {
  it("без clients.viewPhone номера в ссылках закрыты", async () => {
    const res = await request(app)
      .patch(`/api/v1/reports/problems/${problemId}`)
      .set("Authorization", `Bearer ${blindToken}`)
      .send({ notes: "заметка" });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(DIGITS);
    expect(res.body.metrics.sections[0].links[0].label).toContain("Входящий");
  });

  it("с clients.viewPhone ссылки целые", async () => {
    const res = await request(app)
      .patch(`/api/v1/reports/problems/${problemId}`)
      .set("Authorization", `Bearer ${seeingToken}`)
      .send({ notes: "заметка 2" });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(DIGITS);
  });
});
