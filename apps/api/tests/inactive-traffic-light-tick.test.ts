import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/** Считаем ИМЕННО отправки push: строка в ленте и раньше была одна (она
 *  схлопывается по тегу), а звонил телефон на каждой попытке — проверять надо
 *  то, что убрали. Подмена ДОПОЛНЯЕТ модуль, иначе у соседнего файла в том же
 *  процессе пропадут остальные экспорты. */
const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { runInactiveTrafficLightTick } = await import("../src/lib/inactiveTrafficLight.js");

/**
 * Полный тик светофора неактивных, отдельно от inactive-traffic-light-lost.test.ts
 * (тот проверяет исход «предел исчерпан»). Здесь — что тик вообще не трогает
 * клиентов замороженного агента (absentAgentIds, владелец 08.09.2026) и что он
 * шлёт напоминание, когда попыток ещё в пределах (пачка 10, 11.09.2026, п.7).
 */

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let frozenAgentId: string;
const clientIds: string[] = [];

// В рабочие часы по Душанбе (07:00Z = 12:00 Душанбе) — тот же момент, что и в
// inactive-traffic-light-lost.test.ts, иначе isWithinWorkingHours пропустит тик целиком.
const NOW = new Date("2026-09-01T07:00:00Z");

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент тика светофора", phone: `+992967${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  frozenAgentId = (
    await prisma.agent.create({
      data: {
        fullName: "Замороженный агент тика",
        phone: `+992968${runId}`,
        role: "AGENT",
        passwordHash,
        frozenAt: NOW,
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { agentId: { in: [agentId, frozenAgentId] } } });
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: [agentId, frozenAgentId] } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, frozenAgentId] } } });
  await prisma.$disconnect();
});

async function makeClient(owner: string, overrides: { inactivePingCount?: number; sinceStepsAgo?: number } = {}) {
  const stepsAgo = overrides.sinceStepsAgo ?? 1;
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент тика светофора ${runId}-${clientIds.length}`,
      phone: `+992969${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: owner,
      lastAgentId: owner,
      acceptedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000),
      workStatus: "INACTIVE",
      inactiveLevel: "RED",
      // Красный по умолчанию: 72ч шаг, 2 попытки предел (Settings.inactiveRed*).
      inactiveSince: new Date(NOW.getTime() - stepsAgo * 72 * 60 * 60 * 1000),
      inactivePingCount: overrides.inactivePingCount ?? 0,
    },
  });
  clientIds.push(c.id);
  return c;
}

/** Сколько раз телефон зазвонил про этого клиента. Тег с 23.09.2026 несёт
 *  цикл (inactiveSince) — `inactive-ping-<id>-<ms>`, поэтому по префиксу. */
function pushesFor(clientId: string): number {
  return (sendPushToAgent.mock.calls as unknown as [string, Record<string, string>][]).filter(
    ([, p]) => p.tag?.startsWith(`inactive-ping-${clientId}-`)
  ).length;
}

describe("Полный тик светофора неактивных", () => {
  it("клиента замороженного агента тик не трогает вовсе (absentAgentIds)", async () => {
    const client = await makeClient(frozenAgentId, { sinceStepsAgo: 3, inactivePingCount: 2 });
    await runInactiveTrafficLightTick(NOW);

    const reloaded = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    // Ни статус, ни счётчик попыток, ни владелец не должны были измениться —
    // клиент замороженного агента для тика как будто не существует.
    expect(reloaded.status).not.toBe("LOST");
    expect(reloaded.assignedAgentId).toBe(frozenAgentId);
    expect(reloaded.inactivePingCount).toBe(2);
  });

  it("клиент того же профиля у обычного агента доходит до LOST", async () => {
    const client = await makeClient(agentId, { sinceStepsAgo: 3, inactivePingCount: 2 });
    const result = await runInactiveTrafficLightTick(NOW);

    expect(result.lost).toBeGreaterThanOrEqual(1);
    const reloaded = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(reloaded.status).toBe("LOST");
    // Решение владельца 11.09.2026 (docs/ownership-audit-11-09.md, markClientLost):
    // при LOST агент СОХРАНЯЕТСЯ, а lastAgentId проставляется тем же агентом —
    // карточка не занимает слот в портфеле (TERMINAL_STATUSES), но не становится «ничьей».
    expect(reloaded.assignedAgentId).toBe(agentId);
    expect(reloaded.lastAgentId).toBe(agentId);
  });

  it("попыток ещё в пределах — тик ведёт счётчик, а не уводит клиента", async () => {
    const client = await makeClient(agentId, { sinceStepsAgo: 1, inactivePingCount: 0 });
    const result = await runInactiveTrafficLightTick(NOW);

    expect(result.pinged).toBeGreaterThanOrEqual(1);
    const reloaded = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(reloaded.status).not.toBe("LOST");
    expect(reloaded.assignedAgentId).toBe(agentId);
    expect(reloaded.inactivePingCount).toBeGreaterThanOrEqual(1);
  });

  /**
   * НАПОМИНАНИЯ АГЕНТУ «Клиент давно не отвечает» УБРАНЫ (владелец 02.10.2026:
   * «не нужные уведомления»). Ритм попыток остаётся — по счётчику светофор решает,
   * когда клиент уходит в Потерянные, — а телефон и лента молчат.
   */
  it("ритм попыток идёт, а агента про клиента не уведомляем вовсе", async () => {
    const client = await makeClient(agentId, { sinceStepsAgo: 1, inactivePingCount: 0 });
    sendPushToAgent.mockClear();
    await runInactiveTrafficLightTick(NOW);
    const afterFirst = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(afterFirst.inactivePingCount).toBe(1);

    await runInactiveTrafficLightTick(new Date(NOW.getTime() + 72 * 60 * 60 * 1000));
    const afterSecond = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(afterSecond.inactivePingCount, "сам ритм попыток остался как был").toBe(2);

    expect(pushesFor(client.id), "пуша нет").toBe(0);
    const rows = await prisma.notification.count({
      where: { agentId, tag: { startsWith: `inactive-ping-${client.id}-` } },
    });
    expect(rows, "записи в ленте тоже нет").toBe(0);
  });
});
