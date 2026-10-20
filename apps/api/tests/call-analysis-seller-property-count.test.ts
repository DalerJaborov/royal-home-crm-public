import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const callAiText = vi.fn();
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText }));

const { prisma } = await import("../src/db.js");
const { analyzeCall } = await import("../src/ai/callAnalysis.js");

/**
 * ЧИСЛО ОБЪЕКТОВ ПРОДАВЦА ИЗ РАЗБОРА ЗВОНКА (владелец 06.09.2026, разбор
 * слепых зон п.3): «не агент решает сколько у клиента объектов на продажу —
 * ИИ сам понимает это из разговора и вносит».
 */

const runId = Date.now();
let agentId: string;
const clientIds: string[] = [];
const interactionIds: string[] = [];

const LONG_TRANSCRIPT = "Разговор с продавцом про несколько квартир на продажу и условия ".repeat(6);

async function makeClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Продавец разбор ${runId}-${clientIds.length}`,
      phone: `+992975${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "SELLER",
      assignedAgentId: agentId,
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
      data: { fullName: `Агент разбор числа ${runId}`, phone: `+992976${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.callAnalysis.deleteMany({ where: { interactionId: { in: interactionIds } } });
  await prisma.interaction.deleteMany({ where: { OR: [{ agentId }, { clientId: { in: clientIds } }] } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("Разбор звонка — число объектов продавца", () => {
  it("sellerPropertyCount=3 записывается на карточку с отметкой времени", async () => {
    const client = await makeClient();
    const interaction = await makeCallInteraction(client.id);
    callAiText.mockResolvedValueOnce({
      score: 60,
      summary: "Продавец сказал, что у него три квартиры на продажу",
      outcome: "WAITING_CALL",
      sellerPropertyCount: 3,
    });

    const before = new Date();
    const result = await analyzeCall(interaction.id);
    expect(result.ok).toBe(true);

    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    expect(updated?.sellerDeclaredPropertyCount).toBe(3);
    expect(updated?.sellerDeclaredPropertyCountAt).not.toBeNull();
    expect(updated!.sellerDeclaredPropertyCountAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("большее новое число заменяет прежнее (не складывается с ним)", async () => {
    const client = await makeClient();
    const first = await makeCallInteraction(client.id);
    callAiText.mockResolvedValueOnce({ score: 60, summary: "Первый звонок", outcome: "WAITING_CALL", sellerPropertyCount: 2 });
    await analyzeCall(first.id);

    const second = await makeCallInteraction(client.id);
    callAiText.mockResolvedValueOnce({
      score: 60,
      summary: "Продавец поправился — на самом деле три",
      outcome: "WAITING_CALL",
      sellerPropertyCount: 3,
    });
    await analyzeCall(second.id);

    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    expect(updated?.sellerDeclaredPropertyCount).toBe(3);
  });

  /**
   * ЖИВОЙ СЛУЧАЙ 18.09.2026 (карточка Ахтам, агент Ноза): клиент назвал 4
   * объекта одним звонком, а следующий звонок обсуждал цену только ОДНОГО из
   * них — разбор этого звонка вслепую видел «1 объект» и тихо занижал уже
   * известные 4 до 1. Меньшее число из ОДНОГО разговора не должно понижать
   * уже известное большее — звонок про конкретный объект не значит, что
   * остальные пропали.
   */
  it("меньшее число из следующего звонка НЕ понижает уже известное большее", async () => {
    const client = await makeClient();
    const first = await makeCallInteraction(client.id);
    callAiText.mockResolvedValueOnce({
      score: 60,
      summary: "Продавец назвал четыре объекта в разных районах",
      outcome: "WAITING_CALL",
      sellerPropertyCount: 4,
    });
    await analyzeCall(first.id);

    const second = await makeCallInteraction(client.id);
    callAiText.mockResolvedValueOnce({
      score: 60,
      summary: "Согласовали снижение цены только по одной из квартир",
      outcome: "WAITING_CALL",
      sellerPropertyCount: 1,
    });
    await analyzeCall(second.id);

    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    expect(updated?.sellerDeclaredPropertyCount).toBe(4);
  });

  it("число не названо — поле на карточке не трогается", async () => {
    const client = await makeClient();
    const interaction = await makeCallInteraction(client.id);
    callAiText.mockResolvedValueOnce({ score: 60, summary: "Обычный разговор", outcome: "WAITING_CALL" });

    await analyzeCall(interaction.id);

    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    expect(updated?.sellerDeclaredPropertyCount).toBeNull();
  });

  it("покупатель хочет купить несколько — пишется в buyerDesiredPropertyCount (владелец 06.09.2026)", async () => {
    const client = await makeClient();
    const interaction = await makeCallInteraction(client.id);
    callAiText.mockResolvedValueOnce({
      score: 60,
      summary: "Покупатель хочет две квартиры — себе и под сдачу",
      outcome: "WAITING_CALL",
      buyerPropertyCount: 2,
    });

    await analyzeCall(interaction.id);

    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    expect(updated?.buyerDesiredPropertyCount).toBe(2);
    expect(updated?.buyerDesiredPropertyCountAt).not.toBeNull();
    expect(updated?.sellerDeclaredPropertyCount).toBeNull();
  });
});
