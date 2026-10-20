import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { randomInt } from "node:crypto";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Владелец 23.09.2026 (разбор раздачи, пункт 4): «По кругу» ставило вперёд тех,
 * кто НЕ принимает. Очередь смотрела на самого свежего из клиентов, которые у
 * агента сейчас; не принятый лид уходил дальше — и агент снова оказывался
 * первым. Теперь очередь помнит, что лид ему уже доставался.
 */

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => undefined),
  sendPushToAgents: vi.fn(async () => undefined),
}));

const { reassignStaleLeads } = await import("../src/services/leads/reassignment.js");
const { pickAgentForLead } = await import("../src/services/leads/selection.js");

const runId = `${Date.now()}${randomInt(1000, 9999)}`;
const DAY = 24 * 3600_000;
const phone = () => `+99296${randomInt(1_000_000, 9_999_999)}`;
const ids = { ignorer: "", fresh: "", waiting: "" };
const clientIds: string[] = [];
let frozenOthers: string[] = [];
let savedSettings: Record<string, unknown> | null = null;

async function client(agentId: string, assignedAt: Date, accepted: boolean) {
  const c = await prisma.client.create({
    data: {
      fullName: `Очередь ${runId} ${clientIds.length}`,
      phone: phone(),
      source: "PHONE_CALL",
      kind: "SELLER",
      status: "NEW",
      assignedAgentId: agentId,
      assignedAt,
      acceptedAt: accepted ? assignedAt : null,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 4);
  for (const k of Object.keys(ids) as (keyof typeof ids)[]) {
    ids[k] = (await prisma.agent.create({ data: { fullName: `Очередь ${k} ${runId}`, phone: phone(), role: "AGENT", passwordHash } })).id;
  }
  frozenOthers = (
    await prisma.agent.findMany({
      where: { role: "AGENT", isActive: true, frozenAt: null, id: { notIn: Object.values(ids) } },
      select: { id: true },
    })
  ).map((a) => a.id);
  if (frozenOthers.length) await prisma.agent.updateMany({ where: { id: { in: frozenOthers } }, data: { frozenAt: new Date() } });
  savedSettings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { leadAcceptMinutes: true, leadDistributionStrategy: true, leadEscalationEnabled: true },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { leadAcceptMinutes: 15, leadDistributionStrategy: "round_robin", leadEscalationEnabled: true },
  });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: Object.values(ids) } } });
  await deleteAgentsWithTraces(Object.values(ids));
  if (frozenOthers.length) await prisma.agent.updateMany({ where: { id: { in: frozenOthers } }, data: { frozenAt: null } });
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.$disconnect();
});

describe("«По кругу» не ставит вперёд того, кто не принял", () => {
  it("лид ушёл от агента кругом — следующий новый лид достаётся не ему", async () => {
    // Давние принятые клиенты: у «игнорщика» самый старый, у «ждущего» новее.
    await client(ids.ignorer, new Date(Date.now() - 3 * DAY), true);
    await client(ids.fresh, new Date(Date.now() - 2 * DAY), true);
    await client(ids.waiting, new Date(Date.now() - 1 * DAY), true);
    // Очередь дошла до «игнорщика»: лид выдан ему 16 минут назад, не принят.
    const lead = await client(ids.ignorer, new Date(Date.now() - 16 * 60_000), false);

    await reassignStaleLeads();
    const moved = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(moved?.assignedAgentId).toBe(ids.fresh);

    // Следующий новый лид — тому, кто ждёт дольше всех, а не «игнорщику».
    expect(await pickAgentForLead([], "SELLER")).toBe(ids.waiting);
  });
});
