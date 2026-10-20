import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const callAiText = vi.fn();
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText }));

const { prisma } = await import("../src/db.js");
const { analyzeCall } = await import("../src/ai/callAnalysis.js");

/**
 * СИГНАЛ «КЛИЕНТ УЖЕ ОБРАЩАЛСЯ» (владелец 19.08.2026) — живой случай: клиент
 * позвонил с нового номера и сказал агенту «вы мне недавно звонили», но
 * автоматика по телефону карточку не нашла (номер новый). Разбор звонка ловит
 * это по СМЫСЛУ фразы и пишет отдельную заметку в хронологию — баннер похожих
 * заметок мог ничего не найти, если описание объекта в этот раз другое.
 */

const runId = Date.now();
let agentId: string;
const clientIds: string[] = [];
const interactionIds: string[] = [];

const LONG_TRANSCRIPT = "Разговор про квартиру и напоминание, что уже звонили раньше ".repeat(6);

async function makeClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент повторный ${runId}-${clientIds.length}`,
      phone: `+992973${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
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
      data: { fullName: `Агент повторный ${runId}`, phone: `+992974${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.callAnalysis.deleteMany({ where: { interactionId: { in: interactionIds } } });
  await prisma.interaction.deleteMany({ where: { OR: [{ agentId }, { clientId: { in: clientIds } }] } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("Разбор звонка — сигнал «уже обращался»", () => {
  it("mentionsPriorContact=true пишет заметку в хронологию и сохраняется в разборе", async () => {
    const client = await makeClient();
    const interaction = await makeCallInteraction(client.id);
    callAiText.mockResolvedValueOnce({
      score: 60,
      summary: "Клиент напомнил, что уже звонил раньше",
      outcome: "WAITING_CALL",
      mentionsPriorContact: true,
    });

    const result = await analyzeCall(interaction.id);
    expect(result.ok).toBe(true);

    const analysis = await prisma.callAnalysis.findUnique({ where: { interactionId: interaction.id } });
    expect(analysis?.mentionsPriorContact).toBe(true);

    const note = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SYSTEM", notes: { contains: "уже обращался" } },
    });
    expect(note).toBeTruthy();
  });

  it("mentionsPriorContact отсутствует/false — заметка не пишется", async () => {
    const client = await makeClient();
    const interaction = await makeCallInteraction(client.id);
    callAiText.mockResolvedValueOnce({
      score: 60,
      summary: "Обычный разговор про квартиру",
      outcome: "WAITING_CALL",
    });

    const result = await analyzeCall(interaction.id);
    expect(result.ok).toBe(true);

    const analysis = await prisma.callAnalysis.findUnique({ where: { interactionId: interaction.id } });
    expect(analysis?.mentionsPriorContact).toBe(false);

    const note = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SYSTEM", notes: { contains: "уже обращался" } },
    });
    expect(note).toBeNull();
  });

  it("ДЕДУП (24.09.2026, живой случай ПК-000381): второй звонок с тем же сигналом за 14 дней заметку не дублирует", async () => {
    const client = await makeClient();
    const firstCall = await makeCallInteraction(client.id);
    const secondCall = await makeCallInteraction(client.id);

    callAiText.mockResolvedValueOnce({
      score: 60,
      summary: "Клиент напомнил, что уже звонил раньше",
      outcome: "WAITING_CALL",
      mentionsPriorContact: true,
    });
    const first = await analyzeCall(firstCall.id);
    expect(first.ok).toBe(true);

    // Второй разговор ТОГО ЖЕ клиента, модель снова видит тот же сигнал —
    // это законный повтор (клиент действительно напоминает об этом не в первый
    // раз), а не поломка разбора.
    callAiText.mockResolvedValueOnce({
      score: 55,
      summary: "Клиент снова упомянул прошлое обращение",
      outcome: "WAITING_CALL",
      mentionsPriorContact: true,
    });
    const second = await analyzeCall(secondCall.id);
    expect(second.ok).toBe(true);

    // Оба разбора сохранились честно (mentionsPriorContact=true у обоих) —
    // дедуп касается только заметки в хронологии, не самого разбора.
    const analyses = await prisma.callAnalysis.findMany({
      where: { interactionId: { in: [firstCall.id, secondCall.id] } },
    });
    expect(analyses.every((a) => a.mentionsPriorContact)).toBe(true);

    const notes = await prisma.interaction.findMany({
      where: { clientId: client.id, type: "SYSTEM", notes: { contains: "уже обращался" } },
    });
    expect(notes).toHaveLength(1);
  });
});
