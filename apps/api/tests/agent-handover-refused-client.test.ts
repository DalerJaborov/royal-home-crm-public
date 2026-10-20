import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomInt } from "node:crypto";

/**
 * B15 глубокой проверки 02.10.2026: «Передача дел» не смотрела на ответ
 * changeClientAgent. Если запись клиента не состоялась (карточку в ту же секунду
 * отправили в Корзину, закон запретил передачу), его незакрытые задачи всё равно
 * уезжали получателю в той же транзакции: задачи у одного агента, клиент у
 * другого, а в итоге «передано» считался и этот клиент.
 *
 * Отказ записи здесь подставляется обёрткой над настоящим changeClientAgent —
 * поймать живую гонку с Корзиной в тесте нельзя, а механизм тот же.
 */

const refuseFor = new Set<string>();
vi.mock("../src/lib/changeClientAgent.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/changeClientAgent.js")>();
  return {
    ...orig,
    changeClientAgent: async (input: Parameters<typeof orig.changeClientAgent>[0]) =>
      refuseFor.has(input.clientId) ? { ok: false, reason: "deleted" as const } : orig.changeClientAgent(input),
  };
});
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 1),
  sendPushToAgents: vi.fn(async () => 1),
}));

const { prisma } = await import("../src/db.js");
const { handoverAgentWork } = await import("../src/lib/agentHandover.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const phone = () => `+99293${randomInt(1_000_000, 9_999_999)}`;
let leavingId = "";
let receiverId = "";
let managerId = "";
const clientIds: string[] = [];

beforeAll(async () => {
  const mk = (fullName: string, role: "AGENT" | "MANAGER") =>
    prisma.agent.create({ data: { fullName, phone: phone(), role, passwordHash: "x" } });
  leavingId = (await mk("Уходит B15", "AGENT")).id;
  receiverId = (await mk("Принимает B15", "AGENT")).id;
  managerId = (await mk("Руководитель B15", "MANAGER")).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([leavingId, receiverId, managerId]);
  await prisma.$disconnect();
});

describe("передача дел: клиент не переехал — задачи по нему тоже остаются", () => {
  it("отказ записи клиента откатывает перенос его задач и не считается переданным", async () => {
    const make = async (name: string) => {
      const c = await prisma.client.create({
        data: { fullName: name, phone: phone(), source: "PHONE_CALL", status: "HOT", assignedAgentId: leavingId, acceptedAt: new Date() },
      });
      clientIds.push(c.id);
      const task = await prisma.interaction.create({
        data: {
          clientId: c.id,
          agentId: leavingId,
          type: "CALL",
          notes: "перезвонить",
          nextAction: "Перезвонить",
          nextActionDate: new Date(Date.now() + 3600_000),
        },
      });
      return { clientId: c.id, taskId: task.id };
    };
    const refused = await make("Отказ B15");
    const moved = await make("Переезжает B15");
    refuseFor.add(refused.clientId);

    const result = await handoverAgentWork(leavingId, receiverId, managerId);

    const refusedTask = await prisma.interaction.findUniqueOrThrow({ where: { id: refused.taskId } });
    expect(refusedTask.agentId).toBe(leavingId);
    const movedTask = await prisma.interaction.findUniqueOrThrow({ where: { id: moved.taskId } });
    expect(movedTask.agentId).toBe(receiverId);
    expect(result.clients).toBe(1);
  });
});
