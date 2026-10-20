import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { runDealStalePipeline } from "../src/lib/dealStalePipeline.js";
import { dushanbeNextOccurrence } from "../src/lib/dushanbeTime.js";

/**
 * СРОК ЗАДАЧИ «ЗАКРОЙТЕ СДЕЛКУ…» — КОНЕЦ РАБОЧЕГО ДНЯ, А НЕ МОМЕНТ КРОНА
 * (жалоба владельца 17.09.2026: Главная показывала «к 00:20» — время, когда
 * отработал ночной cron, а не разумный дедлайн).
 *
 * До этого файла у lib/dealStalePipeline.ts не было ни одного теста вовсе.
 */

const runId = Date.now();
// Ночной прогон крона, 00:20 по Душанбе (ровно жалоба владельца) —
// 2026-09-18T00:20 Душанбе = 2026-09-17T19:20Z.
const NOW = new Date("2026-09-17T19:20:00.000Z");
const DAY_MS = 86_400_000;

let districtId: string;
let agentId: string;
const clientIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("x", 10);
  const district = await prisma.district.create({ data: { name: `Тест-застой-${runId}` } });
  districtId = district.id;
  const agent = await prisma.agent.create({
    data: { fullName: "Агент застоя", phone: `+992955${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  if (agentId) await prisma.agent.delete({ where: { id: agentId } }).catch(() => {});
  if (districtId) await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
});

describe("застой сделки — срок задачи агенту", () => {
  it("ставит nextActionDate на 18:00 того же дня по Душанбе, а не на момент крона", async () => {
    // Продавец без объекта старше порога по умолчанию (10 дней, см. FALLBACK).
    const client = await prisma.client.create({
      data: {
        fullName: `Продавец застоя ${runId}`,
        phone: `+992909${runId}`,
        source: "PHONE_CALL",
        kind: "SELLER",
        status: "CONTACTED",
        assignedAgentId: agentId,
        desiredDistrictId: districtId,
        // securityReview остаётся NULL нарочно: до 17.09 такой продавец молча выпадал из выборки
        createdAt: new Date(NOW.getTime() - 15 * DAY_MS),
      },
    });
    clientIds.push(client.id);

    await runDealStalePipeline(NOW);

    const task = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SYSTEM" },
      orderBy: { createdAt: "desc" },
    });
    expect(task).not.toBeNull();
    expect(task?.nextActionDate?.toISOString()).toBe(dushanbeNextOccurrence("18:00", NOW).toISOString());
  });
});
