import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { runDealStalePipeline } from "../src/lib/dealStalePipeline.js";
import { dushanbeNextOccurrence } from "../src/lib/dushanbeTime.js";

/**
 * Выключатели «работа с продавцами» (14.11.2026) — подменяются ТОЛЬКО в этом файле:
 * по умолчанию всё включено, как в базе, а выключение не трогает общую строку
 * Settings, которую в тот же момент читают тесты других файлов.
 */
const switchesOff = vi.hoisted(() => new Set<string>());
vi.mock("../src/lib/sellerSwitches.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/sellerSwitches.js")>()),
  sellerSwitchOn: async (key: string) => !switchesOff.has(key),
}));

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

describe("застой сделки — выключатель владельца по продавцам (14.11.2026)", () => {
  it("выключен — продавцов не ищем и задачу не ставим; включили — как раньше", async () => {
    const client = await prisma.client.create({
      data: {
        fullName: `Продавец застоя выкл ${runId}`,
        phone: `+992908${runId}`,
        source: "PHONE_CALL",
        kind: "SELLER",
        status: "CONTACTED",
        assignedAgentId: agentId,
        desiredDistrictId: districtId,
        createdAt: new Date(NOW.getTime() - 15 * DAY_MS),
      },
    });
    clientIds.push(client.id);
    const tasks = () => prisma.interaction.count({ where: { clientId: client.id, type: "SYSTEM" } });

    switchesOff.add("dealStaleSellersEnabled");
    try {
      const summary = await runDealStalePipeline(NOW);
      expect(summary.sellersEscalated).toBe(0);
      expect(await tasks()).toBe(0);
      const row = await prisma.client.findUnique({ where: { id: client.id }, select: { dealStaleEscalatedAt: true } });
      expect(row?.dealStaleEscalatedAt).toBeNull();
    } finally {
      switchesOff.delete("dealStaleSellersEnabled");
    }

    await runDealStalePipeline(NOW);
    expect(await tasks()).toBe(1);
  });
});
