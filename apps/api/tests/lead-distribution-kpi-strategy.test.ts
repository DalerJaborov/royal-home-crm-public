import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { pickAgentForLead } from "../src/leads.js";

/**
 * Стратегия распределения "kpi" (Настройки → Деньги) — спецификация владельца,
 * «Алгоритм распределения лидов»: отсев по порогу → сортировка по уровню Royal
 * Score → кольцо (round robin) внутри уровня. Раньше внутри уровня был
 * взвешенно-случайный выбор — не то же самое, что «следующий агент по кругу»,
 * и расходилось с тай-брейком передачи отказного клиента (pickNextAgentByKpiQueue).
 */

const runId = Date.now();
let savedStrategy: string | null = null;
let savedThreshold: number | null = null;
let savedTierSize: number | null = null;

let strongAgentId: string;
let strongAgentId2: string;
let weakAgentId: string;
const clientIds: string[] = [];

beforeAll(async () => {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  savedStrategy = settings?.leadDistributionStrategy ?? null;
  savedThreshold = settings?.kpiMinThreshold ?? null;
  savedTierSize = settings?.kpiQueueTierSize ?? null;
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { leadDistributionStrategy: "kpi", kpiMinThreshold: 50, kpiQueueTierSize: 10 },
  });

  strongAgentId = (
    await prisma.agent.create({
      data: { fullName: "Сильный А", phone: `+992961${runId}`, role: "AGENT", passwordHash: "x", kpi: 95 },
    })
  ).id;
  strongAgentId2 = (
    await prisma.agent.create({
      data: { fullName: "Сильный Б", phone: `+992962${runId}`, role: "AGENT", passwordHash: "x", kpi: 91 },
    })
  ).id;
  weakAgentId = (
    await prisma.agent.create({
      data: { fullName: "Слабый", phone: `+992963${runId}`, role: "AGENT", passwordHash: "x", kpi: 40 },
    })
  ).id;
});

afterEach(async () => {
  if (clientIds.length) {
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    clientIds.length = 0;
  }
});

afterAll(async () => {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      leadDistributionStrategy: (savedStrategy as never) ?? "fair",
      kpiMinThreshold: savedThreshold ?? 70,
      kpiQueueTierSize: savedTierSize ?? 10,
    },
  });
  await prisma.agent.deleteMany({ where: { id: { in: [strongAgentId, strongAgentId2, weakAgentId] } } });
  await prisma.$disconnect();
});

async function assign(agentId: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент ${clientIds.length} ${runId}`,
      phone: `+99295${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      status: "NEW",
    },
  });
  clientIds.push(c.id);
}

async function excludeOthers(): Promise<string[]> {
  // В базе есть агенты сидов и соседних тестовых файлов — исключаем всех, кроме
  // троих из этого теста, иначе на выбор влияет их KPI (null = 100, выше любого
  // из тестовых уровней).
  const others = await prisma.agent.findMany({
    where: { role: "AGENT", isActive: true, id: { notIn: [strongAgentId, strongAgentId2, weakAgentId] } },
    select: { id: true },
  });
  return others.map((a) => a.id);
}

describe("Стратегия распределения kpi — отсев → уровень → кольцо", () => {
  it("ниже порога не получает лид вовсе", async () => {
    const exclude = await excludeOthers();
    for (let i = 0; i < 5; i++) {
      const picked = await pickAgentForLead(exclude);
      expect(picked).not.toBe(weakAgentId);
    }
  });

  it("внутри уровня — круговая очередь, не тот же агент дважды подряд", async () => {
    // Оба сильных агента в одном уровне (95 и 91 при tierSize=10 → оба tier 9).
    // Кому «давно не назначали» решает lastAssignedById (последний Client.assignedAt) —
    // сперва оба одинаково давно (никогда), первым по сортировке идёт кто угодно из
    // двух, но после назначения именно ему — следующий раз должен прийти другой.
    const exclude = await excludeOthers();
    const first = await pickAgentForLead(exclude);
    expect([strongAgentId, strongAgentId2]).toContain(first);
    await assign(first!);
    const second = await pickAgentForLead(exclude);
    expect(second).not.toBe(first);
    expect([strongAgentId, strongAgentId2]).toContain(second);
  });
});
