import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomInt } from "node:crypto";

/**
 * Ревью починки аудита переназначения (19.11.2026): intake меняет владельца
 * через дверь `changeClientAgent`. Если дверь отказала (гонка с ручным
 * назначением или закон П-3), назначение не происходит — но способы связи из
 * этого обращения (Telegram, запасной номер) и отметка «вернулся» не должны
 * пропасть вместе с ним. Отказ двери здесь подставлен подменой: живой гонки в
 * тесте детерминированно не поймать.
 */

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 1),
  sendPushToAgents: vi.fn(async () => 1),
}));

vi.mock("../src/lib/changeClientAgent.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/changeClientAgent.js")>();
  return {
    ...real,
    changeClientAgent: vi.fn(async (input: Parameters<typeof real.changeClientAgent>[0]) =>
      input.source === "intake.reactivation-fallback" ? { ok: false, reason: "race" as const } : real.changeClientAgent(input)
    ),
  };
});

const { prisma } = await import("../src/db.js");
const { createLeadFromChannel } = await import("../src/leads.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const phone = () => `+9929${randomInt(10_000_000, 99_999_999)}`;
const agentIds: string[] = [];
const clientIds: string[] = [];

beforeAll(async () => {
  agentIds.push((await prisma.agent.create({ data: { fullName: "Уволенный агент отказа двери", phone: phone(), role: "AGENT", passwordHash: "x" } })).id);
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.$disconnect();
});

describe("дверь отказала в смене владельца — способы связи всё равно записаны", () => {
  it("возврат из «Неактивных»: Telegram, запасной номер и «вернулся» сохранены, владелец прежний", async () => {
    const firedId = agentIds[0];
    const extra = phone();
    const chatId = String(randomInt(100_000_000, 999_999_999));
    const c = await prisma.client.create({
      data: {
        fullName: "Клиент отказа двери", phone: phone(), source: "PHONE_CALL", kind: "BUYER",
        assignedAgentId: firedId, lastAgentId: firedId, acceptedAt: new Date(), workStatus: "INACTIVE",
      },
    });
    clientIds.push(c.id);
    await prisma.agent.update({ where: { id: firedId }, data: { isActive: false } });

    await createLeadFromChannel({
      fullName: c.fullName, phone: c.phone, source: "TELEGRAM", telegramChatId: chatId, extraPhones: [extra],
      requirementsNotes: "снова ищу",
    });

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.assignedAgentId).toBe(firedId);
    expect(after.telegramChatId).toBe(chatId);
    expect(after.extraPhones).toContain(extra);
    expect(after.returnedAt).not.toBeNull();
  });
});
