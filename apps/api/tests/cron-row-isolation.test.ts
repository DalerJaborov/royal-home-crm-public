import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * №173 (ночная проверка 24.09): одна «плохая» запись роняла весь тик.
 *
 * Тики проходят список одним циклом без `try` на строку: сбой на первой
 * записи (битые данные, гонка, отказ базы на одном update) обрывал цикл, и все
 * записи после неё в этот тик не обрабатывались, а на следующем тике та же
 * запись снова шла первой. Здесь первая из двух протухших заявок падает внутри
 * передачи владельца (changeClientAgent подменён только для неё) — вторая
 * обязана быть обработана тем же проходом, а сбой — попасть в журнал.
 */

const { badClientIds, logSystemError } = vi.hoisted(() => ({
  badClientIds: new Set<string>(),
  logSystemError: vi.fn(async () => {}),
}));
vi.mock("../src/lib/changeClientAgent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/changeClientAgent.js")>();
  return {
    ...actual,
    changeClientAgent: (async (input: Parameters<typeof actual.changeClientAgent>[0]) => {
      if (badClientIds.has(input.clientId)) throw new Error("нарочный сбой одной записи");
      return actual.changeClientAgent(input);
    }) as typeof actual.changeClientAgent,
  };
});
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => undefined),
  sendPushToAgents: vi.fn(async () => undefined),
}));

const { prisma } = await import("../src/db.js");
const { reassignStaleLeads } = await import("../src/services/leads/reassignment.js");

const runId = Date.now();
let onlyAgentId: string;
const clientIds: string[] = [];
let savedLeadAcceptMinutes: number;
let savedFrozenAgents: string[] = [];

beforeAll(async () => {
  onlyAgentId = (
    await prisma.agent.create({
      data: {
        fullName: `Агент изоляции строк ${runId}`,
        phone: `+992976${runId}`,
        role: "AGENT",
        passwordHash: await bcrypt.hash("x", 4),
      },
    })
  ).id;
  // Единственный принимающий агент — обе заявки идут по одному пути (эскалация),
  // и исход не зависит от чужих агентов в общей базе.
  const others = await prisma.agent.findMany({
    where: { role: "AGENT", isActive: true, frozenAt: null, id: { not: onlyAgentId } },
    select: { id: true },
  });
  savedFrozenAgents = others.map((a) => a.id);
  if (savedFrozenAgents.length) {
    await prisma.agent.updateMany({ where: { id: { in: savedFrozenAgents } }, data: { frozenAt: new Date() } });
  }
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { leadAcceptMinutes: true } });
  savedLeadAcceptMinutes = s?.leadAcceptMinutes ?? 15;
  await prisma.settings.update({ where: { id: "singleton" }, data: { leadAcceptMinutes: 15 } });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { agentId: onlyAgentId } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: onlyAgentId } });
  if (savedFrozenAgents.length) {
    await prisma.agent.updateMany({ where: { id: { in: savedFrozenAgents } }, data: { frozenAt: null } });
  }
  await prisma.settings.update({ where: { id: "singleton" }, data: { leadAcceptMinutes: savedLeadAcceptMinutes } });
  await prisma.$disconnect();
});

async function staleLead(label: string, minutesAgo: number) {
  const lead = await prisma.client.create({
    data: {
      fullName: `${label} ${runId}`,
      phone: `+9929${Math.floor(Math.random() * 10_000_000)}`,
      source: "PHONE_CALL",
      assignedAgentId: onlyAgentId,
      triedAgentIds: [onlyAgentId],
      assignedAt: new Date(Date.now() - minutesAgo * 60_000),
      acceptedAt: null,
    },
  });
  clientIds.push(lead.id);
  return lead;
}

describe("переназначение протухших заявок — сбой одной не обрывает проход", () => {
  it("первая заявка падает, вторая обработана тем же проходом, сбой в журнале", async () => {
    // Первой в проходе идёт самая давняя (orderBy assignedAt asc).
    const bad = await staleLead("Сломанная заявка", 40);
    const good = await staleLead("Здоровая заявка", 20);
    badClientIds.add(bad.id);
    logSystemError.mockClear();

    await reassignStaleLeads();

    const after = await prisma.client.findUniqueOrThrow({ where: { id: good.id } });
    expect(after.escalatedAt).not.toBeNull();
    expect(logSystemError).toHaveBeenCalledWith("cron", expect.stringContaining("нарочный сбой одной записи"), expect.anything());
  });
});
