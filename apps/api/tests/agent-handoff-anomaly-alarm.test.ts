import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForCount, waitForSettled } from "./helpers/waitFor.js";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { noteAgentHandoffAndAlarmIfAnomalous } from "../src/lib/agentHandoffAnomalyAlarm.js";

/**
 * СЧЁТЧИК АНОМАЛИЙ «ПЕРЕДАЧА / NO_TRUST» (задача F-2, план 03-04.09.2026):
 * агент, который за календарный месяц СУММАРНО передал клиента ИЛИ закрыл с
 * причиной NO_TRUST больше 3 раз — аларм директору. Считаются ОБА действия
 * одним счётчиком (иначе агент выберет необсчитываемый способ).
 */

const runId = Date.now();
const password = "testpass123";
// В рабочих часах по Душанбе (вторник, 12:00) — тот же приём, что и в
// buyer-no-call-alarm.test.ts.
const WORK_NOW = new Date("2026-09-01T07:00:00Z");
// Явно НЕ рабочие часы (01:00 по Душанбе).
const NIGHT_NOW = new Date("2026-09-01T20:00:00Z");

let agentId: string;
let directorId: string;
let token: string;
const clientIds: string[] = [];
const agentIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeClient(suffix: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент аномалии ${runId}-${suffix}`,
      phone: `+992925${runId}${suffix}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент аномалии ${runId}`, phone: `+992926${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentIds.push(agentId);
  directorId = (
    await prisma.agent.create({
      data: { fullName: `Директор аномалии ${runId}`, phone: `+992927${runId}`, role: "DIRECTOR", passwordHash },
    })
  ).id;
  agentIds.push(directorId);
  token = await login(`+992926${runId}`);
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { tag: { startsWith: "agent-handoff-anomaly-" } } });
  await prisma.auditLog.deleteMany({
    where: { agentId, action: { in: ["TRANSFER_NO_TRUST", "REFUSE_NO_TRUST"] } },
  });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

describe("noteAgentHandoffAndAlarmIfAnomalous — прямой вызов", () => {
  it("молчит на 1-3 случае, алармит с 4-го (порог >3)", async () => {
    for (let i = 1; i <= 3; i++) {
      const c = await makeClient(`direct-${i}`);
      await noteAgentHandoffAndAlarmIfAnomalous({
        agentId,
        client: c,
        kind: i % 2 === 0 ? "REFUSE_NO_TRUST" : "TRANSFER_NO_TRUST",
        now: WORK_NOW,
      });
    }
    const beforeFourth = await prisma.notification.findMany({
      where: { agentId: directorId, tag: { startsWith: `agent-handoff-anomaly-${agentId}-` } },
    });
    expect(beforeFourth.length).toBe(0);

    const fourth = await makeClient("direct-4");
    await noteAgentHandoffAndAlarmIfAnomalous({ agentId, client: fourth, kind: "TRANSFER_NO_TRUST", now: WORK_NOW });

    const afterFourth = await prisma.notification.findMany({
      where: { agentId: directorId, tag: { startsWith: `agent-handoff-anomaly-${agentId}-` } },
    });
    expect(afterFourth.length).toBe(1);
    expect(afterFourth[0].title).toContain("много передач");
  });

  it("повторное превышение в том же месяце схлопывается в ту же запись (дедуп по tag)", async () => {
    const fifth = await makeClient("direct-5");
    await noteAgentHandoffAndAlarmIfAnomalous({ agentId, client: fifth, kind: "REFUSE_NO_TRUST", now: WORK_NOW });

    const notifications = await prisma.notification.findMany({
      where: { agentId: directorId, tag: { startsWith: `agent-handoff-anomaly-${agentId}-` } },
    });
    expect(notifications.length).toBe(1);
    expect(notifications[0].count).toBeGreaterThanOrEqual(2);
  });

  it("вне рабочих часов счётчик пишется (AuditLog), но директора не будит", async () => {
    // Свежий агент — чтобы порог считался с нуля, не смешиваясь с предыдущими тестами.
    const passwordHash = await bcrypt.hash(password, 10);
    const nightAgent = await prisma.agent.create({
      data: { fullName: `Ночной агент аномалии ${runId}`, phone: `+992928${runId}`, role: "AGENT", passwordHash },
    });
    agentIds.push(nightAgent.id);
    for (let i = 1; i <= 4; i++) {
      const c = await prisma.client.create({
        data: {
          fullName: `Ночной клиент ${runId}-${i}`,
          phone: `+992929${runId}${i}`,
          source: "PHONE_CALL",
          assignedAgentId: nightAgent.id,
          acceptedAt: new Date(),
        },
      });
      clientIds.push(c.id);
      await noteAgentHandoffAndAlarmIfAnomalous({
        agentId: nightAgent.id,
        client: c,
        kind: "TRANSFER_NO_TRUST",
        now: NIGHT_NOW,
      });
    }
    // Счётчик считает независимо от часов — 4 записи в AuditLog есть.
    const count = await waitForCount(
      () =>
        prisma.auditLog.count({
          where: { agentId: nightAgent.id, action: { in: ["TRANSFER_NO_TRUST", "REFUSE_NO_TRUST"] } },
        }),
      4
    );
    expect(count).toBe(4);
    // Но директору ночью не пишем.
    const notification = await prisma.notification.findFirst({
      where: { agentId: directorId, tag: { startsWith: `agent-handoff-anomaly-${nightAgent.id}-` } },
    });
    expect(notification).toBeNull();
  });
});

describe("POST /clients/:id/transfer — реальный вызов пишет счётчик", () => {
  it("передача клиента (reason=NO_TRUST) добавляет запись AuditLog TRANSFER_NO_TRUST", async () => {
    const c = await makeClient("http-transfer");
    await prisma.interaction.create({
      data: { clientId: c.id, agentId, type: "SHOWING", notes: "Показ", completedAt: new Date() },
    });
    const before = await waitForSettled(() =>
      prisma.auditLog.count({ where: { agentId, action: "TRANSFER_NO_TRUST" } })
    );
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/transfer`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "NO_TRUST" });
    expect(res.status).toBe(200);
    const after = await waitForCount(
      () => prisma.auditLog.count({ where: { agentId, action: "TRANSFER_NO_TRUST" } }),
      before + 1
    );
    expect(after).toBe(before + 1);
  });
});

describe("Вынужденное переназначение НЕ считается (F-3)", () => {
  it("ручное назначение руководителем не пишет TRANSFER_NO_TRUST/REFUSE_NO_TRUST", async () => {
    const c = await makeClient("forced-reassign");
    const secondAgent = await prisma.agent.create({
      data: {
        fullName: `Второй агент аномалии ${runId}`,
        phone: `+992930${runId}`,
        role: "AGENT",
        passwordHash: await bcrypt.hash(password, 10),
      },
    });
    agentIds.push(secondAgent.id);
    const directorTokenLocal = await login(`+992927${runId}`);

    const before = await waitForSettled(() =>
      prisma.auditLog.count({
        where: { agentId, action: { in: ["TRANSFER_NO_TRUST", "REFUSE_NO_TRUST"] } },
      })
    );
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/assign`)
      .set("Authorization", `Bearer ${directorTokenLocal}`)
      .send({ agentId: secondAgent.id });
    expect(res.status).toBe(200);
    // Здесь ждём ОТСУТСТВИЯ записи: дождаться нечего, поэтому даём фоновой
    // записи осесть (два одинаковых замера подряд) и только тогда сверяем.
    const after = await waitForSettled(() =>
      prisma.auditLog.count({
        where: { agentId, action: { in: ["TRANSFER_NO_TRUST", "REFUSE_NO_TRUST"] } },
      })
    );
    expect(after).toBe(before);
  });
});
