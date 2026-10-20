// PRIVATE candidate; NOT RUN. Normal PG/default setup after root-owned DDL.
// Actual same-body HMAC/RAW routing namespace + real SQL enrollment. No FINAL,
// principal, private rights or callback fixture grant is manufactured here.
// This part01 suite is NOT producer/consumer one-executor integration proof.
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import type { CustomerAgentEnrollmentSubject, CustomerAgentRolloutConfig } from "@royal-home/shared";
import { createCustomerAgentProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import { registerCurrentCustomerAgentRevision } from "../src/lib/customerAgentRegistration.js";
import { enrollCustomerAgentSubjectTx, customerAgentEnrollmentSubjectKey, readCustomerDmSourceExecution } from "../src/lib/customerAgentEnrollment.js";
import { registerAuthenticatedMetaCustomerRequest, verifyMetaCustomerReferralTarget } from "../src/lib/customerIngressAuthority.js";
import { normalizeAuthenticatedCustomerIngress } from "../src/lib/customerIngressNormalize.js";
import { ensureCustomerEndpoint, ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";
import { ensurePublicCommentInstallation } from "../src/lib/customerPublicCommentStore.js";
import { createMetaPublicCapture } from "../src/lib/metaPublicCommentCapture.js";
import { persistVerifiedCustomerIngressBatch } from "../src/lib/customerIngressProducer.js";
import { customerPropertyScopeKey } from "../src/lib/customerPropertyScope.js";
import { deleteAccount, resetAccountsCache } from "../src/messengers/accounts.js";
import { resetMetaAccountCredsCache } from "../src/messengers/meta.js";

const accounts: string[] = [], scopes: string[] = [], natives: string[] = [], events: string[] = [];
let revisionId: string;
let savedSettings: Awaited<ReturnType<typeof settingsSnapshot>>;
let savedPolicy: Awaited<ReturnType<typeof policySnapshot>>;
let savedConfig: unknown;
function settingsSnapshot() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, metaEnabled: true, botInstagramEnabled: true, botCanAnswerComments: true, metaVerifyToken: true,
} }); }
function policySnapshot() { return prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  contractVersion: true, rolloutMode: true, capabilities: true, activeAgentRevisionId: true,
} }); }
async function account() {
  const id = randomUUID(), externalId = `enrollment-install-${id}`, secret = `synthetic-enroll-secret-${id}`;
  await prisma.messengerAccount.create({ data: { id, externalId, channel: "INSTAGRAM", enabled: true,
    username: `synthetic_enrollment_${id.replaceAll("-", "")}`, title: "Synthetic routing metadata",
    token: encryptSecret(`synthetic-enroll-token-${id}`), appSecret: encryptSecret(secret) } });
  accounts.push(id); resetAccountsCache(); resetMetaAccountCredsCache(); return { id, externalId, secret };
}
function signed(a: Awaited<ReturnType<typeof account>>, body: unknown) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const request = { rawBody, get: (name: string) => name === "x-hub-signature-256"
    ? `sha256=${createHmac("sha256", a.secret).update(rawBody).digest("hex")}` : undefined };
  registerAuthenticatedMetaCustomerRequest(request); return request;
}
async function subject(a = account(), peer = `enrollment-peer-${randomUUID()}`) {
  const installed = await a;
  const request = signed(installed, { object: "instagram", entry: [{ id: installed.externalId, messaging: [{
    sender: { id: peer }, recipient: { id: installed.externalId }, timestamp: Date.now(), message: { mid: randomUUID(), text: "Здравствуйте" },
  }] }] });
  const normalized = normalizeAuthenticatedCustomerIngress(request);
  expect(normalized.entries).toHaveLength(1);
  const entry = normalized.entries[0];
  const target = { channel: "INSTAGRAM" as const, peer: entry.peer, accountExternalId: entry.accountExternalId };
  expect(await verifyMetaCustomerReferralTarget(request, target)).toBe(true);
  // Mirrors the existing RAW producer namespace stage, without pretending RAW
  // is FINAL. No BotConversation, memory or input authority is created here.
  const endpoint = await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel: entry.channel,
    subscriberId: entry.peer, accountId: installed.id, accountExternalId: entry.accountExternalId }));
  expect(await verifyMetaCustomerReferralTarget(request, target)).toBe(true);
  scopes.push(endpoint.endpointScopeId);
  const { endpointScopeId, scopeRevision, channel, accountId, transportKey } = endpoint;
  const value: CustomerAgentEnrollmentSubject = { surface: "dm", endpoint: { endpointScopeId, scopeRevision, channel, accountId, transportKey }, peer };
  return { value, request, installed, endpoint };
}
async function configure(subjects: CustomerAgentEnrollmentSubject[], percentBasisPoints: number, cohortId = randomUUID()) {
  const config: CustomerAgentRolloutConfig = { version: 1, cohortId, candidateRevisionId: revisionId, percentBasisPoints,
    allowed: subjects.map(s => ({ surface: s.surface, channel: s.endpoint.channel as "INSTAGRAM", endpointScopeId: s.endpoint.endpointScopeId })) };
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"='scoped',"rolloutMode"='ACTIVE',
    "activeAgentRevisionId"=${revisionId},"rolloutConfig"=${JSON.stringify(config)}::jsonb WHERE "id"='singleton'`;
  return config;
}
const enroll = (s: CustomerAgentEnrollmentSubject) => prisma.$transaction(tx => enrollCustomerAgentSubjectTx(tx, s));
async function count(s: CustomerAgentEnrollmentSubject) {
  const [row] = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "CustomerAgentRolloutAssignment"
    WHERE "surface"=${s.surface} AND "endpointScopeId"=${s.endpoint.endpointScopeId} AND "subjectKey"=${customerAgentEnrollmentSubjectKey(s)}`;
  return row.n;
}
beforeAll(async () => {
  savedSettings = await settingsSnapshot(); savedPolicy = await policySnapshot();
  const [row] = await prisma.$queryRaw<Array<{ rolloutConfig: unknown }>>`SELECT "rolloutConfig" FROM "CustomerRuntimePolicy" WHERE "id"='singleton'`;
  savedConfig = row.rolloutConfig;
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true,
    botInstagramEnabled: true, botCanAnswerComments: true, metaVerifyToken: encryptSecret("synthetic-enrollment-verify") } });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Enrollment must perform zero physical provider/model HTTP"); }));
  revisionId = (await registerCurrentCustomerAgentRevision(createCustomerAgentProviderSnapshot())).id;
});
afterAll(async () => {
  try {
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: events.map(key => `customer-inbox-consume:${key}`) } } });
    await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: events } } });
    await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: natives } } });
    await prisma.botConversation.deleteMany({ where: { id: { in: natives } } });
    // Every listed scope was created by this fixture, including the tombstoned
    // account-deletion case. Source FKs were removed above; exact scope cleanup
    // uses the approved FK cascade, not a global assignment wipe/reset.
    await prisma.customerEndpointScope.deleteMany({ where: { id: { in: [...new Set(scopes)] } } });
    await prisma.messengerAccount.deleteMany({ where: { id: { in: accounts } } });
  } finally {
    try {
      try { if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings }); }
      finally {
        if (savedPolicy) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: savedPolicy });
        if (savedConfig === null) await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=NULL WHERE "id"='singleton'`;
        else if (savedConfig !== undefined) await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${JSON.stringify(savedConfig)}::jsonb WHERE "id"='singleton'`;
      }
    } finally { vi.unstubAllGlobals(); resetAccountsCache(); resetMetaAccountCredsCache(); }
  }
});

it("persists the negative first choice and never resamples it after percent or cohort changes", async () => {
  const s = await subject(), config = await configure([s.value], 0), first = await enroll(s.value);
  expect(first.lane).toBe("LEGACY"); if (first.lane !== "LEGACY" || !first.assignment) throw new Error("Actual persisted negative required");
  expect(await count(s.value)).toBe(1n);
  await configure([s.value], 10_000, config.cohortId);
  expect(await enroll(s.value)).toEqual(first);
  await configure([s.value], 10_000); // New campaign cannot flip the same subject.
  expect(await enroll(s.value)).toEqual(first); expect(await count(s.value)).toBe(1n);
});
it("five real first-enrollment transactions converge to one exact CORE assignment", async () => {
  const s = await subject(); await configure([s.value], 10_000);
  const results = await Promise.all(Array.from({ length: 5 }, () => enroll(s.value)));
  expect(results.every(row => row.lane === "CORE")).toBe(true);
  expect(new Set(results.flatMap(row => row.lane === "CORE" && row.assignment ? [row.assignment.id] : [])).size).toBe(1);
  expect(await count(s.value)).toBe(1n);
});
it("persists an unconfigured OFF negative before a deferred legacy continuation and cannot flip during activation", async () => {
  const s = await subject();
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"='compat',"rolloutMode"='OFF',
    "activeAgentRevisionId"=NULL,"rolloutConfig"=NULL WHERE "id"='singleton'`;
  let release!: () => void;
  const suspended = new Promise<void>(resolve => { release = resolve; });
  const first = await enroll(s.value); // Metadata transaction committed before ANY legacy async boundary.
  expect(first.lane).toBe("LEGACY");
  if (first.lane !== "LEGACY" || !first.assignment) throw new Error("Durable OFF negative required before legacy work");
  expect(first.assignment).toMatchObject({ cohortId: null, candidateRevisionId: null, bucketBps: null });
  let continued = false;
  const continuation = suspended.then(() => { continued = true; return first; }); // Explicit barrier, not a fake engine.
  try {
    await configure([s.value], 10_000);
    const second = await enroll(s.value); // Fresh B while A is suspended, before native exists.
    expect(second).toEqual(first); expect(second.lane).toBe("LEGACY");
    expect(await count(s.value)).toBe(1n); expect(continued).toBe(false);
    expect(await prisma.botConversation.count({ where: { endpointScopeId: s.endpoint.endpointScopeId, subscriberId: s.value.peer } })).toBe(0);
  } finally { release(); }
  expect(await continuation).toEqual(first); expect(continued).toBe(true);
});
it("kill holds owned CORE but the real original durable source can never become LEGACY", async () => {
  const s = await subject(); await configure([s.value], 10_000);
  const first = await enroll(s.value); expect(first.lane).toBe("CORE");
  const produced = await persistVerifiedCustomerIngressBatch(s.request);
  expect(produced.status).toBe("persisted"); if (produced.status !== "persisted") throw new Error("Real raw source required");
  const key = produced.tickets[0].eventKey; events.push(key);
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { rolloutMode: "OFF" } });
  expect(await enroll(s.value)).toEqual({ lane: "HELD", reason: "owned_subject_stopped" });
  const scopeKey = customerPropertyScopeKey(s.value.endpoint.channel, s.value.peer, s.value.endpoint.accountId, s.value.endpoint.endpointScopeId);
  expect(await readCustomerDmSourceExecution(prisma, key, scopeKey, s.value)).toMatchObject({ lane: "CORE", revisionId });
  expect(await count(s.value)).toBe(1n);
});
it("token A→B→A revokes the original captured namespace even when raw HMAC is still valid", async () => {
  const s = await subject(); await configure([s.value], 10_000);
  const tokenA = (await prisma.messengerAccount.findUniqueOrThrow({ where: { id: s.installed.id }, select: { token: true } })).token;
  await prisma.messengerAccount.update({ where: { id: s.installed.id }, data: { token: encryptSecret("synthetic-next-token") } });
  await prisma.messengerAccount.update({ where: { id: s.installed.id }, data: { token: tokenA } });
  expect(await enroll(s.value)).toEqual({ lane: "HELD", reason: "captured_scope_changed" }); expect(await count(s.value)).toBe(0n);
  const fresh = await subject(Promise.resolve(s.installed)); await configure([fresh.value], 10_000);
  expect((await enroll(fresh.value)).lane).toBe("CORE");
});
it("an existing scoped native stays baseline and GateA foreign same-peer collision is held", async () => {
  const s = await subject();
  const native = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel: "INSTAGRAM",
    subscriberId: s.value.peer, transport: s.endpoint })); natives.push(native.id);
  await configure([s.value], 10_000); expect((await enroll(s.value)).lane).toBe("LEGACY");
  const b = await subject(account(), s.value.peer); await configure([s.value, b.value], 10_000);
  expect(await enroll(b.value)).toEqual({ lane: "HELD", reason: "legacy_native_scope_collision" }); expect(await count(b.value)).toBe(0n);
  expect(await prisma.botConversation.count({ where: { id: native.id, endpointScopeId: s.endpoint.endpointScopeId } })).toBe(1);
});
it("actual signed public capture keeps its own installation/thread assignment and creates no source/principal/effect", async () => {
  const a = await account(), comment = `enroll-comment-${randomUUID()}`, publication = `enroll-publication-${randomUUID()}`;
  const request = signed(a, { object: "instagram", entry: [{ id: a.externalId, changes: [{ field: "comments", value: {
    id: comment, media: { id: publication }, from: { id: "synthetic-public-author" }, text: "Цена?" } }] }] });
  const capture = await createMetaPublicCapture({ readInstallation: ensurePublicCommentInstallation,
    commitQueueAndCapture: async () => { throw new Error("Metadata test must not create a public source"); } })(request);
  expect(capture.status).toBe("current"); if (capture.status !== "current") throw new Error("Actual signed public capture required");
  expect(capture.value.items).toHaveLength(1);
  const row = capture.value.items[0], stamp = await ensurePublicCommentInstallation("INSTAGRAM", a.externalId);
  if (!stamp) throw new Error("Actual PUBLIC installation required");
  scopes.push(stamp.installation.id);
  const s: CustomerAgentEnrollmentSubject = { surface: "public_comment", endpoint: { endpointScopeId: stamp.installation.id,
    scopeRevision: stamp.installation.revision, channel: "INSTAGRAM", accountId: a.id, transportKey: stamp.installation.transportKey },
    target: { channel: "INSTAGRAM", publicationId: row.mediaId, commentId: row.commentId, parentId: row.parentId ?? null,
      threadId: row.parentId ?? row.commentId, threadKind: "comment_anchor", accountExternalId: a.externalId } };
  await configure([s], 0); const first = await enroll(s); expect(first.lane).toBe("LEGACY");
  await configure([s], 10_000); expect(await enroll(s)).toEqual(first);
  expect(await prisma.instagramComment.count({ where: { accountExternalId: a.externalId } })).toBe(0);
  expect(await prisma.customerOutboxPart.count({ where: { endpointScopeId: stamp.installation.id } })).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});
it("real account deletion preserves the negative assignment and tombstones its scope", async () => {
  const s = await subject(); await configure([s.value], 0);
  const first = await enroll(s.value); expect(first.lane).toBe("LEGACY");
  if (first.lane !== "LEGACY" || !first.assignment) throw new Error("Actual negative assignment required");
  await deleteAccount(s.installed.id);
  const scope = await prisma.customerEndpointScope.findUniqueOrThrow({ where: { id: s.endpoint.endpointScopeId } });
  expect(scope.messengerAccountId).toBeNull(); expect(scope.kind).toBe("LEGACY_UNKNOWN");
  expect(scope.scopeRevision > BigInt(s.endpoint.scopeRevision)).toBe(true);
  expect(await count(s.value)).toBe(1n);
  const [row] = await prisma.$queryRaw<Array<{ id: string; lane: string; candidateRevisionId: string | null }>>`
    SELECT "id","lane","candidateRevisionId" FROM "CustomerAgentRolloutAssignment" WHERE "id"=${first.assignment.id}`;
  expect(row).toEqual({ id: first.assignment.id, lane: "LEGACY", candidateRevisionId: revisionId });
  expect(await enroll(s.value)).toEqual({ lane: "HELD", reason: "captured_scope_changed" });
});
it("explicit cleanup of an unreferenced owned scope cascades only that scope's assignment", async () => {
  const a = await subject(), b = await subject(); await configure([a.value, b.value], 0);
  expect((await enroll(a.value)).lane).toBe("LEGACY"); expect((await enroll(b.value)).lane).toBe("LEGACY");
  await prisma.customerEndpointScope.delete({ where: { id: a.endpoint.endpointScopeId } });
  expect(await count(a.value)).toBe(0n); expect(await count(b.value)).toBe(1n);
  expect(await prisma.messengerAccount.count({ where: { id: a.installed.id } })).toBe(1);
});
it("a real durable source restricts assignment deletion and its scope cascade", async () => {
  const s = await subject(); await configure([s.value], 10_000);
  const produced = await persistVerifiedCustomerIngressBatch(s.request);
  expect(produced.status).toBe("persisted"); if (produced.status !== "persisted") throw new Error("Real raw source required");
  const key = produced.tickets[0].eventKey; events.push(key);
  const [source] = await prisma.$queryRaw<Array<{ rolloutAssignmentId: string | null }>>`
    SELECT "rolloutAssignmentId" FROM "CustomerPropertyIngressTicket" WHERE "eventKey"=${key}`;
  expect(source.rolloutAssignmentId).toBeTruthy(); // Requires actual part02 producer stamp, never a hand-made link.
  if (!source.rolloutAssignmentId) throw new Error("Real producer must retain first assignment");
  await expect(prisma.$executeRaw`DELETE FROM "CustomerAgentRolloutAssignment" WHERE "id"=${source.rolloutAssignmentId}`).rejects.toThrow();
  await expect(prisma.customerEndpointScope.delete({ where: { id: s.endpoint.endpointScopeId } })).rejects.toThrow();
  expect(await count(s.value)).toBe(1n);
  expect(await prisma.customerPropertyIngressTicket.count({ where: { eventKey: key } })).toBe(1);
});
