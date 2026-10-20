import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { closeStaleNextActions } from "../src/lib/nextActionAutoClose.js";

/**
 * Подсказки «Мой фокус» на Главной — открытые Interaction (nextAction != null,
 * completedAt == null). Раньше единственным способом их закрыть была ручная
 * кнопка «Отметить выполненной» — новое реальное взаимодействие с клиентом
 * (звонок, сообщение, показ) их не трогало, и подсказка «зависала», даже если
 * агент уже перезвонил или списался с клиентом. См. lib/nextActionAutoClose.ts.
 */

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let clientId: string;
let otherClientId: string;
let token: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: "Агент подсказок", phone: `+992983${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: "Клиент подсказок",
        phone: `+992984${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  otherClientId = (
    await prisma.client.create({
      data: {
        fullName: "Другой клиент подсказок",
        phone: `+992985${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;

  const res = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: [clientId, otherClientId] } } });
  await prisma.client.deleteMany({ where: { id: { in: [clientId, otherClientId] } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Автозакрытие старых подсказок клиента", () => {
  it("новое взаимодействие закрывает старую открытую подсказку того же клиента", async () => {
    const stale = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "CALL",
        notes: "Клиент звонил сам и не дозвонился",
        nextAction: "Перезвонить — клиент звонил сам и не дозвонился",
        nextActionDate: new Date(Date.now() - 60_000),
      },
    });

    const closed = await closeStaleNextActions(clientId);
    expect(closed).toBe(1);

    const reloaded = await prisma.interaction.findUnique({ where: { id: stale.id } });
    expect(reloaded?.completedAt).not.toBeNull();
  });

  it("подсказка ДРУГОГО клиента не трогается", async () => {
    const untouched = await prisma.interaction.create({
      data: {
        clientId: otherClientId,
        agentId,
        type: "CALL",
        notes: "Недозвон у другого клиента",
        nextAction: "Перезвонить — клиент звонил сам и не дозвонился",
        nextActionDate: new Date(Date.now() - 60_000),
      },
    });

    await closeStaleNextActions(clientId);

    const reloaded = await prisma.interaction.findUnique({ where: { id: untouched.id } });
    expect(reloaded?.completedAt).toBeNull();
  });

  it("свежесозданная этим же событием подсказка себя не гасит", async () => {
    const freshlyCreated = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "CALL",
        notes: "Новый недозвон — только что записан",
        nextAction: "Перезвонить — клиент не ответил (попытка 1 из 3)",
        nextActionDate: new Date(Date.now() + 15 * 60_000),
      },
    });
    const olderStale = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "SYSTEM",
        notes: "Старая подсказка, заведённая раньше",
        nextAction: "Согласовать новую дату показа",
        nextActionDate: new Date(Date.now() - 3600_000),
      },
    });

    // Ровно так же вызывается из callTracker.ts/incomingCalls.ts: excludeInteractionId
    // — id только что созданной записи, чтобы она не закрыла сама себя в той же
    // операции, где создалась.
    const closed = await closeStaleNextActions(clientId, freshlyCreated.id);
    expect(closed).toBe(1);

    const fresh = await prisma.interaction.findUnique({ where: { id: freshlyCreated.id } });
    expect(fresh?.completedAt).toBeNull();

    const older = await prisma.interaction.findUnique({ where: { id: olderStale.id } });
    expect(older?.completedAt).not.toBeNull();
  });

  it("завершение показа через PATCH /interactions/:id/complete закрывает старую подсказку клиента", async () => {
    const staleCall = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "CALL",
        notes: "Старая подсказка перед показом",
        nextAction: "Связаться с клиентом",
        nextActionDate: new Date(Date.now() - 60_000),
      },
    });
    const showing = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "SHOWING",
        notes: "Показ объекта",
        nextAction: "Показ объекта",
        nextActionDate: new Date(Date.now() - 30_000),
      },
    });

    const res = await request(app)
      .patch(`/api/v1/interactions/${showing.id}/complete`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(200);

    // Автозакрытие — фоновая (не ожидаемая ответом) операция; даём ей тик события.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const reloaded = await prisma.interaction.findUnique({ where: { id: staleCall.id } });
    expect(reloaded?.completedAt).not.toBeNull();
  });
});
