import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { randomInt } from "node:crypto";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Владелец 23.09.2026 (разбор раздачи, пункт 7): карточку, вернувшуюся из
 * Корзины, сначала предлагают прежнему агенту — а утренняя раздача не ждала
 * его ответа и отдавала её другому.
 */

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => undefined),
  sendPushToAgents: vi.fn(async () => undefined),
}));

const { assignPendingLeads } = await import("../src/services/leads/reassignment.js");

const runId = `${Date.now()}${randomInt(1000, 9999)}`;
const phone = () => `+99299${randomInt(1_000_000, 9_999_999)}`;
let formerId: string;
let otherId: string;
const clientIds: string[] = [];
let savedStrategy: string | null = null;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 4);
  formerId = (await prisma.agent.create({ data: { fullName: `Прежний ${runId}`, phone: phone(), role: "AGENT", passwordHash } })).id;
  otherId = (await prisma.agent.create({ data: { fullName: `Другой ${runId}`, phone: phone(), role: "AGENT", passwordHash } })).id;
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { leadDistributionStrategy: true } });
  savedStrategy = s?.leadDistributionStrategy ?? null;
  await prisma.settings.update({ where: { id: "singleton" }, data: { leadDistributionStrategy: "round_robin" } });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([formerId, otherId]);
  if (savedStrategy) await prisma.settings.update({ where: { id: "singleton" }, data: { leadDistributionStrategy: savedStrategy } });
  await prisma.$disconnect();
});

describe("утренняя раздача и предложение прежнему агенту", () => {
  it("карточку, предложенную прежнему агенту, волна не трогает", async () => {
    const c = await prisma.client.create({
      data: {
        fullName: `Вернулся ${runId}`,
        phone: phone(),
        source: "PHONE_CALL",
        kind: "BUYER",
        status: "NEW",
        workStatus: "INACTIVE",
        assignedAgentId: null,
        lastAgentId: formerId,
        reactivationOfferedToAgentId: formerId,
        reactivationOfferedAt: new Date(),
      },
    });
    clientIds.push(c.id);

    await assignPendingLeads();

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.assignedAgentId).toBeNull();
    expect(after?.reactivationOfferedToAgentId).toBe(formerId);
  });
});
