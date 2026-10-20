import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { claimBatch, isBackgroundJobRunning, runCustomerJobsTick } from "../src/jobs/runner.js";
import { jobHandlerOf } from "../src/jobs/registry.js";

const owned: string[] = [];
let parked: Array<{ id: string; runAt: Date; lockedAt: Date | null }> = [];
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function job(type: string, payload: object, offset = 0) {
  const row = await prisma.backgroundJob.create({ data: { type, payload, maxAttempts: 3,
    runAt: new Date(Date.now() - 3_600_000 + offset), dedupeKey: `synthetic-lane:${randomUUID()}` } });
  owned.push(row.id); return row;
}
beforeEach(async () => {
  // Other files in this shard may leave jobs. Park, then restore exact times;
  // never delete their data or allow an unrelated provider/media side effect.
  parked = await prisma.backgroundJob.findMany({ where: { OR: [
    { status: "PENDING", runAt: { lte: new Date() } },
    { status: "RUNNING", lockedAt: { lt: new Date(Date.now() - 15 * 60_000) } },
  ] }, select: { id: true, runAt: true, lockedAt: true } });
  if (parked.length) await prisma.backgroundJob.updateMany({ where: { id: { in: parked.map(r => r.id) } },
    data: { runAt: new Date("2099-01-01"), lockedAt: new Date("2099-01-01") } });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected provider I/O in queue tests"); }));
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await prisma.backgroundJob.deleteMany({ where: { id: { in: owned.splice(0) } } });
  for (const row of parked) await prisma.backgroundJob.updateMany({ where: { id: row.id }, data: { runAt: row.runAt, lockedAt: row.lockedAt } });
});
afterAll(async () => { await prisma.$disconnect(); });

it("ordinary claims leave both interactive jobs PENDING and preserve their dedupe keys", async () => {
  const inbox = await job("customer-inbox-consume", { version: 1, eventKey: "a".repeat(64) });
  const outbox = await job("customer-outbox-dispatch", { version: 1, partId: randomUUID() });
  const heavy = await job("clip-compress", {});
  expect((await claimBatch()).map(row => row.id)).toEqual([heavy.id]);
  for (const original of [inbox, outbox]) {
    expect(await prisma.backgroundJob.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({
      status: "PENDING", attempts: 0, lockedAt: null, dedupeKey: original.dedupeKey,
    });
  }
});

it("a model turn does not delay another customer's delivery; each lane has one slot", async () => {
  const first = await job("customer-inbox-consume", { version: 1, eventKey: "a".repeat(64) });
  const next = await job("customer-inbox-consume", { version: 1, eventKey: "b".repeat(64) }, 1);
  const output = await job("customer-outbox-dispatch", { version: 1, partId: randomUUID() });
  const entered = barrier(), release = barrier();
  const consume = vi.spyOn(jobHandlerOf("customer-inbox-consume")!, "run").mockImplementation(async () => {
    entered.resolve(); await release.promise;
  });
  const send = vi.spyOn(jobHandlerOf("customer-outbox-dispatch")!, "run").mockResolvedValue(undefined);
  const running = runCustomerJobsTick("inbox");
  try {
    await entered.promise;
    expect(isBackgroundJobRunning()).toBe(true);
    expect(await runCustomerJobsTick("inbox")).toBe(0);
    expect(await runCustomerJobsTick("outbox")).toBe(1);
    expect(send).toHaveBeenCalledTimes(1); expect(consume).toHaveBeenCalledTimes(1);
    expect(await prisma.backgroundJob.findUniqueOrThrow({ where: { id: output.id } })).toMatchObject({ status: "DONE" });
    expect(await prisma.backgroundJob.findUniqueOrThrow({ where: { id: next.id } })).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(await prisma.backgroundJob.count({ where: { id: { in: [first.id, next.id] }, status: "RUNNING" } })).toBe(1);
  } finally { release.resolve(); await running; }
  expect(isBackgroundJobRunning()).toBe(false);
  expect(await prisma.backgroundJob.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: "DONE" });
  expect(fetch).not.toHaveBeenCalled();
});

it("a row locked by media work does not block the exact-type customer claim", async () => {
  const heavy = await job("clip-compress", {});
  const output = await job("customer-outbox-dispatch", { version: 1, partId: randomUUID() });
  vi.spyOn(jobHandlerOf("customer-outbox-dispatch")!, "run").mockResolvedValue(undefined);
  const locked = barrier(), release = barrier();
  const owner = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "BackgroundJob" WHERE id=${heavy.id} FOR UPDATE`;
    locked.resolve(); await release.promise;
  }, { timeout: 10_000 });
  try {
    await locked.promise;
    expect(await runCustomerJobsTick("outbox")).toBe(1);
    expect(await prisma.backgroundJob.findUniqueOrThrow({ where: { id: output.id } })).toMatchObject({ status: "DONE" });
  } finally { release.resolve(); await owner; }
});

it("expired worker claim consumes an attempt; exhausted work does not call the provider", async () => {
  const output = await job("customer-outbox-dispatch", { version: 1, partId: randomUUID() });
  await prisma.backgroundJob.update({ where: { id: output.id }, data: {
    status: "RUNNING", attempts: 2, lockedAt: new Date(Date.now() - 16 * 60_000), lockedBy: "synthetic-dead-worker",
  } });
  const send = vi.spyOn(jobHandlerOf("customer-outbox-dispatch")!, "run").mockResolvedValue(undefined);
  vi.spyOn(jobHandlerOf("customer-outbox-dispatch")!, "onGiveUp").mockResolvedValue(undefined);
  expect(await runCustomerJobsTick("outbox")).toBe(1);
  expect(send).not.toHaveBeenCalled();
  expect(await prisma.backgroundJob.findUniqueOrThrow({ where: { id: output.id } })).toMatchObject({
    status: "GIVEN_UP", attempts: 3, dedupeKey: null,
  });
});
