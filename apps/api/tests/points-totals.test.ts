import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { sumPointsByAgent } from "../src/lib/pointsTotals.js";

/**
 * Итог баллов считает база (SUM по JSON-полю), а не Node. Запрос написан
 * сырым SQL, поэтому `tsc` его не проверяет ВООБЩЕ — ошибка в имени столбца или
 * в приведении типа всплыла бы только на живом экране «Команда». Эти тесты и
 * есть проверка того, что запрос выполняется и считает правильно.
 */

const runId = Date.now();
let agentA: string;
let agentB: string;

async function award(agentId: string, meta: unknown, action = "POINTS_AWARD") {
  await prisma.auditLog.create({
    data: {
      action,
      entityType: "Agent",
      entityId: agentId,
      agentName: "Тест",
      meta: meta as never,
    },
  });
}

beforeAll(async () => {
  agentA = (
    await prisma.agent.create({
      data: { fullName: "Баллы А", phone: `+992969${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  agentB = (
    await prisma.agent.create({
      data: { fullName: "Баллы Б", phone: `+992970${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [agentA, agentB] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentA, agentB] } } });
  await prisma.$disconnect();
});

describe("Сумма баллов агента", () => {
  it("складывает начисления по каждому агенту отдельно", async () => {
    await award(agentA, { points: 5 });
    await award(agentA, { points: 2.5 });
    await award(agentB, { points: 3 });

    const totals = await sumPointsByAgent([agentA, agentB]);

    expect(totals.get(agentA)).toBe(7.5);
    expect(totals.get(agentB)).toBe(3);
  });

  it("отрицательные начисления вычитаются, а не игнорируются", async () => {
    await award(agentB, { points: -1 });

    const totals = await sumPointsByAgent([agentB]);

    expect(totals.get(agentB)).toBe(2);
  });

  it("записи без числа в meta.points и чужие действия в сумму не попадают", async () => {
    await award(agentA, { points: "много" });
    await award(agentA, null);
    await award(agentA, { points: 100 }, "PROPERTY_UPDATE");

    const totals = await sumPointsByAgent([agentA]);

    expect(totals.get(agentA)).toBe(7.5);
  });

  it("агент без начислений и пустой список не роняют запрос", async () => {
    const totals = await sumPointsByAgent([agentA]);
    expect(totals.has(agentB)).toBe(false);

    await expect(sumPointsByAgent([])).resolves.toEqual(new Map());
  });
});
