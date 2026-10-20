import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";

/**
 * «💼 НОВЫЙ КАНДИДАТ» РУКОВОДСТВУ НОЧЬЮ — НЕ ПУШЕМ (02.10.2026).
 *
 * Круг vacancies.view — это руководство (MANAGER/ADMIN), а правило владельца:
 * руководству пуш ночью не приходит никогда. notifyCandidateOwners слала пуш
 * напрямую в любой час. Теперь — как notifyHr (lib/interviewInviteCall.ts): в
 * часы алармов очередь руководству, вне их — строка в ленте без пуша.
 *
 * Часы алармов подменены: менять общие Settings на базе, где параллельно идут
 * другие файлы, нельзя.
 */

const { withinHours } = vi.hoisted(() => ({ withinHours: vi.fn() }));
vi.mock("../src/lib/workingHours.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/workingHours.js")>()),
  isWithinAlarmHours: withinHours,
}));
const { pushMany } = vi.hoisted(() => ({ pushMany: vi.fn() }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents: pushMany,
}));

const { notifyCandidateOwners } = await import("../src/lib/clientToCandidate.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = Date.now();
const agentIds: string[] = [];
const tags: string[] = [];

afterEach(() => {
  withinHours.mockReset();
  pushMany.mockReset();
});

afterAll(async () => {
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: tags } } });
  await prisma.notification.deleteMany({ where: { tag: { in: tags } } });
  await deleteAgentsWithTraces(agentIds);
});

async function director(): Promise<string> {
  if (agentIds.length === 0) agentIds.push(await createTestAgent(`Руководство-кандидаты ${runId}`, "DIRECTOR"));
  return agentIds[0];
}

describe("notifyCandidateOwners: руководству ночью без пуша", () => {
  it("вне часов алармов — строка в ленте, пуша нет", async () => {
    const directorId = await director();
    withinHours.mockResolvedValue(false);
    const conversationId = `night-${runId}`;
    tags.push(`candidate-${conversationId}`);

    await notifyCandidateOwners({ name: "Шоира", channel: "WHATSAPP", conversationId, why: "тест" });

    expect(pushMany).not.toHaveBeenCalled();
    const rows = await prisma.notification.findMany({ where: { agentId: directorId, tag: `candidate-${conversationId}` } });
    expect(rows).toHaveLength(1);
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `candidate-${conversationId}` } })).toBe(0);
  });

  it("в часы алармов — одна строка очереди руководству, а не прямой пуш", async () => {
    await director();
    withinHours.mockResolvedValue(true);
    const conversationId = `day-${runId}`;
    tags.push(`candidate-${conversationId}`);

    await notifyCandidateOwners({ name: "Азиза", channel: "INSTAGRAM", conversationId, why: "тест" });

    expect(pushMany).not.toHaveBeenCalled();
    const queued = await prisma.pendingDirectorAlert.findMany({ where: { tag: `candidate-${conversationId}` } });
    expect(queued).toHaveLength(1);
    expect(queued[0].recipientPermission).toBe("vacancies.view");
  });
});
