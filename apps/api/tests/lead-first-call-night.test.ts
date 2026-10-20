import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { penalizeMissedFirstCalls, firstCallCandidateWindow, remindDueFirstCalls } from "../src/leads.js";
import { closedMsBeforeDue } from "../src/services/leads/shared.js";
import { dushanbeInputToDate } from "../src/lib/dushanbeTime.js";

/**
 * Срок первого звонка стоит ночью (23.09.2026, проверка раздачи, пункт 10).
 * Часы раздачи 10:00–21:00, на звонок 15 минут.
 *  - Принят в 20:50: раньше срок истекал в 21:05, когда проверка уже молчала,
 *    а утром лид выпадал из окна и его не проверял никто.
 *  - Принят в 07:00: раньше в 10:00 агента штрафовали за то, что он не позвонил
 *    ночью.
 */

const HOURS = { start: "10:00", end: "21:00" };
const runId = Date.now();
const DAY1 = "2026-08-11";
const DAY2 = "2026-08-12";
const at = (day: string, time: string) => dushanbeInputToDate(day, time);
const MIN = 60_000;

let agentId: string;
const clientIds: string[] = [];
let saved: {
  workHoursStart: string;
  workHoursEnd: string;
  leadCallMinutes: number;
  leadReassignOnMissedCallEnabled: boolean;
} | null = null;

async function makeAcceptedLead(name: string, acceptedAt: Date) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+9929${Math.floor(Math.random() * 10_000_000)}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      assignedAt: acceptedAt,
      acceptedAt,
    },
  });
  clientIds.push(c.id);
  return c;
}

const penalized = (clientId: string) =>
  prisma.royalScoreEvent.count({ where: { sourceId: { startsWith: `call-missed-${clientId}-` } } });

describe("сколько срок стоит ночью (closedMsBeforeDue)", () => {
  it("днём срок не стоит", () => {
    expect(closedMsBeforeDue(at(DAY1, "12:00"), 15, HOURS)).toBe(0);
  });
  it("принят в 20:50 — 10 минут вечером, остаток утром: стоит вся ночь", () => {
    expect(closedMsBeforeDue(at(DAY1, "20:50"), 15, HOURS)).toBe(at(DAY2, "10:00").getTime() - at(DAY1, "21:00").getTime());
  });
  it("принят в 07:00 — срок начинается в 10:00", () => {
    expect(closedMsBeforeDue(at(DAY2, "07:00"), 15, HOURS)).toBe(3 * 60 * MIN);
  });
  it("окно нулевой длины — ограничений нет", () => {
    expect(closedMsBeforeDue(at(DAY2, "07:00"), 15, { start: "10:00", end: "10:00" })).toBe(0);
  });
});

describe("правило первого звонка на краях дня", () => {
  beforeAll(async () => {
    const passwordHash = await bcrypt.hash("testpass123", 10);
    agentId = (
      await prisma.agent.create({
        data: { fullName: "Агент края дня", phone: `+992972${runId}`, role: "AGENT", passwordHash },
      })
    ).id;
    saved = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { workHoursStart: true, workHoursEnd: true, leadCallMinutes: true, leadReassignOnMissedCallEnabled: true },
    });
    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        workHoursStart: HOURS.start,
        workHoursEnd: HOURS.end,
        leadCallMinutes: 15,
        leadReassignOnMissedCallEnabled: false,
      },
    });
  });

  afterAll(async () => {
    await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
    await prisma.interaction.deleteMany({ where: { OR: [{ clientId: { in: clientIds } }, { agentId }] } });
    await prisma.notification.deleteMany({ where: { agentId } }).catch(() => {});
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await deleteAgentsWithTraces([agentId]);
    if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
    await prisma.$disconnect();
  });

  it("принят в 07:00: в 10:05 штрафа нет, в 10:20 есть", async () => {
    const lead = await makeAcceptedLead("Принят ночью", at(DAY2, "07:00"));
    await penalizeMissedFirstCalls(at(DAY2, "10:05"));
    expect(await penalized(lead.id)).toBe(0);
    await penalizeMissedFirstCalls(at(DAY2, "10:20"));
    expect(await penalized(lead.id)).toBe(1);
  });

  it("принят в 20:50 и не прозвонен: утром в 10:10 проверка его видит", async () => {
    const lead = await makeAcceptedLead("Принят вечером", at(DAY1, "20:50"));
    // Вечером срок ещё не вышел: 10 минут до закрытия, остальные 5 — утром.
    await penalizeMissedFirstCalls(at(DAY1, "20:59"));
    expect(await penalized(lead.id)).toBe(0);
    await penalizeMissedFirstCalls(at(DAY2, "10:02"));
    expect(await penalized(lead.id)).toBe(0);
    await penalizeMissedFirstCalls(at(DAY2, "10:10"));
    expect(await penalized(lead.id)).toBe(1);
  });

  it("напоминание вечернему лиду приходит утром и не обещает «лид уйдёт» (пункт 15)", async () => {
    const lead = await makeAcceptedLead("Напомнить утром", at(DAY1, "20:52"));
    // Срок 10:07: в 10:03 до него 4 минуты — время напомнить.
    await remindDueFirstCalls(at(DAY2, "10:03"));
    const note = await prisma.interaction.findFirst({
      where: { clientId: lead.id, notes: { startsWith: "Напоминание о первом звонке отправлено" } },
      select: { notes: true },
    });
    expect(note?.notes).toContain("потом минус к Royal Score");
    expect(note?.notes).not.toContain("лид уйдёт");
  });

  it("окно кандидатов утром отодвинуто к вечеру, днём прежнее", () => {
    const settings = { leadCallMinutes: 15, leadPoolAfterMinutes: 25, workHoursStart: HOURS.start, workHoursEnd: HOURS.end };
    expect(firstCallCandidateWindow(settings, at(DAY2, "10:10")).from <= at(DAY1, "20:50")).toBe(true);
    const noon = at(DAY2, "15:00");
    expect(firstCallCandidateWindow(settings, noon).from.getTime()).toBe(noon.getTime() - 4 * 60 * MIN);
  });
});
