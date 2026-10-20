import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { loadShowingsToday } from "../src/lib/missionControlGaps.js";

/**
 * АУДИТ CODEX 04.10.2026, CHANNEL-CROSSCHECK02: «ПОДТВЕРДИЛИ N» НА ПУЛЬТЕ СЧИТАЛОСЬ ПО ШЕСТИ СТРОКАМ ПРЕВЬЮ.
 *
 * count считался по всем показам суток, а confirmed — по строкам findMany с take: LIST_CAP (6):
 * при десяти подтверждённых показах плитка печатала «10 · подтвердили 6», будто четыре ещё
 * не подтвердили. Теперь confirmed считается отдельным count по тем же условиям суток.
 */
const runId = Date.now();
// Далёкая дата, чтобы в базе не было чужих показов этих суток.
const NOW = new Date("2031-05-05T07:00:00Z"); // 12:00 по Душанбе
let agentId = "";
let clientId = "";
const interactionIds: string[] = [];

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент показов-сегодня", phone: `+992958${String(runId).slice(-9)}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент показов-сегодня ${runId}`,
        phone: `+992912${String(runId).slice(-9)}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  for (let i = 0; i < 10; i++) {
    const row = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "SHOWING",
        notes: "тест показ",
        nextAction: "Показ",
        nextActionDate: new Date(NOW.getTime() + i * 10 * 60 * 1000),
        // Подтверждены все, кроме последнего: 9 из 10.
        confirmedAt: i < 9 ? new Date(NOW.getTime() - 60 * 60 * 1000) : null,
      },
    });
    interactionIds.push(row.id);
  }
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("loadShowingsToday: confirmed считается по всем показам суток, не по превью", () => {
  it("10 показов, 9 подтверждены, в превью 6 строк: confirmed = 9", async () => {
    const res = await loadShowingsToday(NOW);
    expect(res.count).toBe(10);
    expect(res.items).toHaveLength(6);
    expect(res.confirmed).toBe(9);
  });
});
