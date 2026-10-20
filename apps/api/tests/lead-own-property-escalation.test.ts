import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { reassignStaleLeads } from "../src/leads.js";

/**
 * П-13 (18.09.2026, `docs/audit/recon-17-09/06-chats-misrouting-30d.md` §3):
 * 86% (18 из 21) лидов по своему объекту за 30 дней ушли НЕ хозяину — не из-за
 * автоматики (она уже эскалировала правильно, Пачка 1 п.6, 11.09.2026), а из-за
 * ручного `LEAD_ASSIGN` директора сразу по первому сигналу «эскалация». Живой
 * пример из отчёта: объект №3, хозяин Бахтиёр — 8 разных клиентов заматчено,
 * ни один не остался у него.
 *
 * Уточнение — ДВЕ ступени вместо одной: сначала напоминание хозяину (без
 * эскалации, без пуша руководителю), эскалация только при продолжающемся
 * молчании ещё `leadAcceptMinutes` спустя. Лид «по своему объекту» НИКОГДА не
 * уходит следующему по очереди автоматически — ни на первой, ни на второй
 * ступени.
 */

const runId = Date.now();
let ownerAgentId: string;
let otherAgentId: string;
const clientIds: string[] = [];
let savedLeadAcceptMinutes: number;

async function makeOwnPropertyLead(assignedMinutesAgo: number, reminderSentMinutesAgo: number | null) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент по объекту №3 ${runId}-${clientIds.length}`,
      phone: `+9929${Math.floor(Math.random() * 10_000_000)}`,
      source: "INSTAGRAM",
      kind: "BUYER",
      assignedAgentId: ownerAgentId,
      assignedAt: new Date(Date.now() - assignedMinutesAgo * 60_000),
      acceptedAt: null,
      ownPropertyLead: true,
      assignReason: "own_property_match",
      ownPropertyReminderSentAt:
        reminderSentMinutesAgo === null ? null : new Date(Date.now() - reminderSentMinutesAgo * 60_000),
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  ownerAgentId = (
    await prisma.agent.create({
      data: { fullName: "Бахтиёр (хозяин объекта, тест)", phone: `+992975${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  otherAgentId = (
    await prisma.agent.create({
      data: { fullName: "Другой агент (тест)", phone: `+992976${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { leadAcceptMinutes: true } });
  savedLeadAcceptMinutes = s?.leadAcceptMinutes ?? 15;
  await prisma.settings.update({ where: { id: "singleton" }, data: { leadAcceptMinutes: 15 } });
});

afterEach(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: [ownerAgentId, otherAgentId] } } });
});

afterAll(async () => {
  // Запись хронологии от агента может дописаться уже после первой чистки (её пишет
  // фоновый вызов) — поэтому чистим и по клиентам, и по самим агентам, иначе
  // удаление агента падает на Interaction_agentId_fkey (воркер vitest ронял весь прогон).
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { agentId: { in: [ownerAgentId, otherAgentId] } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [ownerAgentId, otherAgentId] } } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { leadAcceptMinutes: savedLeadAcceptMinutes } });
  await prisma.$disconnect();
});

describe("Лид по своему объекту, не принятый вовремя — две ступени, не очередь", () => {
  it("15+ мин без напоминания — ступень 1: только напоминание хозяину, без эскалации, лид остаётся у него", async () => {
    const lead = await makeOwnPropertyLead(20, null);
    await reassignStaleLeads();

    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    // Хозяин объекта не поменялся — карусель НЕ отдала лид следующему агенту.
    expect(after?.assignedAgentId).toBe(ownerAgentId);
    expect(after?.escalatedAt).toBeNull();
    expect(after?.ownPropertyReminderSentAt).not.toBeNull();
  });

  it("меньше 15 мин — ещё рано, ни напоминания, ни эскалации", async () => {
    const lead = await makeOwnPropertyLead(5, null);
    await reassignStaleLeads();

    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(ownerAgentId);
    expect(after?.escalatedAt).toBeNull();
    expect(after?.ownPropertyReminderSentAt).toBeNull();
  });

  it("напоминание отправлено, но меньше 15 мин назад — ждём, эскалации ещё нет", async () => {
    const lead = await makeOwnPropertyLead(20, 5);
    await reassignStaleLeads();

    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(ownerAgentId);
    expect(after?.escalatedAt).toBeNull();
  });

  it("ступень 2: напоминание было 15+ мин назад, хозяин всё ещё молчит — эскалация руководителю, лид НЕ уходит следующему по очереди", async () => {
    const lead = await makeOwnPropertyLead(35, 20);
    await reassignStaleLeads();

    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    // Ключевая проверка отчёта: объект №3 остаётся за хозяином, а не уходит
    // произвольному следующему агенту (то, что раньше делал ручной LEAD_ASSIGN).
    expect(after?.assignedAgentId).toBe(ownerAgentId);
    expect(after?.assignedAgentId).not.toBe(otherAgentId);
    expect(after?.escalatedAt).not.toBeNull();
  });
});
