import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";

/**
 * УТРЕННЯЯ ВОЛНА НЕ ПЕРЕПИСЫВАЕТ «ВЗЯТЬ СЕБЕ» (23.09.2026, аудит №23).
 *
 * Волна читает ничейных лидов, потом по одному подбирает агента. Если между
 * чтением и записью руководитель нажал «Взять себе» (или отдал лида агенту),
 * запись волны шла без условия на владельца и молча переставляла карточку.
 * Подбор агента подменён: в нём и происходит «ручное» назначение — ровно то
 * окно, в которое оно попадает в жизни.
 */

const { takeOver } = vi.hoisted(() => ({ takeOver: { clientId: "", managerId: "", waveAgentId: "" } }));

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => undefined),
  sendPushToAgents: vi.fn(async () => undefined),
}));
vi.mock("../src/services/leads/assignment.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/services/leads/assignment.js")>();
  return {
    ...orig,
    assignAgentForLead: vi.fn(async (ctx: { clientId: string }) => {
      if (ctx.clientId !== takeOver.clientId) return { agentId: null };
      const { prisma: db } = await import("../src/db.js");
      await db.client.update({ where: { id: takeOver.clientId }, data: { assignedAgentId: takeOver.managerId, acceptedAt: new Date() } });
      return { agentId: takeOver.waveAgentId };
    }),
  };
});

const { assignPendingLeads } = await import("../src/services/leads/reassignment.js");

const runId = Date.now();
const tail = String(runId).slice(-6);
const agentIds: string[] = [];

beforeAll(async () => {
  for (const [name, role, prefix] of [
    ["Руководитель", "MANAGER", "992931"],
    ["Агент волны", "AGENT", "992932"],
  ] as const) {
    const a = await prisma.agent.create({ data: { fullName: `${name} ${runId}`, phone: `+${prefix}${tail}`, role, passwordHash: "x" } });
    agentIds.push(a.id);
  }
  [takeOver.managerId, takeOver.waveAgentId] = agentIds;
  const phone = `+992933${tail}`;
  await prisma.client.deleteMany({ where: { phone } });
  takeOver.clientId = (
    await prisma.client.create({ data: { fullName: `Лид с ночи ${runId}`, phone, source: "INSTAGRAM", status: "NEW" } })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: takeOver.clientId } });
  await prisma.client.deleteMany({ where: { id: takeOver.clientId } });
  await prisma.interaction.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("Утренняя волна и ручное назначение", () => {
  it("лид, которого руководитель взял себе, пока волна подбирала агента, остаётся у руководителя", async () => {
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { leadDistributionStrategy: true } });
    if (settings?.leadDistributionStrategy === "manual") {
      await prisma.settings.update({ where: { id: "singleton" }, data: { leadDistributionStrategy: "fair" } });
    }
    try {
      await assignPendingLeads();
    } finally {
      if (settings?.leadDistributionStrategy === "manual") {
        await prisma.settings.update({ where: { id: "singleton" }, data: { leadDistributionStrategy: "manual" } });
      }
    }
    const c = await prisma.client.findUniqueOrThrow({ where: { id: takeOver.clientId }, select: { assignedAgentId: true } });
    expect(c.assignedAgentId).toBe(takeOver.managerId);
  });
});
