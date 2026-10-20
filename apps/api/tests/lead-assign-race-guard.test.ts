import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomInt } from "node:crypto";

/**
 * B12 глубокой проверки 02.10.2026: «создал карточку → потом назначил». Пока
 * заявка выбирала агента, утренняя волна (или «не дубль» вместе с просрочкой
 * проверки) уже назначала карточку своему, а затем заявка перезаписывала её
 * на другого: два пуша, у первого карточка «уведена». Теперь запись агента —
 * только если карточка всё ещё без агента.
 *
 * Гонка подставляется обёрткой над настоящим assignAgentForLead: пока он
 * «выбирает», карточку назначают сопернику — ровно то окно, в котором её
 * видит утренняя волна.
 */

const raceRival = { id: "" };
vi.mock("../src/services/leads/assignment.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/services/leads/assignment.js")>();
  return {
    ...orig,
    assignAgentForLead: async (...args: Parameters<typeof orig.assignAgentForLead>) => {
      const result = await orig.assignAgentForLead(...args);
      const clientId = args[0].clientId;
      if (raceRival.id && clientId) {
        const { prisma } = await import("../src/db.js");
        const c = await prisma.client.findUnique({ where: { id: clientId }, select: { fullName: true } });
        if (c?.fullName.startsWith("Гонка B12")) {
          await prisma.client.update({ where: { id: clientId }, data: { assignedAgentId: raceRival.id, assignedAt: new Date() } });
        }
      }
      return result;
    },
  };
});
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 1),
  sendPushToAgents: vi.fn(async () => 1),
}));

const { prisma } = await import("../src/db.js");
const { createLeadFromChannel } = await import("../src/leads.js");
const { assignHeldLead } = await import("../src/services/leads/intake.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const phone = () => `+99293${randomInt(1_000_000, 9_999_999)}`;
let freeAgentId = "";
const clientIds: string[] = [];

beforeAll(async () => {
  const mk = (fullName: string) =>
    prisma.agent.create({ data: { fullName, phone: phone(), role: "AGENT", passwordHash: "x", lastSeenAt: new Date() } });
  raceRival.id = (await mk("Соперник B12")).id;
  freeAgentId = (await mk("Свободный B12")).id;
  // Соперник загружен — очередь сама выбрала бы свободного, и перезапись видна.
  for (let i = 0; i < 6; i++) {
    const busy = await prisma.client.create({
      data: { fullName: `Загрузка B12 ${i}`, phone: phone(), kind: "BUYER", source: "WALK_IN", status: "NEW", assignedAgentId: raceRival.id, acceptedAt: new Date() },
    });
    clientIds.push(busy.id);
  }
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([raceRival.id, freeAgentId]);
  await prisma.$disconnect();
});

describe("назначение не перезаписывает агента, успевшего первым", () => {
  it("новая заявка: карточку уже назначила волна — остаётся у неё", async () => {
    const { clientId } = await createLeadFromChannel({ fullName: "Гонка B12 заявка", phone: phone(), source: "INSTAGRAM", kind: "BUYER" });
    clientIds.push(clientId);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(after.assignedAgentId).toBe(raceRival.id);
  });

  it("придержанная проверкой дубля: «не дубль» не перезаписывает того, кто успел", async () => {
    const c = await prisma.client.create({
      data: { fullName: "Гонка B12 придержка", phone: phone(), kind: "BUYER", source: "INSTAGRAM" },
    });
    clientIds.push(c.id);
    await assignHeldLead(c.id);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.assignedAgentId).toBe(raceRival.id);
  });
});
