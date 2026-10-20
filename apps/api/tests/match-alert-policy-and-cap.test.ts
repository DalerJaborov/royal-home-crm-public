import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { notifyWaitingBuyersOfNewProperty } from "../src/lib/propertyMatchFilter.js";
import { findMatchingClients } from "../src/routes/matching.js";

/**
 * АВТОПОДБОР: ДОПУСКИ ИЗ НАСТРОЕК И СРЕЗ ДО ФИЛЬТРА (находка О4 проверки 02.10.2026).
 *
 * 1. notifyWaitingBuyersOfNewProperty держал допуски числами (бюджет 0.9/1.1,
 *    площадь 0.9, комнаты ±1) мимо lib/matchPolicy.ts: директор менял допуск в
 *    Настройках, а автопуш продолжал считать по-старому — «Кому подойдёт» и
 *    пуш расходились.
 * 2. Выборка кандидатов обрезалась (take 200 / 300) ДО проверки бюджета и
 *    площади в JS: при широком фильтре (частый район) подходящий покупатель за
 *    пределом первых строк не подбирался вовсе. Бюджет, площадь и этаж теперь
 *    отсекаются в самом запросе, срез получает только реальных кандидатов.
 */

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn().mockResolvedValue(0),
}));

const runId = Date.now();
const tail = String(runId).slice(-7);
const districtIds: string[] = [];
const propertyIds: string[] = [];
let agentId = "";
let savedBudgetTolerance = 10;

async function district() {
  const d = await prisma.district.create({ data: { name: `Допуски-${runId}-${districtIds.length}` } });
  districtIds.push(d.id);
  return d.id;
}

async function property(districtId: string, price: number) {
  const p = await prisma.property.create({
    data: {
      title: `Объект допусков ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 60,
      rooms: 2,
      price,
      currency: "TJS",
      districtId,
      condition: "GOOD",
      status: "AVAILABLE",
    },
  });
  propertyIds.push(p.id);
  return p;
}

function buyer(districtId: string, n: number, budgetMax: number, createdAt: Date) {
  return {
    fullName: `Покупатель допусков ${runId}-${n}`,
    phone: `+99277${tail}${String(n).padStart(3, "0")}`,
    kind: "BUYER" as const,
    workStatus: "ACTIVE" as const,
    source: "WEBSITE" as const,
    assignedAgentId: agentId,
    currency: "TJS" as const,
    desiredDistrictId: districtId,
    budgetMax,
    lastContactAt: new Date(),
    createdAt,
  };
}

async function notified(propertyId: string, clientId: string) {
  return prisma.interaction.count({ where: { propertyId, clientId, type: "SYSTEM", matchNotifiedPriceTjs: { not: null } } });
}

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({ data: { fullName: `Агент допусков ${runId}`, phone: `+99278${tail}`, role: "AGENT", passwordHash: "x" } })
  ).id;
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedBudgetTolerance = settings.matchBudgetTolerancePct;
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { matchBudgetTolerancePct: savedBudgetTolerance } });
  await prisma.interaction.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyInterestEvent.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { assignedAgentId: agentId } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: { in: districtIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("О4: срез кандидатов после фильтра бюджета", () => {
  it("подходящий покупатель за двумя сотнями неподходящих по бюджету всё равно уведомляется и виден в «Кому подойдёт»", async () => {
    const d = await district();
    const longAgo = new Date(Date.now() - 86_400_000);
    await prisma.client.createMany({ data: Array.from({ length: 305 }, (_, i) => buyer(d, i, 1000, longAgo)) });
    // Подходящий — самый свежий: при старом порядке (по дате создания, первые 200)
    // он в срез автопуша не попадал.
    const match = await prisma.client.create({ data: buyer(d, 900, 450_000, new Date()) });
    // Для «Кому подойдёт» (новые первыми, первые 300) — подходящий самый старый.
    const oldMatch = await prisma.client.create({ data: buyer(d, 901, 450_000, new Date(Date.now() - 2 * 86_400_000)) });
    const p = await property(d, 400_000);

    await notifyWaitingBuyersOfNewProperty(p);
    expect(await notified(p.id, match.id)).toBe(1);

    const list = await findMatchingClients(p.id, 10);
    expect(list.items.map((c) => c.id)).toContain(oldMatch.id);
    expect(list.total).toBe(2);
  });
});

describe("О4: допуск бюджета берётся из Настроек", () => {
  it("допуск 0% — объект на 5% дороже бюджета не уходит покупателю", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { matchBudgetTolerancePct: 0 } });
    const d = await district();
    const client = await prisma.client.create({ data: buyer(d, 950, 380_000, new Date()) });
    const p = await property(d, 400_000);

    await notifyWaitingBuyersOfNewProperty(p);
    expect(await notified(p.id, client.id)).toBe(0);
  });

  it("допуск 20% — объект на 15% дороже бюджета уходит покупателю", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { matchBudgetTolerancePct: 20 } });
    const d = await district();
    const client = await prisma.client.create({ data: buyer(d, 960, 348_000, new Date()) });
    const p = await property(d, 400_000);

    await notifyWaitingBuyersOfNewProperty(p);
    expect(await notified(p.id, client.id)).toBe(1);
  });
});
