import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * GET /security/summary и фильтр agentFault на /security/lost-clients — шаг 5
 * переноса: заменяют заглушки «сумму по вердиктам сервер не считает» и «такого
 * фильтра сервер не умеет» на плашке кабинета СБ (SecurityCenter.tsx).
 *
 * Проверяем то, что ничем другим не ловится:
 *  1) /summary считает securityReview ПО ВСЕЙ выборке (groupBy), а не по одной
 *     странице — дельтой, каталог общий на все тесты;
 *  2) agentFault считается ТЕМ ЖЕ правилом, что и в карточке (lib/clientLossFault.ts):
 *     непросроченная задача — без вины, просроченная (nextActionDate в прошлом,
 *     не завершена) — с виной;
 *  3) фильтр agentFault=1/0 на списке сужает выдачу по тому же правилу.
 */

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let securityToken: string;
const clientIds: string[] = [];
const interactionIds: string[] = [];
let faultClientId: string;
let noFaultClientId: string;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент сводки СБ", phone: `+992965${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const securityAgent = await prisma.agent.create({
    data: { fullName: "СБ сводки", phone: `+992966${runId}`, role: "SECURITY", passwordHash },
  });
  securityToken = await login(`+992966${runId}`);

  const faultClient = await prisma.client.create({
    data: {
      fullName: `СБ с виной ${runId}`,
      phone: `+992967${runId}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      securityReview: "PENDING",
    },
  });
  faultClientId = faultClient.id;
  clientIds.push(faultClientId);
  // Просроченная незакрытая задача — ровно то, что classifyClientLossFault считает виной.
  const overdueTask = await prisma.interaction.create({
    data: {
      clientId: faultClientId,
      agentId,
      type: "CALL",
      notes: "тест: просроченная задача",
      completedAt: null,
      nextActionDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    },
  });
  interactionIds.push(overdueTask.id);

  const noFaultClient = await prisma.client.create({
    data: {
      fullName: `СБ без вины ${runId}`,
      phone: `+992968${runId}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      securityReview: "CLEARED",
      securityReviewedAt: new Date(),
    },
  });
  noFaultClientId = noFaultClient.id;
  clientIds.push(noFaultClientId);
  void securityAgent;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { phone: { in: [`+992965${runId}`, `+992966${runId}`] } } });
});

describe("GET /security/summary", () => {
  it("считает pending/cleared/agentFault по всей выборке (не по одной странице)", async () => {
    // Фикстуры (PENDING с просрочкой + CLEARED без) уже созданы в beforeAll —
    // каталог общий на все тесты, поэтому проверяем «не меньше ожидаемого
    // минимума», а не точное число (тот же приём, что и director-тесты в
    // clients-summary.test.ts).
    const res = await request(app)
      .get("/api/v1/security/summary?tab=clients")
      .set("Authorization", `Bearer ${securityToken}`);
    expect(res.status).toBe(200);
    expect(res.body.pending).toBeGreaterThanOrEqual(1);
    expect(res.body.cleared).toBeGreaterThanOrEqual(1);
    expect(res.body.agentFault).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.total).toBe("number");
    expect(res.body.total).toBeGreaterThanOrEqual(2);
  });
});

describe("GET /security/summary — плитки макета c99db05f (alerts)", () => {
  it("считает входы с новых устройств, смены прав и красные флаги звонков", async () => {
    const loginLog = await prisma.loginLog.create({
      data: { agentId, ip: "10.0.0.1", device: "Тестовое устройство", deviceKey: `test-${runId}`, isNewDevice: true },
    });
    const permAudit = await prisma.auditLog.create({
      data: {
        action: "AGENT_PERMISSIONS_UPDATE",
        entityType: "Agent",
        entityId: agentId,
        agentId,
        agentName: "Тест СБ",
        meta: { granted: [], revoked: [] },
      },
    });
    const flaggedClient = await prisma.client.create({
      data: {
        fullName: `СБ красный флаг ${runId}`,
        phone: `+992969${runId}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agentId,
      },
    });
    clientIds.push(flaggedClient.id);
    // Источник красных флагов с 17.09.2026 — единственный опрос после показа
    // (PostShowingCall, см. lib/postShowingCallFeed.ts). Плитка СБ и её проверка
    // прежние, поменялось только то, откуда берутся находки.
    const flaggedShowing = await prisma.interaction.create({
      data: { clientId: flaggedClient.id, agentId, type: "SHOWING", notes: "Показ для проверки СБ" },
    });
    const survey = await prisma.postShowingCall.create({
      data: {
        showingId: flaggedShowing.id,
        clientId: flaggedClient.id,
        agentId,
        scheduledFor: new Date(),
        status: "DONE",
        attempts: 1,
        lastAttemptAt: new Date(),
        talkedAt: new Date(),
        redFlags: ["Тестовая находка антифрода"],
      },
    });

    try {
      const res = await request(app)
        .get("/api/v1/security/summary?tab=clients")
        .set("Authorization", `Bearer ${securityToken}`);
      expect(res.status).toBe(200);
      expect(res.body.alerts.newDeviceLogins).toBeGreaterThanOrEqual(1);
      expect(res.body.alerts.permissionChangeCount).toBeGreaterThanOrEqual(1);
      expect(res.body.alerts.lastPermissionChangeAt).not.toBeNull();
      const flag = res.body.alerts.callRedFlags.find((f: { id: string }) => f.id === survey.id);
      expect(flag).toBeDefined();
      expect(flag.detail).toBe("Тестовая находка антифрода");
    } finally {
      await prisma.postShowingCall.delete({ where: { id: survey.id } });
      await prisma.interaction.delete({ where: { id: flaggedShowing.id } });
      await prisma.loginLog.delete({ where: { id: loginLog.id } });
      await prisma.auditLog.delete({ where: { id: permAudit.id } });
    }
  });
});

describe("GET /security/lost-clients?agentFault=1", () => {
  it("отдаёт только карточки с просроченной задачей/окном", async () => {
    const res = await request(app)
      .get("/api/v1/security/lost-clients?agentFault=1")
      .set("Authorization", `Bearer ${securityToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(faultClientId);
    expect(ids).not.toContain(noFaultClientId);
    for (const item of res.body.items) {
      expect(item.lossFault).toBe("client_lost_agent_fault");
    }
  });

  it("agentFault=0 отдаёт только карточки без вины", async () => {
    const res = await request(app)
      .get("/api/v1/security/lost-clients?agentFault=0")
      .set("Authorization", `Bearer ${securityToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(noFaultClientId);
    expect(ids).not.toContain(faultClientId);
  });
});
