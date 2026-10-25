import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { logTimelineMany } from "../src/lib/timeline.js";

/**
 * Задание Б2-КПИ (18.09.2026, docs/archive/agent-briefs/timeline-kpi-subject-agent-18-09.md):
 * «Лидер по показам» на доске почёта раньше считал строго groupBy(["agentId"]) —
 * после Б1/Б2 показ, записанный ботом от лица клиента, пишется с agentId: null и
 * subjectAgentId: держатель, и groupBy по agentId такую строку теряет вовсе
 * (группируется в null). Номинация обязана по-прежнему видеть держателя.
 */

const runId = Date.now();
let agentId: string;
let agentToken: string;
let clientId: string;

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент доски почёта", phone: `+992952${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  agentToken = signAccessToken({ sub: agentId, role: "AGENT" });
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент доски почёта ${runId}`,
        phone: `+992951${runId}`,
        source: "WALK_IN",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;

  // Большой перевес счётчика (не 1), чтобы тест не зависел от того, сколько
  // показов насчитали параллельно другие файлы теста в общей базе за этот
  // месяц — top3 отдаёт только первых трёх, и запись «в принципе видна»
  // недостаточно, если её обгоняют случайные соседи.
  await logTimelineMany(
    Array.from({ length: 50 }, (_, i) => ({
      clientId,
      actor: { kind: "bot" as const, source: "test-bot-hof-showing", subjectAgentId: agentId, channel: "whatsapp" },
      type: "SHOWING" as const,
      notes: `Бот записал показ доски почёта ${runId}-${i}`,
    }))
  );
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Доска почёта: показ бота засчитывается держателю", () => {
  it("приватные показы не дают место в публичном рейтинге", async () => {
    await prisma.interaction.updateMany({ where: { clientId }, data: { investigationOnly: true } });
    try {
      const res = await request(app).get("/api/v1/hall-of-fame").set("Authorization", `Bearer ${agentToken}`);
      expect(res.status).toBe(200);
      const showings = res.body.nominations.find((n: { key: string }) => n.key === "showings");
      expect(showings.nominees.some((n: { id: string }) => n.id === agentId)).toBe(false);
    } finally {
      await prisma.interaction.updateMany({ where: { clientId }, data: { investigationOnly: false } });
    }
  });
  it("«Лидер по показам» видит агента с одним показом, записанным от лица бота", async () => {
    const res = await request(app).get("/api/v1/hall-of-fame").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    const showings = res.body.nominations.find((n: { key: string }) => n.key === "showings");
    expect(showings.nominees.some((n: { id: string }) => n.id === agentId)).toBe(true);
  });
});
