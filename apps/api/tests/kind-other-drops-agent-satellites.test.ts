import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomInt } from "node:crypto";
import { waitFor } from "./helpers/waitFor.js";

/**
 * B11 глубокой проверки 02.10.2026: непринятый лид, который при повторном
 * обращении оказался «прочим обращением» (работа, аренда, другой город),
 * снимался с агента прямой записью: уведомление «новый лид» у агента оставалось
 * непрочитанным, а аудит записывал чужую причину «Возврат из Неактивных…».
 */

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 1),
  sendPushToAgents: vi.fn(async () => 1),
}));

const { prisma } = await import("../src/db.js");
const { createLeadFromChannel } = await import("../src/leads.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const phone = () => `+99293${randomInt(1_000_000, 9_999_999)}`;
let agentId = "";
const clientIds: string[] = [];

beforeAll(async () => {
  agentId = (await prisma.agent.create({ data: { fullName: "Агент B11", phone: phone(), role: "AGENT", passwordHash: "x" } })).id;
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { agentId } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([agentId]);
  await prisma.$disconnect();
});

describe("непринятый лид стал «прочим обращением»", () => {
  it("снимается с агента: уведомление «новый лид» гаснет, аудит с верной причиной", async () => {
    const c = await prisma.client.create({
      data: {
        fullName: "Лид B11",
        phone: phone(),
        kind: "BUYER",
        source: "INSTAGRAM",
        assignedAgentId: agentId,
        assignedAt: new Date(),
        acceptedAt: null,
      },
    });
    clientIds.push(c.id);
    const note = await prisma.notification.create({
      data: { agentId, kind: "lead", title: "🔔 Новый лид", body: "Лид B11", tag: `lead-${c.id}`, url: `/clients/${c.shortId}` },
    });

    await createLeadFromChannel({ fullName: c.fullName, phone: c.phone, source: "INSTAGRAM", kind: "OTHER" });

    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.kind).toBe("OTHER");
    expect(after.assignedAgentId).toBeNull();
    const noteAfter = await prisma.notification.findUniqueOrThrow({ where: { id: note.id } });
    expect(noteAfter.read).toBe(true);
    const audit = await waitFor(() =>
      prisma.auditLog.findFirst({ where: { entityId: c.id, action: "CLIENT_AGENT_CHANGE" }, orderBy: { createdAt: "desc" } })
    );
    expect((audit!.meta as { source: string }).source).toBe("intake.kind-other");
  });
});
