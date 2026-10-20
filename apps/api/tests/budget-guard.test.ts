import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../src/db.js";

/**
 * Перехват в db.ts (19.09.2026, разбор карточки №298: «Бюджет от 463 500 до
 * 6 027» — задом наперёд, потому что budgetMax переписался ценой за квадратный
 * метр отдельным звонком, а budgetMin от прежнего звонка остался нетронутым).
 * Тест ходит через prisma напрямую, как ходят все ~30 точек записи бюджета.
 */

const PHONE = "+992557700222";
let clientId = "";

const errorsOf = () =>
  prisma.errorLog.findMany({ where: { source: "ai", message: { contains: clientId } } });

beforeAll(async () => {
  await prisma.client.deleteMany({ where: { phone: PHONE } });
});

afterAll(async () => {
  if (clientId) {
    await prisma.errorLog.deleteMany({ where: { message: { contains: clientId } } });
    await prisma.client.deleteMany({ where: { id: clientId } });
  }
  await prisma.$disconnect();
});

describe("бюджет клиента не может оказаться задом наперёд", () => {
  it("обычная запись (min ≤ max) проходит без вмешательства", async () => {
    const created = await prisma.client.create({
      data: { fullName: "Тест Бюджета", phone: PHONE, source: "WALK_IN", budgetMin: 300_000, budgetMax: 500_000 },
    });
    clientId = created.id;
    expect(Number(created.budgetMin)).toBe(300_000);
    expect(Number(created.budgetMax)).toBe(500_000);
    expect(await errorsOf()).toHaveLength(0);
  });

  it("живой случай №298: новый budgetMax противоречит старому budgetMin — старая половина стирается, не выдумывается", async () => {
    // budgetMin=463500 уже в карточке (прошлый звонок). Новый звонок даёт только
    // budgetMax=6027 (цена за метр, ошибочно принятая за бюджет) — budgetMin не
    // трогают вовсе, ровно как в lib/cardSuggestions.ts.
    const updated = await prisma.client.update({ where: { id: clientId }, data: { budgetMax: 6_027 } });
    expect(updated.budgetMax === null || Number(updated.budgetMax) === 6_027).toBe(true);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    // Итоговая пара обязана быть согласованной: либо min стёрт, либо (не наш
    // случай здесь) обе стороны переставлены местами — но никогда min > max.
    if (after.budgetMin !== null && after.budgetMax !== null) {
      expect(Number(after.budgetMin)).toBeLessThanOrEqual(Number(after.budgetMax));
    }
    // Конкретно для этого сценария (тронут только max): стирается старая
    // сторона, а не изобретается новая — budgetMin должен стать пустым.
    expect(after.budgetMin).toBeNull();
    expect(Number(after.budgetMax)).toBe(6_027);

    const logs = await errorsOf();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].message).toMatch(/задом наперёд/);
  });

  it("обе границы пришли одной записью задом наперёд — переставляются местами, без потери данных", async () => {
    await prisma.client.update({ where: { id: clientId }, data: { budgetMin: 800_000, budgetMax: 400_000 } });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(Number(after.budgetMin)).toBe(400_000);
    expect(Number(after.budgetMax)).toBe(800_000);
  });

  it("создание карточки сразу с перепутанными границами тоже переставляется местами", async () => {
    const other = await prisma.client.create({
      data: {
        fullName: "Тест Бюджета 2",
        phone: "+992557700223",
        source: "WALK_IN",
        budgetMin: 900_000,
        budgetMax: 100_000,
      },
    });
    try {
      const after = await prisma.client.findUniqueOrThrow({ where: { id: other.id } });
      expect(Number(after.budgetMin)).toBe(100_000);
      expect(Number(after.budgetMax)).toBe(900_000);
    } finally {
      await prisma.errorLog.deleteMany({ where: { message: { contains: other.id } } });
      await prisma.client.deleteMany({ where: { id: other.id } });
    }
  });

  it("внутри интерактивной транзакции перехват исправляет через tx и не виснет на блокировке строки", async () => {
    await prisma.client.update({ where: { id: clientId }, data: { budgetMin: 100_000, budgetMax: 200_000 } });
    await prisma.$transaction(async (tx) => {
      await tx.client.update({ where: { id: clientId }, data: { budgetMin: 900_000, budgetMax: 300_000 } });
    });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(Number(after.budgetMin)).toBe(300_000);
    expect(Number(after.budgetMax)).toBe(900_000);
  }, 15_000);
});
