import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { activeLeadCounts, loadLeadLimits, slotsTaken } from "../src/lib/leadLimits.js";
import { MANUAL_THINKING_TASK } from "../src/lib/buyerThinkingSlowTrack.js";

/**
 * ВЗВЕШЕННЫЕ СЛОТЫ ЛИМИТА ЛИДОВ — план владельца 20-21.08.2026 («Логика 2.0»,
 * рубеж «слив»): «взвешенные слоты (свежий 1.0 / после показа 0.5 / думает
 * 0.25) — гейминг становится бессмысленным, а не запрещённым».
 *
 * Проверяем ровно три вещи, на которых держится правило:
 *  1) выключенный рубильник ничего не меняет — weighted равен штучному total
 *     (иначе включение прошло бы «тихо» на всю компанию);
 *  2) три ступени считаются каждая своим весом, а «думает» перекрывает
 *     «после показа», а не складывается с ним;
 *  3) назначенный на будущее и отменённый показы за проведённые НЕ считаются —
 *     то же определение, что у кнопок «Передать» и «Завершить сделку»
 *     (lib/conductedShowing.ts), иначе агент удешевлял бы слот, просто
 *     поставив показ на следующий месяц.
 */

const runId = Date.now();
const WEIGHT_FIELDS = [
  "weightedLeadSlotsEnabled",
  "leadSlotWeightFreshPercent",
  "leadSlotWeightAfterShowingPercent",
  "leadSlotWeightThinkingPercent",
] as const;

let agentId: string;
let saved: Record<string, unknown> = {};
const clientIds: string[] = [];

const HOUR = 3600_000;

async function makeClient(name: string, index: number): Promise<string> {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+99298${index}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      status: "NEW",
    },
  });
  clientIds.push(c.id);
  return c.id;
}

async function setWeights(data: Record<string, unknown>) {
  await prisma.settings.update({ where: { id: "singleton" }, data });
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент взвешенных слотов ${runId}`, phone: `+992937${runId}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;

  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = Object.fromEntries(WEIGHT_FIELDS.map((k) => [k, (current as Record<string, unknown>)[k]]));
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Взвешенные слоты лимита лидов", () => {
  it("рубильник выключен — счёт прежний, штуками", async () => {
    await setWeights({ weightedLeadSlotsEnabled: false });
    await makeClient("Свежий выключено", 1);

    const counts = (await activeLeadCounts([agentId])).get(agentId);
    expect(counts?.total).toBe(1);
    expect(counts?.weighted).toBe(1);

    const limits = await loadLeadLimits();
    expect(limits.weightedSlotsEnabled).toBe(false);
    expect(slotsTaken(counts, limits)).toBe(1);
  });

  it("свежий занимает целое место, после показа половину, «думает» четверть", async () => {
    await setWeights({
      weightedLeadSlotsEnabled: true,
      leadSlotWeightFreshPercent: 100,
      leadSlotWeightAfterShowingPercent: 50,
      leadSlotWeightThinkingPercent: 25,
    });

    const afterShowing = await makeClient("После показа", 2);
    await prisma.interaction.create({
      data: {
        clientId: afterShowing,
        agentId,
        type: "SHOWING",
        notes: "показ состоялся",
        completedAt: new Date(),
      },
    });

    const thinking = await makeClient("Думает", 3);
    await prisma.interaction.create({
      data: { clientId: thinking, agentId, type: "SHOWING", notes: "показ состоялся", completedAt: new Date() },
    });
    await prisma.interaction.create({
      data: {
        clientId: thinking,
        agentId,
        type: "MEETING",
        notes: "итог показа: думает",
        nextAction: MANUAL_THINKING_TASK,
        nextActionDate: new Date(Date.now() + 24 * HOUR),
      },
    });

    // Свежий из первого теста (1.0) + после показа (0.5) + думает (0.25) = 1.75
    // при трёх карточках штуками.
    const counts = (await activeLeadCounts([agentId])).get(agentId);
    expect(counts?.total).toBe(3);
    expect(counts?.weighted).toBeCloseTo(1.75, 5);

    const limits = await loadLeadLimits();
    expect(limits.weightedSlotsEnabled).toBe(true);
    expect(slotsTaken(counts, limits)).toBeCloseTo(1.75, 5);
  });

  it("«думает» перекрывает «после показа», а не складывается с ним", async () => {
    // У «думающего» клиента показ ЕСТЬ (иначе ветки «Итог показа» не было бы
    // вовсе), и если бы веса складывались, он занимал бы 0.75 места вместо
    // 0.25 — то есть больше, чем клиент сразу после показа. Проверка выше это
    // уже ловит суммой, здесь называем причину отдельным весом: делаем
    // «думающего» дороже свежего и убеждаемся, что берётся именно его вес.
    await setWeights({ leadSlotWeightThinkingPercent: 200 });
    const counts = (await activeLeadCounts([agentId])).get(agentId);
    // 1.0 (свежий) + 0.5 (после показа) + 2.0 (думает) = 3.5
    expect(counts?.weighted).toBeCloseTo(3.5, 5);
    await setWeights({ leadSlotWeightThinkingPercent: 25 });
  });

  it("показ на будущее и отменённый показ клиента не удешевляют", async () => {
    const scheduled = await makeClient("Показ назначен на будущее", 4);
    await prisma.interaction.create({
      data: {
        clientId: scheduled,
        agentId,
        type: "SHOWING",
        notes: "показ назначен",
        nextAction: "Показ объекта",
        nextActionDate: new Date(Date.now() + 72 * HOUR),
      },
    });

    const cancelled = await makeClient("Показ отменён", 5);
    await prisma.interaction.create({
      data: {
        clientId: cancelled,
        agentId,
        type: "SHOWING",
        notes: "показ отменён",
        declinedAt: new Date(),
        completedAt: new Date(),
      },
    });

    // Оба новых клиента — «свежие» по 1.0: 1.75 + 1 + 1 = 3.75.
    const counts = (await activeLeadCounts([agentId])).get(agentId);
    expect(counts?.total).toBe(5);
    expect(counts?.weighted).toBeCloseTo(3.75, 5);
  });

  it("отрицательный вес не переворачивает лимит — считается нулём", async () => {
    // Иначе чем больше у агента клиентов, тем свободнее он выглядит, и лимит
    // перестаёт быть лимитом вовсе.
    await setWeights({ leadSlotWeightFreshPercent: -500 });
    const counts = (await activeLeadCounts([agentId])).get(agentId);
    // Три свежих по 0 + после показа 0.5 + думает 0.25 = 0.75.
    expect(counts?.weighted).toBeCloseTo(0.75, 5);
    await setWeights({ leadSlotWeightFreshPercent: 100 });
  });
});
