import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * №168 (ночная проверка 24.09): повтор задания реактивации после таймаута
 * дублировал сообщение клиенту и задачу «Перезвонить» у агента.
 *
 * Медленный Meta (до ~67 с своих повторов) дольше срока попытки — раннер
 * перестаёт ждать, задание уходит в повтор, а первая попытка всё равно
 * досылает. Повтор отправлял ещё раз: замка «уже отправлено на этой неделе» не
 * было. Здесь отправка подменена (сеть не нужна), база настоящая: обработчик
 * зовётся дважды подряд, как его позвала бы очередь после таймаута.
 */

const { deliverToConversation } = vi.hoisted(() => ({
  deliverToConversation: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("../src/lib/conversationDelivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/conversationDelivery.js")>()),
  findClientDeliveryTarget: vi.fn(async () => ({ kind: "telegram" as const, id: "tg-reactivation-test", subscriberId: "1" })),
  deliverToConversation,
}));

const { prisma } = await import("../src/db.js");
const { clientReactivationJob } = await import("../src/jobs/clientReactivation.js");
const { reactivationWeekKey } = await import("../src/lib/reactivationCampaign.js");

const runId = Date.now();
let agentId: string;
const clientIds: string[] = [];

async function makeColdClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Остывший клиент ${runId}-${clientIds.length}`,
      phone: `+992931${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      status: "COLD",
      assignedAgentId: agentId,
      assignedAt: new Date(),
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

async function reactivationRows(clientId: string) {
  return prisma.interaction.findMany({
    where: { clientId, type: "SYSTEM", notes: { startsWith: "[reactivation]" } },
  });
}

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: {
        fullName: `Агент реактивации ${runId}`,
        phone: `+992932${runId}`,
        role: "AGENT",
        passwordHash: await bcrypt.hash("x", 4),
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

beforeEach(() => {
  deliverToConversation.mockClear();
});

describe("задание реактивации одному клиенту", () => {
  it("повтор той же недели (после таймаута первой попытки) не шлёт второе сообщение и не заводит вторую задачу", async () => {
    const client = await makeColdClient();
    const payload = { clientId: client.id, weekKey: reactivationWeekKey(new Date()) };

    await clientReactivationJob.run(payload);
    await clientReactivationJob.run(payload);

    expect(deliverToConversation).toHaveBeenCalledTimes(1);
    const rows = await reactivationRows(client.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].nextAction).toContain("Перезвонить");
  });

  it("реактивация прошлой недели новую не блокирует", async () => {
    const client = await makeColdClient();
    const lastWeek = new Date(Date.now() - 7 * 24 * 3600_000);
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        actorKind: "SYSTEM",
        type: "SYSTEM",
        notes: "[reactivation] Реактивация: сообщение отправлено",
        createdAt: lastWeek,
      },
    });

    await clientReactivationJob.run({ clientId: client.id, weekKey: reactivationWeekKey(new Date()) });

    expect(deliverToConversation).toHaveBeenCalledTimes(1);
    expect(await reactivationRows(client.id)).toHaveLength(2);
  });

  it("ждёт отправку дольше медленного Meta (~67 с своих повторов)", () => {
    expect(clientReactivationJob.timeoutMs ?? 60_000).toBeGreaterThan(70_000);
  });
});
