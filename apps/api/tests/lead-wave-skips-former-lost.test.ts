import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { randomInt } from "node:crypto";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Владелец 16.11.2026: «Потерянных» больше нет, старые LOST вернулись в обычный
 * список (NEW/CONTACTED) — часть из них без агента. Утренняя волна раздаёт только
 * настоящие новые заявки: бывшую «потерянную» она не рассылает агентам как
 * «новый лид с ночи». Свежая заявка без агента по-прежнему раздаётся.
 */

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => undefined),
  sendPushToAgents: vi.fn(async () => undefined),
}));

const { assignPendingLeads } = await import("../src/services/leads/reassignment.js");

const runId = `${Date.now()}${randomInt(1000, 9999)}`;
const phone = () => `+99299${randomInt(1_000_000, 9_999_999)}`;
const DAY = 24 * 3600_000;
let agentId: string;
const clientIds: string[] = [];
let savedStrategy: string | null = null;
let savedHours: { workHoursStart: string; workHoursEnd: string } | null = null;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 4);
  agentId = (await prisma.agent.create({ data: { fullName: `Волна ${runId}`, phone: phone(), role: "AGENT", passwordHash } })).id;
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { leadDistributionStrategy: true, workHoursStart: true, workHoursEnd: true } });
  savedStrategy = s?.leadDistributionStrategy ?? null;
  savedHours = s ? { workHoursStart: s.workHoursStart, workHoursEnd: s.workHoursEnd } : null;
  await prisma.settings.update({ where: { id: "singleton" }, data: { leadDistributionStrategy: "round_robin", workHoursStart: "00:00", workHoursEnd: "24:00" } });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([agentId]);
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { ...(savedStrategy ? { leadDistributionStrategy: savedStrategy } : {}), ...(savedHours ?? {}) },
  });
  await prisma.$disconnect();
});

describe("утренняя волна — только новые заявки", () => {
  it("бывший LOST без агента не раздаётся, свежая заявка раздаётся", async () => {
    const old = new Date(Date.now() - 60 * DAY);
    const formerLost = await prisma.client.create({
      data: {
        fullName: `Бывший потерянный ${runId}`,
        phone: phone(),
        source: "PHONE_CALL",
        kind: "BUYER",
        status: "NEW",
        assignedAgentId: null,
        lostAt: new Date(Date.now() - 30 * DAY),
        createdAt: old,
        assignedAt: old,
      },
    });
    clientIds.push(formerLost.id);
    const fresh = await prisma.client.create({
      data: { fullName: `Новая заявка ${runId}`, phone: phone(), source: "PHONE_CALL", kind: "BUYER", status: "NEW", assignedAgentId: null },
    });
    clientIds.push(fresh.id);

    await assignPendingLeads();

    expect((await prisma.client.findUniqueOrThrow({ where: { id: formerLost.id } })).assignedAgentId).toBeNull();
    expect((await prisma.client.findUniqueOrThrow({ where: { id: fresh.id } })).assignedAgentId).not.toBeNull();
  });
});
