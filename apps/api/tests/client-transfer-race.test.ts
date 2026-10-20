import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { transferClientByAgent } from "../src/lib/clientTransfer.js";
import { refuseClient } from "../src/lib/clientRefuse.js";

/**
 * ГОНКА «ПЕРЕДАТЬ»/«БЕЗ СДЕЛКИ» С «/assign» РУКОВОДИТЕЛЯ (ночная проверка
 * 24.09.2026, находка №5).
 *
 * Обе кнопки читают снимок клиента, потом секунды считают квоту, порог,
 * предел передач, подбирают получателя — и только затем пишут владельца.
 * Руководитель за это окно успевает через `/assign` отдать карточку другому
 * агенту (у `/assign` `guardWhere` есть, он проходит). До починки запись шла
 * без условия на прежнего владельца и молча перезаписывала (или откатывала к
 * прежнему агенту) решение руководителя.
 *
 * Момент «между снимком и записью» подменяем через `loadMaxTransfers` — её обе
 * функции зовут ровно после снимка и до записи: хук делает то, что сделал бы
 * `/assign` (владелец Б, принято, `lastAgentId` А), и отдаёт настоящий ответ.
 */
const hooks = vi.hoisted(() => ({ beforeMaxTransfers: null as null | (() => Promise<void>) }));

vi.mock("../src/lib/leadTransfers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/leadTransfers.js")>();
  return {
    ...actual,
    loadMaxTransfers: async () => {
      await hooks.beforeMaxTransfers?.();
      return actual.loadMaxTransfers();
    },
  };
});

const runId = Date.now();

let agentAId: string; // нажимает кнопку
let agentBId: string; // получил карточку от руководителя за секунду до записи
let agentCId: string; // свободный агент — чтобы очереди по KPI было кому отдать
const clientIds: string[] = [];

async function makeClientOfA(idx: number) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент гонки передачи ${runId}-${idx}`,
      phone: `+992975${runId}${idx}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentAId,
      assignedAt: new Date(Date.now() - 3_600_000),
      acceptedAt: new Date(Date.now() - 3_600_000),
    },
  });
  clientIds.push(c.id);
  return c;
}

/** То же, что делает `/assign` руководителя: владелец Б, принято, прежний — А. */
async function supervisorAssignsToB(clientId: string) {
  await prisma.client.update({
    where: { id: clientId },
    data: { assignedAgentId: agentBId, lastAgentId: agentAId, acceptedAt: new Date(), assignedAt: new Date() },
  });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentAId = (
    await prisma.agent.create({
      data: { fullName: "Агент А гонки", phone: `+992976${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentBId = (
    await prisma.agent.create({
      data: { fullName: "Агент Б гонки", phone: `+992977${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentCId = (
    await prisma.agent.create({
      data: { fullName: "Агент В гонки", phone: `+992978${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
});

afterAll(async () => {
  hooks.beforeMaxTransfers = null;
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentAId, agentBId, agentCId] } } });
  await prisma.$disconnect();
});

describe("«Передать» против /assign", () => {
  it("руководитель отдал карточку Б между снимком и записью — 409, владелец остаётся Б", async () => {
    const c = await makeClientOfA(1);
    hooks.beforeMaxTransfers = () => supervisorAssignsToB(c.id);
    let result;
    try {
      result = await transferClientByAgent({ clientId: c.id, agentId: agentAId, reason: "NO_TRUST" });
    } finally {
      hooks.beforeMaxTransfers = null;
    }

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toMatch(/обновите страницу/);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.assignedAgentId).toBe(agentBId);
    expect(after?.lastAgentId).toBe(agentAId);
    expect(after?.acceptedAt).not.toBeNull();
    expect(after?.refusalCount).toBe(0);
    expect(after?.status).toBe("NEW");
    expect(after?.escalatedAt).toBeNull();
    // Хронология откатилась вместе с транзакцией — записи о передаче нет.
    const trace = await prisma.interaction.findFirst({
      where: { clientId: c.id, notes: { contains: "Передан другому агенту" } },
    });
    expect(trace).toBeNull();
  });
});

describe("«Без сделки» против /assign", () => {
  it("руководитель отдал карточку Б между снимком и записью — 409, статус и владелец не тронуты", async () => {
    const c = await makeClientOfA(2);
    hooks.beforeMaxTransfers = () => supervisorAssignsToB(c.id);
    let result;
    try {
      result = await refuseClient({
        clientId: c.id,
        reason: "STOPPED_RESPONDING",
        initiator: "AGENT",
        comment: "перестал отвечать на звонки и сообщения",
        actorId: agentAId,
        actorAgentId: agentAId,
        // Гейт «был показ» — не предмет этого теста (проверен в client-refuse.test.ts).
        bypassPreCloseGates: true,
      });
    } finally {
      hooks.beforeMaxTransfers = null;
    }

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toMatch(/обновите страницу/);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.assignedAgentId).toBe(agentBId);
    expect(after?.acceptedAt).not.toBeNull();
    expect(after?.status).toBe("NEW");
    expect(after?.refusalCount).toBe(0);
    expect(after?.refusalReason).toBeNull();
    expect(after?.escalatedAt).toBeNull();
    const trace = await prisma.interaction.findFirst({
      where: { clientId: c.id, notes: { contains: "Клиент отказался" } },
    });
    expect(trace).toBeNull();
  });
});
