import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const callAiText = vi.fn();
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText }));

const { prisma } = await import("../src/db.js");
const { analyzeCall } = await import("../src/ai/callAnalysis.js");

/**
 * ИИ БОЛЬШЕ НЕ ПРИОСТАНАВЛИВАЕТ КЛИЕНТА (владелец 16.11.2026: «Неактивных» нет).
 *
 * До 16.11.2026 разбор звонка по полю inactiveReason переводил клиента в
 * «Неактивные». Состояние удалено — и поле больше не запрашивается у модели
 * (не просим того, что сервер заведомо отбросит). Даже если модель всё равно
 * вернёт причину паузы, клиент остаётся в работе, а лишней записи нет.
 */

const runId = Date.now();
let agentId: string;
const clientIds: string[] = [];
const interactionIds: string[] = [];

const LONG_TRANSCRIPT = "Клиент говорит что пока откладывает покупку и просит связаться позже ".repeat(6);

async function makeClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент паузы ${runId}-${clientIds.length}`,
      phone: `+992963${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      workStatus: "ACTIVE",
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeCallInteraction(clientId: string) {
  const i = await prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", notes: "Звонок через CRM", transcript: LONG_TRANSCRIPT },
  });
  interactionIds.push(i.id);
  return i;
}

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент паузы ${runId}`, phone: `+992964${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.incomingCall.deleteMany({ where: { interactionId: { in: interactionIds } } });
  await prisma.callAnalysis.deleteMany({ where: { interactionId: { in: interactionIds } } });
  await prisma.interaction.deleteMany({ where: { OR: [{ agentId }, { clientId: { in: clientIds } }] } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("Разбор звонка — клиента в «Неактивные» не переводит", () => {
  it("модель вернула причину паузы — клиент остаётся в работе, записи о переводе нет", async () => {
    const client = await makeClient();
    const interaction = await makeCallInteraction(client.id);
    callAiText.mockResolvedValueOnce({
      score: 40,
      summary: "Клиент откладывает покупку до осени",
      outcome: "WAITING_CALL",
      inactiveReason: "POSTPONED",
    });

    expect((await analyzeCall(interaction.id)).ok).toBe(true);
    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(after?.workStatus).toBe("ACTIVE");
    const note = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SYSTEM", notes: { contains: "Неактивные" } },
    });
    expect(note).toBeNull();
  });

  it("запрос к модели больше не просит причину паузы", async () => {
    const client = await makeClient();
    const interaction = await makeCallInteraction(client.id);
    callAiText.mockResolvedValueOnce({ score: 70, summary: "Обычный разговор", outcome: "WAITING_CALL" });
    expect((await analyzeCall(interaction.id)).ok).toBe(true);
    expect(JSON.stringify(callAiText.mock.calls.at(-1))).not.toContain("inactiveReason");
  });
});
