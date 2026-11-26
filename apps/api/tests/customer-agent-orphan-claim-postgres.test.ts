// Prod 26.11.2026: a worker killed mid-turn left a ticket CLAIMED for ever, the
// idle door counted it as in-flight and every revision advance after the next
// deploy failed — the core was silent on all channels. The same class exists for
// a RECEIVED ticket whose inbox job is gone. Real PostgreSQL: the same SQL
// function the advance trigger, the owner publication and the sweep call.
// No model calls, no delivery; the staff signal door is observed, not run.
// Assertions are scoped to this file's own rows: other files may leave theirs.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ report: vi.fn(async (..._args: unknown[]) => {}) }));
vi.mock("../src/lib/customerTurnSilence.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/customerTurnSilence.js")>()), reportUnansweredCustomerTurn: h.report }));

import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { createCustomerAgentMediaProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import * as registration from "../src/lib/customerAgentRegistration.js";
import { customerAgentManifestId } from "../src/lib/customerAgentRevision.js";
import { ensureCustomerEndpoint } from "../src/lib/customerConversationScope.js";
import { autoRefreshCustomerAgentRevision, readCustomerAgentIdleBlockers, resetCustomerAgentAutoRefreshState } from "../src/lib/customerAgentAutoRefresh.js";
import { CLAIM_ORPHANED_REASON, RECEIVED_ORPHANED_REASON, releaseOrphanedCustomerAgentClaims } from "../src/lib/customerAgentOrphanClaims.js";
import { resetCustomerAgentRevisionAlertMemo } from "../src/lib/customerAgentRevisionAlert.js";
import { customerTurnSilenceIsIntended } from "../src/lib/customerIntendedSilence.js";
import { consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";
import { customerInboxConsumeJob } from "../src/jobs/customerInboxConsume.js";

const tag = `synthetic-orphan-claim-${randomUUID()}`;
const accountId = randomUUID(), resource = `${tag}-resource`, peer = `${tag}-peer`;
const capabilities = { publicRead: true, contactWrite: true, callbackWrite: true, newLeadBridge: true, handoverWrite: false, showingWrite: true, ownerQuestionWrite: true };
const readPolicy = () => prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } });
const tickets: string[] = [], operations: string[] = [], jobs: string[] = [];
let savedPolicy: Awaited<ReturnType<typeof readPolicy>>;
let scopeId = "", newId = "";
let manifest: Omit<Awaited<ReturnType<typeof registration.registerCurrentCustomerAgentRevision>>, "id">;

async function historical() {
  const previous = { ...manifest, coreHash: createHash("sha256").update(`${tag}-${randomUUID()}`).digest("hex") };
  const id = customerAgentManifestId(previous);
  await prisma.$executeRaw`INSERT INTO "CustomerAgentRevision" ("id","manifestJson","createdAt") VALUES (${id},${JSON.stringify(previous)}::jsonb,now())`;
  return id;
}
async function install(id: string) {
  const rollout = { version: 1, cohortId: randomUUID(), candidateRevisionId: id, percentBasisPoints: 5000,
    allowed: [{ surface: "dm", channel: "INSTAGRAM", endpointScopeId: scopeId }] };
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"='scoped',"rolloutMode"='ACTIVE',"activeAgentRevisionId"=${id},
    "rolloutConfig"=${JSON.stringify(rollout)}::jsonb,"capabilities"=${JSON.stringify(capabilities)}::jsonb WHERE "id"='singleton'`;
  return rollout;
}
const newEventKey = () => { const k = createHash("sha256").update(`${tag}-${randomUUID()}`).digest("hex"); tickets.push(k); return k; };
/** A core turn pinned to `revisionId` and CLAIMED by a worker. `receivedAgoMs` places the
 * original receipt in the past; lease and provider deadline end `deadlineMs` after it (like the real pin). */
async function claimedTicket(revisionId: string, receivedAgoMs: number, deadlineMs = 120_000, operation?: { status: string; deadlineShiftMs?: number }) {
  const eventKey = newEventKey();
  const receivedAt = new Date(Date.now() - receivedAgoMs), deadline = new Date(receivedAt.getTime() + deadlineMs);
  const operationId = randomUUID(), owner = randomUUID();
  await prisma.$executeRaw`INSERT INTO "CustomerPropertyIngressTicket" ("eventKey","scopeKey","endpointScopeId","payloadVersion","payloadCiphertext",
    "payloadHash","receivedAt","originVersion","originCiphertext","originCapturedAt","inputRecordedAt","processingState","claimRevision","leaseOwner",
    "leaseUntil","attempts","intakeAgentRevisionId","agentRevisionId","providerOperationId","providerDeadlineAt","createdAt")
    VALUES (${eventKey},${`${tag}-scope`},${scopeId},1,${"synthetic"},${"a".repeat(64)},${receivedAt},1,${"synthetic"},${receivedAt},${receivedAt},
      'CLAIMED',1,${owner},${deadline},1,${revisionId},${revisionId},${operationId},${deadline},${receivedAt})`;
  if (operation) {
    operations.push(operationId);
    await prisma.aiProviderOperation.create({ data: { id: operationId, policyKey: `${tag}-policy`, policyHash: "e".repeat(64), dayKey: "2026-11-26",
      deadlineAt: new Date(deadline.getTime() + (operation.deadlineShiftMs ?? 0)), maxAttempts: 1, reservedUsd: "0", status: operation.status } });
  }
  return { eventKey, owner };
}
/** An admitted, never-pinned turn still RECEIVED, optionally with its inbox job. */
async function receivedTicket(revisionId: string, receivedAgoMs: number, job?: { status: "PENDING" | "RUNNING" | "GIVEN_UP"; lockedAgoMs?: number }) {
  const eventKey = newEventKey(), receivedAt = new Date(Date.now() - receivedAgoMs);
  await prisma.$executeRaw`INSERT INTO "CustomerPropertyIngressTicket" ("eventKey","scopeKey","endpointScopeId","payloadVersion","payloadCiphertext",
    "payloadHash","receivedAt","originVersion","originCiphertext","originCapturedAt","inputRecordedAt","processingState","intakeAgentRevisionId","createdAt")
    VALUES (${eventKey},${`${tag}-scope`},${scopeId},1,${"synthetic"},${"a".repeat(64)},${receivedAt},1,${"synthetic"},${receivedAt},${receivedAt},
      'RECEIVED',${revisionId},${receivedAt})`;
  if (job) {
    const row = await prisma.backgroundJob.create({ data: { type: "customer-inbox-consume", payload: { version: 1, eventKey }, maxAttempts: 5,
      dedupeKey: `${tag}-job-${eventKey}`, status: job.status, lockedAt: job.lockedAgoMs === undefined ? null : new Date(Date.now() - job.lockedAgoMs) } });
    jobs.push(row.id);
  }
  return { eventKey };
}
const ticketRow = (eventKey: string) => prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey },
  select: { processingState: true, errorCode: true, leaseOwner: true, leaseUntil: true, claimRevision: true, attempts: true } });
/** The one SQL predicate, for THIS row only (immune to other files' rows). */
const orphaned = async (eventKey: string) => (await prisma.$queryRaw<Array<{ v: boolean }>>`SELECT customer_agent_ticket_orphaned(t."eventKey",
  t."processingState",t."receivedAt",t."leaseUntil",t."providerDeadlineAt",t."providerOperationId") AS v FROM "CustomerPropertyIngressTicket" t
  WHERE t."eventKey"=${eventKey}`)[0].v;
/** Sweep result restricted to this file's rows. */
const sweepOwn = async () => (await releaseOrphanedCustomerAgentClaims()).filter(t => tickets.includes(t.eventKey));
const ownReports = () => h.report.mock.calls.filter(call => tickets.includes(String(call[0])));
/** The DB trigger on its own: a context-correct advance edge, rolled back whatever happens. */
async function triggerVerdict(fromId: string, fromCohort: string): Promise<"allowed" | "requires_idle" | string> {
  const policy = await readPolicy();
  try {
    await prisma.$transaction(async tx => {
      await tx.customerAgentRevisionAdvance.create({ data: { fromRevisionId: fromId, fromCohortId: fromCohort, toRevisionId: newId,
        toCohortId: randomUUID(), policyRevision: policy.policyRevision + 1n } });
      throw new Error("rollback-probe");
    });
    return "unreachable";
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return text.includes("rollback-probe") ? "allowed" : text.includes("requires idle") ? "requires_idle" : text;
  }
}

beforeAll(async () => {
  savedPolicy = await readPolicy();
  const current = await registration.registerCurrentCustomerAgentRevision(createCustomerAgentMediaProviderSnapshot());
  newId = current.id; const { id: _id, ...rest } = current; manifest = rest;
  await prisma.messengerAccount.create({ data: { id: accountId, channel: "INSTAGRAM", externalId: resource, title: tag, enabled: true,
    token: encryptSecret(tag), appSecret: encryptSecret(`${tag}-secret`) } });
  const scope = await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel: "INSTAGRAM", subscriberId: peer, accountId, accountExternalId: resource }));
  scopeId = scope.endpointScopeId;
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("Orphan recovery must not call providers"); }));
});
beforeEach(() => { h.report.mockClear(); resetCustomerAgentAutoRefreshState(); resetCustomerAgentRevisionAlertMemo(); });
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  await prisma.backgroundJob.deleteMany({ where: { id: { in: jobs } } });
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: tickets } } });
  await prisma.aiProviderOperation.deleteMany({ where: { id: { in: operations } } });
  await prisma.customerAgentRolloutAssignment.deleteMany({ where: { endpointScopeId: scopeId } });
});
afterAll(async () => {
  try {
    if (savedPolicy) await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"=${savedPolicy.contractVersion},"rolloutMode"=${savedPolicy.rolloutMode},
      "activeAgentRevisionId"=${savedPolicy.activeAgentRevisionId},"rolloutConfig"=${savedPolicy.rolloutConfig === null ? null : JSON.stringify(savedPolicy.rolloutConfig)}::jsonb,"capabilities"=${JSON.stringify(savedPolicy.capabilities)}::jsonb WHERE "id"='singleton'`;
    await prisma.customerEndpointScope.deleteMany({ where: { id: scopeId } });
    await prisma.messengerAccount.deleteMany({ where: { id: accountId } });
  } finally { vi.unstubAllGlobals(); }
});

it("an orphaned CLAIMED ticket past lease and deadline is released to HELD and the advance proceeds", async () => {
  const oldId = await historical(); await install(oldId);
  // The prod shape: received 4 h ago, lease = provider deadline = receipt + 2 min, the worker died.
  const orphan = await claimedTicket(oldId, 4 * 60 * 60_000);
  expect(await orphaned(orphan.eventKey)).toBe(true);
  const before = await readPolicy();
  expect(await autoRefreshCustomerAgentRevision()).toEqual({ status: "refreshed" });
  const after = await readPolicy();
  expect(after.activeAgentRevisionId).toBe(newId);
  expect(after.policyRevision).toBe(before.policyRevision + 1n);
  // Same shape as releaseHeldClaim; claimRevision/attempts untouched: no re-run, no new claim.
  expect(await ticketRow(orphan.eventKey)).toEqual({ processingState: "HELD", errorCode: CLAIM_ORPHANED_REASON,
    leaseOwner: null, leaseUntil: null, claimRevision: 1n, attempts: 1 });
  // The person learns through the one «бот не ответил клиенту» door, exactly once (in the background).
  await vi.waitFor(() => expect(ownReports()).toEqual([[orphan.eventKey, CLAIM_ORPHANED_REASON]]));
  expect(customerTurnSilenceIsIntended(CLAIM_ORPHANED_REASON)).toBe(false);
  expect(await sweepOwn()).toEqual([]);
  expect(ownReports()).toHaveLength(1);
});

it("a stale queue job re-running a released ticket neither overwrites the code nor reports again", async () => {
  const oldId = await historical(); await install(oldId);
  const orphan = await claimedTicket(oldId, 60 * 60_000);
  expect(await sweepOwn()).toEqual([{ eventKey: orphan.eventKey, reason: CLAIM_ORPHANED_REASON }]);
  await vi.waitFor(() => expect(ownReports()).toHaveLength(1));
  // The RUNNING lock of the killed worker is reclaimed after 15 min and the job runs again.
  expect(await consumeCustomerInboxTicket(orphan.eventKey)).toEqual({ status: "held", reason: CLAIM_ORPHANED_REASON });
  expect((await ticketRow(orphan.eventKey)).errorCode).toBe(CLAIM_ORPHANED_REASON);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(ownReports()).toHaveLength(1);
});

it("a CLAIMED ticket within its deadline still blocks: the TS publication and the DB trigger agree", async () => {
  const oldId = await historical(); const rollout = await install(oldId);
  const live = await claimedTicket(oldId, 30_000); // lease and deadline 90 s ahead
  expect(await orphaned(live.eventKey)).toBe(false);
  expect(await readCustomerAgentIdleBlockers()).toContain("customer_turn");
  expect(await triggerVerdict(oldId, rollout.cohortId)).toBe("requires_idle");
  const before = await readPolicy();
  expect(await autoRefreshCustomerAgentRevision()).toEqual({ status: "busy", reason: "core_work_requires_idle_publication" });
  expect(await readPolicy()).toEqual(before);
  expect(await sweepOwn()).toEqual([]);
  expect((await ticketRow(live.eventKey)).processingState).toBe("CLAIMED");
  expect(ownReports()).toEqual([]);
});

it("inside the five-minute margin after the deadline the claim still counts as in-flight", async () => {
  const oldId = await historical(); const rollout = await install(oldId);
  const recent = await claimedTicket(oldId, 4 * 60_000); // deadline passed 2 min ago, margin is 5
  expect(await orphaned(recent.eventKey)).toBe(false);
  expect(await triggerVerdict(oldId, rollout.cohortId)).toBe("requires_idle");
  expect(await sweepOwn()).toEqual([]);
  expect((await ticketRow(recent.eventKey)).processingState).toBe("CLAIMED");
});

it("an OPEN pinned provider operation with a later deadline keeps the claim (belt and braces)", async () => {
  const oldId = await historical(); const rollout = await install(oldId);
  const held = await claimedTicket(oldId, 60 * 60_000, 120_000, { status: "OPEN", deadlineShiftMs: 2 * 60 * 60_000 });
  expect(await orphaned(held.eventKey)).toBe(false);
  expect(await triggerVerdict(oldId, rollout.cohortId)).toBe("requires_idle");
  expect(await sweepOwn()).toEqual([]);
  expect((await ticketRow(held.eventKey)).processingState).toBe("CLAIMED");
  // Settled (not OPEN) operation: the orphan is released again.
  await prisma.aiProviderOperation.updateMany({ where: { id: { in: operations } }, data: { status: "HELD" } });
  expect(await orphaned(held.eventKey)).toBe(true);
  expect(await sweepOwn()).toEqual([{ eventKey: held.eventKey, reason: CLAIM_ORPHANED_REASON }]);
});

it("a RECEIVED ticket past its pin window with no live inbox job is released (the trigger reads the same predicate)", async () => {
  const oldId = await historical(); await install(oldId);
  const lost = await receivedTicket(oldId, 30 * 60_000);                                         // job gone entirely
  const gaveUp = await receivedTicket(oldId, 30 * 60_000, { status: "GIVEN_UP" });               // finished job: not live
  const stuck = await receivedTicket(oldId, 30 * 60_000, { status: "RUNNING", lockedAgoMs: 20 * 60_000 }); // runner reclaims it
  for (const t of [lost, gaveUp, stuck]) expect(await orphaned(t.eventKey)).toBe(true);
  const released = await sweepOwn();
  expect(released.map(t => t.eventKey).sort()).toEqual([lost.eventKey, gaveUp.eventKey, stuck.eventKey].sort());
  expect(released.every(t => t.reason === RECEIVED_ORPHANED_REASON)).toBe(true);
  expect(await ticketRow(lost.eventKey)).toMatchObject({ processingState: "HELD", errorCode: RECEIVED_ORPHANED_REASON, claimRevision: 0n });
  await vi.waitFor(() => expect(ownReports()).toHaveLength(3));
  expect(customerTurnSilenceIsIntended(RECEIVED_ORPHANED_REASON)).toBe(false);
});

it("a RECEIVED ticket inside its window, or with a live inbox job, still blocks in the trigger", async () => {
  const oldId = await historical(); const rollout = await install(oldId);
  const fresh = await receivedTicket(oldId, 60_000);
  const pending = await receivedTicket(oldId, 30 * 60_000, { status: "PENDING" });
  const running = await receivedTicket(oldId, 30 * 60_000, { status: "RUNNING", lockedAgoMs: 60_000 });
  for (const t of [fresh, pending, running]) expect(await orphaned(t.eventKey)).toBe(false);
  expect(await triggerVerdict(oldId, rollout.cohortId)).toBe("requires_idle");
  expect(await sweepOwn()).toEqual([]);
  // Only the pending one left (others removed): still blocks — the trigger and the predicate agree row by row.
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: [fresh.eventKey, running.eventKey] } } });
  expect(await triggerVerdict(oldId, rollout.cohortId)).toBe("requires_idle");
});

it("a queue job that gives up moves its RECEIVED ticket to HELD itself: the sweep does not report it twice", async () => {
  const oldId = await historical(); await install(oldId);
  const t = await receivedTicket(oldId, 30 * 60_000, { status: "GIVEN_UP" });
  await customerInboxConsumeJob.onGiveUp({ version: 1, eventKey: t.eventKey });
  expect(await ticketRow(t.eventKey)).toMatchObject({ processingState: "HELD", errorCode: "consume_job_gave_up" });
  expect(await orphaned(t.eventKey)).toBe(false);
  expect(await sweepOwn()).toEqual([]);
  await vi.waitFor(() => expect(ownReports()).toEqual([[t.eventKey, "consume_job_gave_up", { gaveUp: true }]]));
});

it("a ticket already planned is never touched (the answer exists)", async () => {
  const oldId = await historical(); await install(oldId);
  const orphan = await claimedTicket(oldId, 60 * 60_000);
  await prisma.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "processingState"='PLANNED',"plannedAt"=now(),"leaseOwner"=NULL,"leaseUntil"=NULL
    WHERE "eventKey"=${orphan.eventKey}`;
  expect(await orphaned(orphan.eventKey)).toBe(false);
  expect(await sweepOwn()).toEqual([]);
  expect((await ticketRow(orphan.eventKey)).processingState).toBe("PLANNED");
  expect(ownReports()).toEqual([]);
});
