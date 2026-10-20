import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * B7 глубокой проверки 02.10.2026, решение владельца «да, по советам»: клиенты,
 * переданные руководителем «Передачей дел», сразу считаются принятыми. Раньше
 * они приходили получателю непринятыми, и через 15 минут карусель разносила их
 * другим агентам, а получателя штрафовала «не принял».
 */

const { prisma } = await import("../src/db.js");
const { handoverAgentWork } = await import("../src/lib/agentHandover.js");
const { reassignStaleLeads, penalizeMissedFirstCalls } = await import("../src/leads.js");
const { leadReasonText } = await import("../src/lib/leadReason.js");

const runId = Date.now().toString().slice(-7);
let leavingId: string;
let receiverId: string;
let otherId: string;
let managerId: string;
const clientIds: string[] = [];
let savedHours: { workHoursStart: string; workHoursEnd: string } | null = null;

beforeAll(async () => {
  const s = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } });
  savedHours = { workHoursStart: s.workHoursStart, workHoursEnd: s.workHoursEnd };
  // Проверяем не ночь, а карусель и штраф — окно раздачи на сутки.
  await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "24:00" } });
  const mk = async (fullName: string, role: "AGENT" | "MANAGER", n: number) =>
    (await prisma.agent.create({ data: { fullName: `${fullName} ${runId}`, phone: `+99291${runId}${n}`, role, passwordHash: "x" } })).id;
  leavingId = await mk("Уходит", "AGENT", 1);
  receiverId = await mk("Получатель", "AGENT", 2);
  otherId = await mk("Соседний агент", "AGENT", 3);
  managerId = await mk("Руководитель", "MANAGER", 4);
});

afterAll(async () => {
  if (savedHours) await prisma.settings.update({ where: { id: "singleton" }, data: savedHours });
  const agents = [leavingId, receiverId, otherId, managerId];
  await prisma.notification.deleteMany({ where: { agentId: { in: agents } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agents } } });
});

describe("B7: «Передача дел» — клиенты приходят уже принятыми", () => {
  it("клиент принят сразу, карусель и срок первого звонка его не трогают", async () => {
    const c = await prisma.client.create({
      data: {
        fullName: `Клиент уходящего ${runId}`,
        phone: `+99292${runId}1`,
        source: "PHONE_CALL",
        kind: "BUYER",
        status: "NEW",
        assignedAgentId: leavingId,
        acceptedAt: new Date(),
      },
    });
    clientIds.push(c.id);

    const res = await handoverAgentWork(leavingId, receiverId, managerId);
    expect(res.clients).toBe(1);

    const after = await prisma.client.findUniqueOrThrow({
      where: { id: c.id },
      select: { assignedAgentId: true, acceptedAt: true, assignReason: true },
    });
    expect(after.assignedAgentId).toBe(receiverId);
    expect(after.acceptedAt).not.toBeNull();
    expect(leadReasonText({ assignReason: after.assignReason, matchedPropertyId: null }, null)?.text).toBe(
      "Передал руководитель из дел другого сотрудника"
    );

    // Прошло 20 минут без звонка — у обычного лида сработали бы и карусель, и штраф первого звонка.
    await prisma.client.update({
      where: { id: c.id },
      data: { acceptedAt: new Date(Date.now() - 20 * 60_000), assignedAt: new Date(Date.now() - 20 * 60_000) },
    });
    await reassignStaleLeads();
    await penalizeMissedFirstCalls();

    const later = await prisma.client.findUniqueOrThrow({
      where: { id: c.id },
      select: { assignedAgentId: true, escalatedAt: true },
    });
    expect(later.assignedAgentId).toBe(receiverId);
    expect(later.escalatedAt).toBeNull();
    // Ни штрафа «не принял», ни штрафа «не позвонил» — в журнале баллов получателя пусто.
    expect(await prisma.royalScoreEvent.count({ where: { agentId: receiverId } })).toBe(0);
  });
});
