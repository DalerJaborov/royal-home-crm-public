import { afterAll, describe, expect, it } from "vitest";

/**
 * Смена статуса внутри транзакции не просит второе соединение с базой (аудит
 * 23.09.2026, круг 3, №78).
 *
 * Журнал переходов (`src/db.ts`) перед записью статуса читает «как было». Раньше
 * чтение шло мимо транзакции — вторым соединением пула, пока первое держит сама
 * транзакция. Когда транзакций со сменой статуса больше, чем соединений в пуле
 * (15 на процесс), все ждут друг друга до таймаута пула, и захваты лидов падают.
 *
 * Пул здесь — из одного соединения: так «транзакций больше, чем соединений»
 * наступает на первой же. Старый код ждал второе соединение до таймаута пула и
 * падал; новый читает «как было» тем же соединением, что у транзакции.
 */

const base = new URL(process.env.DATABASE_URL!);
base.searchParams.set("connection_limit", "1");
base.searchParams.set("pool_timeout", "3");
process.env.DATABASE_URL = base.toString();

const { prisma } = await import("../src/db.js");

const runId = Date.now();
const clientIds: string[] = [];

async function waitForEvents(entityId: string, n: number) {
  for (let i = 0; i < 100; i++) {
    const rows = await prisma.stageEvent.findMany({ where: { entityId }, orderBy: { at: "asc" } });
    if (rows.length >= n) return rows;
    await new Promise((r) => setTimeout(r, 30));
  }
  return prisma.stageEvent.findMany({ where: { entityId }, orderBy: { at: "asc" } });
}

afterAll(async () => {
  if (clientIds.length) {
    await prisma.stageEvent.deleteMany({ where: { entityId: { in: clientIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  }
  await prisma.$disconnect();
});

describe("журнал переходов внутри транзакции", () => {
  it("смена статуса в транзакции при пуле из одного соединения проходит и пишет переход", async () => {
    const c = await prisma.client.create({
      data: { fullName: "Статус в транзакции", phone: `+99290${String(runId).slice(-7)}`, source: "WALK_IN" },
    });
    clientIds.push(c.id);

    await prisma.$transaction(async (tx) => {
      await tx.client.update({ where: { id: c.id }, data: { status: "CONTACTED" } });
      await tx.client.updateMany({ where: { id: c.id }, data: { status: "HOT" } });
    });

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id }, select: { status: true } });
    expect(after.status).toBe("HOT");
    const events = await waitForEvents(c.id, 2);
    // «Как было» прочитано ВНУТРИ транзакции: второй переход видит первый.
    expect(events.map((e) => [e.from, e.to])).toEqual([
      ["NEW", "CONTACTED"],
      ["CONTACTED", "HOT"],
    ]);
  });

  it("откат транзакции — перехода не было, и в журнале его нет", async () => {
    const c = await prisma.client.create({
      data: { fullName: "Откат статуса", phone: `+99291${String(runId).slice(-7)}`, source: "WALK_IN" },
    });
    clientIds.push(c.id);

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.client.update({ where: { id: c.id }, data: { status: "CONTACTED" } });
        throw new Error("передумали");
      })
    ).rejects.toThrow("передумали");

    await new Promise((r) => setTimeout(r, 300));
    const events = await prisma.stageEvent.findMany({ where: { entityId: c.id } });
    expect(events).toEqual([]);
  });

  it("запись вне транзакции работает как раньше", async () => {
    const c = await prisma.client.create({
      data: { fullName: "Без транзакции", phone: `+99292${String(runId).slice(-7)}`, source: "WALK_IN" },
    });
    clientIds.push(c.id);
    await prisma.client.update({ where: { id: c.id }, data: { status: "CONTACTED" } });
    const events = await waitForEvents(c.id, 1);
    expect(events.map((e) => [e.from, e.to])).toEqual([["NEW", "CONTACTED"]]);
  });

  it("дело, запущенное из транзакции и пережившее её, пишет статус обычным путём", async () => {
    const c = await prisma.client.create({
      data: { fullName: "Отложенная правка", phone: `+99293${String(runId).slice(-7)}`, source: "WALK_IN" },
    });
    clientIds.push(c.id);
    let later: Promise<unknown> = Promise.resolve();
    await prisma.$transaction(async () => {
      later = new Promise((r) => setTimeout(r, 50)).then(() =>
        prisma.client.update({ where: { id: c.id }, data: { status: "CONTACTED" } })
      );
    });
    await later;
    const events = await waitForEvents(c.id, 1);
    expect(events.map((e) => [e.from, e.to])).toEqual([["NEW", "CONTACTED"]]);
  });
});
