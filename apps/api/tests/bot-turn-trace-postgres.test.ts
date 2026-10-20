import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { BotTurnTracePayload } from "@royal-home/shared";
// Explicit narrow run supplies DATABASE_URL before import; don't load local keys.
vi.mock("../src/loadEnv.js", () => ({}));
import { prisma } from "../src/db.js";
import { withBotTurnTrace } from "../src/lib/botTurnTrace.js";
import { cleanupBotTurnTraces, writeBotTurnTrace } from "../src/lib/botTurnTraceStore.js";
import { parseTraceExportArgs, readTraceExport } from "../src/lib/botTurnTraceExport.js";

const createdIds: string[] = [];
async function payload(createdAt = new Date()): Promise<BotTurnTracePayload> {
  const rows: BotTurnTracePayload[] = [];
  await withBotTurnTrace({ channel: "WEBSITE", source: "website" }, async () => {}, { enabled: true, secret: "fictional-db-trace-key-only-for-tests-0000", text: false, write: (row) => { rows.push(row); } });
  const result = { ...rows[0], traceId: randomUUID(), createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + 7 * 86400000).toISOString(), checkpointSeq: 0, completedAt: null };
  createdIds.push(result.traceId); return result;
}
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  const expected = process.env.BOT_TRACE_TEST_DATABASE;
  if (expected) {
    expect(url.hostname).toBe("localhost"); expect(url.port).toBe("15500"); expect(url.pathname).toBe(`/${expected}`);
  }
  const [current] = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  expect(current.name).toBe(url.pathname.slice(1));
});
afterEach(async () => { await prisma.botTurnTrace.deleteMany({ where: { id: { in: createdIds.splice(0) } } }); });
afterAll(async () => { await prisma.$disconnect(); });

describe("real PostgreSQL turn trace fences and bounded export", () => {
  it("lower/equal sequences cannot replace the latest checkpoint; account binding persists", async () => {
    const first = await payload(); await writeBotTurnTrace({ ...first, checkpointSeq: 2 });
    await writeBotTurnTrace({ ...first, checkpointSeq: 4, accountKey: "a".repeat(64), conversationKey: "b".repeat(64) });
    await writeBotTurnTrace({ ...first, checkpointSeq: 3, outcome: "failed" });
    await writeBotTurnTrace({ ...first, checkpointSeq: 4, outcome: "failed" });
    const stored = await prisma.botTurnTrace.findUniqueOrThrow({ where: { id: first.traceId } });
    expect(stored.checkpointSeq).toBe(4); expect(stored.outcome).toBe("incomplete");
    expect(stored.accountKey).toBe("a".repeat(64)); expect(stored.conversationKey).toBe("b".repeat(64));
    expect(stored.expiresAt.toISOString()).toBe(first.expiresAt);
  });
  it("concurrent differently ordered checkpoints finish at the maximum sequence", async () => {
    const first = await payload(); await writeBotTurnTrace(first);
    await Promise.all([7, 2, 9, 4, 10, 1, 8, 3, 6, 5].map((checkpointSeq) => writeBotTurnTrace({ ...first, checkpointSeq })));
    const stored = await prisma.botTurnTrace.findUniqueOrThrow({ where: { id: first.traceId } });
    expect(stored.checkpointSeq).toBe(10); expect((stored.payload as BotTurnTracePayload).checkpointSeq).toBe(10);
  });
  it("a concurrent terminal checkpoint survives all older writes and later higher reopening attempts", async () => {
    const first = await payload(); const completedAt = new Date().toISOString(); await writeBotTurnTrace(first);
    await Promise.all([3, 1, 4, 7, 2, 10, 5, 9, 8, 6].map((checkpointSeq) => writeBotTurnTrace({ ...first, checkpointSeq, ...(checkpointSeq === 10 ? { completedAt, outcome: "completed" as const } : {}) })));
    await Promise.all([11, 20, 100].map((checkpointSeq) => writeBotTurnTrace({ ...first, checkpointSeq, outcome: "failed" })));
    const stored = await prisma.botTurnTrace.findUniqueOrThrow({ where: { id: first.traceId } });
    expect(stored.checkpointSeq).toBe(10); expect(stored.completedAt?.toISOString()).toBe(completedAt); expect(stored.outcome).toBe("completed");
    expect((stored.payload as BotTurnTracePayload).completedAt).toBe(completedAt);
  });
  it("actual expiry cleanup removes only this test's expired/boundary fixtures", async () => {
    // A past clock avoids touching current application diagnostics. Refuse to
    // delete if an unrelated pre-existing row would fall under this cutoff.
    const now = new Date("1970-01-10T12:00:00.000Z");
    expect(await prisma.botTurnTrace.count({ where: { expiresAt: { lte: now } } })).toBe(0);
    const fixtures = await Promise.all([-1, 0, 1].map((offset) => payload(new Date(now.getTime() - 7 * 86400000 + offset))));
    for (const fixture of fixtures) await writeBotTurnTrace(fixture);
    expect(await cleanupBotTurnTraces(now)).toBe(2);
    expect(await prisma.botTurnTrace.findMany({ where: { id: { in: fixtures.map((row) => row.traceId) } }, select: { id: true } })).toEqual([{ id: fixtures[2].traceId }]);
  });
  it("export enforces expiry/version/range/limit and omits malformed stored payloads", async () => {
    const now = new Date("2031-01-10T12:00:00.000Z");
    const expired = await payload(new Date("2031-01-03T10:00:00.000Z"));
    const active1 = await payload(new Date("2031-01-04T10:00:00.000Z"));
    const active2 = await payload(new Date("2031-01-05T10:00:00.000Z"));
    const malformed = await payload(new Date("2031-01-06T10:00:00.000Z"));
    const nextVersion = await payload(new Date("2031-01-07T10:00:00.000Z"));
    const outside = await payload(new Date("2031-01-11T10:00:00.000Z"));
    for (const fixture of [expired, active1, active2, malformed, nextVersion, outside]) await writeBotTurnTrace(fixture);
    await prisma.botTurnTrace.update({ where: { id: malformed.traceId }, data: { payload: { rawPrivatePayload: "FAKE_MUST_NOT_EXPORT" } } });
    await prisma.botTurnTrace.update({ where: { id: nextVersion.traceId }, data: { schemaVersion: 2 } });
    const options = parseTraceExportArgs(["--from=2031-01-03T00:00:00Z", "--to=2031-01-10T00:00:00Z", "--limit=20"]);
    const result = await readTraceExport(prisma.botTurnTrace, options, now);
    expect(result.payloads.map((row) => row.traceId)).toEqual([active1.traceId, active2.traceId]); expect(result.omitted).toBe(1);
    expect(JSON.stringify(result)).not.toContain("FAKE_MUST_NOT_EXPORT");
    const bounded = await readTraceExport(prisma.botTurnTrace, { ...options, limit: 1 }, now);
    expect(bounded.payloads.map((row) => row.traceId)).toEqual([active1.traceId]);
  });
});
