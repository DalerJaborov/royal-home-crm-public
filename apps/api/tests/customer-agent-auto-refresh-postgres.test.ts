// Post-deploy automatic routine refresh (05.11.2026) against real PostgreSQL:
// the same idle triggers, lineage and policy CAS as the owner button. Only the
// historical (pre-deploy) manifest is synthetic. No model calls, no delivery.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { createCustomerAgentMediaProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import * as registration from "../src/lib/customerAgentRegistration.js";
import { customerAgentManifestId, decodeCustomerAgentRevision } from "../src/lib/customerAgentRevision.js";
import { ensureCustomerEndpoint } from "../src/lib/customerConversationScope.js";
import { autoRefreshCustomerAgentRevision, customerAgentAutoRefreshBlocker, resetCustomerAgentAutoRefreshState } from "../src/lib/customerAgentAutoRefresh.js";
import { CUSTOMER_AGENT_AUTO_REFRESH_ACTOR_NAME, publishCustomerAgentAutoRefresh } from "../src/lib/customerAgentOwnerPolicy.js";
import { resetCustomerAgentRevisionAlertMemo } from "../src/lib/customerAgentRevisionAlert.js";

const tag = `synthetic-auto-refresh-${randomUUID()}`;
const accountId = randomUUID(), resource = `${tag}-resource`, peer = `${tag}-peer`;
const capabilities = { publicRead: true, contactWrite: true, callbackWrite: true, newLeadBridge: true, handoverWrite: false, showingWrite: true, ownerQuestionWrite: true };
const readPolicy = () => prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } });
const isolatedParts: string[] = [], isolatedInquiries: string[] = [];
let savedPolicy: Awaited<ReturnType<typeof readPolicy>>;
let scopeId = "", newId = "";
let manifest: Omit<Awaited<ReturnType<typeof registration.registerCurrentCustomerAgentRevision>>, "id">;

async function historical(change: Record<string, unknown> = {}) {
  const previous = { ...manifest, coreHash: createHash("sha256").update(`${tag}-${randomUUID()}`).digest("hex"), ...change };
  const id = customerAgentManifestId(previous);
  await prisma.$executeRaw`INSERT INTO "CustomerAgentRevision" ("id","manifestJson","createdAt") VALUES (${id},${JSON.stringify(previous)}::jsonb,now())`;
  return id;
}
async function install(id: string, mode = "ACTIVE", percent = 5000) {
  const rollout = { version: 1, cohortId: randomUUID(), candidateRevisionId: id, percentBasisPoints: percent,
    allowed: [{ surface: "dm", channel: "INSTAGRAM", endpointScopeId: scopeId }] };
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"='scoped',"rolloutMode"=${mode},"activeAgentRevisionId"=${id},
    "rolloutConfig"=${JSON.stringify(rollout)}::jsonb,"capabilities"=${JSON.stringify(capabilities)}::jsonb WHERE "id"='singleton'`;
  return rollout;
}
async function uncertainPart(revisionId: string) {
  const id = randomUUID(), at = new Date();
  isolatedParts.push(id);
  const inquiry = await prisma.customerInquiry.create({ data: { endpointScopeId: scopeId, peerId: peer, threadId: id } });
  isolatedInquiries.push(inquiry.id);
  const payload = JSON.stringify({ kind: "text", text: "Synthetic in-flight delivery" });
  await prisma.customerOutboxPart.create({ data: { id, inquiryId: inquiry.id, partKey: createHash("sha256").update(id).digest("hex"),
    originalNativeId: randomUUID(), turnKey: id, ordinal: 0, mode: "LIVE", sourceKind: "BOT_TURN", sourceKey: id,
    channel: "INSTAGRAM", endpointScopeId: scopeId, agentRevisionId: revisionId, transportJson: {},
    payloadEncrypted: encryptSecret(payload), payloadHash: createHash("sha256").update(payload).digest("hex"), payloadVersion: 1,
    fenceJson: { endpoint: { peerId: peer } }, receiptRefsJson: [], status: "UNKNOWN", createdAt: at } });
}

beforeAll(async () => {
  savedPolicy = await readPolicy();
  const current = await registration.registerCurrentCustomerAgentRevision(createCustomerAgentMediaProviderSnapshot());
  newId = current.id; const { id: _id, ...rest } = current; manifest = rest;
  await prisma.messengerAccount.create({ data: { id: accountId, channel: "INSTAGRAM", externalId: resource, title: tag, enabled: true,
    token: encryptSecret(tag), appSecret: encryptSecret(`${tag}-secret`) } });
  const scope = await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel: "INSTAGRAM", subscriberId: peer, accountId, accountExternalId: resource }));
  scopeId = scope.endpointScopeId;
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("Auto refresh must not call providers"); }));
});
beforeEach(() => { resetCustomerAgentAutoRefreshState(); resetCustomerAgentRevisionAlertMemo(); });
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  await prisma.customerOutboxPart.deleteMany({ where: { id: { in: isolatedParts } } });
  await prisma.customerInquiry.deleteMany({ where: { id: { in: isolatedInquiries } } });
  await prisma.customerAgentRolloutAssignment.deleteMany({ where: { endpointScopeId: scopeId } });
});
afterAll(async () => {
  try {
    if (savedPolicy) await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"=${savedPolicy.contractVersion},"rolloutMode"=${savedPolicy.rolloutMode},
      "activeAgentRevisionId"=${savedPolicy.activeAgentRevisionId},"rolloutConfig"=${savedPolicy.rolloutConfig === null ? null : JSON.stringify(savedPolicy.rolloutConfig)}::jsonb,"capabilities"=${JSON.stringify(savedPolicy.capabilities)}::jsonb WHERE "id"='singleton'`;
    await prisma.auditLog.deleteMany({ where: { agentName: CUSTOMER_AGENT_AUTO_REFRESH_ACTOR_NAME, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
    await prisma.customerEndpointScope.deleteMany({ where: { id: scopeId } });
    await prisma.messengerAccount.deleteMany({ where: { id: accountId } });
  } finally { vi.unstubAllGlobals(); }
});

it("adopts a code-only release by itself: same share, channels and capabilities, audited as the system", async () => {
  const oldId = await historical(), before = await install(oldId, "ACTIVE", 3700);
  const policyBefore = await readPolicy();
  expect(await autoRefreshCustomerAgentRevision()).toEqual({ status: "refreshed" });
  const after = await readPolicy();
  expect(after.activeAgentRevisionId).toBe(newId);
  expect(after.rolloutMode).toBe("ACTIVE");
  expect(after.policyRevision).toBe(policyBefore.policyRevision + 1n);
  const rollout = after.rolloutConfig as typeof before;
  expect(rollout).toMatchObject({ candidateRevisionId: newId, percentBasisPoints: 3700, allowed: before.allowed });
  expect(rollout.cohortId).not.toBe(before.cohortId);
  expect(after.capabilities).toEqual(capabilities);
  const audit = await prisma.auditLog.findFirst({ where: { action: "CUSTOMER_AGENT_PUBLISH", agentName: CUSTOMER_AGENT_AUTO_REFRESH_ACTOR_NAME }, orderBy: { createdAt: "desc" } });
  expect(audit?.agentId).toBeNull();
  expect(audit?.meta).toMatchObject({ authority: "system_auto_refresh", routineRefresh: true, idleRevisionAdvanced: true, candidate: newId,
    catalogFactsUpgrade: false, mediaProfileUpgrade: false, qualityContinuityUpgradeVersion: null });
  expect(await prisma.customerAgentRevisionAdvance.count({ where: { fromRevisionId: oldId, toRevisionId: newId } })).toBe(1);
  // Second tick is a no-op.
  expect(await autoRefreshCustomerAgentRevision()).toEqual({ status: "current" });
  expect((await readPolicy()).policyRevision).toBe(after.policyRevision);
});

it.each([
  ["promptHash", { promptHash: "a".repeat(64) }],
  ["toolSchemaHash", { toolSchemaHash: "b".repeat(64) }],
  ["knowledgeSchemaHash", { knowledgeSchemaHash: "c".repeat(64) }],
  ["knowledgeSourceHash", { knowledgeSourceHash: "d".repeat(64) }],
  ["providerProfileHash", { providerProfileHash: "e".repeat(64) }],
  ["limits", { limits: { ...({} as Record<string, number>), maxRounds: 1, maxToolCalls: 1, maxInputChars: 1, maxOutputChars: 1, maxModelOutputTokens: 1, deadlineMs: 1 } }],
] as const)("leaves a %s change to the owner: policy untouched", async (field, change) => {
  const oldId = await historical(change as Record<string, unknown>); await install(oldId);
  const before = await readPolicy();
  expect(await autoRefreshCustomerAgentRevision()).toEqual({ status: "manual_required", reason: `${field}_changed` });
  expect(await readPolicy()).toEqual(before);
});

it("waits for idle: unresolved delivery keeps the old revision and the tick retries", async () => {
  const oldId = await historical(); await install(oldId);
  await uncertainPart(oldId);
  const before = await readPolicy();
  expect(await autoRefreshCustomerAgentRevision()).toEqual({ status: "busy", reason: "core_work_requires_idle_publication" });
  expect(await readPolicy()).toEqual(before);
  await prisma.customerOutboxPart.deleteMany({ where: { id: { in: isolatedParts } } });
  expect(await autoRefreshCustomerAgentRevision()).toEqual({ status: "refreshed" });
});

it("never returns to a superseded revision (old container during a rolling deploy)", async () => {
  const later = await historical();
  // History: the installed code was active once and was superseded by `later`.
  const rollout = await install(newId);
  const policy = await readPolicy();
  await prisma.$transaction(async tx => {
    await tx.customerAgentRevisionAdvance.create({ data: { fromRevisionId: newId, fromCohortId: rollout.cohortId, toRevisionId: later,
      toCohortId: randomUUID(), policyRevision: policy.policyRevision + 1n } });
    await tx.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "policyRevision"="policyRevision"+1 WHERE "id"='singleton'`;
  });
  await install(later);
  const before = await readPolicy();
  expect(await autoRefreshCustomerAgentRevision()).toEqual({ status: "manual_required", reason: "target_superseded" });
  expect(await readPolicy()).toEqual(before);
});

it("does nothing while the bot is off", async () => {
  const oldId = await historical(); await install(oldId, "OFF");
  const before = await readPolicy();
  expect(await autoRefreshCustomerAgentRevision()).toEqual({ status: "inactive" });
  expect(await readPolicy()).toEqual(before);
});

it("the system path cannot carry an owner acknowledgement or change the share", async () => {
  const oldId = await historical(); const rollout = await install(oldId, "ACTIVE", 5000);
  const before = await readPolicy();
  const spec = { expectedPolicyRevision: before.policyRevision.toString(), reason: tag, capabilities };
  await expect(publishCustomerAgentAutoRefresh({ ...spec, rollout: { ...rollout, candidateRevisionId: newId, cohortId: randomUUID(), percentBasisPoints: 10000 } }))
    .rejects.toMatchObject({ code: "routine_refresh_configuration_changed" });
  await expect(publishCustomerAgentAutoRefresh({ ...spec, rollout: { ...rollout, candidateRevisionId: newId, cohortId: randomUUID() },
    capabilities: { ...capabilities, handoverWrite: true } })).rejects.toMatchObject({ code: "routine_refresh_configuration_changed" });
  await expect(publishCustomerAgentAutoRefresh({ ...spec, rollout: { ...rollout, candidateRevisionId: newId, cohortId: randomUUID() },
    ...({ confirmCatalogFactsUpgrade: true } as object) } as Parameters<typeof publishCustomerAgentAutoRefresh>[0]))
    .rejects.toMatchObject({ code: "auto_refresh_requires_owner" });
  expect(await readPolicy()).toEqual(before);
});

it("blocker is pure and names the first pinned field", () => {
  const prior = decodeCustomerAgentRevision({ id: customerAgentManifestId(manifest), manifestJson: manifest });
  expect(customerAgentAutoRefreshBlocker(prior, { ...manifest, coreHash: "f".repeat(64), rendererHash: "f".repeat(64), modelSchemaHash: "f".repeat(64) })).toBeNull();
  expect(customerAgentAutoRefreshBlocker(prior, { ...manifest, promptHash: "f".repeat(64) })).toBe("promptHash_changed");
});
