import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * АУДИТ CODEX 04.10.2026, CHANNEL-NEW-02 (родственные пути): СТАРАЯ ЗАДАЧА НЕ ЗАКРЫВАЕТСЯ
 * РАНЬШЕ, ЧЕМ СОЗДАН ПРЕЕМНИК.
 *
 * buyerThinkingSlowTrack.advanceTier ставил completedAt старой задаче, затем создавал
 * преемника: временный сбой создания оставлял трек без единой незавершённой задачи, и
 * выборка «незавершённые и просроченные» его больше не видела. Тот же порядок в
 * noAnswerStreak.processNoAnswerTailAnchors (маячок гасился до upsertAutoTask).
 */
const failFor = vi.hoisted(() => ({ timelineClientId: "", timelineArmed: false, autoTaskClientId: "", autoTaskArmed: false }));
vi.mock("../src/lib/timeline.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/timeline.js")>();
  return {
    ...orig,
    logTimeline: async (...args: Parameters<typeof orig.logTimeline>) => {
      if (failFor.timelineArmed && args[0].clientId === failFor.timelineClientId) {
        failFor.timelineArmed = false;
        throw new Error("временный отказ создания преемника");
      }
      return orig.logTimeline(...args);
    },
  };
});
vi.mock("../src/lib/autoTasks.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/autoTasks.js")>();
  return {
    ...orig,
    upsertAutoTask: async (...args: Parameters<typeof orig.upsertAutoTask>) => {
      if (failFor.autoTaskArmed && args[0].clientId === failFor.autoTaskClientId) {
        failFor.autoTaskArmed = false;
        throw new Error("временный отказ создания задачи");
      }
      return orig.upsertAutoTask(...args);
    },
  };
});

import { prisma } from "../src/db.js";
import { AUTO_THINKING_MARKER, runBuyerThinkingSlowTrackTick } from "../src/lib/buyerThinkingSlowTrack.js";
import { processNoAnswerTailAnchors } from "../src/lib/noAnswerStreak.js";

const SECOND_TIER_MARKER = "Связаться с клиентом — думает над показом (авто-подстраховка, шаг 2)";
const runId = Date.now();
let agentId = "";
const clientIds: string[] = [];

async function makeClient(kind: "BUYER" | "SELLER") {
  const c = await prisma.client.create({
    data: {
      fullName: `Порядок-задач ${runId}-${clientIds.length}`,
      phone: `+992911${String(runId).slice(-8)}${clientIds.length}`,
      source: "PHONE_CALL",
      kind,
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("x", 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент порядок-задач", phone: `+992957${String(runId).slice(-9)}`, role: "AGENT", passwordHash },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("advanceTier: преемник создаётся вместе с закрытием старой задачи", () => {
  it("сбой создания преемника оставляет старую задачу открытой, следующий тик продвигает трек", async () => {
    const c = await makeClient("BUYER");
    const old = await prisma.interaction.create({
      data: {
        clientId: c.id, agentId, type: "SYSTEM", notes: "тест",
        nextAction: AUTO_THINKING_MARKER, nextActionDate: new Date(Date.now() - 3600_000),
      },
    });
    failFor.timelineClientId = c.id;
    failFor.timelineArmed = true;

    await runBuyerThinkingSlowTrackTick().catch(() => undefined);
    const afterFail = await prisma.interaction.findUnique({ where: { id: old.id } });
    expect(afterFail?.completedAt).toBeNull();
    expect(await prisma.interaction.count({ where: { clientId: c.id, nextAction: SECOND_TIER_MARKER } })).toBe(0);

    await runBuyerThinkingSlowTrackTick();
    const afterOk = await prisma.interaction.findUnique({ where: { id: old.id } });
    expect(afterOk?.completedAt).not.toBeNull();
    expect(await prisma.interaction.count({ where: { clientId: c.id, nextAction: SECOND_TIER_MARKER } })).toBe(1);
  });
});

describe("processNoAnswerTailAnchors: маячок гасится после созданной задачи", () => {
  it("сбой создания задачи оставляет маячок открытым, следующий тик заводит задачу", async () => {
    const c = await makeClient("BUYER");
    const anchor = await prisma.interaction.create({
      data: {
        clientId: c.id, type: "SYSTEM", actorKind: "SYSTEM", subjectAgentId: agentId,
        notes: "noAnswerTail:day2", nextActionDate: new Date(Date.now() - 3600_000),
        createdAt: new Date(Date.now() - 2 * 86_400_000),
      },
    });
    failFor.autoTaskClientId = c.id;
    failFor.autoTaskArmed = true;

    await processNoAnswerTailAnchors().catch(() => undefined);
    const afterFail = await prisma.interaction.findUnique({ where: { id: anchor.id } });
    expect(afterFail?.completedAt).toBeNull();

    await processNoAnswerTailAnchors();
    const afterOk = await prisma.interaction.findUnique({ where: { id: anchor.id } });
    expect(afterOk?.completedAt).not.toBeNull();
    expect(
      await prisma.interaction.count({ where: { clientId: c.id, autoTaskKind: "no_answer_tail_retry", completedAt: null } })
    ).toBe(1);
  });
});
