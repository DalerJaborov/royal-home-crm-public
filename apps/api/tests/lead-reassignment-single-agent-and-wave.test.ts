import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";

/**
 * ДВЕ ПОЛОМКИ ОДНОГО РАЗБОРА (владелец 22.09.2026, живой случай ПР-000424:
 * «почему лид по истечению 15 минут не переназначился»). Механизм жив, но
 * рядом с ним нашлись две молчащие дыры того же семейства «крутится вхолостую,
 * а не решает».
 */

const { push } = vi.hoisted(() => ({ push: vi.fn(async () => undefined) }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: push,
  sendPushToAgents: push,
}));

const { reassignStaleLeads } = await import("../src/services/leads/reassignment.js");
const { assignPendingLeads } = await import("../src/services/leads/reassignment.js");

const runId = Date.now();
let onlyAgentId: string;
const clientIds: string[] = [];
let savedLeadAcceptMinutes: number;
let savedFrozenAgents: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  onlyAgentId = (
    await prisma.agent.create({
      data: { fullName: `Единственный агент ${runId}`, phone: `+992975${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  // Замораживаем ВСЕХ остальных агентов на время теста: сценарий требует, чтобы
  // принимающих лиды был ровно один — сам держатель карточки.
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
  /**
   * ЧИСТКА ПО agentId, А НЕ ТОЛЬКО ПО clientId (регрессия в CI, найдена
   * 22.09.2026: `Interaction_agentId_fkey` на `agent.deleteMany`).
   *
   * Тест держит onlyAgentId единственным активным незамороженным агентом и
   * зовёт настоящий, не подменённый assignPendingLeads()/reassignStaleLeads() —
   * при параллельном прогоне (CI гоняет тесты сервера в несколько процессов на
   * одной базе, см. CLAUDE.md) эти функции читают ВСЮ таблицу клиентов, а не
   * только clientIds этого файла, и могут назначить onlyAgentId'у чужой
   * непринятый лид другого теста. Interaction на эту связку остаётся с чужим
   * clientId, который тут не отслежен, — и без строки ниже удаление агента
   * падает по внешнему ключу. Тот же приём уже применён в
   * tests/duplicate-review.test.ts (`agentId: { in: agentIds }`).
   */
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

describe("карусель с единственным агентом не переназначает лид ему самому", () => {
  it("держатель — единственный кандидат: карточка эскалируется, а не крутится вхолостую", async () => {
    const lead = await prisma.client.create({
      data: {
        fullName: `Один агент, круг вхолостую ${runId}`,
        phone: `+9929${Math.floor(Math.random() * 10_000_000)}`,
        source: "PHONE_CALL",
        assignedAgentId: onlyAgentId,
        // Уже был круг карусели: держатель сам себе в списке пробованных —
        // именно это заставляло старый код искать "любого, кроме себя",
        // не находить никого и откатываться на "единственного" без проверки.
        triedAgentIds: [onlyAgentId],
        assignedAt: new Date(Date.now() - 20 * 60_000),
        acceptedAt: null,
      },
    });
    clientIds.push(lead.id);
    push.mockClear();

    const { moved, escalated } = await reassignStaleLeads();

    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    // Раньше: "переназначен" тому же держателю, reassignCount растёт, escalatedAt
    // остаётся null навсегда — карточка крутится вхолостую без исхода.
    expect(after?.assignedAgentId).toBe(onlyAgentId);
    expect(after?.escalatedAt).not.toBeNull();
    expect(escalated).toBeGreaterThanOrEqual(1);
    expect(moved).toBe(0);
    // Держатель не должен получить пуш "переназначен вам" — это пуш от него же ему же.
    const selfPush = push.mock.calls.some(
      (call) => (call as unknown as [string, { title?: string }])[1]?.title === "🤝 Лид переназначен вам"
    );
    expect(selfPush).toBe(false);
  });
});

describe("утренняя волна не обрывается на первом лиде без агента", () => {
  it("следующий лид назначается, даже если предыдущий не нашёл агента", async () => {
    // Замораживаем и единственного агента — теперь агентов, принимающих лиды, нет
    // вовсе, и волна обязана выйти сама (acceptingAgents===0), не тронув лидов.
    await prisma.agent.update({ where: { id: onlyAgentId }, data: { frozenAt: new Date() } });
    const lead = await prisma.client.create({
      data: {
        fullName: `Волна, нет агентов ${runId}`,
        phone: `+9929${Math.floor(Math.random() * 10_000_000)}`,
        source: "PHONE_CALL",
        status: "NEW",
        kind: "BUYER",
      },
    });
    clientIds.push(lead.id);

    const assignedWithNoAgents = await assignPendingLeads();
    expect(assignedWithNoAgents).toBe(0);
    let after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBeNull();

    // Агент снова доступен — волна теперь обязана дойти до лида и назначить его.
    await prisma.agent.update({ where: { id: onlyAgentId }, data: { frozenAt: null } });
    const assigned = await assignPendingLeads();
    expect(assigned).toBeGreaterThanOrEqual(1);
    after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(onlyAgentId);
  });
});
