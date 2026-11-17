import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { randomInt } from "node:crypto";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ВОЗВРАТ ИЗ КОРЗИНЫ — НОВАЯ ЖИЗНЬ (владелец 16.11.2026). Отказ теперь уводит
 * карточку в Корзину, не ставя LOST/«Неактивный». Прежний сброс счётчиков при
 * возврате был привязан к этим статусам и пропускал как раз такой случай: старые
 * отказы и круги передачи тянулись в новый заход клиента. Теперь сбрасываются
 * всегда, при любом статусе карточки.
 */

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => undefined),
  sendPushToAgents: vi.fn(async () => undefined),
}));

const { createLeadFromChannel } = await import("../src/services/leads/intake.js");

const runId = `${Date.now()}${randomInt(1000, 9999)}`;
const phone = `+99299${randomInt(1_000_000, 9_999_999)}`;
let agentId: string;
const clientIds: string[] = [];

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Прежний ${runId}`, phone: `+99299${randomInt(1_000_000, 9_999_999)}`, role: "AGENT", passwordHash: await bcrypt.hash("x", 4) },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([agentId]);
  await prisma.$disconnect();
});

describe("возврат из Корзины сбрасывает отказы и круги передачи", () => {
  it("карточка CONTACTED (не LOST) с отказами — после обращения счётчики пустые", async () => {
    const trashed = await prisma.client.create({
      data: {
        fullName: `Отказник ${runId}`,
        phone,
        source: "PHONE_CALL",
        kind: "BUYER",
        status: "CONTACTED",
        assignedAgentId: agentId,
        lastAgentId: agentId,
        refusalCount: 3,
        triedAgentIds: [agentId],
        declinedAgentIds: [agentId],
        deletedAt: new Date(Date.now() - 24 * 3600_000),
      },
    });
    clientIds.push(trashed.id);

    const res = await createLeadFromChannel({ fullName: `Отказник ${runId}`, phone, source: "PHONE_CALL" });
    expect(res.clientId).toBe(trashed.id);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: trashed.id } });
    expect(after.deletedAt).toBeNull();
    expect(after.refusalCount).toBe(0);
    expect(after.triedAgentIds ?? []).toEqual([]);
    expect(after.declinedAgentIds).toEqual([]);
  });
});
