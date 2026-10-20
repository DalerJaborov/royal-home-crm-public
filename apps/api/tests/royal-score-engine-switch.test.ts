import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { calculateDailyKpiForAllAgents } from "../src/kpi.js";
import { DEFAULT_EVENT_POINTS, recordScoreEvent } from "../src/lib/scoreJournal.js";

/**
 * Переключение движка (решение владельца 03.08.2026, отменяет решение от
 * 01.08): официальный счёт (Agent.kpi, KpiDailyScore.score) теперь пишется из
 * событийного журнала (computeRoyalScore), а не из взвешенной модели восьми
 * показателей. Разбор по показателям (KpiDailyScore.breakdown) остаётся —
 * диагностика активности дня для панели руководителя, но больше не
 * определяет сам счёт.
 */

const runId = Date.now();
let agentId: string;
let districtId: string;

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-переключение-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент переключения", phone: `+992957${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.kpiDailyScore.deleteMany({ where: { agentId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Ночной пересчёт пишет событийный счёт, а не взвешенный", () => {
  it("Agent.kpi и KpiDailyScore.score равны computeRoyalScore, а не взвешенной модели", async () => {
    // Штраф, которого не существует во взвешенной модели: если пересчёт всё ещё
    // писал бы её результат, эта запись никак не повлияла бы на итог, и тест
    // остался бы зелёным при откате правки — проверка бы ничего не проверяла.
    // Цена события — из таблицы владельца (loadEventPoints по (kind, sourceId)
    // читает АКТУАЛЬНУЮ цену из Settings/DEFAULT_EVENT_POINTS, а не то, что здесь
    // передано в `delta`; передаём совпадающее значение, чтобы не путать читателя).
    recordScoreEvent({
      agentId,
      kind: "inactivity_penalty",
      delta: DEFAULT_EVENT_POINTS.inactivity_penalty,
      reason: "тест переключения",
    });
    await new Promise((r) => setTimeout(r, 200));

    const today = new Date();
    await calculateDailyKpiForAllAgents(today);

    const expected = 100 + DEFAULT_EVENT_POINTS.inactivity_penalty; // старт 100 − 3
    const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { kpi: true } });
    expect(agent?.kpi).toBe(expected);

    const daily = await prisma.kpiDailyScore.findFirst({ where: { agentId } });
    expect(daily?.score).toBe(expected);
    // Разбор по восьми показателям по-прежнему пишется — диагностика активности
    // дня для RadarTile/AgentOverviewModal, независимо от того, что определяет счёт.
    expect(daily?.breakdown).not.toBeNull();
  });
});
