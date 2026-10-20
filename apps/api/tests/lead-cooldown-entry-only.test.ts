import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { randomInt } from "node:crypto";

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 1),
}));

const { prisma } = await import("../src/db.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { agentsInCooldown, runInactiveTrafficLightTick, shiftInactiveClockAfterAbsence } = await import(
  "../src/lib/inactiveTrafficLight.js"
);
const { dushanbeNextOccurrence } = await import("../src/lib/dushanbeTime.js");

/**
 * Владелец 23.09.2026 (ПР-000453): пауза выдачи лидов «после слива» стояла у
 * четырёх агентов из шести, и весь поток шёл одной Сурайё. Пауза считалась от
 * таймера светофора (inactiveSince), а он сдвигается при РАЗГОВОРЕ с неактивным
 * клиентом и при возврате агента из отпуска — то есть за нужную работу.
 * Теперь пауза — только от входа в Неактивные (inactiveEnteredAt).
 */

const runId = `${Date.now()}${randomInt(1000, 9999)}`;
const phone = () => `+99295${randomInt(1_000_000, 9_999_999)}`;
const DAY = 24 * 3600_000;
let agentId: string;
const clientIds: string[] = [];

async function makeInactive(data: { inactiveSince: Date; inactiveEnteredAt: Date | null; lastClientMessageAt?: Date }) {
  const c = await prisma.client.create({
    data: {
      fullName: `Пауза ${runId} ${clientIds.length}`,
      phone: phone(),
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      lastAgentId: agentId,
      acceptedAt: new Date(Date.now() - 30 * DAY),
      workStatus: "INACTIVE",
      inactiveLevel: "RED",
      inactivePingCount: 0,
      ...data,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 4);
  agentId = (await prisma.agent.create({ data: { fullName: `Агент паузы ${runId}`, phone: phone(), role: "AGENT", passwordHash } })).id;
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { agentId } });
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([agentId]);
  await prisma.$disconnect();
});

describe("пауза выдачи лидов — только от входа в Неактивные", () => {
  it("клиент ответил неактивному агенту — светофор начал отсчёт заново, но пауза выдачи не включилась", async () => {
    // Последний полдень по Душанбе — в часах светофора и не дальше суток назад.
    const noon = new Date(dushanbeNextOccurrence("12:00").getTime() - DAY);
    const c = await makeInactive({
      inactiveEnteredAt: new Date(noon.getTime() - 3 * DAY),
      inactiveSince: new Date(noon.getTime() - 2 * DAY),
      lastClientMessageAt: new Date(noon.getTime() - 3600_000),
    });

    await runInactiveTrafficLightTick(noon);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.inactiveSince?.getTime()).toBe(noon.getTime()); // сброс светофора правда был
    // Окно паузы с запасом (48 ч), чтобы сброс в полдень точно в него попадал.
    expect((await agentsInCooldown([agentId], 48)).has(agentId)).toBe(false);
  });

  it("агент вернулся из отпуска — пауза выдачи не включилась", async () => {
    await makeInactive({ inactiveEnteredAt: new Date(Date.now() - 10 * DAY), inactiveSince: new Date(Date.now() - 10 * DAY) });

    await shiftInactiveClockAfterAbsence(agentId, null);

    expect((await agentsInCooldown([agentId], 5)).has(agentId)).toBe(false);
  });

  it("свежий вход в Неактивные по-прежнему ставит паузу", async () => {
    await makeInactive({ inactiveEnteredAt: new Date(), inactiveSince: new Date() });
    expect((await agentsInCooldown([agentId], 5)).has(agentId)).toBe(true);
  });
});
