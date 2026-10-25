import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { dushanbeStartOfMonth } from "../src/lib/dushanbeTime.js";
import { loadEventPoints } from "../src/lib/scoreJournal.js";

/**
 * GET /me/score-months — «Вы против себя» на главной агента (AgentHome.tsx):
 * очки и три показателя (принятые заявки, показы, сделки) за этот и прошлый
 * календарный месяц по Душанбе.
 *
 * Проверяем то, что не ловят ни build, ни глазами:
 *  1) числа за каждый месяц попадают в правильное ведро по границе месяца, а
 *     не мешаются в кучу («показ вчера в прошлом месяце» не должен утечь в
 *     «этот месяц»);
 *  2) очки — сумма событий журнала по АКТУАЛЬНОЙ цене (loadEventPoints), а не
 *     по сохранённому delta — событие с ценой ниже стандартной не должно
 *     задвоить ожидание теста.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let agentToken: string;
let propertyId: string;
const clientIds: string[] = [];
const dealIds: string[] = [];
const interactionIds: string[] = [];
const eventIds: string[] = [];

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-против-себя-${runId}` } })).id;

  const agent = await prisma.agent.create({
    data: { fullName: `Агент против себя ${runId}`, phone: `+992930${runId.toString().slice(-6)}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  agentToken = await login(agent.phone);

  const property = await prisma.property.create({
    data: {
      title: `Объект против себя ${runId}`,
      type: "APARTMENT",
      areaSqm: 45,
      price: 80000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 5",
      condition: "GOOD",
    },
  });
  propertyId = property.id;

  // Та же граница месяца, что считает сам маршрут (lib/dushanbeTime.ts) —
  // тест обязан целиться в те же ворота, а не в приблизительное "вчера".
  const currentStart = dushanbeStartOfMonth();
  const previousStart = dushanbeStartOfMonth(new Date(currentStart.getTime() - 1));
  const currentMoment = new Date(currentStart.getTime() + 60_000); // минута внутрь этого месяца
  const previousMoment = new Date(previousStart.getTime() + 24 * 60 * 60 * 1000); // день внутрь прошлого месяца

  const clientCurrent = await prisma.client.create({
    data: {
      fullName: `Клиент этого месяца ${runId}`,
      phone: `+992931${runId.toString().slice(-6)}`,
      source: "INSTAGRAM",
      assignedAgentId: agentId,
      acceptedAt: currentMoment,
    },
  });
  const clientPrevious = await prisma.client.create({
    data: {
      fullName: `Клиент прошлого месяца ${runId}`,
      phone: `+992932${runId.toString().slice(-6)}`,
      source: "INSTAGRAM",
      assignedAgentId: agentId,
      acceptedAt: previousMoment,
    },
  });
  clientIds.push(clientCurrent.id, clientPrevious.id);

  const showingCurrent = await prisma.interaction.create({
    data: {
      clientId: clientCurrent.id,
      agentId,
      type: "SHOWING",
      propertyId,
      notes: `Показ этого месяца ${runId}`,
      createdAt: currentMoment,
    },
  });
  const showingPrevious = await prisma.interaction.create({
    data: {
      clientId: clientPrevious.id,
      agentId,
      type: "SHOWING",
      propertyId,
      notes: `Показ прошлого месяца ${runId}`,
      createdAt: previousMoment,
    },
  });
  interactionIds.push(showingCurrent.id, showingPrevious.id);

  const dealCurrent = await prisma.deal.create({
    data: {
      clientId: clientCurrent.id,
      propertyId,
      agentId,
      stage: "COMPLETED",
      commissionAmount: 5000,
      currency: "TJS",
      closedAt: currentMoment,
    },
  });
  const dealPrevious = await prisma.deal.create({
    data: {
      clientId: clientPrevious.id,
      propertyId,
      agentId,
      stage: "COMPLETED",
      commissionAmount: 5000,
      currency: "TJS",
      closedAt: previousMoment,
    },
  });
  dealIds.push(dealCurrent.id, dealPrevious.id);

  // Очки: deal_closed в ОБА месяца, плюс call_on_time только в этот месяц —
  // pointsDiff обязан отразить именно разницу, а не оба события целиком.
  const eDealCurrent = await prisma.royalScoreEvent.create({
    data: { agentId, kind: "deal_closed", delta: 10, reason: "тест: сделка этого месяца", at: currentMoment, sourceId: `test-score-months-deal-current-${runId}` },
  });
  const eDealPrevious = await prisma.royalScoreEvent.create({
    data: { agentId, kind: "deal_closed", delta: 10, reason: "тест: сделка прошлого месяца", at: previousMoment, sourceId: `test-score-months-deal-previous-${runId}` },
  });
  const eCallCurrent = await prisma.royalScoreEvent.create({
    data: { agentId, kind: "call_on_time", delta: 2, reason: "тест: звонок вовремя, этот месяц", at: currentMoment, sourceId: `test-score-months-call-current-${runId}` },
  });
  eventIds.push(eDealCurrent.id, eDealPrevious.id, eCallCurrent.id);
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { id: { in: eventIds } } });
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("GET /me/score-months", () => {
  it("считает заявки/показы/сделки и очки раздельно по месяцу и разницу между ними", async () => {
    const points = await loadEventPoints();
    const expectedCurrentPoints = Math.round((points.deal_closed + points.call_on_time) * 100) / 100;
    const expectedPreviousPoints = Math.round(points.deal_closed * 100) / 100;

    const res = await request(app).get("/api/v1/me/score-months").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);

    expect(res.body.current.acceptedClients).toBe(1);
    expect(res.body.current.showings).toBe(1);
    expect(res.body.current.deals).toBe(1);
    expect(res.body.current.points).toBe(expectedCurrentPoints);

    expect(res.body.previous.acceptedClients).toBe(1);
    expect(res.body.previous.showings).toBe(1);
    expect(res.body.previous.deals).toBe(1);
    expect(res.body.previous.points).toBe(expectedPreviousPoints);

    const expectedDiff = Math.round((expectedCurrentPoints - expectedPreviousPoints) * 100) / 100;
    expect(res.body.pointsDiff).toBe(expectedDiff);
  });

  it("чужой агент не видит эти числа без токена", async () => {
    const res = await request(app).get("/api/v1/me/score-months");
    expect(res.status).toBe(401);
  });
});

/**
 * Задание Б2-КПИ (18.09.2026, docs/archive/agent-briefs/timeline-kpi-subject-agent-18-09.md):
 * показ, записанный ботом от лица клиента (agentId: null, subjectAgentId:
 * держатель) — та же личная статистика, что и раньше, когда agentId всегда был
 * держателем. Отдельный агент/клиент — чтобы не задеть числа выше (там ровно 1).
 */
describe("GET /me/score-months: показ бота засчитывается держателю", () => {
  it("считает показ, записанный ботом от лица клиента (subjectAgentId)", async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    const agent = await prisma.agent.create({
      data: { fullName: `Агент показ-бот ${runId}`, phone: `+992933${runId.toString().slice(-6)}`, role: "AGENT", passwordHash },
    });
    const token = await login(agent.phone);
    const client = await prisma.client.create({
      data: {
        fullName: `Клиент показ-бот ${runId}`,
        phone: `+992934${runId.toString().slice(-6)}`,
        source: "INSTAGRAM",
        assignedAgentId: agent.id,
        acceptedAt: new Date(),
      },
    });
    const { logTimeline } = await import("../src/lib/timeline.js");
    await logTimeline({
      clientId: client.id,
      actor: { kind: "bot", source: "test-bot-score-months-showing", subjectAgentId: agent.id, channel: "whatsapp" },
      type: "SHOWING",
      nextActionDate: new Date(),
      showingOffCrm: true,
      showingOffCrmDetails: "Тестовый объект вне CRM, улица Проверочная 1",
      notes: `Бот записал показ против себя ${runId}`,
    });

    try {
      const res = await request(app).get("/api/v1/me/score-months").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.current.showings).toBe(1);
    } finally {
      await prisma.interaction.deleteMany({ where: { clientId: client.id } });
      await prisma.client.deleteMany({ where: { id: client.id } });
      await prisma.agent.deleteMany({ where: { id: agent.id } });
    }
  });
});
