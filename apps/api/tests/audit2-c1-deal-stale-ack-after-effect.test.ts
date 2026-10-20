import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * АУДИТ CODEX 04.10.2026, CHANNEL-NEW-02: ОТМЕТКА «ЭСКАЛИРОВАНО» ТОЛЬКО ПОСЛЕ ЗАДАЧИ.
 *
 * escalateStaleDeal глотал ошибку logTimeline (создание задачи агенту) и всё равно
 * ставил dealStaleEscalatedAt; обе выборки исключают клиента с этой отметкой, так что
 * после временного сбоя задача не создавалась НИКОГДА. Докстринг файла обещал обратное
 * («упадёт — повторим»).
 */
const failFor = vi.hoisted(() => ({ clientId: "" as string, armed: false }));
vi.mock("../src/lib/timeline.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/timeline.js")>();
  return {
    ...orig,
    logTimeline: async (...args: Parameters<typeof orig.logTimeline>) => {
      if (failFor.armed && args[0].clientId === failFor.clientId) {
        failFor.armed = false; // временный сбой: только первый вызов
        throw new Error("временный отказ записи задачи");
      }
      return orig.logTimeline(...args);
    },
  };
});

import { prisma } from "../src/db.js";
import { runDealStalePipeline } from "../src/lib/dealStalePipeline.js";

const runId = Date.now();
const NOW = new Date("2026-09-17T19:20:00.000Z");
const DAY_MS = 86_400_000;
let districtId = "";
let agentId = "";
let clientId = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("x", 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-застой-ack-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент застой-ack", phone: `+992956${String(runId).slice(-9)}`, role: "AGENT", passwordHash },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Продавец застой-ack ${runId}`,
        phone: `+992910${String(runId).slice(-9)}`,
        source: "PHONE_CALL",
        kind: "SELLER",
        status: "CONTACTED",
        assignedAgentId: agentId,
        desiredDistrictId: districtId,
        createdAt: new Date(NOW.getTime() - 15 * DAY_MS),
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("escalateStaleDeal: отметка только после созданной задачи", () => {
  it("временный сбой создания задачи: отметка не ставится, следующий прогон заводит задачу и ставит отметку", async () => {
    failFor.clientId = clientId;
    failFor.armed = true;

    await runDealStalePipeline(NOW);
    const afterFirst = await prisma.client.findUnique({ where: { id: clientId }, select: { dealStaleEscalatedAt: true } });
    expect(afterFirst?.dealStaleEscalatedAt).toBeNull();
    expect(await prisma.interaction.count({ where: { clientId, type: "SYSTEM" } })).toBe(0);

    await runDealStalePipeline(NOW);
    const afterSecond = await prisma.client.findUnique({ where: { id: clientId }, select: { dealStaleEscalatedAt: true } });
    expect(afterSecond?.dealStaleEscalatedAt).not.toBeNull();
    expect(await prisma.interaction.count({ where: { clientId, type: "SYSTEM" } })).toBe(1);
  });
});
