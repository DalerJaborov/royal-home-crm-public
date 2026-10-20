import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ГЛУБОКАЯ ПРОВЕРКА 02.10.2026, A10 — «Попросить восстановить» без предела.
 *
 * Тег уведомления собирался с Date.now(), и каждое нажатие ставило в очередь
 * директоров НОВЫЙ аларм уровня «на решение»: десять нажатий — десять
 * отдельных уведомлений у каждого, у кого есть clients.delete. Правило теперь:
 * одна просьба на одно попадание карточки в Корзину; повторное нажатие отвечает
 * «уже отправлено» и очередь не трогает.
 */

const runId = `${Date.now()}`.slice(-7);
const password = "testpass123";
const agentIds: string[] = [];
let clientId: string;
let agentToken: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Агент A10 ${runId}`, phone: `+992979${runId}`, role: "AGENT", passwordHash },
  });
  agentIds.push(agent.id);
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Корзина A10 ${runId}`,
        phone: `+992980${runId}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agent.id,
        acceptedAt: new Date(),
        deletedAt: new Date(),
      },
    })
  ).id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  agentToken = login.body.accessToken;
});

afterAll(async () => {
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { startsWith: `restore-request-${clientId}` } } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await deleteAgentsWithTraces(agentIds);
});

describe("A10: просьба восстановить карточку — одна на попадание в Корзину", () => {
  it("три нажатия подряд — одна просьба в очереди директоров", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post(`/api/v1/clients/${clientId}/request-restore`)
        .set("Authorization", `Bearer ${agentToken}`);
      expect(res.status).toBe(200);
    }
    const queued = await prisma.pendingDirectorAlert.count({ where: { tag: { startsWith: `restore-request-${clientId}` } } });
    expect(queued).toBe(1);
  });
});
