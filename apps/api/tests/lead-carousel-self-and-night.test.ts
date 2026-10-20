import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { randomInt } from "node:crypto";
import { prisma } from "../src/db.js";
import { dushanbeNextOccurrence } from "../src/lib/dushanbeTime.js";

/**
 * ПР-000453 (владелец 23.09.2026): непринятый лид каждые 16 минут
 * «переназначался» Сурайё от неё же самой, а круг «не принял за 15 минут»
 * крутился и ночью. Три правила этого файла:
 *  1. новый круг не выбирает текущего держателя;
 *  2. с конца до начала «Когда лиды уходят агентам» круг стоит;
 *  3. утром круг продолжает с вечернего лида и не штрафует за ночь.
 */

const { push } = vi.hoisted(() => ({ push: vi.fn(async () => undefined) }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: push,
  sendPushToAgents: push,
}));

const { reassignStaleLeads, staleLeadCircleOpen } = await import("../src/services/leads/reassignment.js");

// Ровно то, что делает задача «lead-stale-reassignment» в cron.ts.
async function cronTick(now: Date) {
  if (!(await staleLeadCircleOpen(now))) return { skipped: true };
  await reassignStaleLeads(now);
  return { skipped: false };
}

const runId = `${Date.now()}${randomInt(1000, 9999)}`;
let veteranId: string;
let newbieId: string;
const clientIds: string[] = [];
let frozenOthers: string[] = [];
let savedSettings: Record<string, unknown> | null = null;

const phone = () => `+99293${randomInt(1_000_000, 9_999_999)}`;

async function makeLead(data: { holder: string; assignedAt: Date; reassignCount?: number; triedAgentIds?: string[] }) {
  const lead = await prisma.client.create({
    data: {
      fullName: `Круг ${runId} ${clientIds.length}`,
      phone: phone(),
      source: "PHONE_CALL",
      kind: "SELLER",
      status: "NEW",
      assignedAgentId: data.holder,
      assignedAt: data.assignedAt,
      acceptedAt: null,
      reassignCount: data.reassignCount ?? 0,
      triedAgentIds: data.triedAgentIds ?? [],
    },
  });
  clientIds.push(lead.id);
  return lead;
}

const pushTitlesTo = (agentId: string) =>
  push.mock.calls
    .filter((c) => (c as unknown as [string])[0] === agentId)
    .map((c) => (c as unknown as [string, { title?: string }])[1]?.title);

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 4);
  veteranId = (await prisma.agent.create({ data: { fullName: `Опытный ${runId}`, phone: phone(), role: "AGENT", passwordHash } })).id;
  newbieId = (await prisma.agent.create({ data: { fullName: `Новичок ${runId}`, phone: phone(), role: "AGENT", passwordHash } })).id;
  frozenOthers = (
    await prisma.agent.findMany({
      where: { role: "AGENT", isActive: true, frozenAt: null, id: { notIn: [veteranId, newbieId] } },
      select: { id: true },
    })
  ).map((a) => a.id);
  if (frozenOthers.length) await prisma.agent.updateMany({ where: { id: { in: frozenOthers } }, data: { frozenAt: new Date() } });

  savedSettings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      leadAcceptMinutes: true,
      leadDistributionStrategy: true,
      leadEscalationEnabled: true,
      workHoursStart: true,
      workHoursEnd: true,
      royalScoreEnabled: true,
    },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      leadAcceptMinutes: 15,
      leadDistributionStrategy: "round_robin",
      leadEscalationEnabled: true,
      workHoursStart: "10:00",
      workHoursEnd: "21:00",
      royalScoreEnabled: true,
    },
  });

  // Опытный только что перевёл клиента в «Неактивные» — пауза выдачи (как на
  // проде 23.09: все, кроме новичка, на паузе).
  const inactive = await prisma.client.create({
    data: {
      fullName: `Неактивный ${runId}`,
      phone: phone(),
      source: "PHONE_CALL",
      status: "COLD",
      workStatus: "INACTIVE",
      inactiveSince: new Date(),
      inactiveEnteredAt: new Date(),
      assignedAgentId: veteranId,
      assignedAt: new Date(Date.now() - 86_400_000),
      acceptedAt: new Date(Date.now() - 86_400_000),
    },
  });
  clientIds.push(inactive.id);
});

beforeEach(() => push.mockClear());

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { OR: [{ clientId: { in: clientIds } }, { agentId: { in: [veteranId, newbieId] } }] } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [veteranId, newbieId] } } });
  if (frozenOthers.length) await prisma.agent.updateMany({ where: { id: { in: frozenOthers } }, data: { frozenAt: null } });
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.$disconnect();
});

describe("новый круг не отдаёт лид тому же держателю", () => {
  it("круг пройден, держатель — новичок: лид уходит опытному, а не новичку самому себе", async () => {
    const lead = await makeLead({
      holder: newbieId,
      assignedAt: new Date(Date.now() - 16 * 60_000),
      reassignCount: 5, // потолок круга давно пройден — ровно как у ПР-000453
      triedAgentIds: [],
    });

    await reassignStaleLeads();

    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(veteranId);
    expect(pushTitlesTo(newbieId)).not.toContain("🤝 Лид переназначен вам");
  });

  it("кроме держателя принимать некому: руководителю, а не самому себе", async () => {
    await prisma.agent.update({ where: { id: veteranId }, data: { frozenAt: new Date() } });
    try {
      const lead = await makeLead({ holder: newbieId, assignedAt: new Date(Date.now() - 16 * 60_000), reassignCount: 5 });

      await reassignStaleLeads();

      const after = await prisma.client.findUnique({ where: { id: lead.id } });
      expect(after?.assignedAgentId).toBe(newbieId);
      expect(after?.escalatedAt).not.toBeNull();
      expect(after?.reassignCount).toBe(5);
      expect(pushTitlesTo(newbieId)).not.toContain("🤝 Лид переназначен вам");
    } finally {
      await prisma.agent.update({ where: { id: veteranId }, data: { frozenAt: null } });
    }
  });
});

describe("ночью круг стоит, утром продолжает", () => {
  it("в 22:00 по Душанбе лид остаётся у держателя, уведомлений нет", async () => {
    const night = dushanbeNextOccurrence("22:00");
    const lead = await makeLead({ holder: newbieId, assignedAt: new Date(night.getTime() - 40 * 60_000) });

    const result = await cronTick(night);

    expect(result.skipped).toBe(true);
    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(newbieId);
    expect(after?.reassignCount).toBe(0);
    expect(push).not.toHaveBeenCalled();
  });

  it("в 10:01 вечерний лид (20:55) уходит дальше, штрафа за ночь нет", async () => {
    const morning = dushanbeNextOccurrence("10:01");
    const evening = new Date(morning.getTime() - (13 * 60 + 6) * 60_000); // 20:55 накануне
    const lead = await makeLead({ holder: newbieId, assignedAt: evening });

    const result = await cronTick(morning);

    expect(result.skipped).toBe(false);
    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(veteranId);
    const penalties = await prisma.royalScoreEvent.count({
      where: { agentId: newbieId, kind: "lead_ignored", sourceId: { contains: lead.id } },
    });
    expect(penalties).toBe(0);
  });

  it("днём просроченный лид по-прежнему штрафуется", async () => {
    const lead = await makeLead({ holder: newbieId, assignedAt: new Date(Date.now() - 16 * 60_000) });
    const noon = dushanbeNextOccurrence("12:00");
    // Держатель выдан в 11:44 того же дня, срок 11:59 — внутри часов раздачи.
    await prisma.client.update({ where: { id: lead.id }, data: { assignedAt: new Date(noon.getTime() - 16 * 60_000) } });

    await cronTick(noon);

    const penalties = await prisma.royalScoreEvent.count({
      where: { agentId: newbieId, kind: "lead_ignored", sourceId: { contains: lead.id } },
    });
    expect(penalties).toBe(1);
  });
});
