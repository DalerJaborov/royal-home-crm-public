import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { randomInt } from "node:crypto";
import { prisma } from "../src/db.js";
import { mergeClients } from "../src/lib/clientMerge.js";
import { createLeadFromChannel } from "../src/leads.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Номер объединённого дубля переезжает к основной карточке (23.09.2026,
 * проверка раздачи, пункт 17). Раньше номер дубля при слиянии считался
 * «занятым» самим дублем и не переезжал: следующее сообщение с этого номера
 * воскрешало карточку из Корзины вторым лидом.
 */

const phone = () => `+99293${randomInt(1_000_000, 9_999_999)}`;
let agentId = "";
let adminId = "";
const clientIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 4);
  agentId = (await prisma.agent.create({ data: { fullName: "Агент основной карточки", phone: phone(), role: "AGENT", passwordHash } })).id;
  adminId = (await prisma.agent.create({ data: { fullName: "Админ слияния номера", phone: phone(), role: "ADMIN", passwordHash } })).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([agentId, adminId]);
  await prisma.$disconnect();
});

describe("слияние дублей с разными номерами", () => {
  it("номер дубля становится запасным у основной, и новое обращение с него не воскрешает дубль", async () => {
    const primary = await prisma.client.create({
      data: { fullName: "Основная", phone: phone(), kind: "BUYER", source: "PHONE_CALL", assignedAgentId: agentId, acceptedAt: new Date() },
    });
    const dupPhone = phone();
    const duplicate = await prisma.client.create({
      data: { fullName: "Дубль", phone: dupPhone, kind: "BUYER", source: "WHATSAPP" },
    });
    clientIds.push(primary.id, duplicate.id);

    await mergeClients(primary.id, duplicate.id, adminId, "Объединено: тот же человек");

    const after = await prisma.client.findUniqueOrThrow({ where: { id: primary.id } });
    expect(after.extraPhones).toContain(dupPhone);

    const { clientId } = await createLeadFromChannel({
      fullName: "Снова пишет",
      phone: dupPhone,
      source: "WHATSAPP",
      kind: "BUYER",
    });
    if (!clientIds.includes(clientId)) clientIds.push(clientId);
    expect(clientId).toBe(primary.id);
    const dupAfter = await prisma.client.findUniqueOrThrow({ where: { id: duplicate.id } });
    expect(dupAfter.deletedAt).not.toBeNull();
  });
});
