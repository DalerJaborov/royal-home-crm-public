import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * B14 глубокой проверки 02.10.2026, решение владельца «да, по советам»:
 * стратегия раздачи «честно» (fair) считает загрузку агента тем же правилом,
 * что лимит и дашборд, — активные покупатели (OCCUPIES_SLOT_WHERE). Раньше
 * она считала всех клиентов со статусами NEW/CONTACTED/HOT/COLD, включая
 * продавцов, и агент с продавцами переставал получать лиды.
 */

const { prisma } = await import("../src/db.js");
const { pickAgentForLead } = await import("../src/leads.js");

const runId = Date.now().toString().slice(-7);
let sellersAgentId: string;
let buyerAgentId: string;
const clientIds: string[] = [];
let savedStrategy: string | null = null;

async function makeClient(agentId: string, kind: "BUYER" | "SELLER", n: number) {
  const c = await prisma.client.create({
    data: {
      fullName: `Загрузка ${kind} ${runId}-${n}`,
      phone: `+99294${runId}${n}`,
      source: "PHONE_CALL",
      kind,
      status: "NEW",
      workStatus: "ACTIVE",
      assignedAgentId: agentId,
      // Давно принят и давно назначен — щиток «принял и не позвонил» не срабатывает.
      acceptedAt: new Date(Date.now() - 3 * 24 * 3_600_000),
      assignedAt: new Date(Date.now() - 3 * 24 * 3_600_000),
      firstContactAt: new Date(Date.now() - 3 * 24 * 3_600_000),
    },
  });
  clientIds.push(c.id);
}

beforeAll(async () => {
  const s = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } });
  savedStrategy = s.leadDistributionStrategy;
  await prisma.settings.update({ where: { id: "singleton" }, data: { leadDistributionStrategy: "fair" } });
  const mk = async (name: string, n: number) =>
    (
      await prisma.agent.create({
        data: { fullName: `${name} ${runId}`, phone: `+99295${runId}${n}`, role: "AGENT", passwordHash: "x", lastSeenAt: new Date() },
      })
    ).id;
  sellersAgentId = await mk("Агент с продавцами", 1);
  buyerAgentId = await mk("Агент с покупателем", 2);
  // У первого — три продавца (место для покупателей не занимают), у второго — один покупатель.
  await makeClient(sellersAgentId, "SELLER", 1);
  await makeClient(sellersAgentId, "SELLER", 2);
  await makeClient(sellersAgentId, "SELLER", 3);
  await makeClient(buyerAgentId, "BUYER", 4);
});

afterAll(async () => {
  if (savedStrategy) await prisma.settings.update({ where: { id: "singleton" }, data: { leadDistributionStrategy: savedStrategy as never } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [sellersAgentId, buyerAgentId] } } });
});

describe("B14: «честная» раздача — загрузка как у лимита и дашборда", () => {
  it("агент с тремя продавцами и без покупателей считается свободнее агента с одним покупателем", async () => {
    const others = (
      await prisma.agent.findMany({ where: { id: { notIn: [sellersAgentId, buyerAgentId] } }, select: { id: true } })
    ).map((a) => a.id);
    expect(await pickAgentForLead(others, "BUYER")).toBe(sellersAgentId);
  });
});
