import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { waitFor } from "./helpers/waitFor.js";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { handoverAgentWork } = await import("../src/lib/agentHandover.js");

/** Передача дел уходящего сотрудника (примечание владельца от 30.07). */

const runId = Date.now();
let leavingId: string;
let receiverId: string;
let managerId: string;
let districtId: string;
let propertyId: string;
const clientIds: string[] = [];

async function makeClient(name: string, data: Record<string, unknown> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+9927${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: leavingId,
      acceptedAt: new Date(),
      ...data,
    },
  });
  clientIds.push(c.id);
  return c.id;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-передача-${runId}` } })).id;
  leavingId = (
    await prisma.agent.create({
      data: { fullName: "Агент уходит", phone: `+992927${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  receiverId = (
    await prisma.agent.create({
      data: { fullName: "Агент принимает", phone: `+992926${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  managerId = (
    await prisma.agent.create({
      data: { fullName: "Руководитель передачи", phone: `+992925${runId}`, role: "MANAGER", passwordHash: "x" },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект передачи ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: { in: [leavingId, receiverId, managerId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Передача дел уходящего сотрудника", () => {
  it("активные клиенты и их незакрытые задачи уходят получателю", async () => {
    const activeId = await makeClient("Активный", { status: "CONTACTED" });
    await prisma.interaction.create({
      data: {
        clientId: activeId,
        agentId: leavingId,
        type: "CALL",
        notes: "Договорились перезвонить",
        nextAction: "Перезвонить",
        nextActionDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    // Выполненная задача переезжать не должна — это уже история.
    await prisma.interaction.create({
      data: {
        clientId: activeId,
        agentId: leavingId,
        type: "CALL",
        notes: "Старая закрытая задача",
        nextAction: "Сделано",
        nextActionDate: new Date(Date.now() - 48 * 60 * 60 * 1000),
        completedAt: new Date(),
      },
    });

    const result = await handoverAgentWork(leavingId, receiverId, receiverId);
    expect(result.clients).toBe(1);
    expect(result.tasks).toBe(1);

    const client = await prisma.client.findUnique({ where: { id: activeId } });
    expect(client?.assignedAgentId).toBe(receiverId);
    // Принят сразу (B7, решение владельца 02.10.2026): портфель передаёт руководитель,
    // карусель и срок первого звонка его не трогают (assignReason «передача дел»).
    expect(client?.acceptedAt).not.toBeNull();
    expect(client?.assignReason).toBe("handover");

    const openTask = await prisma.interaction.findFirst({
      where: { clientId: activeId, nextAction: "Перезвонить" },
    });
    expect(openTask?.agentId).toBe(receiverId);
    const doneTask = await prisma.interaction.findFirst({
      where: { clientId: activeId, nextAction: "Сделано" },
    });
    expect(doneTask?.agentId).toBe(leavingId);
  });

  it("задачу, заведённую ботом на уходящего (subjectAgentId), тоже получает новый агент (23.09.2026)", async () => {
    const clientId = await makeClient("Показ от бота", { status: "CONTACTED" });
    const botTask = await prisma.interaction.create({
      data: {
        clientId,
        agentId: null,
        actorKind: "BOT",
        subjectAgentId: leavingId,
        type: "MEETING",
        notes: "Бот назначил показ",
        nextAction: "Показ от бота",
        nextActionDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const result = await handoverAgentWork(leavingId, receiverId, receiverId);
    expect(result.tasks).toBe(1);
    const task = await prisma.interaction.findUniqueOrThrow({ where: { id: botTask.id } });
    expect(task.subjectAgentId).toBe(receiverId);
  });

  it("получатель узнаёт о переданных клиентах push'ем", () => {
    const calls = sendPushToAgent.mock.calls as unknown as [string, Record<string, string>][];
    expect(calls.some(([to, p]) => to === receiverId && p.title.includes("передано клиентов"))).toBe(true);
  });

  it("передача записана в хронологию клиента", async () => {
    const note = await prisma.interaction.findFirst({
      where: { clientId: clientIds[0], type: "SYSTEM" },
      orderBy: { createdAt: "desc" },
    });
    expect(note?.notes).toContain("передан из дел уходящего сотрудника");
  });

  it("закрытых сделкой и архивных не трогает", async () => {
    const closedId = await makeClient("Закрытый", { status: "DEAL_CLOSED" });
    const archivedId = await makeClient("Архивный", { status: "ARCHIVED" });
    const result = await handoverAgentWork(leavingId, receiverId, receiverId);
    expect(result.clients).toBe(0);
    for (const id of [closedId, archivedId]) {
      const c = await prisma.client.findUnique({ where: { id } });
      expect(c?.assignedAgentId).toBe(leavingId);
    }
  });

  it("открытые сделки не переносит, а возвращает числом — это денежное решение", async () => {
    const withDealId = await makeClient("Со сделкой", { status: "HOT" });
    await prisma.deal.create({
      data: { clientId: withDealId, propertyId, agentId: leavingId, stage: "NEGOTIATION" },
    });
    const result = await handoverAgentWork(leavingId, receiverId, receiverId);
    expect(result.openDeals).toBe(1);
    const deal = await prisma.deal.findFirst({ where: { clientId: withDealId } });
    expect(deal?.agentId).toBe(leavingId);
  });

  it("объекты, где уходящий — хозяин (принял у собственника), переходят получателю целиком, кроме проданных и снятых", async () => {
    // Как на проде 24.09.2026: создатель = принявший, «ответственный риелтор» пуст.
    await prisma.property.update({
      where: { id: propertyId },
      data: { intakeAgentId: leavingId, createdById: leavingId, assignedAgentId: null },
    });
    const soldId = (
      await prisma.property.create({
        data: {
          title: `Продан ${runId}`,
          type: "APARTMENT",
          areaSqm: 40,
          price: 30000,
          currency: "TJS",
          districtId,
          address: "Тестовая, 2",
          condition: "GOOD",
          status: "SOLD",
          intakeAgentId: leavingId,
        },
      })
    ).id;

    const result = await handoverAgentWork(leavingId, receiverId, receiverId);
    expect(result.properties).toBe(1);

    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    // Оба поля хозяина — у получателя (владелец 24.09.2026: переданный объект —
    // целиком объект нового агента), создатель остаётся историей.
    expect(property.intakeAgentId).toBe(receiverId);
    expect(property.assignedAgentId).toBe(receiverId);
    expect(property.createdById).toBe(leavingId);
    // Объект ждёт принятия новым хозяином — без таймера, но с причиной и «от кого».
    expect(property.handoverPendingSince).not.toBeNull();
    expect(property.handoverFromAgentId).toBe(leavingId);
    expect(property.handoverReason).toContain("Агент уходит");

    const sold = await prisma.property.findUniqueOrThrow({ where: { id: soldId } });
    expect(sold.intakeAgentId).toBe(leavingId);

    await prisma.property.deleteMany({ where: { id: soldId } });
  });

  it("объект, принятый ДРУГИМ агентом, но с уходящим в роли риелтора, уходящему не принадлежит и не переезжает", async () => {
    await prisma.property.update({
      where: { id: propertyId },
      data: { intakeAgentId: managerId, assignedAgentId: leavingId, handoverPendingSince: null },
    });
    const result = await handoverAgentWork(leavingId, receiverId, receiverId);
    expect(result.properties).toBe(0);
    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.intakeAgentId).toBe(managerId);
  });

  it("повторная передача дел объекты не трогает — они уже у нового хозяина", async () => {
    await prisma.property.update({
      where: { id: propertyId },
      data: { intakeAgentId: leavingId, assignedAgentId: null, handoverPendingSince: null },
    });
    await handoverAgentWork(leavingId, receiverId, receiverId);
    const again = await handoverAgentWork(leavingId, receiverId, receiverId);
    expect(again.properties).toBe(0);
  });

  /**
   * П-5/П-10 (17.09.2026, `docs/audit/lead-ownership-17-09.md` §2, §4): раздача
   * дел уходящего сотрудника — решение конкретного руководителя, а не
   * автоматика. До этой правки handoverAgentWork звало changeClientAgent с
   * actorId:null безусловно.
   */
  it("actorId в AuditLog — руководитель, запустивший передачу, не null", async () => {
    const clientId = await makeClient("Клиент для актора передачи");
    await handoverAgentWork(leavingId, receiverId, managerId);

    const auditRow = await waitFor(() =>
      prisma.auditLog.findFirst({
        where: { entityType: "Client", entityId: clientId, action: "CLIENT_AGENT_CHANGE" },
        orderBy: { createdAt: "desc" },
      })
    );
    expect(auditRow?.agentId).toBe(managerId);
  });
});
