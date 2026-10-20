import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { acceptLead } from "../src/lib/leadAccept.js";
import { reassignStaleLeads } from "../src/services/leads/reassignment.js";

/**
 * Гонка «принять vs переназначить» (аудит №4, 27.08).
 *
 * Крон переназначения снимает снимок протухших лидов и потом секунды-десятки
 * секунд подбирает агента. Агент, нажавший «Принять» в это окно, раньше терял
 * клиента: безусловный update крона переставлял assignedAgentId, не глядя на
 * acceptedAt, а безусловный update приёма ставил acceptedAt уже уехавшему лиду.
 * Оба пути теперь захватывают условным updateMany.
 */

const runId = Date.now();
let agentA = "";
let agentB = "";
const clientIds: string[] = [];

async function makeAgent(suffix: string): Promise<string> {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Агент гонки ${suffix} ${runId}`, phone: `+99290${suffix}${String(runId).slice(-6)}`, role: "AGENT", passwordHash },
  });
  return agent.id;
}

/** Лид, назначенный агенту и уже протухший (assignedAt в прошлом). */
async function makeStaleLead(agentId: string, minutesAgo = 60): Promise<string> {
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент гонки ${clientIds.length} ${runId}`,
      phone: `+9929${clientIds.length}${String(runId).slice(-7)}`,
      source: "INSTAGRAM",
      assignedAgentId: agentId,
      assignedAt: new Date(Date.now() - minutesAgo * 60_000),
      acceptedAt: null,
    },
  });
  clientIds.push(client.id);
  return client.id;
}

beforeAll(async () => {
  agentA = await makeAgent("1");
  agentB = await makeAgent("2");
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: [agentA, agentB] } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentA, agentB] } } });
  await prisma.$disconnect();
});

describe("захват лида при приёме", () => {
  it("принимает свой лид и снимает «требует внимания»", async () => {
    const id = await makeStaleLead(agentA, 5);
    const outcome = await acceptLead({ clientId: id, agentId: agentA });
    expect(outcome.ok).toBe(true);
    const row = await prisma.client.findUniqueOrThrow({ where: { id } });
    expect(row.acceptedAt).not.toBeNull();
    expect(row.escalatedAt).toBeNull();
  });

  it("лид переназначен другому агенту, пока шёл приём → 409, чужой acceptedAt не ставится", async () => {
    const id = await makeStaleLead(agentA, 5);
    // Имитируем крон, успевший переназначить лид между проверками и записью.
    await prisma.client.update({ where: { id }, data: { assignedAgentId: agentB, assignedAt: new Date() } });

    const outcome = await acceptLead({ clientId: id, agentId: agentA });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(409); // проверка владельца отсекает раньше захвата

    const row = await prisma.client.findUniqueOrThrow({ where: { id } });
    expect(row.acceptedAt).toBeNull();
    expect(row.assignedAgentId).toBe(agentB);
  });

  it("повторное нажатие по уже принятому лиду безопасно", async () => {
    const id = await makeStaleLead(agentA, 5);
    await acceptLead({ clientId: id, agentId: agentA });
    const again = await acceptLead({ clientId: id, agentId: agentA });
    expect(again.ok).toBe(true);
    expect(await prisma.interaction.count({ where: { clientId: id, notes: { contains: "Лид принят агентом" } } })).toBe(1);
  });
});

describe("захват лида при переназначении", () => {
  it("принятый лид крон больше не уводит и штраф за него не пишет", async () => {
    const id = await makeStaleLead(agentA, 60);
    // Агент успел принять ровно перед проходом крона.
    await prisma.client.update({ where: { id }, data: { acceptedAt: new Date() } });

    await reassignStaleLeads();

    const row = await prisma.client.findUniqueOrThrow({ where: { id } });
    // Лид остался у принявшего: ни переназначения, ни эскалации.
    expect(row.assignedAgentId).toBe(agentA);
    expect(row.escalatedAt).toBeNull();
    expect(row.reassignCount).toBe(0);
    const penalties = await prisma.royalScoreEvent.count({
      where: { agentId: agentA, kind: "lead_ignored", sourceId: { contains: id } },
    });
    expect(penalties).toBe(0);
  });

  it("непринятый протухший лид по-прежнему обрабатывается (переназначение или эскалация)", async () => {
    const id = await makeStaleLead(agentA, 60);
    await reassignStaleLeads();
    const row = await prisma.client.findUniqueOrThrow({ where: { id } });
    // Куда именно уйдёт лид, зависит от настроек и наличия свободных агентов —
    // важно, что крон его ТРОНУЛ: сменил агента, посчитал круг или эскалировал.
    const touched = row.assignedAgentId !== agentA || row.reassignCount > 0 || row.escalatedAt !== null;
    expect(touched).toBe(true);
  });
});
