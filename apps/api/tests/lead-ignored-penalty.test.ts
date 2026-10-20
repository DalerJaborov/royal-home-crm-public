import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { waitForSettled } from "./helpers/waitFor.js";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { reassignStaleLeads } from "../src/leads.js";
import { DEFAULT_EVENT_POINTS } from "../src/lib/scoreJournal.js";

/**
 * «Пуш пришёл, он ничего не сделал» (голосовое владельца 12.08.2026) — лид, не
 * принятый и не отклонённый за отведённое время, уходит следующему агенту сам
 * (carousel уже так работал), но теперь ещё и списывает баллы (lead_ignored),
 * отдельно от lead_declined_* — там агент хотя бы явно нажал «Отклонить».
 */

const runId = Date.now();
let agentAId: string;
let agentBId: string;
const clientIds: string[] = [];
let savedLeadAcceptMinutes: number;

async function makeUnacceptedLead(minutesAgo: number) {
  const c = await prisma.client.create({
    data: {
      fullName: `Лид проигнорирован ${runId}-${clientIds.length}`,
      phone: `+9929${Math.floor(Math.random() * 10_000_000)}`,
      source: "PHONE_CALL",
      assignedAgentId: agentAId,
      assignedAt: new Date(Date.now() - minutesAgo * 60_000),
      acceptedAt: null,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentAId = (
    await prisma.agent.create({
      data: { fullName: "Агент игнорирует лиды", phone: `+992973${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentBId = (
    await prisma.agent.create({
      data: { fullName: "Агент Б для игнора", phone: `+992974${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { leadAcceptMinutes: true } });
  savedLeadAcceptMinutes = s?.leadAcceptMinutes ?? 15;
  await prisma.settings.update({ where: { id: "singleton" }, data: { leadAcceptMinutes: 15 } });
});

afterEach(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: [agentAId, agentBId] } } });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentAId, agentBId] } } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { leadAcceptMinutes: savedLeadAcceptMinutes } });
  await prisma.$disconnect();
});

describe("Лид не принят и не отклонён вовремя", () => {
  it("списывает lead_ignored тому, кто промолчал", async () => {
    const lead = await makeUnacceptedLead(20);
    await reassignStaleLeads();

    const event = await prisma.royalScoreEvent.findFirst({
      where: { agentId: agentAId, kind: "lead_ignored", sourceId: { startsWith: `lead-ignored-${lead.id}-` } },
    });
    expect(event).not.toBeNull();
    expect(event?.delta).toBe(DEFAULT_EVENT_POINTS.lead_ignored);

    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).not.toBe(agentAId);
  });

  it("принят меньше 15 минут назад — ещё рано, штрафа нет", async () => {
    await makeUnacceptedLead(5);
    await reassignStaleLeads();
    const event = await prisma.royalScoreEvent.findFirst({ where: { agentId: agentAId, kind: "lead_ignored" } });
    expect(event).toBeNull();
  });

  it("карточка со старым assignedAt (2 дня) не попадает в карусель — окно кандидатов (17.09.2026)", async () => {
    /**
     * Тот же класс, что и у penalizeMissedFirstCalls (17.09.2026): ручная правка
     * assignedAt на старой непринятой карточке не должна снова делать её «свежим»
     * кандидатом карусели reassignStaleLeads.
     */
    const lead = await makeUnacceptedLead(2 * 24 * 60);

    await reassignStaleLeads();

    const event = await prisma.royalScoreEvent.findFirst({
      where: { agentId: agentAId, kind: "lead_ignored", sourceId: { startsWith: `lead-ignored-${lead.id}-` } },
    });
    expect(event).toBeNull();
    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(agentAId);
  });

  it("повторный тик по уже переназначенному лиду не штрафует второй раз тем же sourceId", async () => {
    const lead = await makeUnacceptedLead(20);
    await reassignStaleLeads();
    const before = await waitForSettled(() => prisma.royalScoreEvent.count({ where: { agentId: agentAId, kind: "lead_ignored" } }));
    // Лид уже переназначен — второй тик его не заберёт снова (acceptedAt всё ещё
    // null у нового агента, но assignedAt свежий и под cutoff не попадёт).
    await reassignStaleLeads();
    const after = await waitForSettled(() => prisma.royalScoreEvent.count({ where: { agentId: agentAId, kind: "lead_ignored" } }));
    expect(after).toBe(before);
    void lead;
  });
});
