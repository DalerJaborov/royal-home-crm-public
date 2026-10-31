import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Чистка действий ИИ-помощника (jobs/assistantActionsSweep.ts, П2 задача 2.6).
 * cron.ts сам без тестов — поэтому проверяется вынесенная функция, которую он зовёт.
 */

const logSystemError = vi.fn(async () => undefined);
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));

const { prisma } = await import("../src/db.js");
const { runAssistantActionsSweep, STUCK_CONFIRMED_MS, EXPIRED_RETENTION_MS } = await import(
  "../src/jobs/assistantActionsSweep.js"
);
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");

const runId = String(Date.now()).slice(-8);
const DAY = 24 * 60 * 60_000;
let agentId = "";

async function makeRow(
  label: string,
  data: {
    status: "PENDING" | "CONFIRMED" | "EXECUTED" | "EXPIRED" | "UNDONE" | "CANCELLED";
    expiresAt: Date;
    confirmedAt?: Date;
    executedAt?: Date;
  }
) {
  const live = data.status === "PENDING" || data.status === "CONFIRMED";
  const row = await prisma.assistantAction.create({
    data: {
      agentId,
      tool: `sweep_test_${runId}`,
      args: { label },
      argsHash: label,
      preview: { title: label, was: {}, becomes: {} },
      snapshotBefore: {},
      idempotencyKey: live ? `sweep-${runId}-${label}` : null,
      ...data,
    },
  });
  return row.id;
}

const statusOf = async (id: string) => (await prisma.assistantAction.findUnique({ where: { id } }))?.status ?? "DELETED";

beforeAll(async () => {
  agentId = await createTestAgent(`Чистка помощника ${runId}`);
});

afterAll(async () => {
  await cleanupAssistantActionAgents([agentId]);
  await prisma.$disconnect();
});

describe("Чистка действий помощника", () => {
  it("истекшие PENDING → EXPIRED, зависшие CONFIRMED → FAILED, старые EXPIRED удаляются, след исполненного остаётся", async () => {
    const now = new Date();
    const ids = {
      pendingExpired: await makeRow("pending-expired", { status: "PENDING", expiresAt: new Date(now.getTime() - 1_000) }),
      pendingLive: await makeRow("pending-live", { status: "PENDING", expiresAt: new Date(now.getTime() + 5 * 60_000) }),
      confirmedStuck: await makeRow("confirmed-stuck", {
        status: "CONFIRMED",
        expiresAt: new Date(now.getTime() - 60 * 60_000),
        confirmedAt: new Date(now.getTime() - STUCK_CONFIRMED_MS - 60_000),
      }),
      confirmedFresh: await makeRow("confirmed-fresh", {
        status: "CONFIRMED",
        expiresAt: new Date(now.getTime() + 5 * 60_000),
        confirmedAt: new Date(now.getTime() - 5_000),
      }),
      expiredOld: await makeRow("expired-old", { status: "EXPIRED", expiresAt: new Date(now.getTime() - EXPIRED_RETENTION_MS - DAY) }),
      expiredRecent: await makeRow("expired-recent", { status: "EXPIRED", expiresAt: new Date(now.getTime() - DAY) }),
      executedOld: await makeRow("executed-old", {
        status: "EXECUTED",
        expiresAt: new Date(now.getTime() - 40 * DAY),
        executedAt: new Date(now.getTime() - 40 * DAY),
      }),
      undoneOld: await makeRow("undone-old", { status: "UNDONE", expiresAt: new Date(now.getTime() - 40 * DAY) }),
      cancelledOld: await makeRow("cancelled-old", { status: "CANCELLED", expiresAt: new Date(now.getTime() - 40 * DAY) }),
    };

    const result = await runAssistantActionsSweep(now);
    // Сборщик общий на базу: соседние файлы могли оставить свои строки — проверяем «не меньше».
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(result.stuckFailed).toBeGreaterThanOrEqual(1);
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    expect(await statusOf(ids.pendingExpired)).toBe("EXPIRED");
    expect(await statusOf(ids.pendingLive)).toBe("PENDING");
    expect(await statusOf(ids.confirmedStuck)).toBe("FAILED");
    expect(await statusOf(ids.confirmedFresh)).toBe("CONFIRMED");
    expect(await statusOf(ids.expiredOld)).toBe("DELETED");
    expect(await statusOf(ids.expiredRecent)).toBe("EXPIRED");
    expect(await statusOf(ids.executedOld)).toBe("EXECUTED");
    expect(await statusOf(ids.undoneOld)).toBe("UNDONE");
    expect(await statusOf(ids.cancelledOld)).toBe("CANCELLED");

    const expired = await prisma.assistantAction.findUniqueOrThrow({ where: { id: ids.pendingExpired } });
    expect(expired.idempotencyKey).toBeNull();
    const failed = await prisma.assistantAction.findUniqueOrThrow({ where: { id: ids.confirmedStuck } });
    expect(failed.idempotencyKey).toBeNull();
    expect(failed.statusReason).toMatch(/прервано/);
    expect(logSystemError).toHaveBeenCalledWith("ai", expect.stringContaining("не завершились"));
  });

  it("повторный прогон ничего не меняет", async () => {
    const now = new Date();
    const live = await makeRow("rerun-live", { status: "PENDING", expiresAt: new Date(now.getTime() + 60_000) });
    await runAssistantActionsSweep(now);
    await runAssistantActionsSweep(now);
    expect(await statusOf(live)).toBe("PENDING");
  });
});
