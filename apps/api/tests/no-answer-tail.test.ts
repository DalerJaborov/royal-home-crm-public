import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents, sendPushToAgent: sendPushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { notifyNoAnswerEscalation, processNoAnswerTailAnchors } = await import("../src/lib/noAnswerStreak.js");

/**
 * «Хвост» дозвона (01.09.2026): после эскалации руководителю (серия недозвонов
 * исчерпана) — две ОТЛОЖЕННЫЕ попытки самому агенту, через Settings.noAnswerTailDay1/
 * Day2 дней. Маячок — Interaction без nextAction (не задача, TASK_WHERE его не видит);
 * настоящую задачу заводит processNoAnswerTailAnchors, КОГДА срок настал, — с
 * проверкой актуального статуса клиента на этот момент.
 */

const runId = Date.now();
let agentId: string;
let clientId: string;
const extraClientIds: string[] = [];

async function makeClient(overrides: Record<string, unknown> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент хвоста ${runId}-${extraClientIds.length}`,
      phone: `+992936${runId}${extraClientIds.length}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      ...overrides,
    },
  });
  extraClientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент хвоста", phone: `+992935${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  clientId = (await makeClient()).id;
});

beforeEach(() => sendPushToAgents.mockClear());

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: extraClientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: extraClientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("Хвост дозвона — маячки при эскалации", () => {
  it("noAnswerTailEnabled=false (по умолчанию) — маячки не заводятся", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { noAnswerTailEnabled: false } });
    const client = await makeClient();
    await notifyNoAnswerEscalation(client, agentId, 3);
    await new Promise((r) => setTimeout(r, 100));
    const anchors = await prisma.interaction.findMany({
      where: { clientId: client.id, notes: { startsWith: "noAnswerTail:" } },
    });
    expect(anchors.length).toBe(0);
  });

  it("noAnswerTailEnabled=true — заводит ровно два маячка на день1/день2, без nextAction", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { noAnswerTailEnabled: true, noAnswerTailDay1: 2, noAnswerTailDay2: 5 },
    });
    const client = await makeClient();
    await notifyNoAnswerEscalation(client, agentId, 3);
    await new Promise((r) => setTimeout(r, 100));
    const anchors = await prisma.interaction.findMany({
      where: { clientId: client.id, notes: { startsWith: "noAnswerTail:" } },
      orderBy: { notes: "asc" },
    });
    expect(anchors.length).toBe(2);
    for (const a of anchors) {
      expect(a.nextAction).toBeNull();
      // П-10 (задание Б2): маячок пишет actor system — agentId null, держатель
      // виден через subjectAgentId.
      expect(a.actorKind).toBe("SYSTEM");
      expect(a.agentId).toBeNull();
      expect(a.subjectAgentId).toBe(agentId);
    }
    const day1Ms = anchors[0].nextActionDate!.getTime() - Date.now();
    const day2Ms = anchors[1].nextActionDate!.getTime() - Date.now();
    expect(day1Ms).toBeGreaterThan(1.9 * 24 * 3600_000);
    expect(day1Ms).toBeLessThan(2.1 * 24 * 3600_000);
    expect(day2Ms).toBeGreaterThan(4.9 * 24 * 3600_000);
    expect(day2Ms).toBeLessThan(5.1 * 24 * 3600_000);
  });
});

describe("Хвост дозвона — обработка маячков в срок", () => {
  it("срок ещё не настал — задача не заводится", async () => {
    const client = await makeClient();
    // Маячок пишется actor system (П-10, задание Б2) — agentId null,
    // subjectAgentId — держатель.
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        actorKind: "SYSTEM",
        subjectAgentId: agentId,
        type: "SYSTEM",
        notes: "noAnswerTail:1",
        nextActionDate: new Date(Date.now() + 24 * 3600_000),
      },
    });
    await processNoAnswerTailAnchors();
    // Счётчик у обработчика общий на всю базу: рядом могут лежать чужие маячки
    // (сид стенда, обрывок прошлого прогона), и их обработка — не ошибка.
    // Проверяем своё: по НАШЕЙ карточке задачи не появилось.
    const task = await prisma.interaction.findFirst({
      where: { clientId: client.id, subjectAgentId: agentId, nextAction: { not: null } },
    });
    expect(task).toBeNull();
  });

  it("срок настал, клиент активен — заводит агенту обычную задачу «перезвонить»", async () => {
    const client = await makeClient();
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        actorKind: "SYSTEM",
        subjectAgentId: agentId,
        type: "SYSTEM",
        notes: "noAnswerTail:1",
        nextActionDate: new Date(Date.now() - 60_000),
      },
    });
    const created = await processNoAnswerTailAnchors();
    expect(created).toBeGreaterThan(0);
    const task = await prisma.interaction.findFirst({
      where: { clientId: client.id, subjectAgentId: agentId, nextAction: { not: null } },
    });
    expect(task?.nextAction).toContain("дозвониться");

    // Маячок погашен — второй тик не заводит вторую задачу по тому же маячку.
    const secondRun = await processNoAnswerTailAnchors();
    const tasksAfter = await prisma.interaction.count({
      where: { clientId: client.id, subjectAgentId: agentId, nextAction: { not: null } },
    });
    expect(tasksAfter).toBe(1);
    void secondRun;
  });

  it("клиент уже LOST к сроку — задача не заводится, маячок всё равно гасится", async () => {
    const client = await makeClient({ status: "LOST" });
    const anchor = await prisma.interaction.create({
      data: {
        clientId: client.id,
        actorKind: "SYSTEM",
        subjectAgentId: agentId,
        type: "SYSTEM",
        notes: "noAnswerTail:2",
        nextActionDate: new Date(Date.now() - 60_000),
      },
    });
    await processNoAnswerTailAnchors();
    // Счётчик общий на всю базу — смотрим на свою карточку, не на него.
    const task = await prisma.interaction.findFirst({
      where: { clientId: client.id, subjectAgentId: agentId, nextAction: { not: null } },
    });
    expect(task).toBeNull();
    const refreshed = await prisma.interaction.findUnique({ where: { id: anchor.id } });
    expect(refreshed?.completedAt).not.toBeNull();
  });

  it("клиента передали другому агенту — старому агенту задачу не ставим", async () => {
    const otherAgent = await prisma.agent.create({
      data: { fullName: "Другой агент хвоста", phone: `+992934${runId}`, role: "AGENT", passwordHash: "x" },
    });
    const client = await makeClient({ assignedAgentId: otherAgent.id });
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        // Маячок остался на прежнем агенте (subjectAgentId), а карточку уже передали otherAgent.
        actorKind: "SYSTEM",
        subjectAgentId: agentId,
        type: "SYSTEM",
        notes: "noAnswerTail:1",
        nextActionDate: new Date(Date.now() - 60_000),
      },
    });
    await processNoAnswerTailAnchors();
    // Счётчик общий на всю базу — проверяем, что задачи нет у ПРЕЖНЕГО агента.
    const task = await prisma.interaction.findFirst({
      where: { clientId: client.id, subjectAgentId: agentId, nextAction: { not: null } },
    });
    expect(task).toBeNull();
    await prisma.agent.deleteMany({ where: { id: otherAgent.id } });
  });
});
