import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { randomInt } from "node:crypto";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Владелец 23.09.2026 (разбор раздачи, пункт 6): лид сменил трёх агентов,
 * четвёртый жмёт «Отклонить» — лид уходил в «Неактивные» и оставался у
 * отказавшегося, руководителю шло ложное «свободных исполнителей не осталось».
 * Теперь отказ идёт тем же кругом, что и «не принял за 15 минут».
 */

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => undefined),
  sendPushToAgents: vi.fn(async () => undefined),
}));

const { declineLead } = await import("../src/services/leads/assignment.js");

const runId = `${Date.now()}${randomInt(1000, 9999)}`;
const phone = () => `+99298${randomInt(1_000_000, 9_999_999)}`;
let declinerId: string;
let otherId: string;
const clientIds: string[] = [];
let frozenOthers: string[] = [];
let savedSettings: Record<string, unknown> | null = null;

async function lead(data: { reassignCount: number; triedAgentIds: string[] }) {
  const c = await prisma.client.create({
    data: {
      fullName: `Отказ ${runId} ${clientIds.length}`,
      phone: phone(),
      source: "PHONE_CALL",
      kind: "SELLER",
      status: "NEW",
      assignedAgentId: declinerId,
      assignedAt: new Date(),
      acceptedAt: null,
      ...data,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 4);
  declinerId = (await prisma.agent.create({ data: { fullName: `Отказавший ${runId}`, phone: phone(), role: "AGENT", passwordHash } })).id;
  otherId = (await prisma.agent.create({ data: { fullName: `Следующий ${runId}`, phone: phone(), role: "AGENT", passwordHash } })).id;
  frozenOthers = (
    await prisma.agent.findMany({
      where: { role: "AGENT", isActive: true, frozenAt: null, id: { notIn: [declinerId, otherId] } },
      select: { id: true },
    })
  ).map((a) => a.id);
  if (frozenOthers.length) await prisma.agent.updateMany({ where: { id: { in: frozenOthers } }, data: { frozenAt: new Date() } });
  savedSettings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { leadEscalateAfter: true, leadMaxTransfers: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { leadEscalateAfter: 3, leadMaxTransfers: 3 } });
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: [declinerId, otherId] } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([declinerId, otherId]);
  if (frozenOthers.length) await prisma.agent.updateMany({ where: { id: { in: frozenOthers } }, data: { frozenAt: null } });
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.$disconnect();
});

describe("«Отклонить» после нескольких переходов", () => {
  it("четвёртый отказ: лид уходит следующему агенту, не в «Неактивные» и не руководителю", async () => {
    const c = await lead({ reassignCount: 3, triedAgentIds: [] });

    const result = await declineLead(c.id, declinerId);

    expect(result).toMatchObject({ ok: true, reassignedTo: otherId, escalated: false });
    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.assignedAgentId).toBe(otherId);
    expect(after?.workStatus).not.toBe("INACTIVE");
    expect(after?.escalatedAt).toBeNull();
  });

  it("все уже пробовали: новый круг без отказавшегося", async () => {
    const c = await lead({ reassignCount: 5, triedAgentIds: [otherId] });

    const result = await declineLead(c.id, declinerId);

    expect(result).toMatchObject({ ok: true, reassignedTo: otherId });
  });

  it("отдать правда некому — руководителю, лид не уходит в «Неактивные»", async () => {
    await prisma.agent.update({ where: { id: otherId }, data: { frozenAt: new Date() } });
    try {
      const c = await lead({ reassignCount: 5, triedAgentIds: [] });

      const result = await declineLead(c.id, declinerId);

      expect(result).toMatchObject({ ok: true, reassignedTo: null, escalated: true, lost: false });
      const after = await prisma.client.findUnique({ where: { id: c.id } });
      expect(after?.workStatus).not.toBe("INACTIVE");
      expect(after?.escalatedAt).not.toBeNull();
    } finally {
      await prisma.agent.update({ where: { id: otherId }, data: { frozenAt: null } });
    }
  });
});
