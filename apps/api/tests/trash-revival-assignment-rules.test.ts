import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { randomInt } from "node:crypto";

/**
 * B5 глубокой проверки 02.10.2026: клиент из Корзины, написавший снова, когда
 * прежнего агента предложить некому, раздавался голым pickAgentForLead():
 * ночью (мимо deferAssignment — непринятый лид с ночи, утром карусель/штраф),
 * без kind (продавец упирался в лимит покупателей) и мимо правил «свой объект».
 * Теперь — те же правила, что у новой заявки.
 */

const sendPushToAgent = vi.fn(async () => 1);
const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { createLeadFromChannel } = await import("../src/leads.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const phone = () => `+99293${randomInt(1_000_000, 9_999_999)}`;
let ownerAgentId = "";
let freeAgentId = "";
let districtId = "";
let propertyId = "";
const clientIds: string[] = [];

async function trashedClient() {
  const c = await prisma.client.create({
    data: {
      fullName: "Клиент из Корзины B5",
      phone: phone(),
      kind: "BUYER",
      source: "INSTAGRAM",
      deletedAt: new Date(),
      lastAgentId: null,
      assignedAgentId: null,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 4);
  ownerAgentId = (
    await prisma.agent.create({
      data: { fullName: "Агент объекта B5", phone: phone(), role: "AGENT", passwordHash, lastSeenAt: new Date() },
    })
  ).id;
  // Свободный агент — по очереди «честно» лид ушёл бы ему, а не загруженному
  // агенту объекта: так видно, что сработало правило объекта, а не очередь.
  freeAgentId = (
    await prisma.agent.create({
      data: { fullName: "Свободный агент B5", phone: phone(), role: "AGENT", passwordHash, lastSeenAt: new Date() },
    })
  ).id;
  for (let i = 0; i < 5; i++) {
    const busy = await prisma.client.create({
      data: {
        fullName: `Загрузка B5 ${i}`,
        phone: phone(),
        kind: "BUYER",
        source: "WALK_IN",
        status: "NEW",
        assignedAgentId: ownerAgentId,
        acceptedAt: new Date(),
      },
    });
    clientIds.push(busy.id);
  }
  districtId = (await prisma.district.create({ data: { name: `Район B5 ${randomInt(1_000_000)}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: "Объект B5",
        type: "APARTMENT",
        areaSqm: 50,
        price: 60000,
        currency: "TJS",
        districtId,
        address: "Тест B5",
        condition: "GOOD",
        status: "AVAILABLE",
        assignedAgentId: ownerAgentId,
        intakeAgentId: ownerAgentId,
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await deleteAgentsWithTraces([ownerAgentId, freeAgentId]);
  await prisma.$disconnect();
});

describe("возврат из Корзины в общую раздачу", () => {
  it("ночью агента не назначает — карточку разберёт утренняя волна, объект запомнен", async () => {
    const c = await trashedClient();
    await createLeadFromChannel({
      fullName: c.fullName,
      phone: c.phone,
      source: "INSTAGRAM",
      kind: "BUYER",
      propertyId,
      deferAssignment: true,
    });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.deletedAt).toBeNull();
    expect(after.assignedAgentId).toBeNull();
    expect(after.requestedPropertyId).toBe(propertyId);
  });

  it("LOST без прежнего держателя ночью ждёт обычной раздачи, не эскалации", async () => {
    const c = await trashedClient();
    await prisma.client.update({ where: { id: c.id }, data: { deletedAt: null, status: "LOST", lostAt: new Date() } });
    await createLeadFromChannel({ fullName: c.fullName, phone: c.phone, source: "INSTAGRAM", kind: "BUYER", deferAssignment: true });
    expect(await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: "NEW", assignedAgentId: null, escalatedAt: null, acceptedAt: null });
  });

  it("входящее обращение не обходит окончательный отказ через корзину", async () => {
    const c = await trashedClient();
    const completedAt = new Date();
    await prisma.client.update({ where: { id: c.id }, data: { lastAgentId: freeAgentId, assignmentRefusedAt: completedAt, assignmentCompletedAt: completedAt } });
    await createLeadFromChannel({ fullName: c.fullName, phone: c.phone, source: "INSTAGRAM", kind: "BUYER" });
    expect(await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ deletedAt: c.deletedAt, assignedAgentId: null, assignmentCompletedAt: completedAt });
  });

  it("днём клиент, спросивший про объект, уходит агенту этого объекта", async () => {
    const c = await trashedClient();
    await createLeadFromChannel({
      fullName: c.fullName,
      phone: c.phone,
      source: "INSTAGRAM",
      kind: "BUYER",
      propertyId,
    });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.deletedAt).toBeNull();
    expect(after.assignedAgentId).toBe(ownerAgentId);
  });
});
