import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { classifyClientLossFaultBatch } from "../src/lib/clientLossFault.js";

/** Одиночная версия удалена 16.11.2026 (жила ради штрафа за потерю клиента) —
 *  кабинет СБ зовёт пакетную, ею и проверяем то же правило. */
const classifyClientLossFault = async (clientId: string, now?: Date) =>
  (await classifyClientLossFaultBatch([clientId], now)).get(clientId);

/** Классификация вины агента при потере клиента (кабинет СБ) — по просрочкам.
 *  Штраф Royal Score и ручное переопределение сняты 16.11.2026. */

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

// «Ручное переопределение вины» (PATCH /royal-score-events/:id/override) удалено
// 16.11.2026 вместе со штрафом client_lost_agent_fault — переопределять стало нечего.
