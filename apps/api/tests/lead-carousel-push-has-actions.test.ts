import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { randomInt } from "node:crypto";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * Владелец 23.09.2026 (разбор раздачи, пункт 8): со второго агента круг слал
 * обычный пуш — без кнопок «Принять»/«Отклонить», окно новой заявки не
 * всплывало, а минус за «не принял» писался как обычно.
 */

const { push } = vi.hoisted(() => ({ push: vi.fn(async () => 1) }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: push,
  sendPushToAgents: push,
}));

const { reassignStaleLeads } = await import("../src/services/leads/reassignment.js");

const runId = `${Date.now()}${randomInt(1000, 9999)}`;
const phone = () => `+99290${randomInt(1_000_000, 9_999_999)}`;
let holderId: string;
let nextId: string;
const clientIds: string[] = [];
let frozenOthers: string[] = [];
let savedSettings: Record<string, unknown> | null = null;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 4);
  holderId = (await prisma.agent.create({ data: { fullName: `Держатель ${runId}`, phone: phone(), role: "AGENT", passwordHash } })).id;
  nextId = (await prisma.agent.create({ data: { fullName: `Следующий ${runId}`, phone: phone(), role: "AGENT", passwordHash } })).id;
  frozenOthers = (
    await prisma.agent.findMany({
      where: { role: "AGENT", isActive: true, frozenAt: null, id: { notIn: [holderId, nextId] } },
      select: { id: true },
    })
  ).map((a) => a.id);
  if (frozenOthers.length) await prisma.agent.updateMany({ where: { id: { in: frozenOthers } }, data: { frozenAt: new Date() } });
  savedSettings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { leadAcceptMinutes: true, leadEscalationEnabled: true, pushLeadActionsEnabled: true },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { leadAcceptMinutes: 15, leadEscalationEnabled: true, pushLeadActionsEnabled: true },
  });
});

afterAll(async () => {
  await prisma.pushActionToken.deleteMany({ where: { agentId: { in: [holderId, nextId] } } }).catch(() => undefined);
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: [holderId, nextId] } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([holderId, nextId]);
  if (frozenOthers.length) await prisma.agent.updateMany({ where: { id: { in: frozenOthers } }, data: { frozenAt: null } });
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.$disconnect();
});

describe("лид, ушедший по кругу, приходит следующему агенту с кнопками", () => {
  it("пуш следующему агенту несёт маркер действий «Принять»/«Отклонить»", async () => {
    const lead = await prisma.client.create({
      data: {
        fullName: `Кнопки ${runId}`,
        phone: phone(),
        source: "PHONE_CALL",
        kind: "SELLER",
        status: "NEW",
        assignedAgentId: holderId,
        assignedAt: new Date(Date.now() - 16 * 60_000),
        acceptedAt: null,
      },
    });
    clientIds.push(lead.id);

    await reassignStaleLeads();

    expect((await prisma.client.findUnique({ where: { id: lead.id } }))?.assignedAgentId).toBe(nextId);
    // Пуш уходит «в отрыве» (не ждём его в круге) — дожидаемся.
    const toNext = await waitFor(
      () => {
        const calls = push.mock.calls
          .filter((c) => (c as unknown as [string])[0] === nextId)
          .map((c) => (c as unknown as [string, { actionToken?: string; kind?: string }])[1]);
        return calls.length > 0 ? calls : null;
      },
      { label: "пуш следующему агенту" }
    );
    expect(toNext[0].kind).toBe("lead");
    expect(toNext[0].actionToken).toBeTruthy();
  });
});
