import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";

/**
 * Недозвон — никому (владелец 26–27.11.2026): «почему такие уведомления приходят
 * мне, администратору», затем «уведомление можешь не отправлять никому больше».
 * По умолчанию (рубильник NO_ANSWER_LEADERSHIP_ALERTS не задан) исчерпанные
 * попытки не дают ни пуша, ни колокольчика, ни задачи — ни руководству, ни
 * агенту. Причина недозвона пишется словами по DIALSTATUS станции в историю.
 */
delete process.env.NO_ANSWER_LEADERSHIP_ALERTS;

const { prisma } = await import("../src/db.js");
const { notifyNoAnswerEscalation } = await import("../src/lib/noAnswerStreak.js");
const { describeNoAnswerReason } = await import("../src/lib/telephony/callTracker.js");

const runId = String(Date.now()).slice(-7);
let agentId: string;
let directorId: string;
let clientId: string;
let shortId: number;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 4);
  agentId = (await prisma.agent.create({ data: { fullName: "Агент недозвона", phone: `+992931${runId}`, role: "AGENT", passwordHash } })).id;
  directorId = (await prisma.agent.create({ data: { fullName: "Директор недозвона", phone: `+992932${runId}`, role: "DIRECTOR", passwordHash } })).id;
  const client = await prisma.client.create({
    data: { fullName: `Клиент недозвона ${runId}`, phone: `+992933${runId}`, source: "PHONE_CALL", assignedAgentId: agentId, acceptedAt: new Date() },
  });
  clientId = client.id;
  shortId = client.shortId;
});

afterAll(async () => {
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: `no-answer-${clientId}` } });
  await prisma.notification.deleteMany({ where: { agentId: { in: [agentId, directorId] } } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
});

describe("исчерпанные попытки дозвона — никому ничего", () => {
  it("ни пуша руководству, ни задачи, ни колокольчика агенту", async () => {
    await notifyNoAnswerEscalation({ id: clientId, fullName: `Клиент недозвона ${runId}`, shortId, kind: "BUYER" }, agentId, 3);

    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `no-answer-${clientId}` } })).toBe(0);
    expect(
      await prisma.interaction.count({
        where: { clientId, autoTaskKind: { in: ["no_answer_supervisor_check", "no_answer_agent_followup"] } },
      })
    ).toBe(0);
    expect(await prisma.notification.count({ where: { agentId: { in: [agentId, directorId] } } })).toBe(0);
  });
});

describe("причина недозвона словами", () => {
  it("по DIALSTATUS станции", () => {
    expect(describeNoAnswerReason("NOANSWER", "+992900000000").short).toBe("клиент не ответил");
    expect(describeNoAnswerReason("BUSY", "+992900000000").short).toBe("занято");
    expect(describeNoAnswerReason("CHANUNAVAIL", "+992900000000").short).toBe("номер выключен или вне сети");
    expect(describeNoAnswerReason("CONGESTION", "900000000").short).toBe("сеть не пропустила вызов");
    expect(describeNoAnswerReason(undefined, "+992900000000").short).toBe("клиент не ответил");
  });

  it("иностранный номер с отказом сети — подсказка написать в мессенджер", () => {
    const r = describeNoAnswerReason("CONGESTION", "+1 (415) 555-0100");
    expect(r.short).toContain("международный");
    expect(r.hint).toContain("WhatsApp");
    expect(describeNoAnswerReason("CHANUNAVAIL", "0079991234567").short).toContain("международный");
    // местный номер с ведущей 0 иностранным не считается
    expect(describeNoAnswerReason("CONGESTION", "0900000000").short).toBe("сеть не пропустила вызов");
  });
});
