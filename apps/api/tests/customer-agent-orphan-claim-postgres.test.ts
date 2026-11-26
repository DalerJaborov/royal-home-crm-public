// Prod 26.11.2026: a worker killed mid-turn left a ticket CLAIMED for ever, the
// idle door counted it as in-flight and every revision advance after the next
// deploy failed — the core was silent on all channels. Real PostgreSQL: the
// same idle function the advance trigger and the owner publication call.
// No model calls, no delivery; the staff signal door is observed, not run.
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
import { CLAIM_ORPHANED_REASON, releaseOrphanedCustomerAgentClaims } from "../src/lib/customerAgentOrphanClaims.js";
import { resetCustomerAgentRevisionAlertMemo } from "../src/lib/customerAgentRevisionAlert.js";
import { customerTurnSilenceIsIntended } from "../src/lib/customerIntendedSilence.js";

const tag = `synthetic-orphan-claim-${randomUUID()}`;
const accountId = randomUUID(), resource = `${tag}-resource`, peer = `${tag}-peer`;
const capabilities = { publicRead: true, contactWrite: true, callbackWrite: true, newLeadBridge: true, handoverWrite: false, showingWrite: true, ownerQuestionWrite: true };
const readPolicy = () => prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } });
const tickets: string[] = [], operations: string[] = [];
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
/** A core turn pinned to `revisionId` and CLAIMED by a worker. `receivedAgoMs` places the
 * original receipt in the past; lease and provider deadline end `deadlineMs` after it (like the real pin). */
async function claimedTicket(revisionId: string, receivedAgoMs: number, deadlineMs = 120_000, operation?: { status: string; deadlineShiftMs?: number }) {
  const eventKey = createHash("sha256").update(`${tag}-${randomUUID()}`).digest("hex");
  tickets.push(eventKey);
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
const ticketRow = (eventKey: string) => prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey },
  select: { processingState: true, errorCode: true, leaseOwner: true, leaseUntil: true, claimRevision: true, attempts: true } });
const requiresIdle = async () => (await prisma.$queryRaw<Array<{ v: boolean }>>`SELECT customer_agent_core_requires_idle() AS v`)[0].v;
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
  expect(await requiresIdle()).toBe(false); // the idle door already ignores it (trigger and TS read the same function)
  const before = await readPolicy();
  expect(await autoRefreshCustomerAgentRevision()).toEqual({ status: "refreshed" });
  const after = await readPolicy();
  expect(after.activeAgentRevisionId).toBe(newId);
  expect(after.policyRevision).toBe(before.policyRevision + 1n);
  // Same shape as releaseHeldClaim; claimRevision/attempts untouched: no re-run, no new claim.
  expect(await ticketRow(orphan.eventKey)).toEqual({ processingState: "HELD", errorCode: CLAIM_ORPHANED_REASON,
    leaseOwner: null, leaseUntil: null, claimRevision: 1n, attempts: 1 });
  // The person learns through the one «бот не ответил клиенту» door, exactly once.
  expect(h.report).toHaveBeenCalledTimes(1);
  expect(h.report).toHaveBeenCalledWith(orphan.eventKey, CLAIM_ORPHANED_REASON);
  expect(customerTurnSilenceIsIntended(CLAIM_ORPHANED_REASON)).toBe(false);
  // A second sweep finds nothing: no double signal.
  expect(await releaseOrphanedCustomerAgentClaims()).toEqual([]);
  expect(h.report).toHaveBeenCalledTimes(1);
});

it("a CLAIMED ticket within its deadline still blocks: the TS publication and the DB trigger agree", async () => {
  const oldId = await historical(); const rollout = await install(oldId);
  const live = await claimedTicket(oldId, 30_000); // lease and deadline 90 s ahead
  expect(await requiresIdle()).toBe(true);
  expect(await readCustomerAgentIdleBlockers()).toEqual(["customer_turn"]);
  expect(await triggerVerdict(oldId, rollout.cohortId)).toBe("requires_idle");
  const before = await readPolicy();
  expect(await autoRefreshCustomerAgentRevision()).toEqual({ status: "busy", reason: "core_work_requires_idle_publication" });
  expect(await readPolicy()).toEqual(before);
  expect(await releaseOrphanedCustomerAgentClaims()).toEqual([]);
  expect((await ticketRow(live.eventKey)).processingState).toBe("CLAIMED");
  expect(h.report).not.toHaveBeenCalled();
});

it("inside the five-minute margin after the deadline the claim still counts as in-flight", async () => {
  const oldId = await historical(); const rollout = await install(oldId);
  const recent = await claimedTicket(oldId, 4 * 60_000); // deadline passed 2 min ago, margin is 5
  expect(await requiresIdle()).toBe(true);
  expect(await triggerVerdict(oldId, rollout.cohortId)).toBe("requires_idle");
  expect(await releaseOrphanedCustomerAgentClaims()).toEqual([]);
  expect((await ticketRow(recent.eventKey)).processingState).toBe("CLAIMED");
});

it("an OPEN pinned provider operation with a later deadline keeps the claim (belt and braces)", async () => {
  const oldId = await historical(); const rollout = await install(oldId);
  const held = await claimedTicket(oldId, 60 * 60_000, 120_000, { status: "OPEN", deadlineShiftMs: 2 * 60 * 60_000 });
  expect(await requiresIdle()).toBe(true);
  expect(await triggerVerdict(oldId, rollout.cohortId)).toBe("requires_idle");
  expect(await releaseOrphanedCustomerAgentClaims()).toEqual([]);
  expect((await ticketRow(held.eventKey)).processingState).toBe("CLAIMED");
  // Settled (not OPEN) operation: the orphan is released again.
  await prisma.aiProviderOperation.updateMany({ where: { id: { in: operations } }, data: { status: "HELD" } });
  expect(await triggerVerdict(oldId, rollout.cohortId)).toBe("allowed");
  expect(await releaseOrphanedCustomerAgentClaims()).toEqual([held.eventKey]);
});

it("a ticket already planned is never touched (the answer exists)", async () => {
  const oldId = await historical(); await install(oldId);
  const orphan = await claimedTicket(oldId, 60 * 60_000);
  await prisma.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "processingState"='PLANNED',"plannedAt"=now(),"leaseOwner"=NULL,"leaseUntil"=NULL
    WHERE "eventKey"=${orphan.eventKey}`;
  expect(await releaseOrphanedCustomerAgentClaims()).toEqual([]);
  expect((await ticketRow(orphan.eventKey)).processingState).toBe("PLANNED");
  expect(h.report).not.toHaveBeenCalled();
});
