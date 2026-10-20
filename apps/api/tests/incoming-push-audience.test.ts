import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { prisma } = await import("../src/db.js");
const { incomingOperatorIds } = await import("../src/lib/telephony/incomingSettings.js");
const { findAgentsWithPermission } = await import("../src/lib/recipients.js");

/**
 * КОМУ УХОДИТ УВЕДОМЛЕНИЕ «📞 Входящий звонок» (решение владельца 20.09.2026).
 *
 * До этой правки список считался по праву `clients.assign`, и директор получал пуш
 * о каждом звонке, которого сам не принимает («шлют пуши, но не звонки»). Теперь
 * адресаты — первая линия (`takesUnknownCalls`), а запасной путь на `clients.assign`
 * остаётся ровно на случай, когда оператор не назначен ни один: иначе незнакомый
 * звонок не увидел бы никто.
 */

const runId = Date.now();
let operatorId = "";
let managerId = "";
/** Чужие дежурные из базы гасим на время прогона: иначе запасной путь не проверить. */
let foreignFlagged: string[] = [];

beforeAll(async () => {
  foreignFlagged = (
    await prisma.agent.findMany({ where: { takesUnknownCalls: true }, select: { id: true } })
  ).map((a) => a.id);
  if (foreignFlagged.length > 0) {
    await prisma.agent.updateMany({ where: { id: { in: foreignFlagged } }, data: { takesUnknownCalls: false } });
  }

  const operator = await prisma.agent.create({
    data: {
      fullName: `Первая линия ${runId}`,
      phone: `+992931${String(runId).slice(-6)}`,
      role: "AGENT",
      passwordHash: "x",
      takesUnknownCalls: true,
    },
  });
  operatorId = operator.id;

  const manager = await prisma.agent.create({
    data: {
      fullName: `Руководитель ${runId}`,
      phone: `+992932${String(runId).slice(-6)}`,
      role: "ADMIN",
      passwordHash: "x",
    },
  });
  managerId = manager.id;
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: [operatorId, managerId] } } });
  if (foreignFlagged.length > 0) {
    await prisma.agent.updateMany({ where: { id: { in: foreignFlagged } }, data: { takesUnknownCalls: true } });
  }
});

describe("адресаты уведомления о входящем звонке", () => {
  it("уведомление уходит первой линии, а руководителю без признака — нет", async () => {
    const ids = await incomingOperatorIds();
    expect(ids).toContain(operatorId);
    expect(ids).not.toContain(managerId);
    const flagged = await prisma.agent.findMany({
      where: { takesUnknownCalls: true, isActive: true, frozenAt: null },
      select: { id: true },
    });
    expect(new Set(ids)).toEqual(new Set(flagged.map((a) => a.id)));
  });

  it("замороженный дежурный из адресатов выпадает", async () => {
    await prisma.agent.update({ where: { id: operatorId }, data: { frozenAt: new Date() } });
    try {
      const ids = await incomingOperatorIds();
      expect(ids).not.toContain(operatorId);
    } finally {
      await prisma.agent.update({ where: { id: operatorId }, data: { frozenAt: null } });
    }
  });

  it("оператора не назначили ни одного — уведомление идёт руководству, а не в никуда", async () => {
    await prisma.agent.update({ where: { id: operatorId }, data: { takesUnknownCalls: false } });
    try {
      const ids = await incomingOperatorIds();
      const managers = await findAgentsWithPermission("clients.assign");
      expect(managers).toContain(managerId);
      expect(new Set(ids)).toEqual(new Set(managers));
    } finally {
      await prisma.agent.update({ where: { id: operatorId }, data: { takesUnknownCalls: true } });
    }
  });
});
