import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const callAiText = vi.fn();
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText }));

const { prisma } = await import("../src/db.js");
const { analyzeCall } = await import("../src/ai/callAnalysis.js");

/**
 * РАЗБОР ЗВОНКА МОГ УСТАРЕТЬ (ПР-000381, 24.09.2026).
 *
 * Конвейер расшифровки асинхронный (минуты), и разбор давно завершённого
 * звонка может добраться до деактивации уже ПОСЛЕ того, как клиент вернулся в
 * работу сам (lib/telephony/autoLeadFromCall.ts, «Клиент позвонил сам —
 * возвращён в работу», ставит Client.returnedAt). Лента карточки ПР-000381
 * 20.09 16:02 поймала именно это: «ИИ перевёл в Неактивные» и в ту же минуту
 * «Клиент позвонил сам — возвращён в работу». Ниже — тот же сценарий с
 * контролируемым временем: звонок в 16:00 (Душанбе), реактивация в 16:02,
 * разбор «доезжает» до деактивации позже (МОК callAiText отвечает сразу,
 * само время ответа модели тут не имитируется — важен только порядок штампов
 * в базе: interaction.createdAt < client.returnedAt).
 */

const runId = Date.now();
let agentId: string;
const clientIds: string[] = [];
const interactionIds: string[] = [];

const LONG_TRANSCRIPT = "Клиент говорит что пока откладывает покупку и просит связаться позже ".repeat(6);

async function makeClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент устаревшего разбора ${runId}-${clientIds.length}`,
      phone: `+992965${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      workStatus: "ACTIVE",
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeCallInteraction(clientId: string, createdAt: Date) {
  const i = await prisma.interaction.create({
    data: {
      clientId,
      agentId,
      type: "CALL",
      notes: "Звонок через CRM",
      transcript: LONG_TRANSCRIPT,
      createdAt,
    },
  });
  interactionIds.push(i.id);
  return i;
}

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: {
        fullName: `Агент устаревшего разбора ${runId}`,
        phone: `+992966${runId}`,
        role: "AGENT",
        passwordHash: "x",
      },
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

describe("Разбор звонка — устаревшая деактивация не перечёркивает более свежий контакт", () => {
  it("клиент вернулся в работу (звонок сам) позже разбираемого звонка — деактивация пропущена, в хронологии объяснение", async () => {
    const client = await makeClient();
    const callAt = new Date("2026-09-20T11:00:00.000Z"); // 16:00 по Душанбе (UTC+5)
    const returnedAt = new Date("2026-09-20T11:02:00.000Z"); // 16:02 — «Клиент позвонил сам — возвращён в работу»
    const interaction = await makeCallInteraction(client.id, callAt);
    await prisma.client.update({ where: { id: client.id }, data: { returnedAt } });

    callAiText.mockResolvedValueOnce({
      score: 40,
      summary: "Клиент откладывает покупку, просил не беспокоить",
      outcome: "WAITING_CALL",
      inactiveReason: "POSTPONED",
    });

    expect((await analyzeCall(interaction.id)).ok).toBe(true);

    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(
      after?.workStatus,
      "устаревший разбор не должен деактивировать клиента, который уже вернулся сам",
    ).toBe("ACTIVE");

    const note = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SYSTEM", notes: { contains: "снова на связи" } },
    });
    expect(note, "нет объяснения в хронологии, почему устаревший разбор не сработал").toBeTruthy();
  });

  it("без более свежего контакта — деактивация проходит как раньше", async () => {
    const client = await makeClient();
    const callAt = new Date("2026-09-20T12:00:00.000Z");
    const interaction = await makeCallInteraction(client.id, callAt);

    callAiText.mockResolvedValueOnce({
      score: 40,
      summary: "Клиент откладывает покупку, просил не беспокоить",
      outcome: "WAITING_CALL",
      inactiveReason: "POSTPONED",
    });

    expect((await analyzeCall(interaction.id)).ok).toBe(true);
    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(after?.workStatus).toBe("INACTIVE");
  });
});
