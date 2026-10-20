import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * «КЛИЕНТ ВЕРНУЛСЯ» (владелец 19.08.2026):
 * 1. Потерянный (status LOST — исчерпан лимит передач) вернулся сам — статус
 *    возвращается в работу, агент остаётся ТЕМ ЖЕ (без переназначения через KPI,
 *    тот же принцип, что у Неактивных).
 * 2. returnedAt ставится на любое повторное обращение — значок в списке клиентов
 *    виден без открытия карточки/хронологии.
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
let otherAgentId: string;
const clientIds: string[] = [];

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент потерянных", phone: `+992900${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  otherAgentId = (
    await prisma.agent.create({
      data: { fullName: "Другой агент потерянных", phone: `+992901${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherAgentId] } } });
  await prisma.$disconnect();
});

describe("Потерянный клиент возвращается", () => {
  it("статус возвращается в работу, агент остаётся тем же, returnedAt проставлен", async () => {
    const phone = `+992902${runId}`;
    const first = await createLeadFromChannel({ fullName: "Потерянный клиент", phone, source: "INSTAGRAM" });
    clientIds.push(first.clientId);
    await prisma.client.update({
      where: { id: first.clientId },
      data: { assignedAgentId: agentId, status: "LOST" },
    });

    await createLeadFromChannel({ fullName: "Потерянный клиент", phone, source: "WHATSAPP" });

    const updated = await prisma.client.findUnique({ where: { id: first.clientId } });
    expect(updated?.status).toBe("NEW");
    expect(updated?.assignedAgentId).toBe(agentId);
    expect(updated?.assignedAgentId).not.toBe(otherAgentId);
    expect(updated?.returnedAt).not.toBeNull();
    expect(updated!.returnedAt!.getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  it("обычное активное повторное обращение — тоже получает returnedAt", async () => {
    const phone = `+992903${runId}`;
    const first = await createLeadFromChannel({ fullName: "Обычный клиент", phone, source: "INSTAGRAM" });
    clientIds.push(first.clientId);
    await prisma.client.update({ where: { id: first.clientId }, data: { assignedAgentId: agentId } });

    await createLeadFromChannel({ fullName: "Обычный клиент", phone, source: "WHATSAPP" });

    const updated = await prisma.client.findUnique({ where: { id: first.clientId } });
    expect(updated?.status).toBe("NEW");
    expect(updated?.returnedAt).not.toBeNull();
  });
});
