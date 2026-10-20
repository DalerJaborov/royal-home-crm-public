import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { detachAgentForCandidate } from "../src/lib/clientToCandidate.js";
import { acceptReactivationOffer, releaseReactivationOffer } from "../src/lib/reactivationOffers.js";
import { createTestAgent } from "./helpers/ownAgent.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * КАНДИДАТ НЕ ВОЗВРАЩАЕТСЯ К АГЕНТУ ЧЕРЕЗ ПРЕДЛОЖЕНИЕ РЕАКТИВАЦИИ (02.10.2026).
 *
 * detachAgentForCandidate снимала агента, но не гасила висящее на карточке
 * предложение реактивации. Дальше карточка возвращалась к агенту двумя путями:
 * кнопкой «Принять» (acceptReactivationOffer) и крон-истечением
 * (releaseReactivationOffer), которое раздавало «прочее обращение» по очереди
 * как покупателя (pickAgentForLead с типом BUYER).
 */

const runId = Date.now();
const clientIds: string[] = [];
const agentIds: string[] = [];

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
});

async function seed(tag: string, kind: "BUYER" | "OTHER") {
  if (agentIds.length === 0) agentIds.push(await createTestAgent(`Реактивация-кандидат ${runId}`));
  const agentId = agentIds[0];
  const client = await prisma.client.create({
    data: {
      fullName: `Реактивация-кандидат ${runId} ${tag}`,
      phone: `+9929${String(runId).slice(-7)}${tag === "a" ? "1" : tag === "b" ? "2" : "3"}`,
      source: "WHATSAPP",
      kind,
      currency: "TJS",
      // Клиент вернулся из Корзины: агента пока нет, предложение висит прежнему.
      assignedAgentId: null,
      reactivationOfferedToAgentId: agentId,
      reactivationOfferedAt: new Date(Date.now() - 3 * 24 * 3600_000),
    },
  });
  clientIds.push(client.id);
  return { client, agentId };
}

describe("предложение реактивации и кандидат на вакансию", () => {
  it("снятие агента под кандидата гасит и предложение реактивации", async () => {
    const { client } = await seed("a", "BUYER");
    await detachAgentForCandidate({ clientId: client.id, actorId: null, reason: "тест", channel: "WHATSAPP" });
    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after?.kind).toBe("OTHER");
    expect(after?.reactivationOfferedToAgentId).toBeNull();
    expect(after?.reactivationOfferedAt).toBeNull();
  });

  it("«Принять» по «прочему обращению» — отказ, агент не назначен, предложение снято", async () => {
    const { client, agentId } = await seed("b", "OTHER");
    const outcome = await acceptReactivationOffer(client.id, agentId);
    expect(outcome).toMatchObject({ ok: false, status: 409 });
    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after?.assignedAgentId).toBeNull();
    expect(after?.kind).toBe("OTHER");
    expect(after?.reactivationOfferedToAgentId).toBeNull();
  });

  it("истечение предложения по «прочему обращению» никому его не раздаёт", async () => {
    const { client, agentId } = await seed("c", "OTHER");
    // Карточка стоит в «Неактивных»: прежний путь через changeClientAgent
    // вернул бы её в работу (ACTIVE) с новой датой назначения.
    const assignedAt = new Date("2026-01-01T00:00:00Z");
    await prisma.client.update({ where: { id: client.id }, data: { workStatus: "INACTIVE", assignedAt } });
    const { nextAgentId } = await releaseReactivationOffer(client, agentId, "expired");
    expect(nextAgentId).toBeNull();
    const after = await prisma.client.findUnique({ where: { id: client.id } });
    expect(after?.assignedAgentId).toBeNull();
    expect(after?.kind).toBe("OTHER");
    expect(after?.reactivationOfferedToAgentId).toBeNull();
    expect(after?.reactivationOfferedAt).toBeNull();
    expect(after?.workStatus).toBe("INACTIVE");
    expect(after?.assignedAt.toISOString()).toBe(assignedAt.toISOString());
  });
});
