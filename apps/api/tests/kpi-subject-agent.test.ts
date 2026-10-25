import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { calculateDailyKPI } from "../src/kpi.js";
import { logTimeline } from "../src/lib/timeline.js";
import { dushanbeDayRange } from "../src/lib/dushanbeTime.js";

/**
 * Задание Б2-КПИ (18.09.2026, docs/archive/agent-briefs/timeline-kpi-subject-agent-18-09.md):
 * после Б1/Б2 задача, заведённая ботом/системой от лица держателя карточки,
 * пишется с agentId: null и subjectAgentId: держатель — раньше agentId ВСЕГДА
 * был держателем, и computeCrm/computeDiscipline считали её просто по agentId.
 * Обе метрики обязаны по-прежнему видеть такую задачу.
 */

const runId = Date.now();
let agentId: string;
let clientId: string;
let districtId: string;

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-кпи-субъект-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент кпи-субъект", phone: `+992954${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент кпи-субъект ${runId}`,
        phone: `+992953${runId}`,
        source: "WALK_IN",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("computeCrm видит задачу бота через subjectAgentId", () => {
  it("отмена завтра не улучшает вчерашний KPI и не создаёт будущих хвостов после переназначения", async () => {
    const day = new Date("2001-07-09T07:00:00Z");
    const { start, end } = dushanbeDayRange(day);
    const cancelledAt = new Date(end.getTime() + 60_000);
    const rows = await prisma.interaction.createManyAndReturn({ data: [0, -1].map(offset => ({
      clientId, actorKind: "SYSTEM", subjectAgentId: agentId, type: "SYSTEM", notes: "Temporal cancellation KPI fixture",
      nextAction: "Call", nextActionDate: new Date(start.getTime() + offset * 86_400_000),
      createdAt: new Date(start.getTime() - 172_800_000),
    })), select: { id: true } });
    const ids = rows.map(row => row.id);
    try {
      const before = await calculateDailyKPI(agentId, day);
      expect(before.breakdown.crm).toEqual({ earned: 0, max: 20 });
      expect(before.breakdown.discipline).toEqual({ earned: 15, max: 20 });
      await prisma.interaction.updateMany({ where: { id: { in: ids } }, data: { taskCancelledAt: cancelledAt } });
      await prisma.client.update({ where: { id: clientId }, data: { assignmentCompletedAt: cancelledAt } });
      const after = await calculateDailyKPI(agentId, day);
      expect(after.breakdown.crm).toEqual(before.breakdown.crm);
      expect(after.breakdown.discipline).toEqual(before.breakdown.discipline);
      await prisma.client.update({ where: { id: clientId }, data: { assignmentCompletedAt: null } });
      const reassigned = await calculateDailyKPI(agentId, day);
      expect(reassigned.breakdown.crm).toEqual(before.breakdown.crm);
      expect(reassigned.breakdown.discipline).toEqual(before.breakdown.discipline);
      const later = await calculateDailyKPI(agentId, new Date(end.getTime() + 86_400_000));
      expect(later.breakdown.crm).toEqual({ earned: 20, max: 20 });
      expect(later.breakdown.discipline).toEqual({ earned: 20, max: 20 });
    } finally {
      await prisma.client.update({ where: { id: clientId }, data: { assignmentCompletedAt: null } });
      await prisma.interaction.deleteMany({ where: { id: { in: ids } } });
    }
  });
  it("приватные незакрытые задачи не меняют публичные crm и discipline", async () => {
    const day = new Date("2033-07-09T07:00:00Z");
    const { start } = dushanbeDayRange(day);
    const before = await calculateDailyKPI(agentId, day);
    const rows = await prisma.interaction.createManyAndReturn({ data: [0, -1].map((offset) => ({
      clientId, actorKind: "SYSTEM", subjectAgentId: agentId, type: "SYSTEM", notes: "Private KPI task fixture", investigationOnly: true,
      nextAction: "Private task", nextActionDate: new Date(start.getTime() + offset * 86_400_000),
    })), select: { id: true } });
    try {
      const after = await calculateDailyKPI(agentId, day);
      expect(after.breakdown.crm).toEqual(before.breakdown.crm);
      expect(after.breakdown.discipline).toEqual(before.breakdown.discipline);
    } finally {
      await prisma.interaction.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    }
  });
  it("незакрытая задача бота на сегодня снижает crm держателю, а не прячется", async () => {
    const today = new Date();
    const { start } = dushanbeDayRange(today);
    await logTimeline({
      clientId,
      actor: { kind: "bot", source: "test-bot-task-crm", subjectAgentId: agentId, channel: "whatsapp" },
      type: "MESSAGE",
      notes: `Бот завёл задачу ${runId}`,
      nextAction: "Перезвонить",
      nextActionDate: new Date(start.getTime() + 60 * 60 * 1000),
      completedAt: null,
    });
    const { breakdown } = await calculateDailyKPI(agentId, today);
    // Задача найдена и не закрыта вовремя — без subjectAgentId в фильтре она была
    // бы невидима, dueToday.length === 0, и computeCrm вернул бы полный балл (1),
    // а не 0 — баг маскировался бы презумпцией невиновности «задач не было».
    expect(breakdown.crm).toEqual({ earned: 0, max: 20 });
  });
});

describe("computeDiscipline видит просроченный хвост бота через subjectAgentId", () => {
  it("незакрытый просроченный хвост бота снижает дисциплину держателю", async () => {
    const today = new Date();
    const { start } = dushanbeDayRange(today);
    await logTimeline({
      clientId,
      actor: { kind: "bot", source: "test-bot-task-discipline", subjectAgentId: agentId, channel: "whatsapp" },
      type: "MESSAGE",
      notes: `Бот завёл просроченную задачу ${runId}`,
      nextAction: "Перезвонить",
      nextActionDate: new Date(start.getTime() - 24 * 60 * 60 * 1000),
      completedAt: null,
    });
    const { breakdown } = await calculateDailyKPI(agentId, today);
    // Без subjectAgentId в фильтре хвост невидим, overdue === 0, discipline — 20/20
    // (полный балл), а не штраф в 25% за висящий хвост.
    expect(breakdown.discipline).toEqual({ earned: 15, max: 20 });
  });
});
