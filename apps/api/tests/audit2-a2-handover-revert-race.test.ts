import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 1),
  sendPushToAgents: vi.fn(async () => 1),
}));

const { prisma } = await import("../src/db.js");
const { revertAgentHandover } = await import("../src/lib/agentHandoverRevert.js");

/**
 * CRM-04 (аудит 04.10.2026): откат передачи дел писал объект и задачу без условия
 * на нового владельца. Между чтением и записью другой руководитель назначал В, а
 * откат затирал его решение полями прежнего агента. Гонка воспроизводится
 * подставной задержкой: после чтения строки тест сам передаёт её третьему агенту.
 */
const runId = Date.now();
let aId = "";
let bId = "";
let cId = "";
let districtId = "";
let clientId = "";
const propertyIds: string[] = [];
const batchIds: string[] = [];

beforeAll(async () => {
  const mk = async (name: string, tail: string) =>
    (await prisma.agent.create({ data: { fullName: `${name} ${runId}`, phone: `+9929${tail}${runId}`, role: "AGENT", passwordHash: "x" } })).id;
  aId = await mk("Прежний агент возврата", "71");
  bId = await mk("Получатель передачи", "72");
  cId = await mk("Третий, назначенный в гонке", "73");
  districtId = (await prisma.district.create({ data: { name: `Район гонки возврата ${runId}` } })).id;
  clientId = (
    await prisma.client.create({ data: { fullName: `Клиент гонки возврата ${runId}`, phone: `+99283${runId}`, source: "PHONE_CALL", assignedAgentId: cId } })
  ).id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agentHandoverBatch.deleteMany({ where: { id: { in: batchIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [aId, bId, cId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

async function makeBatch(items: Record<string, unknown>) {
  const b = await prisma.agentHandoverBatch.create({ data: { fromAgentId: aId, toAgentId: bId, items: items as never } });
  batchIds.push(b.id);
  return b.id;
}

describe("откат передачи дел: запись только с условием на нового владельца (CRM-04)", () => {
  it("объект, переназначенный третьему между чтением и записью, откат пропускает", async () => {
    const property = await prisma.property.create({
      data: {
        title: `Объект гонки возврата ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 4",
        condition: "GOOD",
        intakeAgentId: bId,
        createdById: aId,
      },
    });
    propertyIds.push(property.id);
    const batchId = await makeBatch({
      clients: [],
      tasks: [],
      properties: [
        { propertyId: property.id, toAgentId: bId, intakeAgentId: aId, assignedAgentId: null, handoverPendingSince: null, handoverFromAgentId: null, handoverReason: null },
      ],
    });

    const realFind = prisma.property.findUnique.bind(prisma.property);
    vi.spyOn(prisma.property, "findUnique").mockImplementation(((args: never) =>
      realFind(args).then(async (row: unknown) => {
        // Другой руководитель успел назначить объект третьему уже ПОСЛЕ нашего чтения.
        await prisma.property.update({ where: { id: property.id }, data: { intakeAgentId: cId } });
        return row;
      })) as never);

    const outcome = await revertAgentHandover(batchId, null);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.properties).toBe(0);
    expect(outcome.result.skippedProperties).toBe(1);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.intakeAgentId).toBe(cId);
  });

  it("задача, переданная третьему между чтением и записью, остаётся у третьего", async () => {
    const task = await prisma.interaction.create({
      data: { clientId, agentId: bId, type: "CALL", notes: "Перезвонить", nextAction: "Перезвонить", nextActionDate: new Date(Date.now() + 86_400_000) },
    });
    const batchId = await makeBatch({
      clients: [],
      tasks: [{ interactionId: task.id, field: "agentId", toAgentId: bId }],
      properties: [],
    });

    const realFind = prisma.interaction.findUnique.bind(prisma.interaction);
    vi.spyOn(prisma.interaction, "findUnique").mockImplementation(((args: never) =>
      realFind(args).then(async (row: unknown) => {
        await prisma.interaction.update({ where: { id: task.id }, data: { agentId: cId } });
        return row;
      })) as never);

    const outcome = await revertAgentHandover(batchId, null);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.tasks).toBe(0);
    const after = await prisma.interaction.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.agentId).toBe(cId);
  });
});
