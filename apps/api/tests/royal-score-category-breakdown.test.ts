import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { DEFAULT_EVENT_POINTS, computeRoyalScoreBreakdown, recordScoreEvent } from "../src/lib/scoreJournal.js";
import { waitForSettled } from "./helpers/waitFor.js";

/**
 * Расшифровка по шести показателям владельца (docs/owner-spec-verbatim, часть 3:
 * «Продажи 40% · Скорость обработки лидов 20% · Работа с CRM 15% · Работа с
 * объектами 10% · Выполнение задач 10% · Дисциплина 5%») — сумма событий за окно,
 * сгруппированная по смысловым категориям, а не формула пересчёта.
 */

const runId = Date.now();
let agentId: string;

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: "Агент расшифровки", phone: `+99292${runId.toString().slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
});

afterEach(async () => {
  // recordScoreEvent пишет «в отрыве» (см. scoreJournal.ts), а тесты сами не
  // await'ят вызов, а спят фиксированные 200 мс — если запись опоздает, она
  // приземлится уже ПОСЛЕ этой очистки и попадёт в разбивку следующего теста.
  // Ждём, пока счётчик по agentId перестанет расти, прежде чем чистить.
  await waitForSettled(() => prisma.royalScoreEvent.count({ where: { agentId } }));
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("Категории расшифровки", () => {
  it("сделка попадает в «Продажи», просроченная задача — в «Задачи»", async () => {
    recordScoreEvent({ agentId, kind: "deal_closed", delta: DEFAULT_EVENT_POINTS.deal_closed, reason: "тест" });
    recordScoreEvent({ agentId, kind: "task_overdue", delta: DEFAULT_EVENT_POINTS.task_overdue, reason: "тест" });
    await new Promise((r) => setTimeout(r, 200));

    const breakdown = await computeRoyalScoreBreakdown(agentId);
    expect(breakdown.sales).toBe(DEFAULT_EVENT_POINTS.deal_closed);
    expect(breakdown.tasks).toBe(DEFAULT_EVENT_POINTS.task_overdue);
    // Категории, по которым событий не было, — ноль, а не отсутствие ключа.
    expect(breakdown.crm).toBe(0);
    expect(breakdown.properties).toBe(0);
    expect(breakdown.speed).toBe(0);
    expect(breakdown.discipline).toBe(0);
  });

  it("несколько событий одной категории суммируются", async () => {
    recordScoreEvent({ agentId, kind: "card_filled", delta: DEFAULT_EVENT_POINTS.card_filled, reason: "тест 1" });
    recordScoreEvent({
      agentId,
      kind: "card_not_filled",
      delta: DEFAULT_EVENT_POINTS.card_not_filled,
      reason: "тест 2",
    });
    await new Promise((r) => setTimeout(r, 200));

    const breakdown = await computeRoyalScoreBreakdown(agentId);
    expect(breakdown.crm).toBe(DEFAULT_EVENT_POINTS.card_filled + DEFAULT_EVENT_POINTS.card_not_filled);
  });

  it("устаревшие виды событий (kpi_override) не попадают ни в одну категорию", async () => {
    // Сама запись легальна только для чтения истории — recordScoreEvent её всё
    // равно примет (типы не запрещают), а расшифровка обязана её тихо пропустить.
    recordScoreEvent({ agentId, kind: "kpi_override", delta: 0, reason: "историческая запись" });
    await new Promise((r) => setTimeout(r, 200));

    const breakdown = await computeRoyalScoreBreakdown(agentId);
    expect(Object.values(breakdown).every((v) => v === 0)).toBe(true);
  });
});
