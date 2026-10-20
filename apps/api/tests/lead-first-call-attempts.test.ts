import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { collectFirstCallFacts, penalizeMissedFirstCalls } from "../src/leads.js";

/**
 * Что закрывает обязанность первого звонка (23.09.2026, проверка раздачи,
 * пункты 11 и 12).
 *  - Пункт 11: сообщение клиенту из CRM — такая же попытка связаться, как
 *    звонок (закон о владении клиентом, П-2). Раньше считался только звонок.
 *  - Пункт 12: звонок, который агент сам не снял (или отменил до ответа), до
 *    телефона клиента не дошёл. Раньше он закрывал обязанность как попытка.
 */

const runId = Date.now();
const MIN = 60_000;
let agentId: string;
const clientIds: string[] = [];
let savedHours: { workHoursStart: string; workHoursEnd: string } | null = null;

async function seedLead(name: string, acceptedMinutesAgo: number, lastAgentAttemptMinutesAgo?: number) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+9929${Math.floor(Math.random() * 10_000_000)}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      assignedAt: new Date(Date.now() - acceptedMinutesAgo * MIN),
      acceptedAt: new Date(Date.now() - acceptedMinutesAgo * MIN),
      ...(lastAgentAttemptMinutesAgo !== undefined
        ? { lastAgentAttemptAt: new Date(Date.now() - lastAgentAttemptMinutesAgo * MIN) }
        : {}),
    },
  });
  clientIds.push(c.id);
  return c;
}

/** Звонок так, как его пишет lib/telephony/callTracker.ts. */
async function seedCall(clientId: string, minutesAgo: number, callAttempt: string | null) {
  await prisma.interaction.create({
    data: {
      clientId,
      agentId,
      type: "CALL",
      notes: "Звонок через CRM",
      callAttempt,
      createdAt: new Date(Date.now() - minutesAgo * MIN),
    },
  });
}

const tried = async (lead: { id: string; assignedAgentId: string | null; acceptedAt: Date | null }) =>
  !!(await collectFirstCallFacts([lead], 30, 15)).get(lead.id)?.tried;

const penalized = (clientId: string) =>
  prisma.royalScoreEvent.count({ where: { sourceId: { startsWith: `call-missed-${clientId}-` } } });

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент попыток", phone: `+992974${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  savedHours = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { workHoursStart: true, workHoursEnd: true },
  });
  // Срок стоит вне часов раздачи — круглосуточное окно держит файл зелёным ночью.
  await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "24:00" } });
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.interaction.deleteMany({ where: { OR: [{ clientId: { in: clientIds } }, { agentId }] } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([agentId]);
  if (savedHours) await prisma.settings.update({ where: { id: "singleton" }, data: savedHours });
  await prisma.$disconnect();
});

describe("пункт 11: сообщение из CRM — попытка связаться", () => {
  it("агент написал клиенту в срок — обязанность закрыта", async () => {
    const lead = await seedLead("Написал в срок", 20, 18);
    expect(await tried(lead)).toBe(true);
  });

  it("сообщение до принятия лида не в счёт", async () => {
    const lead = await seedLead("Писал раньше", 20, 25);
    expect(await tried(lead)).toBe(false);
  });

  it("крон не штрафует агента, который написал клиенту", async () => {
    const lead = await seedLead("Написал, не звонил", 20, 18);
    await penalizeMissedFirstCalls();
    expect(await penalized(lead.id)).toBe(0);
  });
});

describe("пункт 12: звонок, не дошедший до клиента, — не попытка", () => {
  it("агент не снял трубку — обязанность не закрыта", async () => {
    const lead = await seedLead("Сам не снял", 20);
    await seedCall(lead.id, 18, "AGENT_NO_PICKUP");
    expect(await tried(lead)).toBe(false);
  });

  it("агент отменил вызов — обязанность не закрыта", async () => {
    const lead = await seedLead("Отменил", 20);
    await seedCall(lead.id, 18, "CANCELLED");
    expect(await tried(lead)).toBe(false);
  });

  it("клиент не ответил — попытка засчитана, как и раньше", async () => {
    const lead = await seedLead("Клиент не взял", 20);
    await seedCall(lead.id, 18, "NO_ANSWER");
    expect(await tried(lead)).toBe(true);
  });

  it("ручная запись звонка (исход не указан) — попытка, как и раньше", async () => {
    const lead = await seedLead("Записал руками", 20);
    await seedCall(lead.id, 18, null);
    expect(await tried(lead)).toBe(true);
  });

  it("крон штрафует, если был только несостоявшийся звонок", async () => {
    const lead = await seedLead("Только не снял", 20);
    await seedCall(lead.id, 18, "AGENT_NO_PICKUP");
    await penalizeMissedFirstCalls();
    expect(await penalized(lead.id)).toBe(1);
  });
});
