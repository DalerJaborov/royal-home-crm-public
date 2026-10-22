import { createHmac, randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import request from "supertest";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { customerAgentManifestId } from "../src/lib/customerAgentRevision.js";
import { registerAuthenticatedMetaCustomerRequest } from "../src/lib/customerIngressAuthority.js";
import { persistVerifiedMetaPublicCommentBatch } from "../src/lib/customerPublicCommentProducer.js";
import { loadPublicCommentPrincipal } from "../src/lib/publicCommentSourceIssuer.js";
import { postManagedPublicCommentReply } from "../src/messengers/comments.js";
import { claimPublicManualCommentReply } from "../src/lib/customerPublicManualReply.js";
import { createCustomerRolloutFixture } from "./helpers/customerRolloutFixture.js";
import { dispatchCustomerOutboxPart } from "../src/lib/customerDeliveryDispatcher.js";
import * as meta from "../src/messengers/meta.js";
import { cleanupLegacyPhysicalFixture } from "./helpers/cleanupLegacyPhysicalFixture.js";

// Actual HTTP/auth/HMAC/source CAS/P12/PG. Only physical provider response is fake.
const tag = `public-manual-${randomUUID()}`, accountId = randomUUID(), resource = `${tag}-resource`, secret = `${tag}-secret`;
const sources: string[] = [], actors: string[] = [], wireCommentIds: string[] = [];
let token = "", actorId = "";
let originalSettings: Awaited<ReturnType<typeof settingsSnapshot>>, originalPolicy: Awaited<ReturnType<typeof policySnapshot>>;
let rollout: Awaited<ReturnType<typeof createCustomerRolloutFixture>>;
const digest = "d".repeat(64), manifest = { coreHash: digest, modelSchemaHash: digest, toolSchemaHash: digest, rendererHash: digest,
  knowledgeSchemaHash: digest, knowledgeSourceHash: digest, providerProfileHash: digest, providerPolicyHash: digest, promptHash: digest,
  limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 900_000 } };
const revisionId = customerAgentManifestId(manifest);
function settingsSnapshot() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, botCanAnswerComments: true, botInstagramEnabled: true, metaEnabled: true, metaVerifyToken: true,
} }); }
function policySnapshot() { return prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  contractVersion: true, rolloutMode: true, capabilities: true, activeAgentRevisionId: true,
} }); }
async function enable() {
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, botCanAnswerComments: true,
    botInstagramEnabled: true, metaEnabled: true, metaVerifyToken: encryptSecret(`${tag}-verify`) } });
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "scoped", rolloutMode: "ACTIVE",
    capabilities: { publicRead: true }, activeAgentRevisionId: revisionId } });
  await prisma.agent.update({ where: { id: actorId }, data: { isActive: true } });
}
async function source() {
  await enable();
  await rollout.allowPublic("INSTAGRAM", resource);
  const wireCommentId = `${tag}-${sources.length}`;
  const rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: resource, changes: [{ field: "comments", value: {
    id: wireCommentId, media: { id: `${tag}-publication` }, from: { id: `${tag}-public-author` }, text: "Цена?" } }] }] }));
  const req = { rawBody, get: (name: string) => name === "x-hub-signature-256" ? `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` : undefined };
  registerAuthenticatedMetaCustomerRequest(req);
  const intake = await persistVerifiedMetaPublicCommentBatch(req); expect(intake.status).toBe("persisted");
  if (intake.status !== "persisted" || intake.sources.length !== 1) throw new Error("Actual signed fixture intake failed");
  const ref = intake.sources[0]; sources.push(ref.id); wireCommentIds.push(wireCommentId);
  expect((await prisma.instagramComment.findUniqueOrThrow({ where: { id: ref.id } })).status).toBe("PENDING");
  return ref;
}
function fakeProvider(body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })); vi.stubGlobal("fetch", fetch); return fetch;
}
function reply(id: string) { return request(app).post(`/api/v1/instagram-comments/${id}/reply`).set("Authorization", `Bearer ${token}`).send({ text: "Synthetic staff public reply" }); }
beforeAll(async () => {
  originalSettings = await settingsSnapshot(); originalPolicy = await policySnapshot();
  const password = "Synthetic-public-manual-password", agent = await prisma.agent.create({ data: {
    fullName: "Synthetic public manual director", phone: `+9929${Date.now()}`, role: "DIRECTOR", passwordHash: await bcrypt.hash(password, 4),
  } }); actorId = agent.id; actors.push(agent.id);
  const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password }); expect(login.status).toBe(200); token = login.body.accessToken;
  await prisma.customerAgentRevision.upsert({ where: { id: revisionId }, create: { id: revisionId, manifestJson: manifest }, update: {} });
  rollout = await createCustomerRolloutFixture(revisionId);
  await prisma.messengerAccount.create({ data: { id: accountId, channel: "INSTAGRAM", externalId: resource,
    title: "Synthetic manual comment fixture", token: encryptSecret(`${tag}-token`), appSecret: encryptSecret(secret), enabled: true } });
  meta.resetMetaAccountCredsCache();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => {
  await cleanupLegacyPhysicalFixture({ publicMetaCommentIds: wireCommentIds });
  const parts = await prisma.customerOutboxPart.findMany({ where: { sourceKind: { in: ["PUBLIC_COMMENT_REPLY", "STAFF_PUBLIC_COMMENT_REPLY"] }, sourceKey: { in: sources.map(id => `meta:${id}`) } }, select: { id: true } });
  const ids = parts.map(row => row.id);
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: ids.map(id => `customer-outbox-dispatch:${id}`) } } });
  await prisma.customerDeliveryAttempt.deleteMany({ where: { partId: { in: ids } } });
  await prisma.customerOutboxPart.deleteMany({ where: { id: { in: ids } } });
  await prisma.instagramComment.deleteMany({ where: { id: { in: sources } } });
  await prisma.customerEndpointScope.deleteMany({ where: { realmKey: "customer-public", publicResourceId: resource } });
  await prisma.messengerAccount.deleteMany({ where: { id: accountId } }); meta.resetMetaAccountCredsCache();
  await prisma.auditLog.deleteMany({ where: { agentId: { in: actors } } });
  await prisma.session.deleteMany({ where: { agentId: { in: actors } } });
  await prisma.agent.deleteMany({ where: { id: { in: actors } } });
  if (originalSettings) await prisma.settings.update({ where: { id: "singleton" }, data: originalSettings });
  if (originalPolicy) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: originalPolicy });
  if (rollout) await rollout.restore();
  // Immutable content-addressed manifest retained under507; no bypass/delete of version evidence.
});
it("prior UNKNOWN PUBLIC part blocks manual reply after note/status reset and policy OFF", async () => {
  const ref = await source(); await prisma.instagramComment.update({ where: { id: ref.id }, data: { status: "WORKING" } });
  const principal = await loadPublicCommentPrincipal(ref); if (principal.status !== "current") throw new Error(`fixture principal ${principal.reason}`);
  const fetch = fakeProvider({ success: true });
  await expect(postManagedPublicCommentReply(principal.value, "Synthetic bot reply")).rejects.toMatchObject({ receipt: { outcome: "unknown" } });
  await prisma.instagramComment.update({ where: { id: ref.id }, data: { status: "PENDING", note: "staff overwrote note" } });
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { rolloutMode: "OFF", contractVersion: "compat" } });
  const result = await reply(ref.id); expect(result.status).toBe(409); expect(result.body.code).toBe("PUBLIC_REPLY_HELD"); expect(fetch).toHaveBeenCalledTimes(1);
});
it("fresh staff takeover works with bot OFF and prevents later bot/manual replay by source revision", async () => {
  const ref = await source(), original = await prisma.instagramComment.findUniqueOrThrow({ where: { id: ref.id } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: false } });
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { rolloutMode: "OFF" } });
  const fetch = fakeProvider({ id: `${tag}-staff-accepted` }), result = await reply(ref.id); expect(result.status).toBe(200);
  const row = await prisma.instagramComment.findUniqueOrThrow({ where: { id: ref.id } });
  expect(row).toMatchObject({ status: "REPLIED", replyCommentId: `${tag}-staff-accepted`, note: "manual_reply" });
  expect(row.publicSourceRevision).toBeGreaterThan(original.publicSourceRevision); expect(row.publicOriginCiphertext).toBe(original.publicOriginCiphertext);
  await prisma.instagramComment.update({ where: { id: ref.id }, data: { status: "PENDING", note: "" } });
  expect((await reply(ref.id)).status).toBe(409); expect(fetch).toHaveBeenCalledTimes(1);
});
it("two concurrent manual requests have exactly one actual provider POST", async () => {
  const ref = await source(), fetch = fakeProvider({ id: `${tag}-concurrent` });
  const results = await Promise.all([reply(ref.id), reply(ref.id)]); expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("staff token comes from captured installation, never a different cached/global token", async () => {
  const ref = await source(), original = meta.loadCredentials;
  vi.spyOn(meta, "loadCredentials").mockImplementationOnce(async () => ({ ...await original(), igToken: "synthetic-wrong-default-token" }));
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization") === `Bearer ${tag}-token` || new URL(String(url)).searchParams.get("access_token") === `${tag}-token`).toBe(true);
    return new Response(JSON.stringify({ id: `${tag}-exact-token` }), { status: 200 });
  }); vi.stubGlobal("fetch", fetch);
  expect((await reply(ref.id)).status).toBe(200); expect(fetch).toHaveBeenCalledTimes(1);
});
it("staff source CAS fences an already issued bot principal before any bot POST", async () => {
  const ref = await source(), principal = await loadPublicCommentPrincipal(ref);
  if (principal.status !== "current") throw new Error(`fixture principal ${principal.reason}`);
  const fetch = vi.fn(async () => {
    await expect(postManagedPublicCommentReply(principal.value, "Must not race staff")).rejects.toMatchObject({ reason: "source_changed_or_attempt_exists" });
    return new Response(JSON.stringify({ id: `${tag}-staff-wins` }), { status: 200 });
  }); vi.stubGlobal("fetch", fetch);
  expect((await reply(ref.id)).status).toBe(200); expect(fetch).toHaveBeenCalledTimes(1);
  expect(await prisma.customerOutboxPart.count({ where: { sourceKind: "PUBLIC_COMMENT_REPLY", sourceKey: `meta:${ref.id}` } })).toBe(0);
});
it("staff revoked during awaited credentials produces zero provider POST", async () => {
  const ref = await source(), fetch = fakeProvider({ id: "never-posted" }), original = meta.loadCredentials;
  vi.spyOn(meta, "loadCredentials").mockImplementationOnce(async () => {
    await prisma.agent.update({ where: { id: actorId }, data: { isActive: false } }); return original();
  });
  const result = await reply(ref.id); expect(result.status).toBe(403); expect(result.body.code).toBe("STAFF_PERMISSION_CHANGED"); expect(fetch).not.toHaveBeenCalled();
});
it("2xx without provider ID leaves a held staff claim and no REPLIED/repliedAt; reset cannot resend", async () => {
  const ref = await source(), fetch = fakeProvider({ success: true });
  const result = await reply(ref.id); expect(result.status).toBe(502); expect(result.body.code).toBe("PUBLIC_REPLY_UNKNOWN");
  expect(await prisma.instagramComment.findUniqueOrThrow({ where: { id: ref.id } })).toMatchObject({ status: "WORKING_STAFF", replyCommentId: null, repliedAt: null });
  await prisma.instagramComment.update({ where: { id: ref.id }, data: { status: "PENDING", note: "" } });
  expect((await reply(ref.id)).status).toBe(409); expect(fetch).toHaveBeenCalledTimes(1);
});

async function staffPart(id: string) { return prisma.customerOutboxPart.findFirstOrThrow({ where: { sourceKind: "STAFF_PUBLIC_COMMENT_REPLY", sourceKey: `meta:${id}` } }); }
it("staff source CAS + immutable part/attempt/required reconciliation job are committed BEFORE physical POST", async () => {
  const ref = await source();
  const fetch = vi.fn(async () => {
    const part = await staffPart(ref.id), attempt = await prisma.customerDeliveryAttempt.findFirstOrThrow({ where: { partId: part.id } });
    expect(part).toMatchObject({ status: "IN_FLIGHT", agentRevisionId: null, p03Json: null, inquiryId: null, conversationId: null, ticketEventKey: null });
    expect(part.receiptRefsJson).toEqual([]); expect(attempt).toMatchObject({ outcome: "IN_FLIGHT", attemptNo: 1 });
    expect(await prisma.backgroundJob.findUnique({ where: { dedupeKey: `customer-outbox-dispatch:${part.id}` } })).not.toBeNull();
    expect((await prisma.instagramComment.findUniqueOrThrow({ where: { id: ref.id } })).status).toBe("WORKING_STAFF");
    return new Response(JSON.stringify({ id: `${tag}-committed-before-post` }), { status: 200 });
  }); vi.stubGlobal("fetch", fetch);
  expect((await reply(ref.id)).status).toBe(200); expect(fetch).toHaveBeenCalledTimes(1);
});
it("required job failure rolls back source takeover + part + attempt and prevents every POST", async () => {
  const ref = await source(), before = await prisma.instagramComment.findUniqueOrThrow({ where: { id: ref.id } }), fetch = fakeProvider({ id: "never-posted" });
  const original = prisma.$transaction.bind(prisma);
  const spy = vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any, options?: any) => {
    if (typeof callback !== "function") return original(callback, options);
    return original(async tx => {
      const fault = vi.spyOn(tx.backgroundJob, "create").mockRejectedValueOnce(new Error("Synthetic required staff public job failure"));
      try { return await callback(tx); } finally { fault.mockRestore(); }
    }, options);
  });
  let result; try { result = await reply(ref.id); } finally { spy.mockRestore(); }
  expect(result.status).toBe(502); expect(fetch).not.toHaveBeenCalled();
  expect(await prisma.customerOutboxPart.count({ where: { sourceKey: `meta:${ref.id}` } })).toBe(0);
  const after = await prisma.instagramComment.findUniqueOrThrow({ where: { id: ref.id } });
  expect(after.status).toBe("PENDING"); expect(after.publicSourceRevision).toBe(before.publicSourceRevision); expect(after.publicOriginCiphertext).toBe(before.publicOriginCiphertext);
});
it("accepted staff MID survives source takeover and is never rewritten into unknown or a new reply", async () => {
  const ref = await source();
  const fetch = vi.fn(async () => {
    await prisma.instagramComment.update({ where: { id: ref.id }, data: { status: "HIDDEN", note: "manual_hide" } });
    return new Response(JSON.stringify({ id: `${tag}-accepted-takeover` }), { status: 200 });
  }); vi.stubGlobal("fetch", fetch);
  const response = await reply(ref.id); expect(response.status).toBe(202); expect(response.body).toMatchObject({ deliveryStatus: "ACCEPTED", projectionPending: true });
  const part = await staffPart(ref.id); expect(part.status).toBe("ACCEPTED"); expect(part.projectionRecordedAt).toBeNull();
  expect(await prisma.customerDeliveryAttempt.findFirstOrThrow({ where: { partId: part.id } })).toMatchObject({ outcome: "ACCEPTED", providerMid: `${tag}-accepted-takeover` });
  expect(await prisma.instagramComment.findUniqueOrThrow({ where: { id: ref.id } })).toMatchObject({ status: "HIDDEN", replyCommentId: null });
  expect(await dispatchCustomerOutboxPart(part.id)).toMatchObject({ status: "accepted", projectionPending: true }); expect(fetch).toHaveBeenCalledTimes(1);
});
it("accepted response + local projection DB failure retains receipt; fresh reconciler repairs without another POST", async () => {
  const ref = await source(), fetch = fakeProvider({ id: `${tag}-accepted-repair` }), original = prisma.$transaction.bind(prisma);
  const spy = vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any, options?: any) => {
    if (typeof callback !== "function") return original(callback, options);
    return original(async tx => {
      const update = tx.instagramComment.updateMany.bind(tx.instagramComment);
      const fault = vi.spyOn(tx.instagramComment, "updateMany").mockImplementation(async (args: any) => {
        if (args.where?.status === "WORKING_STAFF") throw new Error("Synthetic post-acceptance projection failure");
        return update(args);
      });
      try { return await callback(tx); } finally { fault.mockRestore(); }
    }, options);
  });
  let response; try { response = await reply(ref.id); } finally { spy.mockRestore(); }
  expect(response.status).toBe(202); const part = await staffPart(ref.id);
  expect(part.status).toBe("ACCEPTED"); expect(part.projectionRecordedAt).toBeNull();
  expect(await prisma.customerDeliveryAttempt.findFirstOrThrow({ where: { partId: part.id } })).toMatchObject({ outcome: "ACCEPTED", providerMid: `${tag}-accepted-repair` });
  // Dispatcher takes only persisted row/fence/attempt, no original opaque staff claim or renewed authority.
  expect(await dispatchCustomerOutboxPart(part.id)).toEqual({ status: "accepted" });
  expect(await prisma.instagramComment.findUniqueOrThrow({ where: { id: ref.id } })).toMatchObject({ status: "REPLIED", replyCommentId: `${tag}-accepted-repair` });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("started staff attempt with lost process/response becomes UNKNOWN and cannot be retried", async () => {
  const ref = await source(), fetch = fakeProvider({ id: "never-posted" });
  await claimPublicManualCommentReply(ref.id, actorId, "Synthetic lost process");
  const part = await staffPart(ref.id);
  await prisma.customerOutboxPart.update({ where: { id: part.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
  expect(await dispatchCustomerOutboxPart(part.id)).toEqual({ status: "unknown" });
  expect(await prisma.customerDeliveryAttempt.findFirstOrThrow({ where: { partId: part.id } })).toMatchObject({ outcome: "UNKNOWN", providerMid: null, attemptNo: 1 });
  expect((await reply(ref.id)).status).toBe(409); expect(fetch).not.toHaveBeenCalled();
});
it("physical retry callback cannot make a second POST under one staff attempt", async () => {
  const ref = await source();
  const fetch = vi.fn(async () => { throw Object.assign(new Error("Synthetic connection refused"), { cause: { code: "ECONNREFUSED" } }); });
  vi.stubGlobal("fetch", fetch);
  expect((await reply(ref.id)).status).toBe(409); expect(fetch).toHaveBeenCalledTimes(1);
  const part = await staffPart(ref.id); expect(part.status).toBe("UNKNOWN"); expect(await prisma.customerDeliveryAttempt.count({ where: { partId: part.id } })).toBe(1);
});
it("credential scope ABA after token capture denies POST and retains one UNKNOWN staff attempt", async () => {
  const ref = await source(), fetch = fakeProvider({ id: "never-posted" }), original = meta.loadCredentials;
  vi.spyOn(meta, "loadCredentials").mockImplementationOnce(async () => {
    const row = await prisma.messengerAccount.findUniqueOrThrow({ where: { id: accountId } });
    await prisma.messengerAccount.update({ where: { id: accountId }, data: { token: encryptSecret("synthetic-rotated-token") } });
    await prisma.messengerAccount.update({ where: { id: accountId }, data: { token: row.token } });
    return original();
  });
  expect((await reply(ref.id)).status).toBe(409); expect(fetch).not.toHaveBeenCalled();
  expect((await staffPart(ref.id)).status).toBe("UNKNOWN");
});
it("source deletion after observed POST keeps the original accepted receipt and reconciliation never resends", async () => {
  const ref = await source();
  const fetch = vi.fn(async () => {
    await prisma.instagramComment.delete({ where: { id: ref.id } });
    return new Response(JSON.stringify({ id: `${tag}-accepted-deleted-source` }), { status: 200 });
  }); vi.stubGlobal("fetch", fetch);
  const response = await reply(ref.id); expect(response.status).toBe(202);
  const part = await staffPart(ref.id); expect(part.status).toBe("ACCEPTED"); expect(part.publicMetaCommentId).toBeNull(); expect(part.cancelRequestedAt).not.toBeNull();
  expect(await prisma.customerDeliveryAttempt.findFirstOrThrow({ where: { partId: part.id } })).toMatchObject({ outcome: "ACCEPTED", providerMid: `${tag}-accepted-deleted-source` });
  expect(await dispatchCustomerOutboxPart(part.id)).toMatchObject({ status: "accepted", projectionPending: true }); expect(fetch).toHaveBeenCalledTimes(1);
});
