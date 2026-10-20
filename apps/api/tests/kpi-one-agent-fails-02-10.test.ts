import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * E8 глубокой проверки 02.10.2026: ночной пересчёт KPI шёл одним циклом по
 * агентам без try на каждого. Исключение на одном (битый разбор, deadlock на
 * upsert) обрывало весь тик: все агенты после него оставались без счёта за
 * день и со старым Agent.kpi — рейтинг искажён.
 *
 * Падает ПЕРВЫЙ же расчёт, кто бы ни оказался первым в выборке: старый код
 * не записал бы никого, новый — всех остальных.
 */

let failedAgentId: string | null = null;
vi.mock("../src/lib/scoreJournal.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/scoreJournal.js")>();
  return {
    ...real,
    computeRoyalScore: vi.fn(async (agentId: string, at?: Date) => {
      if (failedAgentId === null) {
        failedAgentId = agentId;
        throw new Error("нарочный сбой расчёта на одном агенте");
      }
      return real.computeRoyalScore(agentId, at);
    }),
  };
});

const { prisma } = await import("../src/db.js");
const { calculateDailyKpiForAllAgents } = await import("../src/kpi.js");
const { dushanbeDayRange } = await import("../src/lib/dushanbeTime.js");

const runId = Date.now();
const ownIds: string[] = [];
const day = new Date("2026-03-15T08:00:00.000Z");

beforeAll(async () => {
  for (let i = 0; i < 2; i++) {
    const a = await prisma.agent.create({
      data: { fullName: `Агент KPI ${runId}-${i}`, phone: `+99297${i}${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
    });
    ownIds.push(a.id);
  }
});

afterAll(async () => {
  const { start } = dushanbeDayRange(day);
  await prisma.kpiDailyScore.deleteMany({ where: { date: start } });
  await prisma.agent.deleteMany({ where: { id: { in: ownIds } } });
  await prisma.$disconnect();
});

describe("ночной KPI: сбой на одном агенте не обрывает остальных", () => {
  it("все, кроме упавшего, получают счёт за день", async () => {
    await calculateDailyKpiForAllAgents(day).catch(() => {});
    const { start } = dushanbeDayRange(day);
    const active = await prisma.agent.findMany({
      where: { role: "AGENT", isActive: true, frozenAt: null },
      select: { id: true },
    });
    const rows = await prisma.kpiDailyScore.findMany({ where: { date: start }, select: { agentId: true } });
    const scored = new Set(rows.map((r) => r.agentId));
    expect(failedAgentId).not.toBeNull();
    const missing = active.map((a) => a.id).filter((id) => id !== failedAgentId && !scored.has(id));
    expect(missing).toEqual([]);
    expect(scored.has(failedAgentId!)).toBe(false);
  });
});
