import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { randomInt } from "node:crypto";
import { prisma } from "../src/db.js";
import { createLeadFromChannel } from "../src/leads.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Клиент из «Неактивных» написал снова, а прежнего агента нет (23.09.2026,
 * проверка раздачи, пункт 19). Раньше новый агент получал карточку сразу
 * «принятой» (прежний acceptedAt): без «Принять», без срока первого звонка,
 * иногда ночью. Теперь это новый лид, а ночью он ждёт утренней волны.
 */

const phone = () => `+99297${randomInt(1_000_000, 9_999_999)}`;
let firedId = "";
let freeId = "";
const clientIds: string[] = [];

async function inactiveClientOfFired() {
  const c = await prisma.client.create({
    data: {
      fullName: `Вернулся ${randomInt(1000, 9999)}`,
      phone: phone(),
      source: "WHATSAPP",
      kind: "BUYER",
      status: "CONTACTED",
      workStatus: "INACTIVE",
      assignedAgentId: firedId,
      lastAgentId: firedId,
      assignedAt: new Date(Date.now() - 30 * 86_400_000),
      acceptedAt: new Date(Date.now() - 30 * 86_400_000),
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 4);
  firedId = (await prisma.agent.create({ data: { fullName: "Уволенный", phone: phone(), role: "AGENT", passwordHash, isActive: false } })).id;
  freeId = (await prisma.agent.create({ data: { fullName: "Свободный", phone: phone(), role: "AGENT", passwordHash } })).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([firedId, freeId]);
  await prisma.$disconnect();
});

describe("возврат из «Неактивных» к новому агенту", () => {
  it("днём — новому агенту как новый лид: ждёт «Принять»", async () => {
    const c = await inactiveClientOfFired();
    await createLeadFromChannel({ fullName: c.fullName, phone: c.phone, source: "WHATSAPP", kind: "BUYER" });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.workStatus).toBe("ACTIVE");
    expect(after.assignedAgentId).not.toBe(firedId);
    expect(after.assignedAgentId).not.toBeNull();
    expect(after.acceptedAt).toBeNull();
    expect(after.assignedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(after.returnAcceptDueAt).toBeNull();
  });

  it("ночью — без агента, ждёт утренней волны", async () => {
    const c = await inactiveClientOfFired();
    await createLeadFromChannel({ fullName: c.fullName, phone: c.phone, source: "WHATSAPP", kind: "BUYER", deferAssignment: true });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.workStatus).toBe("ACTIVE");
    expect(after.assignedAgentId).toBeNull();
    expect(after.acceptedAt).toBeNull();
  });
});
