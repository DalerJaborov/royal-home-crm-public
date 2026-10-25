// Normal PG integration: real original source, action, HOLD and dedicated ACK purpose.
import type { Request } from "express";
import { customerHandoverAckText } from "@royal-home/shared";
import { claimCustomerAgentTurnTx } from "../src/lib/customerAgentClaim.js";
import { issueCustomerWriteAuthority, loadCustomerStateSnapshot, assertCustomerFence } from "../src/lib/customerState.js";
import { openAuthenticatedCustomerMutationIntent } from "../src/lib/customerMutationIntent.js";
import { continueCustomerAgentAfterLocalAuthority } from "../src/lib/customerAgentContinuation.js";
import { executeCustomerAction } from "../src/lib/customerActionJournal.js";
import { captureCustomerHandoverAckSourceTx, issueCustomerHandoverAckTx, planCustomerHandoverAckTx } from "../src/lib/customerHandoverAck.js";
import * as handoverAck from "../src/lib/customerHandoverAck.js";
import * as actionJournal from "../src/lib/customerActionJournal.js";
import { dispatchCustomerOutboxPart, holdExpiredCustomerDeliveryClaims } from "../src/lib/customerDeliveryDispatcher.js";
import { inspectCustomerDeliveryObservation } from "../src/lib/customerDeliveryObservation.js";
import { recoverAndFinalizeCustomerInboxInput } from "../src/lib/customerIngressRecovery.js";
import { transitionManagedCustomerCallback } from "../src/lib/customerCallbackLifecycle.js";
import * as settlement from "../src/lib/customerDeliverySettlement.js";
const parts: string[] = [], staffIds: string[] = [];
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { customerAgentManifestId } from "../src/lib/customerAgentRevision.js";
import { registerAuthenticatedMetaCustomerRequest } from "../src/lib/customerIngressAuthority.js";
import { persistVerifiedCustomerIngressBatch } from "../src/lib/customerIngressProducer.js";
import { prepareCustomerDmInboxCoreContext } from "../src/lib/customerDmCoreContext.js";
import { createCustomerAgentMutationSession } from "../src/lib/customerAgentMutationSession.js";
import { inspectCustomerWriteAuthority } from "../src/lib/customerState.js";
import { loadCustomerActionReceipt } from "../src/lib/customerActionJournal.js";
import { revalidateCustomerPrincipal } from "../src/lib/customerPrincipal.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";
import { GRAPH_VERSION } from "../src/messengers/metaGraph.js";
import { createCustomerRolloutFixture } from "./helpers/customerRolloutFixture.js";

// Normal PG: real raw HMAC → durable producer → FINAL recovery → recorded IN →
// actual principal/intent/authority/kernel/receipt continuation. ONLY bounded
// username GET is fake; unexpected/paid/provider POSTs throw. No forged grants.
const accounts: string[] = [], events: string[] = [], natives: string[] = [], peers: string[] = [], profileIds: string[] = [];
let savedSettings: Awaited<ReturnType<typeof settingsSnapshot>>, savedPolicy: Awaited<ReturnType<typeof policySnapshot>>;
let rollout: Awaited<ReturnType<typeof createCustomerRolloutFixture>>;
const hash = "8".repeat(64), manifest = { coreHash: hash, modelSchemaHash: hash, toolSchemaHash: hash, rendererHash: hash,
  knowledgeSchemaHash: hash, knowledgeSourceHash: hash, providerProfileHash: hash, providerPolicyHash: hash, promptHash: hash,
  limits: { maxRounds: 3, maxToolCalls: 4, maxInputChars: 20_000, maxOutputChars: 2000, maxModelOutputTokens: 1024, deadlineMs: 120_000 } };
const revisionId = customerAgentManifestId(manifest);
function settingsSnapshot() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, metaEnabled: true, botInstagramEnabled: true, metaVerifyToken: true,
} }); }
function policySnapshot() { return prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  contractVersion: true, rolloutMode: true, capabilities: true, activeAgentRevisionId: true,
} }); }
function phone() { return `+99293${randomInt(1_000_000, 9_999_999)}`; }
function wait() { return { signal: new AbortController().signal, deadlineAt: Date.now() + 90_000 }; }
async function fixture(text: string) {
  const id = randomUUID(), externalId = `mutation-account-${id}`, secret = `mutation-secret-${id}`, token = `mutation-token-${id}`;
  await prisma.messengerAccount.create({ data: { id, channel: "INSTAGRAM", externalId, title: "Synthetic mutation session",
    username: `mutation_agency_${id.replaceAll("-", "")}`, token: encryptSecret(token), appSecret: encryptSecret(secret), enabled: true } });
  accounts.push(id); resetAccountsCache();
  const peer = `mutation-peer-${randomUUID()}`, mid = randomUUID(); peers.push(peer);
  await rollout.allowDm({ peer, accountId: id, accountExternalId: externalId });
  const rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: externalId, messaging: [{
    sender: { id: peer }, recipient: { id: externalId }, timestamp: Date.now(), message: { mid, text },
  }] }] }));
  const request = { rawBody, get: () => `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` };
  registerAuthenticatedMetaCustomerRequest(request);
  const admitted = await persistVerifiedCustomerIngressBatch(request);
  if (admitted.status !== "persisted" || admitted.tickets.length !== 1) throw new Error("Actual mutation fixture intake unavailable");
  const eventKey = admitted.tickets[0].eventKey; events.push(eventKey);
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = new URL(String(url)), headers = new Headers(init?.headers);
    if (u.origin !== "https://graph.instagram.com" || u.pathname !== `/${GRAPH_VERSION}/${peer}` || u.search !== "?fields=username" ||
        init?.method !== "GET" || headers.get("Authorization") !== `Bearer ${token}`) throw new Error("Unexpected mutation fixture I/O");
    return new Response(JSON.stringify({ id: peer, username: "synthetic_mutation_customer" }));
  }); vi.stubGlobal("fetch", fetch);
  const prepared = await prepareCustomerDmInboxCoreContext(eventKey);
  if (prepared.status !== "prepared") throw new Error(`Actual mutation fixture context held: ${prepared.status}:${"reason" in prepared ? prepared.reason : ""}`);
  const lane = prepared.lane; natives.push(lane.ticket.conversationId);
  const native = await prisma.botConversation.findUniqueOrThrow({ where: { id: lane.ticket.conversationId }, select: { contactProfileId: true } });
  if (native.contactProfileId) profileIds.push(native.contactProfileId);
  const created = await createCustomerAgentMutationSession(lane);
  if (created.status !== "ready") throw new Error(`Actual mutation session held: ${created.reason}`);
  return { lane, session: created.session, inquiryId: lane.principal.authority.fence.inquiryId, fetch, accountId: id, token, externalId, secret, peer };
}
async function zeroEffects(inquiryId: string) { expect(await prisma.customerAction.count({ where: { inquiryId } })).toBe(0); }
beforeAll(async () => {
  savedSettings = await settingsSnapshot(); savedPolicy = await policySnapshot();
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true,
    metaVerifyToken: encryptSecret("synthetic-mutation-verify-token") } });
  await prisma.customerAgentRevision.upsert({ where: { id: revisionId }, create: { id: revisionId, manifestJson: manifest }, update: {} });
  rollout = await createCustomerRolloutFixture(revisionId);
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "scoped", rolloutMode: "ACTIVE",
    capabilities: { publicRead: true, contactWrite: true, callbackWrite: true, handoverWrite: true }, activeAgentRevisionId: revisionId } });
  vi.stubEnv("IG_PROXY_URL", ""); vi.stubEnv("GEMINI_PROXY_URL", ""); vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => {
  const actions = await prisma.customerAction.findMany({ where: { inquiry: { conversationId: { in: natives } } }, select: { id: true } });
  const ids = actions.map(row => row.id);
  const ownedParts = await prisma.customerOutboxPart.findMany({ where: { id: { in: parts } }, select: { id: true } });
  const mids = await prisma.customerDeliveryAttempt.findMany({ where: { partId: { in: ownedParts.map(p=>p.id) } }, select: { providerMid: true } });
  await prisma.processedMessage.deleteMany({ where: { channel: "out:meta", messageId: { in: mids.flatMap(p=>p.providerMid?[p.providerMid]:[]) } } });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: parts.map(id=>`customer-outbox-dispatch:${id}`) } } });
  await prisma.customerDeliveryAttempt.deleteMany({ where: { partId: { in: parts } } });
  await prisma.customerOutboxPart.deleteMany({ where: { id: { in: parts } } });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: [...events.map(key => `customer-inbox-consume:${key}`), ...ids.map(id => `customer-callback-notify:${id}`)] } } });
  await prisma.callbackRequest.deleteMany({ where: { customerActionId: { in: ids } } });
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: events } } });
  await prisma.customerAction.deleteMany({ where: { id: { in: ids } } });
  await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: natives } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: natives } } });
  await prisma.outboundShieldState.deleteMany({ where: { endpointScope: { messengerAccountId: { in: accounts } } } });
  const ownedIdentity = { kind: "IG_ID", value: { in: peers } };
  await prisma.contactProfile.deleteMany({ where: { id: { in: profileIds }, clientId: null, mergedIntoId: null,
    identities: { some: ownedIdentity, every: ownedIdentity }, botConversations: { none: {} }, telegramConversations: { none: {} },
    telegramDirectConversations: { none: {} }, incomingCalls: { none: {} }, jobApplications: { none: {} }, mergedFrom: { none: {} },
    linkCandidatesLeft: { none: {} }, linkCandidatesRight: { none: {} }, mergesIn: { none: {} }, mergesOut: { none: {} } } });
  await prisma.customerEndpointScope.deleteMany({ where: { messengerAccountId: { in: accounts } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accounts } } }); resetAccountsCache();
  await prisma.agent.deleteMany({ where: { id: { in: staffIds } } });
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  if (savedPolicy) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: savedPolicy });
  if (rollout) await rollout.restore();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  // Content-addressed fixture manifest retained; historical no-delete guard is not bypassed.
});
// PRIVATE body appended to the existing genuine mutation-session PG fixture;
// prepare-test-draft.cjs produces standalone file without editing that fixture.
async function handover() {
  const f = await fixture("Мне не звонили"), command = { name: "request_handover", args: { topic: "Мне не звонили" } };
  const elected = await prisma.$transaction(tx => claimCustomerAgentTurnTx(tx, f.lane.principal));
  if (elected.status !== "claimed") throw new Error(`ACK fixture claim denied: ${elected.status}`);
  expect(await openAuthenticatedCustomerMutationIntent(f.lane.authenticatedInput, f.lane.ticket, command)).toBe("opened");
  const authority = await issueCustomerWriteAuthority(f.lane.authenticatedInput, f.lane.ticket, "handover");
  if (!authority) throw new Error("Actual handover write authority missing");
  const continued = await continueCustomerAgentAfterLocalAuthority(f.lane.principal, authority);
  if (continued.status !== "current") throw new Error(`Actual own intent continuation denied: ${continued.reason}`);
  const source = await prisma.$transaction(tx => captureCustomerHandoverAckSourceTx(tx, {
    principal: continued.principal, authority, claim: elected.claim, language: "ru",
  }));
  if (!source) throw new Error("Genuine pre-execute ACK source missing");
  const committed = await executeCustomerAction(authority, command);
  if (committed.status !== "created") throw new Error(`Actual handover commit failed: ${committed.status}`);
  return { ...f, source, receipt: committed.receipt, authority, claim: elected.claim, preExecutePrincipal: continued.principal };
}
async function plan(f: Awaited<ReturnType<typeof handover>>) {
  return prisma.$transaction(async tx => {
    const ack = await issueCustomerHandoverAckTx(tx, f.source, f.receipt);
    if (!ack) return null;
    expect(inspectCustomerWriteAuthority(ack)).toBeNull(); // no ordinary action authority
    const id = await planCustomerHandoverAckTx(tx, ack); parts.push(id); return id;
  });
}
function wire(f: Awaited<ReturnType<typeof handover>>, outcome: "accepted" | "empty" | "timeout" = "accepted") {
  const post = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = new URL(String(url));
    if (init?.method !== "POST" || u.origin !== "https://graph.instagram.com" || u.pathname !== `/${GRAPH_VERSION}/me/messages` ||
        new Headers(init.headers).get("Authorization") !== `Bearer ${f.token}`) throw new Error("Unexpected ACK wire");
    const body = JSON.parse(String(init.body));
    expect(body.recipient).toEqual({ id: f.peer });
    expect(body.message.text).toBe(customerHandoverAckText("ru"));
    if (outcome === "timeout") throw new Error("Synthetic timeout AFTER physical POST started");
    return new Response(JSON.stringify(outcome === "empty" ? {} : { message_id: `ack-mid-${randomUUID()}` }));
  });
  vi.stubGlobal("fetch", post); return post;
}
it("real handover task+required notify job commits before ACK Part; ACK sends once with no BOT revival or write grant", async () => {
  const f = await handover(), id = await plan(f); expect(id).not.toBeNull();
  const task = await prisma.callbackRequest.findUniqueOrThrow({ where: { customerActionId: f.receipt.actionId } });
  expect(task).toMatchObject({ requestKind: "HUMAN", lifecycleStatus: "QUEUED", lifecycleRevision: 1n });
  expect(await prisma.backgroundJob.findUnique({ where: { dedupeKey: `customer-callback-notify:${f.receipt.actionId}` } })).not.toBeNull();
  const post = wire(f);
  expect(await dispatchCustomerOutboxPart(id!)).toMatchObject({ status: "accepted" });
  expect(await dispatchCustomerOutboxPart(id!)).toMatchObject({ status: "accepted" }); expect(post).toHaveBeenCalledTimes(1);
  const row = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: id! } });
  expect(row.sourceKind).toBe("HANDOVER_ACK"); expect(row.receiptRefsJson).toEqual([f.receipt]);
  const current = await prisma.customerInquiry.findUniqueOrThrow({ where: { id: f.inquiryId } });
  expect(current.ownerMode).toBe("HOLD"); expect(current.ownerAgentId).toBeNull();
  const hold = await loadCustomerStateSnapshot({ inquiryId: f.inquiryId }); if (!hold) throw new Error("Actual HOLD snapshot missing");
  expect((await assertCustomerFence(prisma, hold.fence, "outbound")).status).toBe("denied");
  expect(await issueCustomerWriteAuthority(f.lane.authenticatedInput, f.lane.ticket, "contact")).toBeNull();
  expect((await revalidateCustomerPrincipal(f.lane.principal)).status).not.toBe("current");
  expect(await prisma.customerAction.count({ where: { inquiryId: f.inquiryId } })).toBe(1);
  const attempt = await prisma.customerDeliveryAttempt.findFirstOrThrow({ where: { partId: id! } });
  expect(await inspectCustomerDeliveryObservation({ endpointScopeId: row.endpointScopeId,
    peerId: f.peer, mid: attempt.providerMid! })).toMatchObject({ status: "known_own", partId: id });
});
it.each(["closed", "staff", "credentialABA", "optout", "OFF"] as const)("%s after plan revokes ACK and causes zero physical POST", async change => {
  const f = await handover(), id = await plan(f); expect(id).not.toBeNull();
  if (change === "closed") {
    const staff = await prisma.agent.create({ data: { fullName: "Synthetic ACK staff", phone: `ack-staff-${randomUUID()}`,
      role: "ADMIN", passwordHash: "not-a-login-hash" } }); staffIds.push(staff.id);
    const req = { agent: { id: staff.id, role: "ADMIN", permissions: new Set(["messages.view","clients.assign"]) } };
    expect((await transitionManagedCustomerCallback(req as unknown as Request,
      { requestId: f.receipt.resourceId, expectedRevision: "1", action: "close" })).status).toBe("applied");
  } else if (change === "staff") {
    const staff = await prisma.agent.create({ data: { fullName: "Synthetic ACK staff", phone: `ack-staff-${randomUUID()}`,
      role: "ADMIN", passwordHash: "not-a-login-hash" } }); staffIds.push(staff.id);
    const req = { agent: { id: staff.id, role: "ADMIN", permissions: new Set(["messages.view"]) } };
    expect((await transitionManagedCustomerCallback(req as unknown as Request,
      { requestId: f.receipt.resourceId, expectedRevision: "1", action: "accept" })).status).toBe("applied");
  } else if (change === "credentialABA") {
    const old = await prisma.messengerAccount.findUniqueOrThrow({ where: { id: f.accountId }, select: { token: true } });
    await prisma.messengerAccount.update({ where: { id: f.accountId }, data: { token: encryptSecret("synthetic-rotation") } });
    await prisma.messengerAccount.update({ where: { id: f.accountId }, data: old }); resetAccountsCache();
  } else if (change === "optout") await prisma.botConversation.update({ where: { id: f.lane.ticket.conversationId }, data: { optedOutAt: new Date() } });
  else await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { rolloutMode: "OFF" } });
  const post = wire(f);
  expect(await dispatchCustomerOutboxPart(id!)).toMatchObject({ status: "suppressed" }); expect(post).not.toHaveBeenCalled();
  expect(await prisma.customerDeliveryAttempt.count({ where: { partId: id! } })).toBe(0);
  if (change === "OFF") await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { rolloutMode: "ACTIVE" } });
});
it("new actual signed FINAL-IN in same HOLD inquiry revokes older ACK; no replacement principal is fabricated", async () => {
  const f = await handover(), id = await plan(f); expect(id).not.toBeNull();
  const rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: f.externalId, messaging: [{
    sender: { id: f.peer }, recipient: { id: f.externalId }, timestamp: Date.now(), message: { mid: randomUUID(), text: "Не нужно, отмените" },
  }] }] }));
  const req = { rawBody, get: () => `sha256=${createHmac("sha256", f.secret).update(rawBody).digest("hex")}` };
  registerAuthenticatedMetaCustomerRequest(req); const result = await persistVerifiedCustomerIngressBatch(req);
  if (result.status !== "persisted") throw new Error("New genuine input was not persisted");
  events.push(...result.tickets.map(t => t.eventKey));
  expect((await recoverAndFinalizeCustomerInboxInput(result.tickets[0].eventKey)).status).toBe("finalized");
  const post = wire(f); expect(await dispatchCustomerOutboxPart(id!)).toMatchObject({ status: "suppressed" }); expect(post).not.toHaveBeenCalled();
});
it.each(["empty", "timeout"] as const)("%s after POST is UNKNOWN; new worker/job delivery cannot issue second POST", async outcome => {
  const f = await handover(), id = await plan(f), post = wire(f, outcome); expect(id).not.toBeNull();
  expect(await dispatchCustomerOutboxPart(id!)).toMatchObject({ status: "unknown" });
  expect(await dispatchCustomerOutboxPart(id!)).toMatchObject({ status: "unknown" }); expect(post).toHaveBeenCalledTimes(1);
  expect(await prisma.customerDeliveryAttempt.count({ where: { partId: id! } })).toBe(1);
});
it("accepted MID survives staff takeover during POST and cannot be replayed after projection repair", async () => {
  const f = await handover(), id = await plan(f); expect(id).not.toBeNull();
  const staff = await prisma.agent.create({ data: { fullName: "Synthetic concurrent ACK staff", phone: `ack-staff-${randomUUID()}`,
    role: "ADMIN", passwordHash: "not-a-login-hash" } }); staffIds.push(staff.id);
  const request = { agent: { id: staff.id, role: "ADMIN", permissions: new Set(["messages.view"]) } };
  const post = wire(f), underlying = post.getMockImplementation()!;
  post.mockImplementation(async (...args) => {
    const response = await underlying(...args);
    // Real lifecycle transaction after physical POST started, before its MID
    // returns to settlement. No pause flag standing in for staff ownership.
    expect((await transitionManagedCustomerCallback(request as unknown as Request,
      { requestId: f.receipt.resourceId, expectedRevision: "1", action: "accept" })).status).toBe("applied");
    return response;
  });
  expect(await dispatchCustomerOutboxPart(id!)).toMatchObject({ status: "accepted" });
  expect((await prisma.customerDeliveryAttempt.findFirstOrThrow({ where: { partId: id! } })).providerMid).toMatch(/^ack-mid-/);
  expect(await dispatchCustomerOutboxPart(id!)).toMatchObject({ status: "accepted" }); expect(post).toHaveBeenCalledTimes(1);
  expect(await prisma.customerInquiry.findUniqueOrThrow({ where: { id: f.inquiryId } }))
    .toMatchObject({ ownerMode: "HUMAN", ownerAgentId: staff.id });
});
it("crash after physical POST/STARTED before settlement stays unknown after expiry; no second POST", async () => {
  const f = await handover(), id = await plan(f), post = wire(f); expect(id).not.toBeNull();
  // The receipt write is retried on a transient failure, so a LOST settlement means every write failed.
  const fault = vi.spyOn(settlement, "recordCustomerDeliveryAttemptOutcome").mockRejectedValue(new Error("Synthetic lost settlement"));
  try { expect(await dispatchCustomerOutboxPart(id!)).toMatchObject({ status: "unknown" }); } finally { fault.mockRestore(); }
  await prisma.customerOutboxPart.update({ where: { id: id! }, data: { leaseUntil: new Date(Date.now()-1) } });
  await holdExpiredCustomerDeliveryClaims();
  expect(await dispatchCustomerOutboxPart(id!)).toMatchObject({ status: "unknown" }); expect(post).toHaveBeenCalledTimes(1);
});
it("a single transient receipt-write failure is retried: the accepted MID is recorded, still exactly one POST", async () => {
  const f = await handover(), id = await plan(f), post = wire(f); expect(id).not.toBeNull();
  const fault = vi.spyOn(settlement, "recordCustomerDeliveryAttemptOutcome").mockRejectedValueOnce(new Error("Synthetic transient settlement failure"));
  try { expect(await dispatchCustomerOutboxPart(id!)).toMatchObject({ status: "accepted" }); } finally { fault.mockRestore(); }
  expect(post).toHaveBeenCalledTimes(1);
  expect(await prisma.customerDeliveryAttempt.count({ where: { partId: id! } })).toBe(1);
});
it("JSON copy and a task receipt without genuine pre-execute source grant cannot plan ACK", async () => {
  const f = await handover();
  expect(await prisma.$transaction(tx => issueCustomerHandoverAckTx(tx, {}, f.receipt))).toBeNull();
  expect(await prisma.customerOutboxPart.count({ where: { inquiryId: f.inquiryId } })).toBe(0);
});
it("HOLD cannot recapture pre-execute source or renew age/lease after process-memory loss", async () => {
  const f = await handover();
  expect(await prisma.$transaction(tx => captureCustomerHandoverAckSourceTx(tx, {
    principal: f.preExecutePrincipal, authority: f.authority, claim: f.claim, language: "ru",
  }))).toBeNull();
  expect(await prisma.customerOutboxPart.count({ where: { inquiryId: f.inquiryId } })).toBe(0);
  expect((await prisma.customerInquiry.findUniqueOrThrow({ where: { id: f.inquiryId } })).ownerMode).toBe("HOLD");
});
it("expired original turn cannot mint ACK or acquire a renewed delivery deadline", async () => {
  const f = await handover(), time = vi.spyOn(Date, "now").mockReturnValue(f.claim.deadlineAt+1);
  try { expect(await plan(f)).toBeNull(); } finally { time.mockRestore(); }
  expect(await prisma.customerOutboxPart.count({ where: { inquiryId: f.inquiryId } })).toBe(0);
  const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.claim.eventKey } });
  expect(ticket.providerDeadlineAt?.getTime()).toBe(f.claim.deadlineAt);
});
it("required ACK dispatch-job fault rolls back Part+PLANNED marker, retaining prior committed task/receipt", async () => {
  const f = await handover();
  await expect(prisma.$transaction(async tx => {
    const ack = await issueCustomerHandoverAckTx(tx, f.source, f.receipt); if (!ack) throw new Error("Genuine ACK missing");
    const fault = vi.spyOn(tx.backgroundJob, "create").mockRejectedValueOnce(new Error("Synthetic ACK required-job failure"));
    try { return await planCustomerHandoverAckTx(tx, ack); } finally { fault.mockRestore(); }
  })).rejects.toThrow("Synthetic ACK required-job failure");
  expect(await prisma.customerOutboxPart.count({ where: { inquiryId: f.inquiryId } })).toBe(0);
  expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: f.claim.eventKey } })).processingState).toBe("CLAIMED");
  expect((await prisma.callbackRequest.findUniqueOrThrow({ where: { customerActionId: f.receipt.actionId } })).lifecycleStatus).toBe("QUEUED");
});

async function ackSessionFixture() {
  const f = await fixture("Мне не звонили");
  const elected = await prisma.$transaction(tx => claimCustomerAgentTurnTx(tx, f.lane.principal));
  if (elected.status !== "claimed") throw new Error("Actual original ACK session claim unavailable");
  const loaded = await createCustomerAgentMutationSession({ ...f.lane, agentClaim: elected.claim, handoverAckLanguage: "ru" });
  if (loaded.status !== "ready") throw new Error(`Actual ACK session held: ${loaded.reason}`);
  return { ...f, session: loaded.session, claim: elected.claim };
}
const handoverCommand = { name: "request_handover", args: { topic: "Мне не звонили" } };
async function noHandoverKernelEffects(f: Awaited<ReturnType<typeof ackSessionFixture>>) {
  expect(await prisma.customerAction.count({ where: { inquiryId: f.inquiryId } })).toBe(0);
  expect(await prisma.callbackRequest.count({ where: { conversationId: f.lane.ticket.conversationId } })).toBe(0);
  expect(await prisma.customerOutboxPart.count({ where: { inquiryId: f.inquiryId } })).toBe(0);
  const [jobs] = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM "BackgroundJob" j
    JOIN "CustomerAction" a ON a."id"=j."payload"->>'actionId'
    WHERE a."inquiryId"=${f.inquiryId} AND j."type"='customer-callback-notify'`;
  expect(jobs.count).toBe(0n);
  expect(f.session.handoverAckSource).toBeNull();
}
it("actual session: capture-only read fault does not suppress real handover kernel/task/notify/HOLD; no ACK part", async () => {
  const f = await ackSessionFixture(), actualCapture = handoverAck.captureCustomerHandoverAckSourceTx;
  const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  let injected = false;
  const capture = vi.spyOn(handoverAck, "captureCustomerHandoverAckSourceTx").mockImplementation(async (tx, input) => {
    const actualQuery = tx.$queryRaw.bind(tx);
    const query = vi.spyOn(tx, "$queryRaw").mockImplementation((first: unknown, ...values: unknown[]) => {
      const sql = Array.isArray(first) ? first.join(" ") : String((first as { sql?: unknown })?.sql ?? "");
      if (sql.includes('SELECT "originCiphertext"') && sql.includes('"CustomerPropertyIngressTicket"')) {
        injected = true; throw new Error("MUST_NOT_PRINT_CAPTURE_ERROR_BODY");
      }
      return Reflect.apply(actualQuery, tx, [first, ...values]);
    });
    try { return await actualCapture(tx, input); } finally { query.mockRestore(); }
  });
  try {
    expect(await f.session.execute(handoverCommand, wait())).toMatchObject({ status: "denied", reason: "handover_committed_ack_purpose_unavailable" });
  } finally { capture.mockRestore(); }
  expect(injected).toBe(true); expect(diagnostic.mock.calls).toEqual([["customer_handover_ack_capture_unavailable"]]);
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("MUST_NOT_PRINT_CAPTURE_ERROR_BODY");
  const receipt = f.session.committedReceipts[0]; expect(receipt?.kind).toBe("handover");
  expect(await prisma.customerAction.count({ where: { inquiryId: f.inquiryId, status: "COMMITTED" } })).toBe(1);
  expect(await prisma.callbackRequest.findUniqueOrThrow({ where: { customerActionId: receipt.actionId } }))
    .toMatchObject({ requestKind: "HUMAN", lifecycleStatus: "QUEUED" });
  expect(await prisma.backgroundJob.findUnique({ where: { dedupeKey: `customer-callback-notify:${receipt.actionId}` } })).not.toBeNull();
  expect((await prisma.customerInquiry.findUniqueOrThrow({ where: { id: f.inquiryId } })).ownerMode).toBe("HOLD");
  expect(f.session.handoverAckSource).toBeNull(); expect(await prisma.customerOutboxPart.count({ where: { inquiryId: f.inquiryId } })).toBe(0);
});
it.each(["abort", "deadline"] as const)("actual session: deferred genuine capture then %s cannot START kernel/task/job/action", async cause => {
  const f = await ackSessionFixture(), actualCapture = handoverAck.captureCustomerHandoverAckSourceTx;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), deferred = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController(), deadlineAt = Date.now()+90_000;
  const capture = vi.spyOn(handoverAck, "captureCustomerHandoverAckSourceTx").mockImplementation(async (tx, input) => {
    const source = await actualCapture(tx, input);
    if (!source) throw new Error("Actual deferred source unexpectedly held");
    enter(); await deferred; return source;
  });
  const kernel = vi.spyOn(actionJournal, "executeCustomerAction"); // call-through, no permission or kernel mock
  let restoreClock = () => {};
  const executing = f.session.execute(handoverCommand, { signal: controller.signal, deadlineAt });
  try {
    // Rendezvous also fails if the session ends before reaching real capture;
    // normal DB transaction/Vitest timeouts still apply to the actual reads.
    await Promise.race([entered, executing.then(() => { throw new Error("Session ended before genuine capture"); })]);
    if (cause === "abort") controller.abort(); else {
      const clock = vi.spyOn(Date, "now").mockReturnValue(deadlineAt+1); restoreClock = () => { clock.mockRestore(); };
    }
    release(); expect((await executing).status).toBe("denied");
    expect(kernel).not.toHaveBeenCalled();
  } finally { release(); await executing; restoreClock(); kernel.mockRestore(); capture.mockRestore(); }
  await noHandoverKernelEffects(f);
  const state = await prisma.customerInquiry.findUniqueOrThrow({ where: { id: f.inquiryId } });
  expect(state.ownerMode).toBe("BOT"); // opening genuine intent is allowed; creating task is not
});
it("actual session: native pause during optional capture revokes original principal before kernel starts", async () => {
  const f = await ackSessionFixture(), actualCapture = handoverAck.captureCustomerHandoverAckSourceTx;
  const capture = vi.spyOn(handoverAck, "captureCustomerHandoverAckSourceTx").mockImplementation(async (tx, input) => {
    const source = await actualCapture(tx, input); if (!source) throw new Error("Actual source unexpectedly held");
    // Real native UPDATE and epoch trigger, committed in the same optional TX.
    // No cross-TX write is awaited while this capture holds the native lock.
    await tx.botConversation.update({ where: { id: f.lane.ticket.conversationId }, data: { pausedUntil: new Date(Date.now()+600_000) } });
    return source;
  });
  const kernel = vi.spyOn(actionJournal, "executeCustomerAction");
  try { expect((await f.session.execute(handoverCommand, wait())).status).toBe("denied"); expect(kernel).not.toHaveBeenCalled(); }
  finally { kernel.mockRestore(); capture.mockRestore(); }
  await noHandoverKernelEffects(f);
});
