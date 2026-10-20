import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { randomInt } from "node:crypto";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Владелец 23.09.2026 (разбор раздачи, пункт 5): лид, с которым уже был
 * контакт (отказ от прежнего агента, «Передать», уход сотрудника, возврат из
 * Корзины), новый агент не принял — и он висел «Ждёт принятия» навсегда: круг
 * его не трогал вовсе, руководитель ничего не знал. Теперь круг его не
 * передаёт (закон П-3), но один раз поднимает руководителю.
 */

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => undefined),
  sendPushToAgents: vi.fn(async () => undefined),
}));

const { reassignStaleLeads } = await import("../src/services/leads/reassignment.js");

const runId = `${Date.now()}${randomInt(1000, 9999)}`;
const phone = () => `+99297${randomInt(1_000_000, 9_999_999)}`;
let holderId: string;
let otherId: string;
let directorId: string;
const clientIds: string[] = [];
let savedSettings: Record<string, unknown> | null = null;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 4);
  holderId = (await prisma.agent.create({ data: { fullName: `Держатель ${runId}`, phone: phone(), role: "AGENT", passwordHash } })).id;
  otherId = (await prisma.agent.create({ data: { fullName: `Другой ${runId}`, phone: phone(), role: "AGENT", passwordHash } })).id;
  directorId = (await prisma.agent.create({ data: { fullName: `Директор ${runId}`, phone: phone(), role: "DIRECTOR", passwordHash } })).id;
  savedSettings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { leadAcceptMinutes: true, leadEscalationEnabled: true },
  });
  await prisma.settings.update({ where: { id: "singleton" }, data: { leadAcceptMinutes: 15, leadEscalationEnabled: true } });
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { agentId: { in: [holderId, otherId, directorId] } } });
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: [holderId, otherId] } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([holderId, otherId, directorId]);
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.$disconnect();
});

describe("лид с контактом не висит «Ждёт принятия» молча", () => {
  it("не принят за 15 минут — остаётся у держателя и один раз уходит руководителю", async () => {
    const lead = await prisma.client.create({
      data: {
        fullName: `Контакт был ${runId}`,
        phone: phone(),
        source: "PHONE_CALL",
        kind: "BUYER",
        status: "CONTACTED",
        assignedAgentId: holderId,
        assignedAt: new Date(Date.now() - 16 * 60_000),
        acceptedAt: null,
        firstContactAt: new Date(Date.now() - 3 * 24 * 3600_000),
      },
    });
    clientIds.push(lead.id);

    await reassignStaleLeads();

    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(holderId);
    expect(after?.escalatedAt).not.toBeNull();
    const toDirector = await prisma.notification.count({ where: { agentId: directorId, url: `/clients/${lead.shortId}` } });
    expect(toDirector).toBeGreaterThan(0);

    // Следующий тик лид уже не трогает: он у руководителя, а не в круге.
    const escalatedAt = after!.escalatedAt!.getTime();
    await reassignStaleLeads();
    const later = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(later?.escalatedAt?.getTime()).toBe(escalatedAt);
    expect(later?.assignedAgentId).toBe(holderId);
  });
});
