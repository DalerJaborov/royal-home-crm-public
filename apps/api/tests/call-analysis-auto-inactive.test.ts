import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const callAiText = vi.fn();
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText }));

const { prisma } = await import("../src/db.js");
const { analyzeCall } = await import("../src/ai/callAnalysis.js");

/**
 * ИИ САМ ПРИОСТАНАВЛИВАЕТ РАБОТУ С КЛИЕНТОМ (владелец 20.08.2026: «ИИ также имеет
 * право перевести в неактивный клиента, продавца, покупателя, если по разговорам
 * это ясно»).
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ. Перевод в «Неактивный» освобождает место в лимите активных
 * лидов, и до этого дня сделать его мог только человек руками. Никто не делал —
 * портфели заилились (у одного агента 16 «активных» при лимите 6), и раздача
 * встала для всей команды.
 *
 * ЧТО ИМЕННО ПРОВЕРЯЕТСЯ. Не «модель умеет вернуть поле», а три границы, за
 * которыми автоматика становится опасной:
 *  1. с причиной из списка — переводит и освобождает слот;
 *  2. без причины — НЕ трогает (обычный разговор не должен убирать клиента);
 *  3. с выдуманным кодом причины — НЕ трогает (модель фантазирует, и слепо
 *     доверять строке из её ответа нельзя).
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

describe("Разбор звонка — ИИ переводит клиента в Неактивные", () => {
  it("причина из списка: клиент уходит в Неактивные и освобождает место в лимите", async () => {
    const client = await makeClient();
    const interaction = await makeCallInteraction(client.id);
    callAiText.mockResolvedValueOnce({
      score: 40,
      summary: "Клиент откладывает покупку до осени, просил не беспокоить",
      outcome: "WAITING_CALL",
      inactiveReason: "POSTPONED",
    });

    expect((await analyzeCall(interaction.id)).ok).toBe(true);

    const after = await prisma.client.findUnique({
      where: { id: client.id },
      select: { workStatus: true },
    });
    expect(after?.workStatus).toBe("INACTIVE");

    // Хронология обязана объяснить, кто и почему приостановил работу: иначе агент
    // видит исчезнувшего из портфеля клиента без единого следа.
    const note = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SYSTEM", notes: { contains: "Неактивные" } },
    });
    expect(note, "нет записи в хронологии о переводе").toBeTruthy();
  });

  it("причины нет — клиент остаётся активным", async () => {
    const client = await makeClient();
    const interaction = await makeCallInteraction(client.id);
    callAiText.mockResolvedValueOnce({
      score: 70,
      summary: "Обычный разговор, договорились созвониться завтра",
      outcome: "WAITING_CALL",
    });

    expect((await analyzeCall(interaction.id)).ok).toBe(true);
    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(after?.workStatus).toBe("ACTIVE");
  });

  it("выдуманный код причины игнорируется — клиент остаётся активным", async () => {
    const client = await makeClient();
    const interaction = await makeCallInteraction(client.id);
    callAiText.mockResolvedValueOnce({
      score: 50,
      summary: "Клиент чем-то недоволен",
      outcome: "WAITING_CALL",
      // Ни в INACTIVE_REASON_CODES, ни в INACTIVE_REASONS такого нет.
      inactiveReason: "CLIENT_IS_TIRED",
    });

    expect((await analyzeCall(interaction.id)).ok).toBe(true);
    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(after?.workStatus).toBe("ACTIVE");
  });
  it("договорились о показе — «не готов» от модели не принимается (ПК-000475, 24.09.2026)", async () => {
    const client = await makeClient();
    const interaction = await makeCallInteraction(client.id);
    callAiText.mockResolvedValueOnce({
      score: 60,
      summary: "Интересуется квартирой за 35 000 $ у фабрики Гулдаст, свяжем с агентом для показа",
      outcome: "WAITING_SHOWING",
      inactiveReason: "NOT_READY_YET",
    });

    expect((await analyzeCall(interaction.id)).ok).toBe(true);
    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(after?.workStatus).toBe("ACTIVE");
  });

  it("входящий звонок на приём (говорил оператор) в Неактивные не переводит", async () => {
    const client = await makeClient();
    const interaction = await makeCallInteraction(client.id);
    await prisma.incomingCall.create({
      data: {
        channelId: `auto-inactive-${runId}-${interactionIds.length}`,
        phone: client.phone,
        answered: true,
        clientId: client.id,
        interactionId: interaction.id,
      },
    });
    callAiText.mockResolvedValueOnce({
      score: 50,
      summary: "Клиент спросил про квартиру, оператор передаст агенту",
      outcome: "WAITING_CALL",
      inactiveReason: "NOT_READY_YET",
    });

    expect((await analyzeCall(interaction.id)).ok).toBe(true);
    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(after?.workStatus).toBe("ACTIVE");
  });
});
