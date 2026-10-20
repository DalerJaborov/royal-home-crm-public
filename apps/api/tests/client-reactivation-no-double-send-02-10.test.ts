import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Ф10 (аудит фона 02.10.2026): реактивационное сообщение уходит клиенту ДО
 * записи в хронологию. Если запись упала (моргнула база), задание бросало
 * исключение и шло в повтор — а замок «сообщение этой недели уже ушло» ищет
 * именно эту строку, её нет, и клиент получал то же сообщение второй раз.
 *
 * Теперь сбой записи после состоявшейся доставки — не повод повторять задание.
 */

const delivered: string[] = [];
vi.mock("../src/lib/conversationDelivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/conversationDelivery.js")>()),
  findClientDeliveryTarget: vi.fn(async () => ({ kind: "agent-chat", id: "тест" })),
  deliverToConversation: vi.fn(async (_t: unknown, text: string) => {
    delivered.push(text);
    return { ok: true };
  }),
}));
vi.mock("../src/lib/timeline.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/timeline.js")>()),
  logTimeline: vi.fn(async () => {
    throw new Error("нарочный сбой базы при записи хронологии");
  }),
}));

const { prisma } = await import("../src/db.js");
const { clientReactivationJob } = await import("../src/jobs/clientReactivation.js");

const runId = Date.now();
let clientId: string;
let agentId: string;

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент реактивации ${runId}`, phone: `+992951${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент реактивации ${runId}`,
        phone: `+992952${runId}`,
        source: "PHONE_CALL",
        status: "COLD",
        assignedAgentId: agentId,
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("реактивация: сообщение ушло, запись упала — повтора нет", () => {
  it("задание завершается без исключения, клиенту ушло одно сообщение", async () => {
    await expect(clientReactivationJob.run({ clientId, weekKey: "2026-09-28" })).resolves.toBeUndefined();
    expect(delivered).toHaveLength(1);
  });
});
