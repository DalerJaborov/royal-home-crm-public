import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForCount } from "./helpers/waitFor.js";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { noteTaskRescheduleAndAlarmIfAnomalous } from "../src/lib/taskRescheduleAnomalyAlarm.js";

/**
 * СЧЁТЧИК АНОМАЛИЙ «ПЕРЕНОС ЗАДАЧИ БЕЗ КОНТАКТА» (04.09.2026, находка аудита) —
 * агент двигает nextActionDate через ассистента (reschedule_task), ни разу не
 * связавшись с клиентом на самом деле, и explainedSilence в buyerNoCallAlarm.ts/
 * sellerNoPropertyAlarm.ts молчит вечно. Порог по аналогии с
 * agentHandoffAnomalyAlarm.ts: >3 переноса подряд без контакта.
 */

const runId = Date.now();
const password = "testpass123";
// Рабочие часы по Душанбе (вторник, 12:00) — тот же приём, что в остальных тестах алармов.
const WORK_NOW = new Date("2026-09-01T07:00:00Z");
const NIGHT_NOW = new Date("2026-09-01T20:00:00Z"); // 01:00 по Душанбе

let agentId: string;
let directorId: string;
const clientIds: string[] = [];
const interactionIds: string[] = [];
const agentIds: string[] = [];

async function makeClient(suffix: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент переноса ${runId}-${suffix}`,
      phone: `+992940${runId}${suffix}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeTask(clientId: string, nextActionDate: Date) {
  const i = await prisma.interaction.create({
    data: { clientId, agentId, type: "SYSTEM", notes: "Задача", nextAction: "Перезвонить", nextActionDate },
  });
  interactionIds.push(i.id);
  return i;
}

/** Реальный звонок (talked) — ломает серию, если создан МЕЖДУ двумя переносами. */
async function makeTalkedCall(clientId: string) {
  const i = await prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", notes: "Дозвонились", callAttempt: "TALKED", recordingDurationSec: 60 },
  });
  interactionIds.push(i.id);
  return i;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент переноса ${runId}`, phone: `+992941${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentIds.push(agentId);
  directorId = (
    await prisma.agent.create({
      data: { fullName: `Директор переноса ${runId}`, phone: `+992942${runId}`, role: "DIRECTOR", passwordHash },
    })
  ).id;
  agentIds.push(directorId);
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { tag: { startsWith: "alarm-task-reschedule-no-contact-" } } });
  await prisma.auditLog.deleteMany({ where: { action: "TASK_RESCHEDULE", entityId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

describe("noteTaskRescheduleAndAlarmIfAnomalous", () => {
  it("молчит на 1-3 переносе подряд, алармит на 4-м (порог >3)", async () => {
    const client = await makeClient("streak");
    let cursor = new Date("2026-09-01T05:00:00Z");
    for (let i = 1; i <= 3; i++) {
      const task = await makeTask(client.id, cursor);
      const nextDate = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
      await noteTaskRescheduleAndAlarmIfAnomalous({
        clientId: client.id,
        client: { shortId: client.shortId, fullName: client.fullName },
        agentId,
        interactionId: task.id,
        previousDate: cursor,
        newDate: nextDate,
        now: WORK_NOW,
      });
      cursor = nextDate;
    }
    const beforeFourth = await prisma.notification.findFirst({
      where: { agentId: directorId, tag: `alarm-task-reschedule-no-contact-${client.id}` },
    });
    expect(beforeFourth).toBeNull();

    const task4 = await makeTask(client.id, cursor);
    const nextDate4 = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    await noteTaskRescheduleAndAlarmIfAnomalous({
      clientId: client.id,
      client: { shortId: client.shortId, fullName: client.fullName },
      agentId,
      interactionId: task4.id,
      previousDate: cursor,
      newDate: nextDate4,
      now: WORK_NOW,
    });

    const afterFourth = await prisma.notification.findFirst({
      where: { agentId: directorId, tag: `alarm-task-reschedule-no-contact-${client.id}` },
    });
    expect(afterFourth).not.toBeNull();
    expect(afterFourth!.title).toContain("Перенос задачи без контакта");
    // Когда/от кого(агент)/про кого(клиент, в title)/что — видно без перехода по ссылке.
    expect(afterFourth!.body).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(afterFourth!.body).toContain(`Агент переноса ${runId}`);
  });

  it("реальный контакт между переносами обрывает серию — аларма нет даже после многих переносов", async () => {
    const client = await makeClient("contact-break");
    let cursor = new Date("2026-09-01T05:00:00Z");
    for (let i = 1; i <= 3; i++) {
      const task = await makeTask(client.id, cursor);
      const nextDate = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
      await noteTaskRescheduleAndAlarmIfAnomalous({
        clientId: client.id,
        client: { shortId: client.shortId, fullName: client.fullName },
        agentId,
        interactionId: task.id,
        previousDate: cursor,
        newDate: nextDate,
        now: WORK_NOW,
      });
      cursor = nextDate;
      if (i === 2) {
        // Реальный звонок МЕЖДУ 2-м и 3-м переносом — серия должна оборваться.
        await makeTalkedCall(client.id);
      }
    }
    const task4 = await makeTask(client.id, cursor);
    const nextDate4 = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    await noteTaskRescheduleAndAlarmIfAnomalous({
      clientId: client.id,
      client: { shortId: client.shortId, fullName: client.fullName },
      agentId,
      interactionId: task4.id,
      previousDate: cursor,
      newDate: nextDate4,
      now: WORK_NOW,
    });

    const notification = await prisma.notification.findFirst({
      where: { agentId: directorId, tag: `alarm-task-reschedule-no-contact-${client.id}` },
    });
    expect(notification).toBeNull();
  });

  it("вне рабочих часов счётчик пишется (AuditLog), но директора не будит", async () => {
    const client = await makeClient("night");
    let cursor = new Date("2026-09-01T05:00:00Z");
    for (let i = 1; i <= 4; i++) {
      const task = await makeTask(client.id, cursor);
      const nextDate = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
      await noteTaskRescheduleAndAlarmIfAnomalous({
        clientId: client.id,
        client: { shortId: client.shortId, fullName: client.fullName },
        agentId,
        interactionId: task.id,
        previousDate: cursor,
        newDate: nextDate,
        now: NIGHT_NOW,
      });
      cursor = nextDate;
    }
    const count = await waitForCount(
      () => prisma.auditLog.count({ where: { action: "TASK_RESCHEDULE", entityId: client.id } }),
      4
    );
    expect(count).toBe(4);

    const notification = await prisma.notification.findFirst({
      where: { agentId: directorId, tag: `alarm-task-reschedule-no-contact-${client.id}` },
    });
    expect(notification).toBeNull();
  });
});
