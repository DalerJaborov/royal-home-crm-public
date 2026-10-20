import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sendPushToAgent = vi.fn(async (..._args: unknown[]) => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents: sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { generateMonthlyReport } = await import("../src/lib/monthlyReport.js");
const { dushanbeStartOfMonth } = await import("../src/lib/dushanbeTime.js");

/**
 * ПУШ О МЕСЯЧНОМ ОТЧЁТЕ НЕ НЕСЁТ КОМИССИЮ ТЕМ, У КОГО НЕТ finance.view
 * (аудит Codex 04.10.2026, ACCESS-04, расширение).
 *
 * Так было: получатели выбирались по dashboard.analytics, а в тексте стояла общая
 * комиссия компании — аналитик без права на финансы получал цифру в уведомлении,
 * хотя в самом отчёте она у него закрыта (GET /reports/monthly).
 */

const runId = Date.now();
const tail = String(runId).slice(-7);
const agentIds: string[] = [];
let withFinance = "";
let withoutFinance = "";
let periodStart: Date;

beforeAll(async () => {
  const now = new Date();
  const wall = new Date(dushanbeStartOfMonth(now).getTime() + 5 * 60 * 60 * 1000);
  periodStart = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - 1, 1) - 5 * 60 * 60 * 1000);
  await prisma.monthlyReport.deleteMany({ where: { periodStart } });
  const mk = async (phone: string, permissions: unknown) =>
    (
      await prisma.agent.create({
        data: { fullName: `Получатель ${phone}`, phone, role: "MANAGER", passwordHash: "x", permissions: permissions as never },
      })
    ).id;
  withFinance = await mk(`+99261${tail}`, { granted: ["dashboard.analytics", "finance.view"], revoked: [] });
  withoutFinance = await mk(`+99262${tail}`, { granted: ["dashboard.analytics"], revoked: ["finance.view"] });
  agentIds.push(withFinance, withoutFinance);
});

afterAll(async () => {
  await prisma.monthlyReport.deleteMany({ where: { periodStart } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

describe("generateMonthlyReport: пуш руководству", () => {
  it("комиссия в тексте только у тех, кому открыт finance.view", async () => {
    const result = await generateMonthlyReport();
    expect(result.created).toBe(true);
    const bodyOf = (id: string) => {
      const call = sendPushToAgent.mock.calls.find((c) => c[0] === id);
      expect(call).toBeTruthy();
      return (call![1] as { body: string }).body;
    };
    expect(bodyOf(withFinance)).toContain("комиссия");
    const hidden = bodyOf(withoutFinance);
    expect(hidden).not.toContain("комиссия");
    expect(hidden).toContain("Сделок");
  });
});
