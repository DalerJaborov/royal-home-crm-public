import { createHash, createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { registerAuthenticatedMetaCustomerRequest, verifyAndRegisterMetaCustomerIssuer } from "../src/lib/customerIngressAuthority.js";
import { persistVerifiedCustomerIngressBatch } from "../src/lib/customerIngressProducer.js";
import { prepareCustomerDmInboxCoreContext } from "../src/lib/customerDmCoreContext.js";
import { claimCustomerAgentTurnTx, customerAgentClaimCurrentTx, customerAgentClaimAcceptsPrincipal } from "../src/lib/customerAgentClaim.js";
import { customerAgentManifestId, pinCustomerAgentTurnTx } from "../src/lib/customerAgentRevision.js";
import { ensurePublicCommentInstallation } from "../src/lib/customerPublicCommentStore.js";
import { decodePublicOrigin, preparePublicOriginTx } from "../src/lib/customerPublicOrigin.js";
import { publicCommentSourceDigest } from "../src/lib/publicCommentSourceIdentity.js";
import { transitionCustomerState, issueCustomerWriteAuthority } from "../src/lib/customerState.js";
import { revalidateCustomerPrincipal } from "../src/lib/customerPrincipal.js";
import { executeCustomerAction } from "../src/lib/customerActionJournal.js";
import { continueCustomerAgentAfterLocalAuthority } from "../src/lib/customerAgentContinuation.js";
import { createCustomerOutboxPartsTx } from "../src/lib/customerOutbox.js";
import type { PublicCommentTarget, PublicSourceProof } from "@royal-home/shared";
import { createCustomerRolloutFixture } from "./helpers/customerRolloutFixture.js";

// Actual PG + real raw HMAC producer + real recovery + real principal/pin.
// Only bounded profile GET is synthetic. No paid model or physical POST.
// Public low-level cases test storage/AEAD, not HTTP producer authenticity.
const accounts: string[] = [], scopes: string[] = [], events: string[] = [], natives: string[] = [], comments: string[] = [], partIds: string[] = [];
const h = "d".repeat(64), manifest = { coreHash: h, modelSchemaHash: h, toolSchemaHash: h, rendererHash: h,
  knowledgeSchemaHash: h, knowledgeSourceHash: h, providerProfileHash: h, providerPolicyHash: h, promptHash: h,
  limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 120_000 } };
const revisionId = customerAgentManifestId(manifest);
let settings: Awaited<ReturnType<typeof readSettings>>, policy: Awaited<ReturnType<typeof readPolicy>>;
let rollout: Awaited<ReturnType<typeof createCustomerRolloutFixture>>;
function readSettings() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, metaEnabled: true, botInstagramEnabled: true, botCanAnswerComments: true,
} }); }
function readPolicy() { return prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } }); }
async function account() {
  const id = randomUUID(), externalId = `synthetic-agent-own-${randomUUID()}`, secret = `synthetic-agent-key-${randomUUID()}`;
  const token = `synthetic-agent-token-${id}`;
  await prisma.messengerAccount.create({ data: { id, externalId, channel: "INSTAGRAM", username: `synthetic_agency_${id.replaceAll("-", "")}`, title: "Synthetic revision PG",
    token: encryptSecret(token), appSecret: encryptSecret(secret), enabled: true } }); accounts.push(id);
  return { id, externalId, secret, token };
}
async function dmFixture(text = "Здравствуйте") {
  const a = await account(), peer = `synthetic-agent-peer-${randomUUID()}`, mid = randomUUID();
  await rollout.allowDm({peer,accountId:a.id,accountExternalId:a.externalId});
  const rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: a.externalId, messaging: [{
    sender: { id: peer }, recipient: { id: a.externalId }, timestamp: Date.now(), message: { mid, text },
  }] }] }));
  const request = { rawBody, get: () => `sha256=${createHmac("sha256", a.secret).update(rawBody).digest("hex")}` };
  registerAuthenticatedMetaCustomerRequest(request);
  const pending = await persistVerifiedCustomerIngressBatch(request);
  if (pending.status !== "persisted") throw new Error("Synthetic actual intake failed");
  expect(await verifyAndRegisterMetaCustomerIssuer(request, { channel: "INSTAGRAM", accountId: a.id, accountExternalId: a.externalId })).toBe(true);
  const eventKey = pending.tickets[0].eventKey; events.push(eventKey);
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.origin !== "https://graph.instagram.com" || u.pathname !== `/v23.0/${peer}` || u.search !== "?fields=username" ||
        init?.method !== "GET" || (init.headers as Record<string, string>)?.Authorization !== `Bearer ${a.token}`) throw new Error("Unexpected synthetic I/O");
    return new Response(JSON.stringify({ id: peer, username: "synthetic_agent_customer" }));
  }));
  const prepared = await prepareCustomerDmInboxCoreContext(eventKey);
  if (prepared.status !== "prepared") throw new Error(`Synthetic context held: ${prepared.status}:${"reason" in prepared ? prepared.reason : ""}`);
  natives.push(prepared.lane.ticket.conversationId); scopes.push(prepared.lane.principal.scope.endpointScopeId);
  return { ...prepared, eventKey };
}
async function publicFixture() {
  const a = await account(), stamp = await ensurePublicCommentInstallation("INSTAGRAM", a.externalId);
  if (!stamp) throw new Error("Synthetic namespace missing"); scopes.push(stamp.installation.id);
  const row = await prisma.instagramComment.create({ data: { channel: "INSTAGRAM", commentId: `synthetic-comment-${randomUUID()}`,
    mediaId: "synthetic-publication", accountExternalId: a.externalId, authorId: "synthetic-author", text: "Нарх?", replyDueAt: new Date() } }); comments.push(row.id);
  const target: PublicCommentTarget = { channel: "INSTAGRAM", publicationId: row.mediaId, commentId: row.commentId,
    accountExternalId: a.externalId, parentId: null, threadId: row.commentId, threadKind: "comment_anchor" };
  const proof: PublicSourceProof = { version: 1, origin: "meta_verified_comment", installation: stamp.installation,
    source: { table: "meta", id: row.id }, sourceRevision: "0", policyRevision: stamp.policyRevision,
    digest: publicCommentSourceDigest({ source: { table: "meta", id: row.id }, target, text: row.text }) };
  const receivedAt = Date.now();
  const origin = await prisma.$transaction(async tx => {
    const value = await preparePublicOriginTx(tx, { proof, target, originalReceivedAt: receivedAt });
    await tx.instagramComment.update({ where: { id: row.id }, data: { publicOriginVersion: value.version,
      publicOriginCiphertext: value.ciphertext, publicOriginCapturedAt: value.capturedAt } }); return value;
  });
  return { a, row, origin, receivedAt, stamp };
}
beforeAll(async () => {
  settings = await readSettings(); policy = await readPolicy();
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true, botCanAnswerComments: true } });
  await prisma.customerAgentRevision.upsert({ where: { id: revisionId }, create: { id: revisionId, manifestJson: manifest }, update: {} });
  rollout = await createCustomerRolloutFixture(revisionId);
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "scoped", rolloutMode: "ACTIVE",
    capabilities: { publicRead: true, contactWrite: true }, activeAgentRevisionId: revisionId } });
  vi.stubEnv("IG_PROXY_URL", ""); vi.stubEnv("GEMINI_PROXY_URL", ""); vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0");
});
afterAll(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  try {
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: events.map(key => `customer-inbox-consume:${key}`) } } });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: partIds.map(id => `customer-outbox-dispatch:${id}`) } } });
  await prisma.customerDeliveryAttempt.deleteMany({ where: { partId: { in: partIds } } });
  await prisma.customerOutboxPart.deleteMany({ where: { id: { in: partIds } } });
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: events } } });
  await prisma.customerAction.deleteMany({ where: { inquiry: { conversationId: { in: natives } } } });
  await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: natives } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: natives } } });
  await prisma.instagramComment.deleteMany({ where: { id: { in: comments } } });
  await prisma.outboundShieldState.deleteMany({ where: { endpointScope: { messengerAccountId: { in: accounts } } } });
  await prisma.customerEndpointScope.deleteMany({ where: { messengerAccountId: { in: accounts } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accounts } } });
  } finally {
  if (settings) await prisma.settings.update({ where: { id: "singleton" }, data: settings });
  if (policy) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: policy.contractVersion,
    rolloutMode: policy.rolloutMode, capabilities: policy.capabilities!, activeAgentRevisionId: policy.activeAgentRevisionId } });
  await rollout?.restore();
  }
  // Immutable synthetic manifests intentionally survive; the isolated test DB is disposable.
});
describe("durable customer version and real inbox ownership", () => {
  it("two genuine worker claims produce only one owner and retain the original operation", async () => {
    const f = await dmFixture();
    const values = await Promise.all([1, 2].map(() => prisma.$transaction(tx => claimCustomerAgentTurnTx(tx, f.lane.principal))));
    expect(values.filter(value => value.status === "claimed")).toHaveLength(1);
    const winner = values.find(value => value.status === "claimed"); if (winner?.status !== "claimed") throw new Error("No claim");
    expect(await customerAgentClaimCurrentTx(prisma, winner.claim)).toBe(true);
    expect(await customerAgentClaimCurrentTx(prisma, JSON.parse(JSON.stringify(winner.claim)))).toBe(false);
    const stored = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.eventKey } });
    expect(stored.attempts).toBe(1); expect(stored.agentRevisionId).toBe(revisionId);
    expect(stored.providerOperationId).toBe(winner.claim.pin.providerOperationId);
    expect(stored.providerDeadlineAt!.getTime()).toBe(stored.receivedAt.getTime() + manifest.limits.deadlineMs);
    expect(await prisma.aiProviderOperation.count({ where: { id: stored.providerOperationId! } })).toBe(0);
    const ids = await prisma.$transaction(tx => createCustomerOutboxPartsTx(tx, { principal: f.lane.principal,
      agentClaim: winner.claim, parts: [{ payload: { kind: "text", text: "Здравствуйте!" } }] })); partIds.push(...ids);
    expect(await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: ids[0] } })).toMatchObject({ agentRevisionId: revisionId, ticketEventKey: f.eventKey });
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: `customer-outbox-dispatch:${ids[0]}` } })).toBe(1);
    expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.eventKey } })).processingState).toBe("PLANNED");
    expect(await customerAgentClaimCurrentTx(prisma, winner.claim)).toBe(false);
  });
  it("rollback retains no lease; a raw policy change revokes execution while retaining stored A", async () => {
    const f = await dmFixture();
    await expect(prisma.$transaction(async tx => { await claimCustomerAgentTurnTx(tx, f.lane.principal); throw new Error("Synthetic rollback"); })).rejects.toThrow();
    expect(await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.eventKey } })).toMatchObject({ agentRevisionId: null, leaseOwner: null, attempts: 0 });
    const first = await prisma.$transaction(tx => pinCustomerAgentTurnTx(tx, f.lane.principal));
    if (first.status !== "pinned") throw new Error("No real pin");
    const other = { ...manifest, promptHash: "b".repeat(64) }, otherId = customerAgentManifestId(other);
    await prisma.customerAgentRevision.upsert({ where: { id: otherId }, create: { id: otherId, manifestJson: other }, update: {} });
    const beforePolicy = await readPolicy();
    try {
      await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { activeAgentRevisionId: otherId } });
      expect((await readPolicy()).policyRevision).toBeGreaterThan(beforePolicy.policyRevision);
      expect(await prisma.$transaction(tx => pinCustomerAgentTurnTx(tx, f.lane.principal))).toMatchObject({status:"held"});
      const retained=await prisma.customerPropertyIngressTicket.findUniqueOrThrow({where:{eventKey:f.eventKey}});
      expect(retained.agentRevisionId).toBe(revisionId);expect(retained.providerOperationId).toBe(first.pin.providerOperationId);
      expect(retained.providerDeadlineAt?.getTime()).toBe(first.pin.providerDeadlineAt);
      await expect(prisma.customerPropertyIngressTicket.update({ where: { eventKey: f.eventKey }, data: { providerDeadlineAt: new Date(first.pin.providerDeadlineAt + 1) } })).rejects.toThrow();
    } finally { await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { activeAgentRevisionId: revisionId } }); }
  });
  it("a copied principal cannot pin and an actual staff pause revokes the original input", async () => {
    const f = await dmFixture();
    expect(await prisma.$transaction(tx => pinCustomerAgentTurnTx(tx, JSON.parse(JSON.stringify(f.lane.principal))))).toEqual({ status: "held", reason: "invalid_context" });
    await prisma.botConversation.update({ where: { id: f.lane.ticket.conversationId }, data: { pausedUntil: new Date(Date.now() + 60_000), botPausedAt: new Date() } });
    expect(await prisma.$transaction(tx => pinCustomerAgentTurnTx(tx, f.lane.principal))).toEqual({ status: "held", reason: "original_context_changed" });
  });
  it("continues over its genuine local contact intent/receipt while the original principal stays stale", async () => {
    const f = await dmFixture("Мой номер +992 93 344 55 66");
    const elected = await prisma.$transaction(tx => claimCustomerAgentTurnTx(tx, f.lane.principal));
    expect(elected.status).toBe("claimed"); if (elected.status !== "claimed") throw new Error("Original claim unavailable");
    expect(customerAgentClaimAcceptsPrincipal(elected.claim, f.lane.principal)).toBe(true);
    // Trusted intent setup only. This does not test a model's extraction or a
    // complete customer turn; authority/execution use the actual FINAL/PG path.
    const opened = await prisma.$transaction(tx => transitionCustomerState(tx, f.lane.principal.authority.fence,
      { type: "intent", kind: "contact", change: "request", evidenceRefs: [f.eventKey] }));
    expect(opened.status).toBe("applied");
    const authority = await issueCustomerWriteAuthority(f.lane.authenticatedInput, f.lane.ticket, "contact");
    expect(authority).not.toBeNull(); if (!authority) throw new Error("No genuine contact authority");
    expect(await revalidateCustomerPrincipal(f.lane.principal)).toMatchObject({ status: "denied" });
    const continued = await continueCustomerAgentAfterLocalAuthority(f.lane.principal, authority);
    expect(continued.status).toBe("current"); if (continued.status !== "current") throw new Error("Same-IN continuation failed");
    expect(customerAgentClaimAcceptsPrincipal(elected.claim, continued.principal)).toBe(true);
    expect(customerAgentClaimAcceptsPrincipal(elected.claim, JSON.parse(JSON.stringify(continued.principal)))).toBe(false);
    const result = await executeCustomerAction(authority, { name: "save_contact", args: { phone: "+992 93 344 55 66" } });
    expect(result.status).toBe("created");
    expect(await revalidateCustomerPrincipal(continued.principal)).toMatchObject({ status: "denied" });
    const after = await continueCustomerAgentAfterLocalAuthority(continued.principal, authority);
    expect(after.status).toBe("current"); if (after.status === "current") {
      expect(customerAgentClaimAcceptsPrincipal(elected.claim, after.principal)).toBe(true);
      expect(after.principal.admission.eventKey).toBe(f.eventKey);
      expect(after.principal.authority.fence.ownerToken).toBe(f.lane.principal.authority.fence.ownerToken);
      expect(await revalidateCustomerPrincipal(f.lane.principal)).toMatchObject({ status: "denied" });
    }
    expect(await continueCustomerAgentAfterLocalAuthority(continued.principal, JSON.parse(JSON.stringify(authority)))).toMatchObject({ status: "held" });
  });
});
describe("public origin AEAD and immutable source storage", () => {
  it("captures one original time/version/operation; queue claims do not renew it, edits revoke it", async () => {
    const f = await publicFixture(), decoded = decodePublicOrigin(f.origin);
    expect(decoded.originalReceivedAt).toBe(f.receivedAt); expect(decoded.agentPin.agentRevisionId).toBe(revisionId);
    expect(decoded.agentPin.providerDeadlineAt).toBe(f.receivedAt + manifest.limits.deadlineMs);
    expect(() => decodePublicOrigin({ ...f.origin, capturedAt: new Date(f.receivedAt + 1) })).toThrow();
    expect(() => decodePublicOrigin({ ...f.origin, ciphertext: "plain invalid" })).toThrow();
    expect((await prisma.instagramComment.update({ where: { id: f.row.id }, data: { status: "WORKING", attempts: 1 } })).publicSourceRevision).toBe(0n);
    expect((await prisma.instagramComment.update({ where: { id: f.row.id }, data: { text: "Другой вопрос" } })).publicSourceRevision).toBe(1n);
    await expect(prisma.instagramComment.update({ where: { id: f.row.id }, data: { publicOriginCapturedAt: new Date() } })).rejects.toThrow();
    await expect(prisma.customerAgentRevision.update({ where: { id: revisionId }, data: { manifestJson: {} } })).rejects.toThrow();
    await expect(prisma.customerAgentRevision.delete({ where: { id: revisionId } })).rejects.toThrow();
  });
  it("source deletion cancels the original part without erasing an in-flight attempt", async () => {
    const f = await publicFixture(), id = randomUUID(), sourceKey = `meta:${f.row.id}`;
    const text = JSON.stringify({ kind: "text", text: "Салом!" }); partIds.push(id);
    await prisma.customerOutboxPart.create({ data: { id, partKey: createHash("sha256").update(id).digest("hex"),
      sourceKind: "PUBLIC_COMMENT_REPLY", sourceKey, originalNativeId: f.row.id, publicMetaCommentId: f.row.id, publicSourceRevision: 0n,
      agentRevisionId: revisionId, turnKey: `public:meta:${f.row.id}`, ordinal: 0, mode: "LIVE", channel: "INSTAGRAM", endpointScopeId: f.stamp.installation.id,
      transportJson: {}, fenceJson: {}, receiptRefsJson: [], payloadEncrypted: encryptSecret(text), payloadHash: createHash("sha256").update(text).digest("hex"),
      payloadVersion: 1, status: "IN_FLIGHT", claimRevision: 1n, leaseOwner: randomUUID(), leaseUntil: new Date(Date.now() + 30_000) } });
    await prisma.customerDeliveryAttempt.create({ data: { partId: id, endpointScopeId: f.stamp.installation.id, attemptNo: 1, claimRevision: 1n, dispatchFenceJson: {} } });
    await prisma.instagramComment.delete({ where: { id: f.row.id } });
    expect(await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id } })).toMatchObject({ publicMetaCommentId: null,
      originalNativeId: f.row.id, status: "IN_FLIGHT", cancelRequestedAt: expect.any(Date) });
    expect(await prisma.customerDeliveryAttempt.count({ where: { partId: id, outcome: "IN_FLIGHT" } })).toBe(1);
  });
});
