import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { changeClientAgent } from "../src/lib/changeClientAgent.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Пункт 21 разбора раздачи (23.09.2026): пометка «свой объект»
 * (`ownPropertyLead`) принадлежит хозяину объекта. Лид, переданный
 * постороннему агенту, раньше вёз её дальше — и у нового агента на первом же
 * сроке уходил руководителю без напоминания, потому что напоминание уже было
 * отмечено отправленным прежнему хозяину.
 */

const runId = Date.now();
let districtId: string;
let ownerId: string;
let otherId: string;
let directorId: string;
let propertyId: string;
const clientIds: string[] = [];

async function makeOwnLead(label: string, agentId: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `Свой объект ${label} ${runId}`,
      phone: `+99291${String(runId).slice(-6)}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      assignedAt: new Date(),
      ownPropertyLead: true,
      ownPropertyReminderSentAt: new Date(),
      matchedPropertyId: propertyId,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район-пометка-${runId}` } })).id;
  const mk = (fullName: string, role: "AGENT" | "DIRECTOR", n: number) =>
    prisma.agent.create({
      data: { fullName, role, phone: `+99290${String(runId).slice(-6)}${n}`, passwordHash: "x" },
    });
  ownerId = (await mk("Хозяин объекта", "AGENT", 1)).id;
  otherId = (await mk("Посторонний агент", "AGENT", 2)).id;
  directorId = (await mk("Директор пометки", "DIRECTOR", 3)).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект пометки ${runId}`,
        type: "APARTMENT",
        areaSqm: 60,
        rooms: 2,
        price: 300_000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 21",
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId: ownerId,
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await deleteAgentsWithTraces([ownerId, otherId, directorId]);
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

async function flags(id: string) {
  return prisma.client.findUniqueOrThrow({
    where: { id },
    select: { assignedAgentId: true, ownPropertyLead: true, ownPropertyReminderSentAt: true },
  });
}

describe("Пометка «свой объект» при смене агента", () => {
  it("передача постороннему агенту снимает пометку и отметку о напоминании", async () => {
    const lead = await makeOwnLead("передача", ownerId);
    const res = await changeClientAgent({
      clientId: lead.id,
      toAgentId: otherId,
      source: "handover",
      reason: "тест: передача постороннему",
      actorId: directorId,
    });
    expect(res.ok).toBe(true);
    const after = await flags(lead.id);
    expect(after.assignedAgentId).toBe(otherId);
    expect(after.ownPropertyLead).toBe(false);
    expect(after.ownPropertyReminderSentAt).toBeNull();
  });

  it("возврат в очередь без агента тоже снимает пометку", async () => {
    const lead = await makeOwnLead("очередь", ownerId);
    const res = await changeClientAgent({
      clientId: lead.id,
      toAgentId: null,
      source: "freeze",
      reason: "тест: снятие в очередь",
      actorId: directorId,
    });
    expect(res.ok).toBe(true);
    const after = await flags(lead.id);
    expect(after.ownPropertyLead).toBe(false);
    expect(after.ownPropertyReminderSentAt).toBeNull();
  });

  it("передача самому хозяину объекта пометку оставляет, а напоминание начинается заново", async () => {
    const lead = await makeOwnLead("к хозяину", otherId);
    const res = await changeClientAgent({
      clientId: lead.id,
      toAgentId: ownerId,
      source: "handover",
      reason: "тест: к хозяину объекта",
      actorId: directorId,
    });
    expect(res.ok).toBe(true);
    const after = await flags(lead.id);
    expect(after.ownPropertyLead).toBe(true);
    expect(after.ownPropertyReminderSentAt).toBeNull();
  });

  it("правка без смены агента пометку не трогает", async () => {
    const lead = await makeOwnLead("тот же", ownerId);
    const res = await changeClientAgent({
      clientId: lead.id,
      toAgentId: ownerId,
      source: "handover",
      reason: "тест: тот же агент",
      actorId: directorId,
    });
    expect(res.ok).toBe(true);
    const after = await flags(lead.id);
    expect(after.ownPropertyLead).toBe(true);
    expect(after.ownPropertyReminderSentAt).not.toBeNull();
  });
});
