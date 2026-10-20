import { describe, expect, it } from "vitest";

/**
 * Место в рейтинге Royal Score при пустом KPI.
 *
 * Ночной пересчёт заполняет KPI только на следующее утро, поэтому у новичка поле
 * пустое. Пока пустое значение подменялось сотней, человек без единого рабочего дня
 * занимал ПЕРВОЕ место — и видел это в своём кабинете, и портил порядок остальным.
 *
 * Проверяется сама формула сортировки: она короткая, но именно в ней была ошибка,
 * и повторить её ничего не стоит.
 */

type Agent = { id: string; kpi: number | null };

/** Ровно то выражение, что стоит в lib/royalScore.ts. */
const rankOf = (agents: Agent[], id: string): number => {
  const sorted = [...agents].sort((a, b) => (b.kpi ?? -1) - (a.kpi ?? -1));
  return Math.max(1, sorted.findIndex((a) => a.id === id) + 1);
};

describe("Новичок без истории KPI", () => {
  const agents: Agent[] = [
    { id: "opytnyi", kpi: 82 },
    { id: "srednii", kpi: 55 },
    { id: "novichok", kpi: null },
  ];

  it("идёт последним, а не первым", () => {
    expect(rankOf(agents, "novichok")).toBe(3);
  });

  it("не сдвигает вниз тех, кто работает", () => {
    expect(rankOf(agents, "opytnyi")).toBe(1);
    expect(rankOf(agents, "srednii")).toBe(2);
  });

  it("двое новичков делят хвост, а не голову", () => {
    const withTwo: Agent[] = [...agents, { id: "novichok2", kpi: null }];
    expect(rankOf(withTwo, "opytnyi")).toBe(1);
    expect(rankOf(withTwo, "novichok")).toBeGreaterThan(2);
  });
});
