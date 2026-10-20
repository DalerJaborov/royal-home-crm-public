import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { classifyClientLossFault } from "../src/lib/clientLossFault.js";
import { DEFAULT_EVENT_POINTS } from "../src/lib/scoreJournal.js";

/** Royal Score: классификация вины агента при потере клиента (docs/spec-compliance,
 *  Этап 1) — автоматика по просрочкам + ручное переопределение под правом
 *  score.clientLossOverride. */

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let directorId: string;
let directorToken: string;
let agentToken: string;
const clientIds: string[] = [];
const interactionIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент под проверкой", phone: `+992971${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор вины", phone: `+992972${runId}`, role: "DIRECTOR", passwordHash },
    })
  ).id;

  const agentLogin = await request(app).post("/api/v1/auth/login").send({ phone: `+992971${runId}`, password });
  agentToken = agentLogin.body.accessToken;
  const dirLogin = await request(app).post("/api/v1/auth/login").send({ phone: `+992972${runId}`, password });
  directorToken = dirLogin.body.accessToken;
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: [agentId, directorId] } } });
  await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.$disconnect();
});

async function makeClient(name: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+9929${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c.id;
}

/**
 * ОКНА ИЗ ЭТОЙ ПРОВЕРКИ УШЛИ 13.09.2026 вместе с самим механизмом обязательных
 * окон. Признаков вины было два — просроченное окно ИЛИ просроченная задача;
 * остался второй. Тесты про окна удалены, а не переписаны: проверять нечего,
 * такие записи больше никто не заводит.
 */
describe("classifyClientLossFault", () => {
  it("нет просрочек — не по вине агента", async () => {
    const clientId = await makeClient("Без просрочек");
    expect(await classifyClientLossFault(clientId)).toBe("client_lost_no_fault");
  });

  it("classifyClientLossFaultBatch видит то же самое, что и одиночная версия", async () => {
    const { classifyClientLossFaultBatch } = await import("../src/lib/clientLossFault.js");
    const guiltyClient = await makeClient("Батч — виновен");
    const overdue = await prisma.interaction.create({
      data: {
        clientId: guiltyClient,
        agentId,
        type: "CALL",
        notes: "задача",
        nextAction: "перезвонить",
        nextActionDate: new Date(Date.now() - 3600_000),
      },
    });
    interactionIds.push(overdue.id);
    const innocentClient = await makeClient("Батч — невиновен");

    const result = await classifyClientLossFaultBatch([guiltyClient, innocentClient]);
    expect(result.get(guiltyClient)).toBe("client_lost_agent_fault");
    expect(result.get(innocentClient)).toBe("client_lost_no_fault");
  });

  it("просроченная незакрытая задача — по вине агента", async () => {
    const clientId = await makeClient("С просроченной задачей");
    const i = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "CALL",
        notes: "задача",
        nextAction: "перезвонить",
        nextActionDate: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    interactionIds.push(i.id);
    expect(await classifyClientLossFault(clientId)).toBe("client_lost_agent_fault");
  });
});

describe("Ручное переопределение вины (PATCH /royal-score-events/:id/override)", () => {
  it("директор переопределяет client_lost_no_fault -> client_lost_agent_fault", async () => {
    const event = await prisma.royalScoreEvent.create({
      data: { agentId, kind: "client_lost_no_fault", delta: 0, reason: "тест" },
    });
    const res = await request(app)
      .patch(`/api/v1/royal-score-events/${event.id}/override`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ override: "client_lost_agent_fault", comment: "на самом деле не дозвонился" });
    expect(res.status).toBe(200);

    const revert = await prisma.royalScoreEvent.findFirst({ where: { sourceId: `override-revert-${event.id}` } });
    const apply = await prisma.royalScoreEvent.findFirst({ where: { sourceId: `override-apply-${event.id}` } });
    expect(revert?.delta).toBe(0);
    expect(apply?.kind).toBe("client_lost_agent_fault");
    expect(apply?.delta).toBe(DEFAULT_EVENT_POINTS.client_lost_agent_fault);

    // Исходная запись не тронута — журнал не редактируется, только дозаписывается.
    const original = await prisma.royalScoreEvent.findUnique({ where: { id: event.id } });
    expect(original?.kind).toBe("client_lost_no_fault");
  });

  it("агент без права score.clientLossOverride получает 403", async () => {
    const event = await prisma.royalScoreEvent.create({
      data: { agentId, kind: "client_lost_no_fault", delta: 0, reason: "тест 2" },
    });
    const res = await request(app)
      .patch(`/api/v1/royal-score-events/${event.id}/override`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ override: "client_lost_agent_fault" });
    expect(res.status).toBe(403);
  });

  it("нельзя переопределить событие другого вида (например deal_closed)", async () => {
    const event = await prisma.royalScoreEvent.create({
      data: { agentId, kind: "deal_closed", delta: 10, reason: "тест 3" },
    });
    const res = await request(app)
      .patch(`/api/v1/royal-score-events/${event.id}/override`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ override: "client_lost_agent_fault" });
    expect(res.status).toBe(409);
  });

  it("повторное переопределение тем же видом отклоняется", async () => {
    const event = await prisma.royalScoreEvent.create({
      data: { agentId, kind: "client_lost_agent_fault", delta: -5, reason: "тест 4" },
    });
    const res = await request(app)
      .patch(`/api/v1/royal-score-events/${event.id}/override`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ override: "client_lost_agent_fault" });
    expect(res.status).toBe(409);
  });
});
