import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { runAsActor } from "../src/lib/requestActor.js";

/**
 * Журнал переходов (26.08.2026, ревью, пункт 4): перехват в db.ts обязан писать
 * StageEvent на смену Client.status/workStatus и Deal.stage из ЛЮБОГО места —
 * тест ходит через prisma напрямую, как ходят роуты, бот и cron.
 */

const PHONE = "+992557700111";
let clientId = "";

// Перехват пишет событие fire-and-forget — даём микрозадачам добежать.
const settle = () => new Promise((r) => setTimeout(r, 150));

const eventsOf = (field: string) =>
  prisma.stageEvent.findMany({
    where: { entityType: "CLIENT", entityId: clientId, field },
    orderBy: { at: "asc" },
  });

beforeAll(async () => {
  await prisma.client.deleteMany({ where: { phone: PHONE } });
});

afterAll(async () => {
  if (clientId) {
    await prisma.stageEvent.deleteMany({ where: { entityId: clientId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
  }
  await prisma.$disconnect();
});

describe("журнал переходов статусов", () => {
  it("создание с явным статусом пишет событие from=null", async () => {
    const created = await prisma.client.create({
      data: { fullName: "Тест Журнала", phone: PHONE, source: "WALK_IN", status: "NEW" },
    });
    clientId = created.id;
    await settle();
    const events = await eventsOf("status");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ from: null, to: "NEW", agentId: null });
  });

  it("update пишет from→to, обычные поля события не плодят", async () => {
    await prisma.client.update({ where: { id: clientId }, data: { status: "HOT" } });
    // Правка без отслеживаемых полей — события быть не должно.
    await prisma.client.update({ where: { id: clientId }, data: { address: "без перехода" } });
    await settle();
    const events = await eventsOf("status");
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ from: "NEW", to: "HOT" });
  });

  it("повтор того же статуса события не пишет", async () => {
    await prisma.client.update({ where: { id: clientId }, data: { status: "HOT" } });
    await settle();
    expect(await eventsOf("status")).toHaveLength(2);
  });

  it("updateMany пишет по строке на каждую реально сменившую статус запись", async () => {
    await prisma.client.updateMany({ where: { id: clientId }, data: { status: "COLD" } });
    await settle();
    const events = await eventsOf("status");
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({ from: "HOT", to: "COLD" });
  });

  it("workStatus — отдельная машина состояний со своим полем", async () => {
    await prisma.client.update({ where: { id: clientId }, data: { workStatus: "INACTIVE" } });
    await settle();
    const events = await eventsOf("workStatus");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ from: "ACTIVE", to: "INACTIVE" });
  });

  it("внутри runAsActor переход подписан сотрудником", async () => {
    await runAsActor("agent-test-id", async () => {
      await prisma.client.update({ where: { id: clientId }, data: { status: "LOST" } });
    });
    await settle();
    const events = await eventsOf("status");
    expect(events.at(-1)).toMatchObject({ from: "COLD", to: "LOST", agentId: "agent-test-id" });
  });
});
