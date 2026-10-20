import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { DEFAULT_KPI_WEIGHTS, loadKpiWeights } from "../src/kpi.js";

/**
 * Веса KPI правятся в Настройках (решение владельца 01.08.2026: ни одно число не
 * живёт в коде). Колонка Json — форме из базы доверять нельзя, и каждый мусорный
 * вариант обязан откатываться к зашитым значениям, а не ронять ночной пересчёт.
 */

let savedWeights: unknown;

beforeAll(async () => {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { kpiWeights: true } });
  savedWeights = s?.kpiWeights ?? null;
});

afterAll(async () => {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { kpiWeights: savedWeights as object | null ?? undefined },
  });
  await prisma.$disconnect();
});

async function setWeights(value: unknown) {
  await prisma.settings.update({ where: { id: "singleton" }, data: { kpiWeights: value as object } });
}

describe("веса KPI из Настроек", () => {
  it("пустая настройка — зашитые значения", async () => {
    await setWeights(null);
    expect(await loadKpiWeights()).toEqual(DEFAULT_KPI_WEIGHTS);
  });

  it("владелец переопределил часть — остальные остаются зашитыми", async () => {
    await setWeights({ response: 40, cards: 0 });
    const weights = await loadKpiWeights();
    expect(weights.response).toBe(40);
    expect(weights.cards).toBe(0);
    expect(weights.crm).toBe(DEFAULT_KPI_WEIGHTS.crm);
  });

  it("мусор в колонке не долетает до расчёта", async () => {
    await setWeights({ response: "сорок", crm: -5, unknown: 99 });
    const weights = await loadKpiWeights();
    expect(weights.response).toBe(DEFAULT_KPI_WEIGHTS.response);
    expect(weights.crm).toBe(DEFAULT_KPI_WEIGHTS.crm);
    expect((weights as Record<string, number>).unknown).toBeUndefined();
  });

  it("массив вместо объекта — зашитые значения, а не падение", async () => {
    await setWeights([20, 20, 60]);
    expect(await loadKpiWeights()).toEqual(DEFAULT_KPI_WEIGHTS);
  });
});
