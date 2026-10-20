import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 1),
  sendPushToAgents: vi.fn(async () => 1),
}));

const { prisma } = await import("../src/db.js");
const { handoverAgentWork } = await import("../src/lib/agentHandover.js");
const { revertAgentHandover } = await import("../src/lib/agentHandoverRevert.js");
const { changeClientAgent } = await import("../src/lib/changeClientAgent.js");

/**
 * «ВЕРНУТЬ ВСЁ КАК БЫЛО» (владелец 24.09.2026): раздача дел пишет снимок, возврат
 * по нему отдаёт клиентов (принятыми), задачи и объекты прежнему агенту, включает
 * учётку, а карточки, ушедшие дальше, не трогает.
 */

const runId = Date.now();
let leavingId: string;
let receiverId: string;
let thirdId: string;
let managerId: string;
let districtId: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-возврат-${runId}` } })).id;
  const mk = async (name: string, tail: string, role = "AGENT") =>
    (await prisma.agent.create({ data: { fullName: name, phone: `+9929${tail}${runId}`, role: role as "AGENT", passwordHash: "x", kpi: 50 } })).id;
  leavingId = await mk("Уходит и возвращается", "61");
  receiverId = await mk("Получатель возврата", "62");
  thirdId = await mk("Третий агент возврата", "63");
  managerId = await mk("Руководитель возврата", "64", "MANAGER");
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agentHandoverBatch.deleteMany({ where: { fromAgentId: leavingId } });
  await prisma.agent.deleteMany({ where: { id: { in: [leavingId, receiverId, thirdId, managerId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

async function makeClient(name: string, kind: "BUYER" | "SELLER" = "BUYER") {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+99281${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      kind,
      status: "CONTACTED",
      assignedAgentId: leavingId,
      acceptedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
      assignedAt: new Date(Date.now() - 4 * 24 * 3600 * 1000),
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeProperty(title: string, sellerClientId: string | null) {
  const p = await prisma.property.create({
    data: {
      title: `${title} ${runId}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: 50000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 9",
      condition: "GOOD",
      intakeAgentId: leavingId,
      createdById: leavingId,
      sellerClientId,
    },
  });
  propertyIds.push(p.id);
  return p.id;
}

describe("Вернуть всё как было", () => {
  it("раздача пишет снимок; возврат отдаёт клиентов принятыми, задачи и объекты — прежнему агенту, включает учётку", async () => {
    const buyer = await makeClient("Покупатель на возврат");
    const seller = await makeClient("Продавец на возврат", "SELLER");
    const sellerHome = await makeProperty("Дом продавца на возврат", seller.id);
    const lone = await makeProperty("Ничей объект на возврат", null);
    const task = await prisma.interaction.create({
      data: {
        clientId: buyer.id,
        agentId: leavingId,
        type: "CALL",
        notes: "Перезвонить",
        nextAction: "Перезвонить",
        nextActionDate: new Date(Date.now() + 24 * 3600 * 1000),
      },
    });

    const handover = await handoverAgentWork(leavingId, receiverId, managerId);
    expect(handover.clients).toBe(2);
    expect(handover.properties).toBe(2);
    expect(handover.batchId).toBeTruthy();
    // Как делает маршрут с галочкой «отключить учётную запись».
    await prisma.agent.update({ where: { id: leavingId }, data: { isActive: false } });
    await prisma.agentHandoverBatch.update({ where: { id: handover.batchId! }, data: { deactivated: true } });

    const batch = await prisma.agentHandoverBatch.findUniqueOrThrow({ where: { id: handover.batchId! } });
    const items = batch.items as { clients: unknown[]; tasks: unknown[]; properties: unknown[] };
    expect(items.clients).toHaveLength(2);
    expect(items.tasks).toHaveLength(1);
    expect(items.properties).toHaveLength(2);

    const outcome = await revertAgentHandover(handover.batchId!, managerId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result).toMatchObject({ clients: 2, tasks: 1, properties: 2, skippedClients: 0, skippedProperties: 0, reactivated: true });

    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: leavingId } });
    expect(agent.isActive).toBe(true);
    const b = await prisma.client.findUniqueOrThrow({ where: { id: buyer.id } });
    expect(b.assignedAgentId).toBe(leavingId);
    // Принят, как и до раздачи: таймер первого звонка по своим клиентам не нужен.
    expect(b.acceptedAt?.toISOString()).toBe(buyer.acceptedAt?.toISOString());
    const t = await prisma.interaction.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.agentId).toBe(leavingId);
    for (const id of [sellerHome, lone]) {
      const p = await prisma.property.findUniqueOrThrow({ where: { id } });
      expect(p.intakeAgentId).toBe(leavingId);
      expect(p.assignedAgentId).toBeNull();
      expect(p.handoverPendingSince).toBeNull();
      expect(p.handoverFromAgentId).toBeNull();
    }
    const reverted = await prisma.agentHandoverBatch.findUniqueOrThrow({ where: { id: handover.batchId! } });
    expect(reverted.revertedAt).not.toBeNull();

    // Второй раз — отказ, не двойной возврат.
    const again = await revertAgentHandover(handover.batchId!, managerId);
    expect(again).toEqual({ ok: false, reason: "already_reverted" });
    // Чтобы следующий сценарий раздавал только своих клиентов.
    await prisma.client.updateMany({ where: { id: { in: [buyer.id, seller.id] } }, data: { status: "ARCHIVED" } });
  });

  it("карточку, которую с тех пор передали дальше, возврат не отбирает и считает пропущенной", async () => {
    const stays = await makeClient("Останется у третьего");
    const back = await makeClient("Вернётся");
    const handover = await handoverAgentWork(leavingId, receiverId, managerId);
    expect(handover.clients).toBe(2);
    await changeClientAgent({
      clientId: stays.id,
      toAgentId: thirdId,
      reason: "Передан дальше",
      actorId: managerId,
      source: "manual",
    });

    const outcome = await revertAgentHandover(handover.batchId!, managerId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.clients).toBe(1);
    expect(outcome.result.skippedClients).toBe(1);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: stays.id } })).assignedAgentId).toBe(thirdId);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: back.id } })).assignedAgentId).toBe(leavingId);
  });
});
