import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentFreezeSchema } from "@royal-home/shared";
import type { Prisma } from "../src/generated/prisma/client.js";

const effects = vi.hoisted(() => ({
  push: vi.fn(async () => 1),
  batch: vi.fn(async () => 1),
  queue: vi.fn(async () => undefined),
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/push.js")>(),
  sendPushToAgent: effects.push,
  sendPushToAgents: effects.batch,
}));
vi.mock("../src/lib/telephony/operatorQueue.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/telephony/operatorQueue.js")>(),
  syncAgentQueuePresence: effects.queue,
}));

import { prisma } from "../src/db.js";
import { runAbsenceReturnTick } from "../src/lib/absenceReturn.js";
import { waitFor } from "./helpers/waitFor.js";

const NOW = new Date("2030-06-03T04:00:00.000Z");
const START = new Date("2030-05-26T04:00:00.000Z");
const agentIds: string[] = [];
const witnessIds: string[] = [];
const clientIds: string[] = [];
let afterCandidateScan: (() => Promise<unknown>) | undefined;
const noExternalFetch = vi.fn(async () => { throw new Error("No external fetch in absence regression"); });
vi.stubGlobal("fetch", noExternalFetch);

beforeEach(() => {
  effects.push.mockClear();
  effects.batch.mockClear();
  effects.queue.mockClear();
  const findMany = prisma.agent.findMany.bind(prisma.agent);
  vi.spyOn(prisma.agent, "findMany").mockImplementation((args) => {
    // Leave recipient and other agent reads on their ordinary query path.
    if (args?.select?.absenceKind !== true || args?.select?.frozenAt !== true) return findMany(args);
    // A full worker may retain another fixture's due absence. Keep the actual
    // query/predicate, but let this fixture's tick inspect only its own subjects.
    const query = findMany({ ...args, where: { AND: [args.where ?? {}, { id: { in: [...agentIds] } }] } });
    // This candidate query is only awaited by the helper; the scheduling hook
    // wraps its actual result, rather than substituting rows or database writes.
    return query.then(async (due) => {
      const change = afterCandidateScan;
      afterCandidateScan = undefined;
      if (change) await change();
      return due;
    }) as typeof query;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  afterCandidateScan = undefined;
  await prisma.stageEvent.deleteMany({ where: { entityType: "CLIENT", entityId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [...agentIds, ...witnessIds] } } });
  clientIds.length = 0;
  agentIds.length = 0;
  witnessIds.length = 0;
  expect(noExternalFetch).not.toHaveBeenCalled();
});
afterAll(() => vi.unstubAllGlobals());

async function makeAgent(overrides: Partial<Pick<Prisma.AgentCreateInput, "isActive" | "absenceKind" | "absenceUntil">> = {}, candidate = true) {
  const id = randomUUID();
  const agent = await prisma.agent.create({ data: {
    id, fullName: "Synthetic absence-return regression", phone: `test-absence-agent-${id}`,
    passwordHash: "test-unused", role: "AGENT", frozenAt: START, frozenReason: "Synthetic planned absence",
    absenceKind: "VACATION", absenceUntil: NOW, ...overrides,
  } });
  (candidate ? agentIds : witnessIds).push(agent.id);
  return agent;
}

/** The SELECT and state change both execute on PostgreSQL, before the real transaction. */
function changeAfterCandidateScan(change: () => Promise<unknown>) {
  afterCandidateScan = change;
}

it("does not return an employee one millisecond before the deadline", async () => {
  const agent = await makeAgent();
  expect(await runAbsenceReturnTick(new Date(NOW.getTime() - 1))).toEqual({ returned: 0 });
  expect(await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).toEqual(agent);
  expect(effects.push).not.toHaveBeenCalled();
  expect(effects.queue).not.toHaveBeenCalled();
});

it("returns at the exact deadline only once and clears the absence metadata", async () => {
  const agent = await makeAgent();
  expect(await runAbsenceReturnTick(NOW)).toEqual({ returned: 1 });
  expect(await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).toMatchObject({
    isActive: true, frozenAt: null, frozenById: null, frozenReason: null,
    frozenReasonVoiceUrl: null, frozenReasonVoiceTranscript: null, absenceKind: null, absenceUntil: null,
  });
  expect(effects.queue).toHaveBeenCalledExactlyOnceWith(agent.id);
  expect(effects.push).toHaveBeenCalledTimes(1);
  expect(await runAbsenceReturnTick(NOW)).toEqual({ returned: 0 });
});

it("keeps indefinite sickness and an employee already inactive before the scan", async () => {
  const indefinite = await makeAgent({ absenceKind: "SICK", absenceUntil: null });
  const inactive = await makeAgent({ isActive: false });
  expect(await runAbsenceReturnTick(NOW)).toEqual({ returned: 0 });
  expect(await prisma.agent.findUniqueOrThrow({ where: { id: indefinite.id } })).toEqual(indefinite);
  expect(await prisma.agent.findUniqueOrThrow({ where: { id: inactive.id } })).toEqual(inactive);
  expect(effects.push).not.toHaveBeenCalled();
  expect(effects.queue).not.toHaveBeenCalled();
});

it("respects a committed future extension made after candidate selection", async () => {
  const agent = await makeAgent();
  const until = new Date(NOW.getTime() + 86400000);
  changeAfterCandidateScan(() => prisma.agent.update({ where: { id: agent.id }, data: { absenceUntil: until } }));
  expect(await runAbsenceReturnTick(NOW)).toEqual({ returned: 0 });
  expect(await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).toMatchObject({ frozenAt: START, absenceUntil: until });
  expect(effects.push).not.toHaveBeenCalled();
  expect(effects.queue).not.toHaveBeenCalled();
});

it("retains existing deadline/null validation without changing absence policy", () => {
  expect(agentFreezeSchema.parse({ reason: "Synthetic absence", kind: "VACATION", until: NOW.toISOString() }).until).toEqual(NOW);
  expect(agentFreezeSchema.parse({ reason: "Synthetic sickness", kind: "SICK", until: null }).until).toBeNull();
  for (const invalid of [
    { reason: "x", kind: "VACATION", until: NOW.toISOString() },
    { reason: "Synthetic reason", kind: "UNSUPPORTED", until: NOW.toISOString() },
    { reason: "Synthetic reason", kind: "VACATION", until: "not-a-date" },
  ]) expect(agentFreezeSchema.safeParse(invalid).success).toBe(false);
});

it("preserves an employee deactivated after the scan, including client clocks and all return effects", async () => {
  const agent = await makeAgent();
  const unrelatedDue = await makeAgent({}, false);
  const id = randomUUID();
  const inactiveSince = new Date("2030-05-20T04:00:00.000Z");
  const client = await prisma.client.create({ data: {
    id, fullName: "Synthetic absence client clock", phone: `test-absence-client-${id}`, source: "PHONE_CALL",
    kind: "BUYER", assignedAgentId: agent.id, workStatus: "INACTIVE", inactiveSince,
  } });
  clientIds.push(client.id);
  // Drain only the initial event for this owned client before scoped cleanup.
  await waitFor(() => prisma.stageEvent.count({ where: { entityType: "CLIENT", entityId: client.id } }));
  changeAfterCandidateScan(() => prisma.agent.update({ where: { id: agent.id }, data: { isActive: false } }));
  const result = await runAbsenceReturnTick(NOW);
  const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
  const storedClient = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
  expect({
    returned: result.returned, isActive: stored.isActive, frozenAt: stored.frozenAt,
    reason: stored.frozenReason, kind: stored.absenceKind, until: stored.absenceUntil,
    inactiveSince: storedClient.inactiveSince,
  }).toEqual({
    returned: 0, isActive: false, frozenAt: START, reason: agent.frozenReason,
    kind: "VACATION", until: NOW, inactiveSince,
  });
  expect(effects.push).not.toHaveBeenCalled();
  expect(effects.batch).not.toHaveBeenCalled();
  expect(effects.queue).not.toHaveBeenCalled();
  expect(await prisma.agent.findUniqueOrThrow({ where: { id: unrelatedDue.id } })).toEqual(unrelatedDue);
});
