import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { releaseLeadsToQueue } from "../src/lib/agentLeadRelease.js";

/**
 * CRM-03 (аудит 04.10.2026): заморозка, пауза и отключение читали список
 * непринятых лидов ДО транзакции, а снимали каждого через changeClientAgent без
 * условия на прежнего владельца. Принял лид агент или передали другому, пока шла
 * заморозка, клиент всё равно уходил в очередь.
 */
const runId = Date.now();
let agentA = "";
let agentB = "";
const clientIds: string[] = [];

async function makeLead(label: string) {
  const c = await prisma.client.create({
    data: { fullName: `Лид ${label} ${runId}`, phone: `+992933${runId}${clientIds.length}`, source: "PHONE_CALL", assignedAgentId: agentA },
    select: { id: true, shortId: true, fullName: true },
  });
  clientIds.push(c.id);
  return c;
}

const opts = () => ({ agentId: agentA, actorId: agentB, actorName: "Руководитель", reason: "тест", source: "freeze" });

beforeAll(async () => {
  agentA = (await prisma.agent.create({ data: { fullName: `Агент A CRM-03 ${runId}`, phone: `+992932${runId}`, role: "AGENT", passwordHash: "x" } })).id;
  agentB = (await prisma.agent.create({ data: { fullName: `Агент B CRM-03 ${runId}`, phone: `+992931${runId}`, role: "AGENT", passwordHash: "x" } })).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentA, agentB] } } });
});

describe("releaseLeadsToQueue: условие на прежнего владельца (CRM-03)", () => {
  it("непринятый лид уходит в очередь; принятый и переданный за время заморозки остаются", async () => {
    const fresh = await makeLead("непринятый");
    const accepted = await makeLead("принят");
    const moved = await makeLead("передан");
    const leads = [fresh, accepted, moved];

    // Между чтением списка и снятием: А принял одного, руководитель передал другого Б.
    await prisma.client.update({ where: { id: accepted.id }, data: { acceptedAt: new Date() } });
    await prisma.client.update({ where: { id: moved.id }, data: { assignedAgentId: agentB } });

    const released = await prisma.$transaction((tx) => releaseLeadsToQueue(tx, leads, opts()));

    const owner = async (id: string) => (await prisma.client.findUniqueOrThrow({ where: { id } })).assignedAgentId;
    expect(await owner(fresh.id)).toBeNull();
    expect(await owner(accepted.id)).toBe(agentA);
    expect(await owner(moved.id)).toBe(agentB);
    expect(released.map((l) => l.id)).toEqual([fresh.id]);
  });
});
