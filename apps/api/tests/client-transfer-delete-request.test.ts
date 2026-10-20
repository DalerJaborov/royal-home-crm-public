import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { transferClientToAgent } from "../src/lib/clientTransfer.js";

/**
 * Разведка 07.09.2026 (класс «осиротевшие спутники»): заявка агента на удаление
 * клиента отражает мнение ПРЕЖНЕГО агента. Как только карточку забрал другой —
 * решение руководства по старой заявке оторвано от реальности: approve стёр бы
 * карточку из-под нового агента, который о заявке даже не знает.
 */

const runId = Date.now();
let fromAgentId = "";
let toAgentId = "";
const clientIds: string[] = [];

beforeAll(async () => {
  fromAgentId = (
    await prisma.agent.create({
      data: { fullName: `Передал ${runId}`, phone: `+992960${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  toAgentId = (
    await prisma.agent.create({
      data: { fullName: `Принял ${runId}`, phone: `+992961${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.clientDeleteRequest.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [fromAgentId, toAgentId] } } });
  await prisma.$disconnect();
});

async function makeClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент передачи ${runId}-${clientIds.length}`,
      phone: `+992962${clientIds.length}${String(runId).slice(-6)}`,
      source: "PHONE_CALL",
      assignedAgentId: fromAgentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

describe("Заявка на удаление клиента снимается при передаче другому агенту", () => {
  it("PENDING заявка становится REJECTED без решения человека", async () => {
    const client = await makeClient();
    const request = await prisma.clientDeleteRequest.create({
      data: { clientId: client.id, requestedById: fromAgentId, reason: "OTHER", comment: "Не отвечает" },
    });

    await transferClientToAgent({
      clientId: client.id,
      fromAgentId,
      toAgentId,
      note: "Передан для теста",
    });

    const after = await prisma.clientDeleteRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.status).toBe("REJECTED");
    expect(after.decidedById).toBeNull();
    expect(after.decidedAt).not.toBeNull();
  });

  it("уже решённую (APPROVED/REJECTED) заявку не трогает", async () => {
    const client = await makeClient();
    const request = await prisma.clientDeleteRequest.create({
      data: {
        clientId: client.id,
        requestedById: fromAgentId,
        reason: "OTHER",
        comment: "Тест",
        status: "REJECTED",
        decidedById: fromAgentId,
        decidedAt: new Date(Date.now() - 3600_000),
        decisionNote: "Отказано руками",
      },
    });

    await transferClientToAgent({
      clientId: client.id,
      fromAgentId,
      toAgentId,
      note: "Передан для теста",
    });

    const after = await prisma.clientDeleteRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.decidedById).toBe(fromAgentId);
    expect(after.decisionNote).toBe("Отказано руками");
  });

  it("нет заявки — передача проходит как обычно, без ошибок", async () => {
    const client = await makeClient();
    await expect(
      transferClientToAgent({ clientId: client.id, fromAgentId, toAgentId, note: "Без заявки" })
    ).resolves.toBeDefined();
  });
});
