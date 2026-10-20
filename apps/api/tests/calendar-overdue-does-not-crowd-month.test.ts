import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * ПРОСРОЧЕННЫЕ НЕ ВЫТЕСНЯЮТ МЕСЯЦ ИЗ КАЛЕНДАРЯ (аудит 23.09.2026, №52).
 *
 * Календарь брал одну выборку с пределом 500 по возрастанию даты: при пятистах
 * просроченных все места занимали старые просрочки, и задачи на завтра не
 * приходили вовсе.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
let agentId = "";
let clientId = "";
let token = "";
let tomorrowTaskId = "";
const DAY = 86_400_000;

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({ data: { fullName: `Агент календаря ${runId}`, phone: `+99291${tail}`, role: "AGENT", passwordHash: "x" } })
  ).id;
  token = signAccessToken({ sub: agentId, role: "AGENT" });
  await prisma.client.deleteMany({ where: { phone: `+99292${tail}` } });
  clientId = (
    await prisma.client.create({
      data: { fullName: `Клиент календаря ${runId}`, phone: `+99292${tail}`, source: "INSTAGRAM", assignedAgentId: agentId, acceptedAt: new Date() },
    })
  ).id;
  const old = Date.now() - 400 * DAY;
  await prisma.interaction.createMany({
    data: Array.from({ length: 520 }, (_, i) => ({
      clientId,
      agentId,
      type: "CALL" as const,
      notes: `Старая задача ${i}`,
      nextAction: "Перезвонить",
      nextActionDate: new Date(old + i * 60_000),
    })),
  });
  tomorrowTaskId = (
    await prisma.interaction.create({
      data: { clientId, agentId, type: "CALL", notes: "Завтра", nextAction: "Перезвонить", nextActionDate: new Date(Date.now() + DAY) },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("Календарь при пятистах просроченных", () => {
  it("задача на завтра в ответе есть", async () => {
    const res = await request(app).get("/api/v1/calendar/tasks").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: string }[]).map((t) => t.id);
    expect(ids).toContain(tomorrowTaskId);
    // Просроченные тоже есть, но в пределах своего потолка.
    expect(ids.length).toBeGreaterThan(1);
    expect(ids.length).toBeLessThanOrEqual(501);
  });

  it("ответ отсортирован по дате", async () => {
    const res = await request(app).get("/api/v1/calendar/tasks").set("Authorization", `Bearer ${token}`);
    const dates = (res.body as { nextActionDate: string }[]).map((t) => new Date(t.nextActionDate).getTime());
    expect([...dates].sort((a, b) => a - b)).toEqual(dates);
  });
});
