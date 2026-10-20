import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * СВОДКА ПО ЗВОНКАМ В ЗАМЕТКЕ О ПОВТОРНОМ ОБРАЩЕНИИ (владелец 19.08.2026).
 *
 * Бот сам не обсуждает ничего в момент приёма заявки (нарочно скупой промт) —
 * поэтому «агент не переспрашивает уже известное» решается через то, что он
 * видит на карточке: сводку последних звонков прямо в заметке.
 */

const sendPushToAgent = vi.fn(async () => 1);
const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { createLeadFromChannel } = await import("../src/leads.js");

const runId = Date.now();
let agentId: string;
const clientIds: string[] = [];
const interactionIds: string[] = [];

afterAll(async () => {
  await prisma.callAnalysis.deleteMany({ where: { interactionId: { in: interactionIds } } });
  await prisma.interaction.deleteMany({ where: { OR: [{ id: { in: interactionIds } }, { clientId: { in: clientIds } }] } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент сводки звонков", phone: `+992${runId}895`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

describe("Сводка по звонкам в заметке о повторном обращении", () => {
  it("заметка содержит краткое резюме прошлых звонков клиента", async () => {
    const phone = `+992${runId}896`;
    const first = await createLeadFromChannel({ fullName: "Клиент со звонками", phone, source: "PHONE_CALL" });
    clientIds.push(first.clientId);
    await prisma.client.update({ where: { id: first.clientId }, data: { assignedAgentId: agentId } });

    const call = await prisma.interaction.create({
      data: { clientId: first.clientId, agentId, type: "CALL", notes: "Звонок", transcript: "разговор" },
    });
    interactionIds.push(call.id);
    await prisma.callAnalysis.create({
      data: {
        interactionId: call.id,
        agentId,
        score: 70,
        summary: "Интересовался трёхкомнатной в Сино, бюджет $35 000",
      },
    });

    await createLeadFromChannel({ fullName: "Клиент со звонками", phone, source: "WHATSAPP" });

    const note = await prisma.interaction.findFirst({
      where: { clientId: first.clientId, type: "SYSTEM", notes: { contains: "снова обратился" } },
      orderBy: { createdAt: "desc" },
    });
    expect(note).not.toBeNull();
    expect(note?.notes).toContain("Из прошлых звонков");
    expect(note?.notes).toContain("трёхкомнатной в Сино");
  });

  it("без прошлых звонков — заметка не упоминает сводку", async () => {
    const phone = `+992${runId}897`;
    const first = await createLeadFromChannel({ fullName: "Клиент без звонков", phone, source: "INSTAGRAM" });
    clientIds.push(first.clientId);
    await prisma.client.update({ where: { id: first.clientId }, data: { assignedAgentId: agentId } });

    await createLeadFromChannel({ fullName: "Клиент без звонков", phone, source: "WHATSAPP" });

    const note = await prisma.interaction.findFirst({
      where: { clientId: first.clientId, type: "SYSTEM", notes: { contains: "снова обратился" } },
      orderBy: { createdAt: "desc" },
    });
    expect(note).not.toBeNull();
    expect(note?.notes).not.toContain("Из прошлых звонков");
  });
});
