// Production compiled modules are intentional: source-ts manifests differ from
// release-js manifests. Only historical A/B database state is synthetic; owner
// HTTP, current C verification, SQL guards, lineage and transaction rollback are real.
import { createHash, createHmac, randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { app } = await import("../dist/app.js") as typeof import("../src/app.js");
const { prisma } = await import("../dist/db.js") as typeof import("../src/db.js");
const { Prisma } = await import("../dist/generated/prisma/client.js") as typeof import("../src/generated/prisma/client.js");
const registration = await import("../dist/lib/customerAgentRegistration.js") as typeof import("../src/lib/customerAgentRegistration.js");
const recovery = await import("../dist/lib/customerAgentQualityRecovery.js") as typeof import("../src/lib/customerAgentQualityRecovery.js");
const { customerAgentManifestId } = await import("../dist/lib/customerAgentRevision.js") as typeof import("../src/lib/customerAgentRevision.js");
const { createCustomerAgentMediaProviderSnapshot } = await import("../dist/ai/customerAgentProviderConfig.js") as typeof import("../src/ai/customerAgentProviderConfig.js");
const { ensureCustomerEndpoint } = await import("../dist/lib/customerConversationScope.js") as typeof import("../src/lib/customerConversationScope.js");
const { enrollCustomerAgentSubjectTx } = await import("../dist/lib/customerAgentEnrollment.js") as typeof import("../src/lib/customerAgentEnrollment.js");
const { customerAgentRevisionReachable } = await import("../dist/lib/customerAgentRevisionAdvance.js") as typeof import("../src/lib/customerAgentRevisionAdvance.js");
const { registerAuthenticatedMetaCustomerRequest } = await import("../dist/lib/customerIngressAuthority.js") as typeof import("../src/lib/customerIngressAuthority.js");
const { persistVerifiedCustomerIngressBatch, consumeCustomerInboxTicket } = await import("../dist/lib/customerIngressProducer.js") as typeof import("../src/lib/customerIngressProducer.js");
const { signAccessToken } = await import("../dist/auth/jwt.js") as typeof import("../src/auth/jwt.js");
const { invalidateAgentAccess } = await import("../dist/auth/middleware.js") as typeof import("../src/auth/middleware.js");
const { grantElevation, revokeElevation } = await import("../dist/lib/stepUp.js") as typeof import("../src/lib/stepUp.js");
const { encryptSecret } = await import("../dist/crypto.js") as typeof import("../src/crypto.js");
const { decodeCustomerOutboxPayload } = await import("../dist/lib/customerOutboxCodec.js") as typeof import("../src/lib/customerOutboxCodec.js");
const { drainBackgroundTasks } = await import("../dist/lib/shutdownState.js") as typeof import("../src/lib/shutdownState.js");

const tag = `synthetic-quality-recovery-${randomUUID()}`, password = `Synthetic-${tag}`;
const base = "/api/v1/settings/customer-agent", accountId = randomUUID(), resource = `${tag}-resource`, secret = `${tag}-secret`;
const peers = { a: `${tag}-a`, b: `${tag}-b` }, capabilities = { publicRead: true, contactWrite: true, callbackWrite: true,
  newLeadBridge: true, handoverWrite: false, showingWrite: true, ownerQuestionWrite: true };
const source = recovery.CUSTOMER_AGENT_QUALITY_RECOVERY_SOURCE, sourceId = recovery.customerAgentQualityRecoverySourceId;
const readPolicy = () => prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } });
const events: string[] = [], parts: string[] = [], inquiries: string[] = [], operations: string[] = [];
let savedPolicy: Awaited<ReturnType<typeof readPolicy>>, actorId = "", staffId = "", token = "", staffToken = "", scopeId = "", aId = "", aCohort = "", bCohort = "";
let endpoint: Awaited<ReturnType<typeof ensureCustomerEndpoint>>, currentC: Awaited<ReturnType<typeof registration.registerCurrentCustomerAgentRevision>>;
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });
const command = async (extra: Record<string, unknown> = {}) => ({ expectedPolicyRevision: (await readPolicy()).policyRevision.toString(),
  requestId: randomUUID(), reason: tag, confirmQualityRecovery: true, ...extra });
// The real authentication routes verify OTP separately. This isolated fixture
// supplies the same process-local elevation, without sending an OTP or using
// the removed password-based API; the recovery HTTP route still checks it.
const elevate = async () => {
  grantElevation(actorId);
  expect((await request(app).get("/api/v1/auth/step-up").set(auth())).body.elevated).toBe(true);
};
const post = (body: unknown, value = token) => request(app).post(`${base}/recover-quality`).set(auth(value)).send(body);
async function insertManifest(manifest: typeof source | Omit<typeof currentC, "id">) {
  const id = customerAgentManifestId(manifest);
  await prisma.$executeRaw`INSERT INTO "CustomerAgentRevision" ("id","manifestJson","createdAt") VALUES (${id},${JSON.stringify(manifest)}::jsonb,now()) ON CONFLICT DO NOTHING`;
  return id;
}
function rollout(id: string, cohortId: string) { return { version: 1, cohortId, candidateRevisionId: id, percentBasisPoints: 10000,
  allowed: [{ surface: "dm", channel: "INSTAGRAM", endpointScopeId: scopeId }] }; }
async function install(id: string, cohortId: string) {
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"='scoped',"rolloutMode"='ACTIVE',"activeAgentRevisionId"=${id},
    "rolloutConfig"=${JSON.stringify(rollout(id, cohortId))}::jsonb,"capabilities"=${JSON.stringify(capabilities)}::jsonb WHERE "id"='singleton'`;
}
async function enroll(peer: string) {
  const result = await prisma.$transaction(tx => enrollCustomerAgentSubjectTx(tx, { surface: "dm", endpoint: {
    endpointScopeId: scopeId, accountId, channel: "INSTAGRAM", scopeRevision: endpoint.scopeRevision, transportKey: endpoint.transportKey }, peer }));
  expect(result.lane).toBe("CORE"); return result;
}
async function capture(peer = peers.b) {
  const mid = randomUUID(), rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: resource, messaging: [{
    sender: { id: peer }, recipient: { id: resource }, timestamp: Date.now(), message: { mid, text: "Здравствуйте" },
  }] }] }));
  const req = { rawBody, get: () => `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` };
  registerAuthenticatedMetaCustomerRequest(req);
  const saved = await persistVerifiedCustomerIngressBatch(req);
  expect(saved.status, JSON.stringify(saved)).toBe("persisted"); if (saved.status !== "persisted") throw Error(JSON.stringify(saved));
  events.push(saved.tickets[0].eventKey); return saved.tickets[0].eventKey;
}
async function part(kind: "text" | "witnessed_image" | "v2" = "text", status = "UNKNOWN", ageMinutes = 10) {
  const id = randomUUID(), at = new Date(Date.now() - ageMinutes * 60000);
  let originalNativeId = randomUUID(), ticketEventKey: string | undefined;
  if (kind === "v2") {
    ticketEventKey = await capture();
    await consumeCustomerInboxTicket(ticketEventKey);
    const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: ticketEventKey } });
    if (!ticket.conversationId) throw Error("Actual synthetic native required for v2 history");
    originalNativeId = ticket.conversationId;
  }
  const inquiry = await prisma.customerInquiry.create({ data: { endpointScopeId: scopeId, peerId: peers.b, threadId: id } }); inquiries.push(inquiry.id);
  const value = kind === "witnessed_image" ? { kind: "image", url: "https://media.synthetic.example/retained.jpg", mediaWitness: { synthetic: true } }
    : { kind: "text", text: "Synthetic retained original delivery" };
  const plaintext = JSON.stringify(value);
  await prisma.customerOutboxPart.create({ data: { id, inquiryId: inquiry.id, partKey: createHash("sha256").update(id).digest("hex"),
    originalNativeId, turnKey: id, ordinal: 0, mode: "LIVE", sourceKind: "BOT_TURN", sourceKey: id, channel: "INSTAGRAM", endpointScopeId: scopeId,
    agentRevisionId: sourceId, transportJson: {}, payloadEncrypted: encryptSecret(plaintext), payloadHash: createHash("sha256").update(plaintext).digest("hex"),
    payloadVersion: kind === "v2" ? 2 : 1, fenceJson: { endpoint: { peerId: peers.b } }, receiptRefsJson: [], status, createdAt: at,
    ...(kind === "v2" ? { conversationId: originalNativeId, ticketEventKey, approvedAssetPurpose: "buyer_guide_follow" } : {}) } });
  parts.push(id);
  if (status === "UNKNOWN") await prisma.customerDeliveryAttempt.create({ data: { partId: id, endpointScopeId: scopeId, attemptNo: 1,
    claimRevision: 0, outcome: "UNKNOWN", dispatchFenceJson: {}, startedAt: at, finishedAt: at } });
  return id;
}
async function unchanged(before: Awaited<ReturnType<typeof readPolicy>>) {
  expect(await readPolicy()).toEqual(before);
  expect(await prisma.customerAgentRevisionAdvance.count({ where: { fromRevisionId: sourceId, fromCohortId: bCohort } })).toBe(0);
}
beforeAll(async () => {
  const [{ database }] = await prisma.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
  expect(database).toBe(new URL(process.env.DATABASE_URL!).pathname.slice(1));
  savedPolicy = await readPolicy();
  const actor = await prisma.agent.create({ data: { fullName: tag, phone: `synthetic-${randomUUID()}`, role: "DIRECTOR", passwordHash: await bcrypt.hash(password, 4) } });
  actorId = actor.id; token = signAccessToken({ sub: actor.id, role: "DIRECTOR" });
  const staff = await prisma.agent.create({ data: { fullName: tag, phone: `synthetic-${randomUUID()}`, role: "AGENT", permissions: { granted: ["settings.manage"], revoked: [] } } });
  staffId = staff.id; staffToken = signAccessToken({ sub: staff.id, role: "AGENT" });
  await prisma.messengerAccount.create({ data: { id: accountId, channel: "INSTAGRAM", externalId: resource, username: "synthetic_recovery_agency", title: tag,
    enabled: true, token: encryptSecret(tag), appSecret: encryptSecret(secret) } });
  endpoint = await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel: "INSTAGRAM", subscriberId: peers.a, accountId, accountExternalId: resource })); scopeId = endpoint.endpointScopeId;
  currentC = await registration.registerCurrentCustomerAgentRevision(createCustomerAgentMediaProviderSnapshot());
  expect(await recovery.isCustomerQualityRecoveryTarget(currentC)).toBe(true);
  expect((await registration.loadVerifiedCustomerAgentRevision(currentC)).status).toBe("current");
  await insertManifest(source);
  vi.stubEnv("CUSTOMER_AGENT_MEDIA_EXECUTION_MODE", "OFF"); vi.stubEnv("CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE", "OFF");
  vi.stubEnv("IG_PROXY_URL", "https://synthetic-recovery-instagram.invalid");
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    if (parsed.origin === "https://synthetic-recovery-instagram.invalid" && parsed.searchParams.get("fields") === "username" &&
      (init?.method === undefined || init.method === "GET") && Object.values(peers).some(peer => parsed.pathname.endsWith(`/${peer}`))) {
      return new Response(JSON.stringify({ username: "synthetic_recovery_customer" }));
    }
    throw Error("Recovery must never issue provider POSTs or other network requests");
  }));
});
beforeEach(async () => {
  await prisma.agent.update({ where: { id: actorId }, data: { isActive: true, role: "DIRECTOR", permissions: Prisma.DbNull } });
  invalidateAgentAccess(actorId); revokeElevation(actorId);
  aId = await insertManifest(recovery.CUSTOMER_AGENT_QUALITY_RECOVERY_PRIOR_A); aCohort = randomUUID(); bCohort = randomUUID();
  expect(aId).toBe(recovery.customerAgentQualityRecoveryPriorAId);
  await install(aId, aCohort); await enroll(peers.a);
  // Represent the already committed quality activation from the other release.
  // This fixture never publishes B using C's verifier or rewrites an assignment.
  await prisma.$transaction(async tx => {
    const p = await tx.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } });
    await tx.$executeRaw`INSERT INTO "CustomerAgentRevisionAdvance" ("id","fromRevisionId","fromCohortId","toRevisionId","toCohortId","policyRevision","approvedAt")
      VALUES (${randomUUID()},${aId},${aCohort},${sourceId},${bCohort},${p.policyRevision + 1n},now())`;
    await tx.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "activeAgentRevisionId"=${sourceId},"rolloutConfig"=${JSON.stringify(rollout(sourceId, bCohort))}::jsonb WHERE "id"='singleton'`;
    const next = await tx.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } });
    await tx.auditLog.create({ data: { action: "CUSTOMER_AGENT_PUBLISH", entityType: "CustomerAgentPolicy", entityId: "singleton", agentId: actorId, agentName: tag,
      meta: { candidate: sourceId, cohort: bCohort, newRevision: next.policyRevision.toString(), qualityContinuityUpgradeVersion: "v1",
        idleRevisionAdvanced: true, percentBasisPoints: 10000, scopes: [scopeId] } } });
  });
  await enroll(peers.b); vi.mocked(fetch).mockClear();
});
afterEach(async () => {
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  vi.restoreAllMocks(); revokeElevation(actorId); await drainBackgroundTasks(3000);
  await prisma.customerDeliveryAttempt.deleteMany({ where: { partId: { in: parts } } });
  await prisma.customerOutboxPart.deleteMany({ where: { id: { in: parts } } });
  await prisma.customerInquiry.deleteMany({ where: { id: { in: inquiries } } });
  const natives = await prisma.customerPropertyIngressTicket.findMany({ where: { eventKey: { in: events } }, select: { conversationId: true } });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: [
    ...events.map(event => `customer-inbox-consume:${event}`), ...parts.map(id => `customer-outbox-dispatch:${id}`),
  ] } } });
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: events } } });
  const nativeIds = natives.flatMap(value => value.conversationId ? [value.conversationId] : []);
  await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: nativeIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: nativeIds } } });
  await prisma.customerAgentRolloutAssignment.deleteMany({ where: { endpointScopeId: scopeId } });
  // Real signed ingress creates shield state even when the old turn is held.
  // Delete only this fixture's scope; retained production shield data is never touched.
  await prisma.outboundShieldState.deleteMany({ where: { endpointScopeId: scopeId } });
  await prisma.aiLog.deleteMany({ where: { operationId: { in: operations } } });
  await prisma.aiProviderOperation.deleteMany({ where: { id: { in: operations } } });
  await prisma.auditLog.deleteMany({ where: { agentId: actorId } });
  events.length = parts.length = inquiries.length = operations.length = 0;
});
afterAll(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  if (savedPolicy) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: savedPolicy.contractVersion,
    rolloutMode: savedPolicy.rolloutMode, activeAgentRevisionId: savedPolicy.activeAgentRevisionId,
    rolloutConfig: savedPolicy.rolloutConfig === null ? Prisma.DbNull : savedPolicy.rolloutConfig,
    capabilities: savedPolicy.capabilities === null ? Prisma.DbNull : savedPolicy.capabilities } });
  if (scopeId) await prisma.outboundShieldState.deleteMany({ where: { endpointScopeId: scopeId } });
  await prisma.customerEndpointScope.deleteMany({ where: { messengerAccountId: accountId } });
  await prisma.messengerAccount.delete({ where: { id: accountId } });
  await prisma.auditLog.deleteMany({ where: { agentId: { in: [actorId, staffId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [actorId, staffId] } } });
  await prisma.$disconnect();
});

describe("compiled reserve C authenticated recovery", () => {
  it("reports live readiness and requires an existing owner with fresh step-up", async () => {
    const state = await request(app).get(`${base}/recovery-state`).set(auth());
    expect(state.status).toBe(200); expect(state.body).toMatchObject({ status: "ready", requiresResumeFromOff: false, policyRevision: (await readPolicy()).policyRevision.toString() });
    expect((await post(await command())).status).toBe(428);
    expect((await post(await command(), staffToken)).status).toBe(428);
    grantElevation(staffId);
    expect((await post(await command(), staffToken)).status).toBe(403);
    revokeElevation(staffId);
    // DIRECTOR always has all permissions by the existing CRM contract.
    // Permission revocation is meaningful for ADMIN, whose overrides apply.
    await prisma.agent.update({ where: { id: actorId }, data: { role: "ADMIN" } }); invalidateAgentAccess(actorId);
    await elevate();
    await prisma.agent.update({ where: { id: actorId }, data: { permissions: { granted: [], revoked: ["settings.manage"] } } }); invalidateAgentAccess(actorId);
    expect((await post(await command())).status).toBe(403);
  });
  it("advances A and new B roots to verified current C while retaining pins, history and old UNKNOWN", async () => {
    const eventKey = await capture(), held = await consumeCustomerInboxTicket(eventKey);
    // This old input is held before a claim. Independently verify the precise
    // artifact mismatch; do not invent a planning pin or a provider operation.
    expect(held, JSON.stringify(held)).toMatchObject({ status: "held", reason: "original_context_changed" });
    expect(await registration.loadVerifiedCustomerAgentRevision({ ...source, id: sourceId })).toMatchObject({
      status: "held", reason: "current_artifact_revision_mismatch",
    });
    const originalPin = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey } });
    expect(originalPin).toMatchObject({ intakeAgentRevisionId: sourceId, processingState: "HELD" });
    const unknown = await part(), originalUnknown = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: unknown } });
    const originalAttempts = await prisma.customerDeliveryAttempt.findMany({ where: { partId: unknown } });
    const assignments = await prisma.customerAgentRolloutAssignment.findMany({ where: { endpointScopeId: scopeId }, orderBy: { id: "asc" } });
    await prisma.outboundShieldState.create({ data: { endpointScopeId: scopeId, channel: "INSTAGRAM", subscriberId: `${tag}-retained-shield`,
      botSentSinceInbound: 1, hourCount: 2, dayCount: 3, firedCount: 1, lastInboundId: `${tag}-inbound`, lastInboundAt: new Date() } });
    const shield = await prisma.outboundShieldState.findMany({ where: { endpointScopeId: scopeId }, orderBy: { id: "asc" } });
    const before = await readPolicy(), body = await command(); await elevate();
    const result = await post(body); expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({ rolloutMode: "ACTIVE", recoveryVersion: "quality-v1", revisionId: currentC.id, alreadyApplied: false });
    const after = await readPolicy(), next = after.rolloutConfig as ReturnType<typeof rollout>;
    expect(after.policyRevision).toBe(before.policyRevision + 1n); expect(after.capabilities).toEqual(before.capabilities);
    expect(next).toMatchObject({ candidateRevisionId: currentC.id, percentBasisPoints: 10000, allowed: rollout(sourceId, bCohort).allowed });
    expect(await customerAgentRevisionReachable(prisma, { candidateRevisionId: aId, cohortId: aCohort }, currentC.id, next.cohortId)).toBe(true);
    expect(await customerAgentRevisionReachable(prisma, { candidateRevisionId: sourceId, cohortId: bCohort }, currentC.id, next.cohortId)).toBe(true);
    expect(await customerAgentRevisionReachable(prisma, { candidateRevisionId: currentC.id, cohortId: next.cohortId }, sourceId)).toBe(false);
    expect(await prisma.customerAgentRolloutAssignment.findMany({ where: { endpointScopeId: scopeId }, orderBy: { id: "asc" } })).toEqual(assignments);
    const retained = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey } });
    for (const key of ["intakeAgentRevisionId", "agentRevisionId", "providerOperationId", "providerDeadlineAt", "payloadCiphertext", "payloadHash", "order"] as const) expect(retained[key]).toEqual(originalPin[key]);
    expect(await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: unknown } })).toEqual(originalUnknown);
    expect(await prisma.customerDeliveryAttempt.findMany({ where: { partId: unknown } })).toEqual(originalAttempts);
    expect(await prisma.outboundShieldState.findMany({ where: { endpointScopeId: scopeId }, orderBy: { id: "asc" } })).toEqual(shield);
    for (const peer of Object.values(peers)) {
      const future = await capture(peer);
      expect(await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: future } })).toMatchObject({ intakeAgentRevisionId: currentC.id });
    }
    expect((await registration.loadVerifiedCustomerAgentRevision(currentC)).status).toBe("current");
    expect((await request(app).get(`${base}/recovery-state`).set(auth())).body.status).toBe("already_recovered");
    const replay = await post(body); expect(replay.status).toBe(200); expect(replay.body.alreadyApplied).toBe(true);
    expect((await post({ ...body, reason: "Different retry" })).body.error).toBe("recovery_request_conflict");
    expect(await prisma.customerAgentRevisionAdvance.count({ where: { fromRevisionId: sourceId, fromCohortId: bCohort } })).toBe(1);
  });
  it("recovers after actual kill only with explicit resume acknowledgement", async () => {
    await elevate(); const kill = await request(app).post(`${base}/kill`).set(auth()).send({ expectedPolicyRevision: (await readPolicy()).policyRevision.toString(), reason: tag });
    expect(kill.status).toBe(200);
    expect((await request(app).get(`${base}/recovery-state`).set(auth())).body).toMatchObject({ status: "ready", requiresResumeFromOff: true });
    expect((await post(await command())).body.error).toBe("recovery_resume_confirmation_required");
    const result = await post(await command({ acknowledgeResumeFromOff: true })); expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect((await readPolicy()).rolloutMode).toBe("ACTIVE");
  });
  it("accepts an active ADMIN with the same effective permission and fresh step-up", async () => {
    await prisma.agent.update({ where: { id: actorId }, data: { role: "ADMIN" } }); invalidateAgentAccess(actorId);
    await elevate(); const result = await post(await command()); expect(result.status, JSON.stringify(result.body)).toBe(200);
  });
  it.each(["coreHash", "rendererHash", "modelSchemaHash", "promptHash", "knowledgeSchemaHash", "toolSchemaHash", "providerProfileHash", "providerPolicyHash"] as const)("rejects a lookalike B with changed %s", async key => {
    const wrong = await insertManifest({ ...source, [key]: "e".repeat(64) }); await install(wrong, randomUUID()); await elevate();
    const before = await readPolicy(), result = await post(await command()); expect(result.status).toBe(409); expect(result.body.error).toBe("recovery_source_not_qualified"); await unchanged(before);
  });
  it("rejects changed percentage, media activation, caller targets and stale CAS", async () => {
    await elevate(); const before = await readPolicy();
    expect((await post(await command({ expectedPolicyRevision: "0" }))).body.error).toBe("policy_changed");
    expect((await post(await command({ revisionId: currentC.id }))).status).toBe(400);
    expect((await post(await command({ confirmCatalogFactsUpgrade: true }))).status).toBe(400);
    expect((await post(await command({ acknowledgeResumeFromOff: true }))).body.error).toBe("recovery_resume_not_required");
    vi.stubEnv("CUSTOMER_AGENT_MEDIA_EXECUTION_MODE", "LIVE");
    expect((await post(await command())).body.error).toBe("recovery_media_must_be_off"); vi.stubEnv("CUSTOMER_AGENT_MEDIA_EXECUTION_MODE", "OFF");
    await unchanged(before);
    await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=jsonb_set("rolloutConfig",'{percentBasisPoints}','5000') WHERE "id"='singleton'`;
    expect((await post(await command())).body.error).toBe("recovery_configuration_changed");
  });
  it("requires the actual approved quality publication proof", async () => {
    await prisma.auditLog.deleteMany({ where: { agentId: actorId, action: "CUSTOMER_AGENT_PUBLISH" } }); await elevate();
    const before = await readPolicy(), result = await post(await command());
    expect(result.status).toBe(409); expect(result.body.error).toBe("recovery_quality_publication_missing"); await unchanged(before);
  });
  it.each(["witnessed_image", "v2"] as const)("blocks incompatible encrypted %s history even when suppressed", async kind => {
    await part(kind, "SUPPRESSED"); await elevate(); const before = await readPolicy();
    const result = await post(await command()); expect(result.status).toBe(409); expect(result.body.error).toBe("recovery_incompatible_delivery_history"); await unchanged(before);
  });
  it("retains all ordinary idle barriers for pending input, delivery, young UNKNOWN and reserved provider work", async () => {
    await elevate();
    const eventKey = await capture(), before = await readPolicy();
    expect((await post(await command())).body.error).toBe("core_work_requires_idle_publication"); await unchanged(before);
    await prisma.customerPropertyIngressTicket.update({ where: { eventKey }, data: { processingState: "HELD", errorCode: "synthetic-idle-fixture" } });
    const ready = await part("text", "READY");
    expect((await post(await command())).body.error).toBe("core_work_requires_idle_publication");
    await prisma.customerOutboxPart.update({ where: { id: ready }, data: { status: "SUPPRESSED" } });
    const young = await part("text", "UNKNOWN", 1);
    expect((await post(await command())).body.error).toBe("core_work_requires_idle_publication");
    await prisma.customerDeliveryAttempt.updateMany({ where: { partId: young }, data: { finishedAt: new Date(Date.now() - 10 * 60000) } });
    const operation = await prisma.aiProviderOperation.create({ data: { policyKey: "royal-customer-gemini", policyHash: source.providerPolicyHash,
      dayKey: "2026-10-26", deadlineAt: new Date(Date.now() + 60000), maxAttempts: 1, reservedUsd: "0.01" } }); operations.push(operation.id);
    expect((await post(await command())).body.error).toBe("core_work_requires_idle_publication"); await unchanged(before);
  });
  it("rereads actor authority and CAS after registration awaits", async () => {
    await elevate(); const before = await readPolicy(), original = registration.registerCurrentCustomerAgentRevision;
    vi.spyOn(registration, "registerCurrentCustomerAgentRevision").mockImplementation(async (...args) => {
      const value = await original(...args); revokeElevation(actorId); return value;
    });
    expect((await post(await command())).status).toBe(428); await unchanged(before);
  });
  it("rejects effective permission revocation after artifact registration", async () => {
    await prisma.agent.update({ where: { id: actorId }, data: { role: "ADMIN" } }); invalidateAgentAccess(actorId);
    await elevate(); const before = await readPolicy(), original = registration.registerCurrentCustomerAgentRevision;
    vi.spyOn(registration, "registerCurrentCustomerAgentRevision").mockImplementation(async (...args) => {
      const value = await original(...args);
      await prisma.agent.update({ where: { id: actorId }, data: { permissions: { granted: [], revoked: ["settings.manage"] } } }); invalidateAgentAccess(actorId);
      return value;
    });
    expect((await post(await command())).status).toBe(403); await unchanged(before);
  });
  it("rejects a policy CAS race after artifact registration without overwriting the intervening configuration", async () => {
    await elevate(); const original = registration.registerCurrentCustomerAgentRevision;
    vi.spyOn(registration, "registerCurrentCustomerAgentRevision").mockImplementation(async (...args) => {
      const value = await original(...args);
      await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "capabilities"=jsonb_set("capabilities",'{contactWrite}','false') WHERE "id"='singleton'`;
      return value;
    });
    const result = await post(await command()); expect(result.status).toBe(409); expect(result.body.error).toBe("policy_changed");
    expect((await readPolicy()).capabilities).toMatchObject({ contactWrite: false });
    expect(await prisma.customerAgentRevisionAdvance.count({ where: { fromRevisionId: sourceId, fromCohortId: bCohort } })).toBe(0);
  });
  it("rolls back edge, policy and success audit together if the final audit insert fails", async () => {
    await elevate(); const before = await readPolicy(), index = `test_recovery_audit_${randomUUID().replaceAll("-", "")}`;
    // The already present synthetic quality publication is the sole index row.
    // A recovery success audit conflicts AFTER the real edge/policy SQL writes.
    await prisma.$executeRaw(Prisma.sql`CREATE UNIQUE INDEX ${Prisma.raw(`"${index}"`)} ON "AuditLog"("entityId")
      WHERE "agentId"=${Prisma.raw(`'${actorId}'`)} AND "action"='CUSTOMER_AGENT_PUBLISH'`);
    try { const result = await post(await command()); expect(result.status).toBe(500); await unchanged(before); }
    finally { await prisma.$executeRaw(Prisma.sql`DROP INDEX ${Prisma.raw(`"${index}"`)}`); }
  });
  it("serializes two deliveries of the same recovery request into one edge and one audited result", async () => {
    await elevate(); const body = await command(), results = await Promise.all([post(body), post(body)]);
    for (const result of results) expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(results.map(value => value.body.alreadyApplied).sort()).toEqual([false, true]);
    expect(await prisma.customerAgentRevisionAdvance.count({ where: { fromRevisionId: sourceId, fromCohortId: bCohort } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { agentId: actorId, action: "CUSTOMER_AGENT_PUBLISH", meta: { path: ["recoveryRequestId"], equals: body.requestId } } })).toBe(1);
  });
  it("executes the prior compiled Core and Renderer on a future C-pinned message after recovery without sending it", async () => {
    await elevate(); const result = await post(await command()); expect(result.status, JSON.stringify(result.body)).toBe(200);
    const select = { botEnabled: true, metaEnabled: true, botInstagramEnabled: true, geminiApiKey: true, geminiApiKey2: true, geminiApiKeysExtra: true } as const;
    const saved = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select });
    const originalFetch = fetch, key = "synthetic-recovery-model-key";
    const envKeys = ["GEMINI_PROXY_URL", "GEMINI_PROXY_KEY", "GEMINI_API_KEY", "GEMINI_API_KEY_2", "BOT_PROPERTY_CONTEXT_ENABLED"] as const;
    const originalEnv = Object.fromEntries(envKeys.map(name => [name, process.env[name]]));
    let future: string | undefined;
    const modelFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      if (parsed.origin === "https://synthetic-recovery-instagram.invalid") return originalFetch(url, init);
      if (parsed.origin !== "https://synthetic-recovery-gemini.invalid" || init?.method !== "POST" ||
        new Headers(init.headers).get("x-goog-api-key") !== key) throw Error("Unexpected network request in compiled recovery turn");
      if (parsed.pathname === "/gemini/v1beta/models/gemini-3.6-flash:countTokens") return new Response(JSON.stringify({ totalTokens: 1000 }));
      if (parsed.pathname === "/gemini/v1beta/models/gemini-3.6-flash:generateContent") return new Response(JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify({ kind: "reply", refs: [], social: "greet", question: "topic" }) }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 30, thoughtsTokenCount: 0, cachedContentTokenCount: 0 },
      }));
      throw Error("Unexpected model operation in compiled recovery turn");
    });
    try {
      await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true,
        geminiApiKey: encryptSecret(key), geminiApiKey2: null, geminiApiKeysExtra: [] } });
      vi.stubEnv("GEMINI_PROXY_URL", "https://synthetic-recovery-gemini.invalid"); vi.stubEnv("GEMINI_PROXY_KEY", "");
      vi.stubEnv("GEMINI_API_KEY", key); vi.stubEnv("GEMINI_API_KEY_2", ""); vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0");
      vi.stubGlobal("fetch", modelFetch);
      future = await capture(peers.b);
      const planned = await consumeCustomerInboxTicket(future);
      expect(planned, JSON.stringify(planned)).toMatchObject({ status: "planned" });
      const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: future } });
      expect(ticket).toMatchObject({ intakeAgentRevisionId: currentC.id, agentRevisionId: currentC.id, processingState: "PLANNED" });
      const outgoing = await prisma.customerOutboxPart.findMany({ where: { ticketEventKey: future } });
      expect(outgoing).toHaveLength(1);
      expect(decodeCustomerOutboxPayload(outgoing[0])).toEqual({ kind: "text", text: "Здравствуйте!\nВы хотите узнать о недвижимости или о работе?" });
      expect(outgoing[0]).toMatchObject({ agentRevisionId: currentC.id, status: "READY" });
      expect(await prisma.customerDeliveryAttempt.count({ where: { partId: outgoing[0].id } })).toBe(0);
      expect(modelFetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([url]) => new URL(String(url)).pathname)).toEqual([
        "/gemini/v1beta/models/gemini-3.6-flash:countTokens", "/gemini/v1beta/models/gemini-3.6-flash:generateContent",
      ]);
    } finally {
      if (future) {
        parts.push(...(await prisma.customerOutboxPart.findMany({ where: { ticketEventKey: future }, select: { id: true } })).map(row => row.id));
        const ticket = await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey: future }, select: { providerOperationId: true } });
        if (ticket?.providerOperationId) operations.push(ticket.providerOperationId);
      }
      await prisma.settings.update({ where: { id: "singleton" }, data: saved });
      for (const name of envKeys) { const value = originalEnv[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      vi.stubGlobal("fetch", originalFetch);
    }
  });
});
