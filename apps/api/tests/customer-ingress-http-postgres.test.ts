import { createHmac, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Actual HTTP raw-body HMAC, installed account, producer, SQL transaction,
// pending ticket/job and legacy processor. Only external Meta profile/typing
// calls are replaced. fetch is denied; bot channel switches prevent paid AI.
vi.mock("../src/messengers/meta.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  fetchInstagramProfile: vi.fn(async () => ({ name: "Synthetic ingress visitor" })),
  showReadAndTyping: vi.fn(async () => undefined),
}));
import { prisma } from "../src/db.js";
import { app } from "../src/app.js";
import { encryptSecret } from "../src/crypto.js";
import * as conversationModule from "../src/messengers/conversation.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";
import { resetMetaAccountCredsCache } from "../src/messengers/meta.js";
import { resetMetaPeerMemory } from "../src/messengers/metaPeerMemory.js";
import { ensureCustomerEndpoint } from "../src/lib/customerConversationScope.js";
import { customerPropertyEventKey, customerPropertyScopeKey } from "../src/lib/customerPropertyScope.js";
import { decryptCustomerIngressEnvelope } from "../src/lib/customerIngressPayload.js";
import { recoverCustomerPendingEnvelope, recoverAuthenticatedCustomerInput } from "../src/lib/customerIngressAuthority.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { createCustomerRolloutFixture } from "./helpers/customerRolloutFixture.js";
import { customerAgentEnrollmentSubjectKey } from "../src/lib/customerAgentEnrollment.js";

const tag = `http-inbox-${randomUUID()}`, secret = `${tag}-synthetic-app-secret`, websiteKey = `${tag}-website-env-only`;
const ticketKeys = new Set<string>(), websitePeers: string[] = [];
const websiteDeliveryKeys: string[] = [];
let account: CustomerMessengerFixture;
let rollout: Awaited<ReturnType<typeof createCustomerRolloutFixture>>;
let settingsBefore: Awaited<ReturnType<typeof readSettings>>, policyBefore: Awaited<ReturnType<typeof readPolicy>>;
let processSpy: ReturnType<typeof vi.spyOn>;
function readSettings() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  metaEnabled: true, metaAppSecret: true, metaVerifyToken: true, botEnabled: true, botInstagramEnabled: true, botWebsiteChatEnabled: true,
} }); }
function readPolicy() { return prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" }, select: { contractVersion: true, rolloutMode: true, capabilities: true } }); }
function deferred() { let resolve = () => {}; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic HTTP ingress wait timed out")), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function metaFrame() {
  const peer = `${tag}-peer-${randomUUID()}`, eventId = `${tag}-mid-${randomUUID()}`;
  account.turnInput(peer); // Cleanup ownership only; no native/proof is created.
  const raw = JSON.stringify({ object: "instagram", entry: [{ id: account.externalId, messaging: [{ sender: { id: peer }, recipient: { id: account.externalId },
    timestamp: Date.now(), message: { mid: eventId, text: "Здравствуйте, это синтетический HTTP-тест" } }] }] });
  const scopeKey = customerPropertyScopeKey("INSTAGRAM", peer, account.id, account.transport.endpointScopeId);
  const eventKey = customerPropertyEventKey(scopeKey, "message", eventId); ticketKeys.add(eventKey);
  return { peer, eventId, eventKey, raw };
}
function postMeta(frame: ReturnType<typeof metaFrame>, valid = true) {
  const signature = createHmac("sha256", valid ? secret : "synthetic-wrong-key").update(frame.raw).digest("hex");
  return request(app).post("/api/v1/webhooks/meta").set("Content-Type", "application/json").set("x-hub-signature-256", `sha256=${signature}`).send(frame.raw);
}
const jobKey = (eventKey: string) => `customer-inbox-consume:${eventKey}`;
async function ticket(eventKey: string) { return prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey } }); }
async function drain() { await drainBackgroundTasks(5000); await drainBackgroundTasks(5000); }
async function assertLegacyInputStored(f: ReturnType<typeof metaFrame>) {
  const native = await prisma.botConversation.findFirstOrThrow({ where: { accountId: account.id, subscriberId: f.peer }, select: { endpointScopeId: true, messages: true } });
  expect(native.endpointScopeId).toBe(account.transport.endpointScopeId);
  expect(native.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", content: "Здравствуйте, это синтетический HTTP-тест" })]));
}

beforeAll(async () => {
  settingsBefore = await readSettings(); policyBefore = await readPolicy();
  await prisma.settings.update({ where: { id: "singleton" }, data: { metaEnabled: true, metaAppSecret: encryptSecret(secret), metaVerifyToken: encryptSecret(`${tag}-verify`),
    botEnabled: true, botInstagramEnabled: false, botWebsiteChatEnabled: false } });
  account = await createCustomerMessengerFixture("INSTAGRAM");
  await prisma.messengerAccount.update({ where: { id: account.id }, data: { appSecret: encryptSecret(secret) } });
  resetAccountsCache(); resetMetaAccountCredsCache();
  rollout = await createCustomerRolloutFixture();
});
beforeEach(async () => {
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "scoped", rolloutMode: "SHADOW", capabilities: { publicRead: true } } });
  resetMetaPeerMemory();
  processSpy = vi.spyOn(conversationModule, "processMessengerTurn"); // Wraps actual implementation, no mockReturnValue/grant.
  vi.stubEnv("WEBSITE_LEAD_API_KEY", websiteKey); vi.stubEnv("BOT_PROPERTY_CONTEXT_ENABLED", "0"); vi.stubEnv("BOT_TURN_TRACE_ENABLED", "0");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected external HTTP in real ingress regression"); }));
});
afterEach(async () => {
  await drain(); expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
afterAll(async () => {
  await drain();
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: [...ticketKeys].map(jobKey) } } });
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: [...ticketKeys] } } });
  if (account) await account.dispose();
  const websiteNatives = await prisma.botConversation.findMany({ where: { channel: "WEBSITE", subscriberId: { in: websitePeers } }, select: { id: true, contactProfileId: true } });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: websiteNatives.map(row => `ai-reply-retry:${row.id}`) } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: websiteNatives.map(row => row.id) } } });
  await prisma.customerInquiry.deleteMany({ where: { peerId: { in: websitePeers }, endpointScope: { channel: "WEBSITE" } } });
  await prisma.outboundShieldState.deleteMany({ where: { channel: "WEBSITE", subscriberId: { in: websitePeers } } });
  const ownedIdentity = { kind: "WEB_SESSION" as const, value: { in: websitePeers } };
  await prisma.contactProfile.deleteMany({ where: { id: { in: websiteNatives.flatMap(row => row.contactProfileId ? [row.contactProfileId] : []) }, clientId: null, mergedIntoId: null,
    identities: { some: ownedIdentity, every: ownedIdentity }, botConversations: { none: {} }, telegramConversations: { none: {} }, telegramDirectConversations: { none: {} },
    incomingCalls: { none: {} }, jobApplications: { none: {} }, mergedFrom: { none: {} }, linkCandidatesLeft: { none: {} }, linkCandidatesRight: { none: {} }, mergesIn: { none: {} }, mergesOut: { none: {} } } });
  await prisma.processedMessage.deleteMany({ where: { OR: [{ channel: "INSTAGRAM", messageId: { startsWith: tag } },
    { channel: "WEBSITE_CHAT_DELIVERY", messageId: { in: websiteDeliveryKeys } }, { channel: "WEBSITE", messageId: { startsWith: tag } }] } });
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  if (policyBefore) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { ...policyBefore, capabilities: policyBefore.capabilities! } });
  if (rollout) await rollout.restore();
  resetAccountsCache(); resetMetaAccountCredsCache(); resetMetaPeerMemory();
});

describe("actual HTTP ACK follows atomic durable ingress", () => {
  it("holds the real transaction after ticket+job insertion and sends no ACK until commit", async () => {
    const f = metaFrame();
    await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { rolloutMode: "ACTIVE" } });
    const endpoint = await rollout.allowDm({ peer: f.peer, accountId: account.id, accountExternalId: account.externalId });
    expect(endpoint.endpointScopeId).toBe(account.transport.endpointScopeId);
    const entered = deferred(), release = deferred(); let gated = false, acked = false;
    const actualTransaction = prisma.$transaction.bind(prisma);
    const transactionSpy = vi.spyOn(prisma, "$transaction");
    transactionSpy.mockImplementation((async (callback: any, options: any) => {
      if (typeof callback !== "function") return actualTransaction(callback, options);
      return actualTransaction(async tx => {
        const result = await callback(tx);
        if (!gated && result?.status === "persisted" && result.tickets?.some((row: { eventKey: string }) => row.eventKey === f.eventKey)) {
          gated = true; entered.resolve(); await release.promise;
        }
        return result;
      }, options);
    }) as typeof prisma.$transaction);
    const responsePromise = postMeta(f).then(value => { acked = true; return value; });
    let response: Awaited<typeof responsePromise>;
    try {
      await bounded(entered.promise);
      expect(await ticket(f.eventKey)).toBeNull();
      expect(await prisma.backgroundJob.count({ where: { dedupeKey: jobKey(f.eventKey) } })).toBe(0);
      expect(processSpy).not.toHaveBeenCalled();
      await new Promise(resolve => setTimeout(resolve, 25)); expect(acked).toBe(false);
    } finally { release.resolve(); response = await bounded(responsePromise); transactionSpy.mockRestore(); }
    expect(response!.status).toBe(200); expect(response!.body).toMatchObject({ ok: true });
    const saved = await ticket(f.eventKey); expect(saved?.payloadVersion).toBe(1); expect(saved?.payloadCiphertext).toBeTruthy();
    expect(saved?.payloadCiphertext).not.toContain("синтетический");
    expect(saved?.rolloutAssignmentId).toBeTruthy();
    expect(saved?.intakeAgentRevisionId).toBe(rollout.revision.id);
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: jobKey(f.eventKey), type: "customer-inbox-consume" } })).toBe(1);
    await drain(); expect(processSpy).not.toHaveBeenCalled();
    expect(await prisma.botConversation.count({ where: { accountId: account.id, subscriberId: f.peer } })).toBe(0);
    expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: f.eventKey } })).toBe(0);
  });
  it("required job unique failure rolls back the ticket and returns 503 without legacy processing", async () => {
    const f = metaFrame();
    await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { rolloutMode: "ACTIVE" } });
    const endpoint = await rollout.allowDm({ peer: f.peer, accountId: account.id, accountExternalId: account.externalId });
    expect(endpoint.endpointScopeId).toBe(account.transport.endpointScopeId);
    await prisma.backgroundJob.create({ data: { type: "customer-inbox-consume", payload: { version: 1, eventKey: f.eventKey }, maxAttempts: 5, dedupeKey: jobKey(f.eventKey), runAt: new Date("2099-01-01") } });
    const response = await postMeta(f); expect(response.status).toBe(503); await drain();
    const subjectKey = customerAgentEnrollmentSubjectKey({ surface: "dm", endpoint: { endpointScopeId: endpoint.endpointScopeId,
      channel: "INSTAGRAM", accountId: account.id, scopeRevision: endpoint.scopeRevision, transportKey: endpoint.transportKey }, peer: f.peer });
    const assignment = await prisma.customerAgentRolloutAssignment.findFirstOrThrow({ where: { surface: "dm", endpointScopeId: endpoint.endpointScopeId, subjectKey } });
    expect(assignment).toMatchObject({ lane: "CORE", candidateRevisionId: rollout.revision.id });
    expect(await ticket(f.eventKey)).toBeNull(); expect(processSpy).not.toHaveBeenCalled();
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: jobKey(f.eventKey) } })).toBe(1);
    expect(await prisma.botConversation.count({ where: { accountId: account.id, subscriberId: f.peer } })).toBe(0);
    expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: f.eventKey } })).toBe(0);
  });
  it("wrong raw HMAC is rejected before durable intake, legacy processing or a required job", async () => {
    const f = metaFrame(); expect((await postMeta(f, false)).status).toBe(403); await drain();
    expect(await ticket(f.eventKey)).toBeNull(); expect(processSpy).not.toHaveBeenCalled();
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: jobKey(f.eventKey) } })).toBe(0);
  });
  it("OFF keeps legacy processing without inventing a recoverable pending payload/job", async () => {
    await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { rolloutMode: "OFF" } });
    const f = metaFrame(); expect((await postMeta(f)).status).toBe(200); await drain();
    expect(processSpy).toHaveBeenCalled(); await assertLegacyInputStored(f);
    expect((await ticket(f.eventKey))?.payloadCiphertext ?? null).toBeNull();
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: jobKey(f.eventKey) } })).toBe(0);
  });
  it("env-only WEBSITE key acknowledges encrypted public intake but grants no restart authority/OUT", async () => {
    const peer = `http-site-${randomUUID()}`; websitePeers.push(peer);
    const eventId = `${tag}-site-${randomUUID()}`;
    websiteDeliveryKeys.push(`mid:${peer}:${eventId}`);
    const endpoint = await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel: "WEBSITE", subscriberId: peer }));
    const scopeKey = customerPropertyScopeKey("WEBSITE", peer, null, endpoint.endpointScopeId), eventKey = customerPropertyEventKey(scopeKey, "website_message", eventId); ticketKeys.add(eventKey);
    const response = await request(app).post("/api/v1/webhooks/website-chat").set("X-Api-Key", websiteKey).send({ sessionId: peer, messageId: eventId, text: "Здравствуйте" });
    expect(response.status).toBe(200); expect(response.body.messages).toEqual([]); await drain();
    const row = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey } });
    const envelope = decryptCustomerIngressEnvelope({ version: 1, eventKey, order: row.order.toString(), scopeKey, endpointScopeId: endpoint.endpointScopeId, payloadHash: row.payloadHash! }, row.payloadCiphertext!);
    expect(envelope.verification).toMatchObject({ provenance: "website_application_key", assurance: "website_public_input", verifierCredential: null });
    expect(await recoverCustomerPendingEnvelope(eventKey)).toMatchObject({ status: "held" });
    expect(await recoverAuthenticatedCustomerInput(eventKey)).toMatchObject({ status: "held" });
    expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: eventKey } })).toBe(0);
    if (row.conversationId) expect(await prisma.customerAction.count({ where: { inquiry: { conversationId: row.conversationId } } })).toBe(0);
  });
  it("WEBSITE auth and schema rejection precede durable ticket/job creation", async () => {
    const peer = `http-site-${randomUUID()}`; websitePeers.push(peer);
    const data = { sessionId: peer, messageId: `${tag}-bad-site`, text: "Здравствуйте" };
    const endpoint = await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel: "WEBSITE", subscriberId: peer }));
    const eventKey = customerPropertyEventKey(customerPropertyScopeKey("WEBSITE", peer, null, endpoint.endpointScopeId), "website_message", data.messageId); ticketKeys.add(eventKey);
    expect((await request(app).post("/api/v1/webhooks/website-chat").set("X-Api-Key", "synthetic-wrong-key").send(data)).status).toBe(401);
    expect((await request(app).post("/api/v1/webhooks/website-chat").set("X-Api-Key", websiteKey).send({ ...data, text: "" })).status).toBe(400);
    expect(await prisma.botConversation.count({ where: { channel: "WEBSITE", subscriberId: peer } })).toBe(0);
    expect(await ticket(eventKey)).toBeNull(); expect(await prisma.backgroundJob.count({ where: { dedupeKey: jobKey(eventKey) } })).toBe(0);
    expect(processSpy).not.toHaveBeenCalled();
  });
});
