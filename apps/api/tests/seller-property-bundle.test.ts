import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 1),
  sendPushToAgents: vi.fn(async () => 1),
}));

const { prisma } = await import("../src/db.js");
const { handoverAgentWork } = await import("../src/lib/agentHandover.js");
const { changeClientAgent } = await import("../src/lib/changeClientAgent.js");
const { transferPropertyWithSeller } = await import("../src/lib/propertyTransferWithSeller.js");

/**
 * СВЯЗКА «ПРОДАВЕЦ + ОБЪЕКТ» (владелец 24.09.2026, вечер).
 *
 * Первая раздача дел уволенной сотрудницы отдала продавцов трём агентам, а их
 * дома остались у неё: новый агент звонил собственнице «вслепую», та отсылала
 * его к прежнему риелтору. Правило: продавец и его объект переезжают вместе в
 * ЛЮБОМ механизме — через единственную точку смены агента клиента
 * (changeClientAgent) и через передачу объекта (transferPropertyToAgent).
 */

const runId = Date.now();
let leavingId: string;
let strongId: string;
let weakId: string;
let managerId: string;
let districtId: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];

async function makeAgent(name: string, phoneTail: string, kpi: number) {
  return (
    await prisma.agent.create({
      data: { fullName: name, phone: `+9929${phoneTail}${runId}`, role: "AGENT", passwordHash: "x", kpi },
    })
  ).id;
}

async function makeSeller(name: string, agentId: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+99280${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      kind: "SELLER",
      status: "CONTACTED",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c.id;
}

async function makeProperty(title: string, ownerId: string, sellerClientId: string | null) {
  const p = await prisma.property.create({
    data: {
      title: `${title} ${runId}`,
      type: "HOUSE",
      areaSqm: 120,
      price: 250000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 7",
      condition: "GOOD",
      intakeAgentId: ownerId,
      createdById: ownerId,
      sellerClientId,
    },
  });
  propertyIds.push(p.id);
  return p.id;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-связка-${runId}` } })).id;
  leavingId = await makeAgent("Уходит со связкой", "51", 50);
  strongId = await makeAgent("Сильный связка", "52", 95);
  weakId = await makeAgent("Слабый связка", "53", 10);
  managerId = (
    await prisma.agent.create({
      data: { fullName: "Руководитель связки", phone: `+992954${runId}`, role: "MANAGER", passwordHash: "x" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [leavingId, strongId, weakId, managerId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Связка «продавец + объект»", () => {
  it("раздача дел: объект продавца уходит ТОМУ ЖЕ агенту, что и продавец, а не по своему кольцу", async () => {
    const sellerId = await makeSeller("Продавец со связкой", leavingId);
    const propertyId = await makeProperty("Дом продавца", leavingId, sellerId);
    // Ничей объект (без продавца) — уйдёт по кольцу объектов, слабому первому.
    const loneId = await makeProperty("Объект без продавца", leavingId, null);

    const others = await prisma.agent.findMany({
      where: { role: "AGENT", isActive: true, id: { notIn: [leavingId, strongId, weakId] } },
      select: { id: true },
    });
    // Исключить посторонних агентов базы из колец: замораживаем их на время теста.
    await prisma.agent.updateMany({ where: { id: { in: others.map((a) => a.id) } }, data: { frozenAt: new Date() } });
    try {
      const result = await handoverAgentWork(leavingId, undefined, managerId);
      expect(result.clients).toBe(1);
      expect(result.properties).toBe(2);

      const seller = await prisma.client.findUniqueOrThrow({ where: { id: sellerId } });
      const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
      const lone = await prisma.property.findUniqueOrThrow({ where: { id: loneId } });
      // Продавец — сильному (кольцо клиентов сверху), его дом — за ним, а не слабому.
      expect(seller.assignedAgentId).toBe(strongId);
      expect(property.intakeAgentId).toBe(strongId);
      expect(property.assignedAgentId).toBe(strongId);
      expect(property.handoverPendingSince).not.toBeNull();
      expect(property.handoverReason).toContain("Продавец передан");
      // Ничей объект — слабому (кольцо объектов снизу).
      expect(lone.intakeAgentId).toBe(weakId);
      // В отчёте объект посчитан у получателя продавца.
      expect(result.byAgent.find((a) => a.agentId === strongId)?.properties).toBe(1);
      expect(result.byAgent.find((a) => a.agentId === weakId)?.properties).toBe(1);
    } finally {
      await prisma.agent.updateMany({ where: { id: { in: others.map((a) => a.id) } }, data: { frozenAt: null } });
    }
  });

  it("ручная передача продавца (changeClientAgent) тянет его объект", async () => {
    const sellerId = await makeSeller("Продавец вручную", leavingId);
    const propertyId = await makeProperty("Дом вручную", leavingId, sellerId);

    const changed = await changeClientAgent({
      clientId: sellerId,
      toAgentId: weakId,
      reason: "Руководитель передал продавца",
      actorId: managerId,
      source: "manual",
      data: { assignedAt: new Date(), acceptedAt: null },
    });
    expect(changed.ok).toBe(true);
    expect(changed.properties).toBe(1);
    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.intakeAgentId).toBe(weakId);
    expect(property.handoverFromAgentId).toBe(leavingId);
  });

  it("объект ТРЕТЬЕГО агента (принял не тот, кто вёл продавца) за продавцом не едет", async () => {
    const sellerId = await makeSeller("Продавец с чужим объектом", leavingId);
    const propertyId = await makeProperty("Дом чужой приёмки", strongId, sellerId);

    const changed = await changeClientAgent({
      clientId: sellerId,
      toAgentId: weakId,
      reason: "Передача продавца",
      actorId: managerId,
      source: "manual",
    });
    expect(changed.ok).toBe(true);
    expect(changed.properties).toBe(0);
    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.intakeAgentId).toBe(strongId);
  });

  it("снятие продавца с агента (в очередь) объект не трогает — он уедет со следующим агентом", async () => {
    const sellerId = await makeSeller("Продавец в очередь", leavingId);
    const propertyId = await makeProperty("Дом в очередь", leavingId, sellerId);

    await changeClientAgent({ clientId: sellerId, toAgentId: null, reason: "В очередь", actorId: managerId, source: "manual" });
    let property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.intakeAgentId).toBe(leavingId);

    const changed = await changeClientAgent({
      clientId: sellerId,
      toAgentId: strongId,
      reason: "Взял из очереди",
      actorId: managerId,
      source: "manual",
    });
    expect(changed.properties).toBe(1);
    property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.intakeAgentId).toBe(strongId);
  });

  it("передача объекта тянет за собой его продавца как новый лид; повторной передачи объекта нет", async () => {
    const sellerId = await makeSeller("Продавец за объектом", leavingId);
    const propertyId = await makeProperty("Дом за которым продавец", leavingId, sellerId);

    const result = await transferPropertyWithSeller({
      propertyId,
      toAgentId: weakId,
      reason: "Собственник говорит по-таджикски",
      actorId: managerId,
      source: "manual",
      notify: false,
    });
    expect(result.changed).toBe(true);
    expect(result.sellerMoved).toBe(true);

    const seller = await prisma.client.findUniqueOrThrow({ where: { id: sellerId } });
    expect(seller.assignedAgentId).toBe(weakId);
    expect(seller.acceptedAt).toBeNull();
    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.intakeAgentId).toBe(weakId);
    // Ровно одна запись о передаче объекта — обратный вызов из changeClientAgent не сделал вторую.
    const handovers = await prisma.auditLog.count({ where: { entityId: propertyId, action: "PROPERTY_HANDOVER" } });
    expect(handovers).toBe(1);
    const note = await prisma.interaction.findFirst({
      where: { clientId: sellerId, type: "SYSTEM" },
      orderBy: { createdAt: "desc" },
    });
    expect(note?.notes).toContain("продавец переходит вместе с ним");
  });

  it("продавец у другого агента, чем хозяин объекта, — за объектом не едет", async () => {
    const sellerId = await makeSeller("Продавец у другого", strongId);
    const propertyId = await makeProperty("Дом с чужим продавцом", leavingId, sellerId);

    const result = await transferPropertyWithSeller({
      propertyId,
      toAgentId: weakId,
      reason: "Передача",
      actorId: managerId,
      source: "manual",
      notify: false,
    });
    expect(result.sellerMoved).toBe(false);
    const seller = await prisma.client.findUniqueOrThrow({ where: { id: sellerId } });
    expect(seller.assignedAgentId).toBe(strongId);
  });
});
