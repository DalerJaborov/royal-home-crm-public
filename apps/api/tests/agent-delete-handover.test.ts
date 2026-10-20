import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

/**
 * УДАЛЕНИЕ АГЕНТА НЕ ДОЛЖНО ОСТАВЛЯТЬ КЛИЕНТОВ НИЧЬИМИ.
 *
 * Требование владельца 10.08.2026: «при удалении агента чтобы его клиенты
 * распределились по агентам KPI». До этого маршрут удаления просто упирался в
 * запрет базы и отвечал «деактивируйте вместо удаления», а клиенты продолжали
 * числиться за человеком, которого в компании нет: лиды без ответа, задачи без
 * исполнителя, и в отчётах всё это выглядело работой.
 *
 * Здесь проверяется САМА РАЗДАЧА (lib/agentHandover.ts), которую маршрут вызывает
 * перед удалением. Ответ маршрута (200 с отчётом вместо пустого 204) проверяется в
 * access-control.test.ts — там уже есть окружение с токенами.
 *
 * Своего АЛГОРИТМА раздачи у увольнения нет и не должно быть: очередь по KPI одна
 * на всю систему. Разошлось 11.08.2026 только НАПРАВЛЕНИЕ: клиенты идут агентам с
 * высоким Royal Score (горячие первыми), объекты — с низким. Это одна и та же
 * очередь, развёрнутая по уровням, и проверяется она в agent-handover-split.test.ts
 * и handover-property-queue.test.ts. Здесь по-прежнему главное: после увольнения
 * ничьих клиентов не остаётся.
 */

const runId = Date.now();
let leavingId: string;
let receiverId: string;
const clientIds: string[] = [];

async function makeClient(name: string, data: Record<string, unknown> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+99295${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: leavingId,
      acceptedAt: new Date(),
      ...data,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  leavingId = (
    await prisma.agent.create({
      data: { fullName: "Уходит на удаление", phone: `+992951${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  receiverId = (
    await prisma.agent.create({
      data: { fullName: "Принимает дела", phone: `+992952${runId}`, role: "AGENT", passwordHash: "x", isActive: true },
    })
  ).id;
});

afterAll(async () => {
  await prisma.clientDeleteRequest.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [leavingId, receiverId] } } });
});

describe("Раздача клиентов уходящего агента", () => {
  it("активные клиенты уходят живым агентам, а не остаются на уволенном", async () => {
    const active = await makeClient("Активный клиент", { status: "HOT" });

    const result = await handoverAgentWork(leavingId, undefined, receiverId);

    expect(result.clients).toBeGreaterThanOrEqual(1);
    const after = await prisma.client.findUnique({
      where: { id: active.id },
      select: { assignedAgentId: true, acceptedAt: true },
    });
    expect(after!.assignedAgentId).not.toBe(leavingId);
    expect(after!.assignedAgentId).not.toBeNull();
    // Клиент приходит уже принятым (B7, решение владельца 02.10.2026): раздачу
    // запустил руководитель, карусель «не принял» и штраф его не трогают.
    expect(after!.acceptedAt).not.toBeNull();
  });

  it("закрытые сделкой карточки не трогаем — это уже история, а не работа", async () => {
    const closed = await makeClient("Закрытый клиент", { status: "DEAL_CLOSED" });

    await handoverAgentWork(leavingId, undefined, receiverId);

    const after = await prisma.client.findUnique({
      where: { id: closed.id },
      select: { assignedAgentId: true },
    });
    // Переписывать ответственного по завершённой сделке значит переписывать прошлое:
    // по этой карточке уже посчитана комиссия и закрыт результат.
    expect(after!.assignedAgentId).toBe(leavingId);
  });

  it("удалённые карточки из Корзины не воскресают у нового агента", async () => {
    const deleted = await makeClient("Удалённый клиент", { deletedAt: new Date() });

    await handoverAgentWork(leavingId, undefined, receiverId);

    const after = await prisma.client.findUnique({
      where: { id: deleted.id },
      select: { assignedAgentId: true },
    });
    expect(after!.assignedAgentId).toBe(leavingId);
  });

  it("повторная раздача ничего не ломает — раздавать уже нечего", async () => {
    // Маршрут удаления может быть вызван дважды (двойное нажатие, повтор запроса).
    const first = await handoverAgentWork(leavingId, undefined, receiverId);
    const second = await handoverAgentWork(leavingId, undefined, receiverId);
    expect(second.clients).toBe(0);
    expect(second.clients).toBeLessThanOrEqual(first.clients);
  });

  it("заявка на удаление клиента снимается, если карточку передали новому агенту", async () => {
    const client = await makeClient("С заявкой на удаление", { status: "HOT" });
    const deleteRequest = await prisma.clientDeleteRequest.create({
      data: { clientId: client.id, requestedById: leavingId, reason: "OTHER", comment: "Тест" },
    });

    await handoverAgentWork(leavingId, undefined, receiverId);

    const after = await prisma.clientDeleteRequest.findUniqueOrThrow({ where: { id: deleteRequest.id } });
    expect(after.status).toBe("REJECTED");
    expect(after.decidedById).toBeNull();
  });
});
