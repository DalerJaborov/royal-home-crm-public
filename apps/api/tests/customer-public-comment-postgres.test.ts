import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { customerAgentManifestId } from "../src/lib/customerAgentRevision.js";
import { registerAuthenticatedMetaCustomerRequest } from "../src/lib/customerIngressAuthority.js";
import { persistVerifiedMetaPublicCommentBatch } from "../src/lib/customerPublicCommentProducer.js";
import { loadPublicCommentPrincipal } from "../src/lib/publicCommentSourceIssuer.js";
import { loadPublicCommentSource, publicCommentOrigin, readPublicSourceRow } from "../src/lib/customerPublicCommentStore.js";
import { postManagedPublicCommentReply } from "../src/messengers/comments.js";
import * as meta from "../src/messengers/meta.js";
import { serverPublicCommentSnapshotSchema, type PublicSourceRef } from "@royal-home/shared";
import { createCustomerRolloutFixture } from "./helpers/customerRolloutFixture.js";

// Normal PG: actual HMAC, default store/AEAD/pin/source triggers, P12 part/attempt/job,
// credential fencing and settlement. ONLY physical HTTP response is fake; no model call.
const tag = `public-pg-${randomUUID()}`, sources: string[] = [], accounts: string[] = [], resources: string[] = [];
let settings: Awaited<ReturnType<typeof savedSettings>>, policy: Awaited<ReturnType<typeof savedPolicy>>;
let rollout: Awaited<ReturnType<typeof createCustomerRolloutFixture>>;
const digest = "c".repeat(64);
const manifest = { coreHash: digest, modelSchemaHash: digest, toolSchemaHash: digest, rendererHash: digest, knowledgeSchemaHash: digest,
  knowledgeSourceHash: digest, providerProfileHash: digest, providerPolicyHash: digest, promptHash: digest,
  limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 900_000 } };
const revisionId = customerAgentManifestId(manifest);
function savedSettings() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, botCanAnswerComments: true, botInstagramEnabled: true, metaEnabled: true,
  metaVerifyToken: true,
} }); }
function savedPolicy() { return prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  contractVersion: true, rolloutMode: true, capabilities: true, activeAgentRevisionId: true,
} }); }
async function account(enabled = true) {
  const id = randomUUID(), resource = `${tag}-account-${accounts.length}`, secret = `${tag}-secret-${accounts.length}`;
  await prisma.messengerAccount.create({ data: { id, channel: "INSTAGRAM", externalId: resource, title: "Synthetic public receipt fixture",
    token: encryptSecret(`${tag}-provider-token`), appSecret: encryptSecret(secret), enabled } });
  meta.resetMetaAccountCredsCache();
  accounts.push(id); resources.push(resource);
  if(enabled) await rollout.allowPublic("INSTAGRAM",resource);
  return { id, resource, secret };
}
async function intake(a: Awaited<ReturnType<typeof account>>, commentId = `${tag}-comment-${sources.length}`) {
  const rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: a.resource, changes: [{ field: "comments", value: {
    id: commentId, media: { id: `${tag}-publication` }, from: { id: `${tag}-public-author` }, text: "Нархаш чанд?" } }] }] }));
  const request = { rawBody, get: (name: string) => name === "x-hub-signature-256" ? `sha256=${createHmac("sha256", a.secret).update(rawBody).digest("hex")}` : undefined };
  registerAuthenticatedMetaCustomerRequest(request);
  const result = await persistVerifiedMetaPublicCommentBatch(request);
  if (result.status === "persisted") for (const ref of result.sources) if (!sources.includes(ref.id)) sources.push(ref.id);
  return result;
}
async function fixture(a?: Awaited<ReturnType<typeof account>>) {
  const installed = a ?? await account(), result = await intake(installed);
  expect(result.status).toBe("persisted"); if (result.status !== "persisted" || result.sources.length !== 1) throw new Error("Actual signed source intake failed");
  const ref: PublicSourceRef = result.sources[0];
  const captured = await prisma.instagramComment.findUniqueOrThrow({ where: { id: ref.id }, select: { status: true, note: true } });
  expect(captured.status, `Actual queue eligibility: ${JSON.stringify(captured)}`).toBe("PENDING");
  await prisma.instagramComment.update({ where: { id: ref.id }, data: { status: "WORKING" } });
  const loaded = await loadPublicCommentPrincipal(ref);
  if (loaded.status !== "current") {
    const snapshot = await loadPublicCommentSource(ref), parsed = serverPublicCommentSnapshotSchema.safeParse(snapshot);
    const source = await readPublicSourceRow(ref);
    let originDecoded = false, originTimeCurrent = false;
    try { if (source) { const origin = publicCommentOrigin(source); originDecoded = true;
      originTimeCurrent = Date.now() >= origin.originalReceivedAt && Date.now() < origin.agentPin.providerDeadlineAt; } } catch { /* No raw AEAD error/payload in diagnostics. */ }
    throw new Error(`Actual default principal unavailable: ${JSON.stringify({ reason: loaded.reason, snapshotPresent: snapshot !== null,
      schemaIssues: parsed.success ? [] : parsed.error.issues.map(issue => ({ path: issue.path.join("."), code: issue.code })),
      originDecoded, originTimeCurrent, sourceRevision: source?.sourceRevision, snapshotStatus: snapshot?.status })}`);
  }
  expect(loaded.status).toBe("current");
  return { ref, principal: loaded.value, installed };
}
async function part(sourceId: string) { return prisma.customerOutboxPart.findFirstOrThrow({ where: { sourceKey: `meta:${sourceId}`, sourceKind: "PUBLIC_COMMENT_REPLY" } }); }
function response(body: unknown) { const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })); vi.stubGlobal("fetch", fetch); return fetch; }
beforeAll(async () => {
  settings = await savedSettings(); policy = await savedPolicy();
  await prisma.customerAgentRevision.upsert({ where: { id: revisionId }, create: { id: revisionId, manifestJson: manifest }, update: {} });
  rollout = await createCustomerRolloutFixture(revisionId);
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, botCanAnswerComments: true, botInstagramEnabled: true, metaEnabled: true,
    metaVerifyToken: encryptSecret(`${tag}-verify-token`) } });
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "scoped", rolloutMode: "ACTIVE", capabilities: { publicRead: true }, activeAgentRevisionId: revisionId } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => {
  const rows = await prisma.customerOutboxPart.findMany({ where: { sourceKind: "PUBLIC_COMMENT_REPLY", sourceKey: { in: sources.map(id => `meta:${id}`) } }, select: { id: true } });
  const ids = rows.map(row => row.id);
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: ids.map(id => `customer-outbox-dispatch:${id}`) } } });
  await prisma.customerDeliveryAttempt.deleteMany({ where: { partId: { in: ids } } });
  await prisma.customerOutboxPart.deleteMany({ where: { id: { in: ids } } });
  await prisma.instagramComment.deleteMany({ where: { id: { in: sources } } });
  await prisma.customerEndpointScope.deleteMany({ where: { realmKey: "customer-public", publicResourceId: { in: resources } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accounts } } });
  meta.resetMetaAccountCredsCache();
  if (settings) await prisma.settings.update({ where: { id: "singleton" }, data: settings });
  if (policy) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: policy });
  await rollout?.restore();
  // One content-addressed test manifest is intentionally retained:507 forbids deleting historical revisions.
});
it("signed source default issuer → actual wire ID → common P12 attempt/queue projection, no Inquiry", async () => {
  const f = await fixture(), fetch = response({ id: `${tag}-accepted-1` });
  expect(await postManagedPublicCommentReply(f.principal, "Synthetic public answer")).toBe(`${tag}-accepted-1`);
  const p = await part(f.ref.id), attempt = await prisma.customerDeliveryAttempt.findFirstOrThrow({ where: { partId: p.id } });
  expect(p).toMatchObject({ sourceKind: "PUBLIC_COMMENT_REPLY", inquiryId: null, conversationId: null, ticketEventKey: null,
    originalNativeId: f.ref.id, status: "ACCEPTED", agentRevisionId: revisionId });
  expect(attempt).toMatchObject({ outcome: "ACCEPTED", providerMid: `${tag}-accepted-1`, attemptNo: 1 });
  expect((await prisma.instagramComment.findUniqueOrThrow({ where: { id: f.ref.id } })).replyCommentId).toBe(`${tag}-accepted-1`);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("2xx missingID remains UNKNOWN; note/status reset and another worker cannot repeat POST", async () => {
  const f = await fixture(), fetch = response({ success: true });
  await expect(postManagedPublicCommentReply(f.principal, "Synthetic unknown")).rejects.toMatchObject({ receipt: { outcome: "unknown" } });
  expect((await part(f.ref.id)).status).toBe("UNKNOWN");
  await prisma.instagramComment.update({ where: { id: f.ref.id }, data: { note: "", status: "PENDING" } });
  await prisma.instagramComment.update({ where: { id: f.ref.id }, data: { status: "WORKING" } });
  await expect(postManagedPublicCommentReply(f.principal, "Must never resend")).rejects.toMatchObject({ reason: "source_changed_or_attempt_exists" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("accepted provider ID survives staff/source takeover but never overwrites HIDDEN", async () => {
  const f = await fixture(); const fetch = vi.fn(async () => {
    await prisma.instagramComment.update({ where: { id: f.ref.id }, data: { status: "HIDDEN", note: "manual_hide" } });
    return new Response(JSON.stringify({ id: `${tag}-accepted-stale` }), { status: 200 });
  }); vi.stubGlobal("fetch", fetch);
  await expect(postManagedPublicCommentReply(f.principal, "Original target")).rejects.toMatchObject({ reason: "source_changed_after_post" });
  const p = await part(f.ref.id); expect(p.status).toBe("ACCEPTED"); expect(p.projectionRecordedAt).toBeNull();
  expect(await prisma.instagramComment.findUniqueOrThrow({ where: { id: f.ref.id } })).toMatchObject({ status: "HIDDEN", replyCommentId: null, repliedAt: null });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("same-scope MID collision retains reported observation but releases authoritative UNKNOWN", async () => {
  const a = await account(), one = await fixture(a), two = await fixture(a), fetch = response({ id: `${tag}-same-mid` });
  await postManagedPublicCommentReply(one.principal, "First synthetic");
  await expect(postManagedPublicCommentReply(two.principal, "Second synthetic")).rejects.toMatchObject({ reason: "mid_conflict", receipt: { outcome: "unknown", providerId: null } });
  const p = await part(two.ref.id), attempt = await prisma.customerDeliveryAttempt.findFirstOrThrow({ where: { partId: p.id } });
  expect(p.status).toBe("UNKNOWN"); expect(attempt).toMatchObject({ outcome: "UNKNOWN", reportedMid: `${tag}-same-mid`, providerMid: null });
  expect((await prisma.instagramComment.findUniqueOrThrow({ where: { id: two.ref.id } })).replyText).toBeNull(); expect(fetch).toHaveBeenCalledTimes(2);
});
it("required reconciliation job failure atomically rolls back part+attempt before physical POST", async () => {
  const f = await fixture(), fetch = response({ id: "never-posted" });
  const original = prisma.$transaction.bind(prisma);
  const spy = vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any, options?: any) => {
    if (typeof callback !== "function") return original(callback, options);
    return original(async tx => {
      const failJob = vi.spyOn(tx.backgroundJob, "create").mockRejectedValueOnce(new Error("Synthetic required public job failure"));
      try { return await callback(tx); } finally { failJob.mockRestore(); }
    }, options);
  });
  try { await expect(postManagedPublicCommentReply(f.principal, "No commit")).rejects.toThrow("Synthetic required public job failure"); } finally { spy.mockRestore(); }
  expect(await prisma.customerOutboxPart.count({ where: { sourceKey: `meta:${f.ref.id}` } })).toBe(0); expect(fetch).not.toHaveBeenCalled();
});
it("source revoke during awaited credentials prevents every physical POST", async () => {
  const f = await fixture(), fetch = response({ id: "never-posted" }), original = meta.loadCredentials;
  vi.spyOn(meta, "loadCredentials").mockImplementationOnce(async () => {
    await prisma.instagramComment.update({ where: { id: f.ref.id }, data: { status: "HIDDEN" } }); return original();
  });
  await expect(postManagedPublicCommentReply(f.principal, "Revoked")).rejects.toMatchObject({ receipt: { outcome: "unknown" } });
  expect(fetch).not.toHaveBeenCalled(); expect((await part(f.ref.id)).status).toBe("UNKNOWN");
});
it("same globally unique provider comment cannot be adopted by a different account", async () => {
  const first = await fixture(), other = await account();
  const original = await prisma.instagramComment.findUniqueOrThrow({ where: { id: first.ref.id } });
  expect(await intake(other, original.commentId)).toMatchObject({ status: "held", reason: "origin_changed" });
  const retained = await prisma.instagramComment.findUniqueOrThrow({ where: { id: first.ref.id } });
  expect(retained.accountExternalId).toBe(first.installed.resource); expect(retained.publicOriginCiphertext).toBe(original.publicOriginCiphertext);
});
it("disabled real signed account is archived SKIPPED without a principal/provider send", async () => {
  const a = await account(false), result = await intake(a); expect(result.status).toBe("persisted"); if (result.status !== "persisted") throw new Error("fixture");
  const ref = result.sources[0], row = await prisma.instagramComment.findUniqueOrThrow({ where: { id: ref.id } });
  expect(row.status).toBe("SKIPPED"); expect(row.publicOriginCiphertext).toBeNull();
  expect(await loadPublicCommentPrincipal(ref)).toMatchObject({ status: "held" });
});
it("duplicate source keeps original encrypted pin/time; it never refreshes operation identity", async () => {
  const f = await fixture(), before = await prisma.instagramComment.findUniqueOrThrow({ where: { id: f.ref.id } });
  expect(await intake(f.installed, before.commentId)).toMatchObject({ status: "persisted" });
  const after = await prisma.instagramComment.findUniqueOrThrow({ where: { id: f.ref.id } });
  expect(after.publicOriginCiphertext).toBe(before.publicOriginCiphertext); expect(after.publicOriginCapturedAt).toEqual(before.publicOriginCapturedAt);
});
