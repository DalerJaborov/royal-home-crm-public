import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { admitCustomerPropertyInput } from "../src/lib/customerPropertyAdmission.js";
import { ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";
import { captureAuthenticatedCustomerInput, registerAuthenticatedMetaCustomerRequest, registerAuthenticatedWebsiteCustomerRequest,
  verifyAndRegisterMetaCustomerIssuer, verifyAndRegisterPublicMetaCustomerIssuer, type AuthenticatedCustomerInput } from "../src/lib/customerIngressAuthority.js";
import { issueCustomerWriteAuthority, loadCustomerStateSnapshot, transitionCustomerState } from "../src/lib/customerState.js";
import { executeCustomerAction, loadCustomerActionReceipt, reconcileCustomerAction, observeProtectedInquiryPhone } from "../src/lib/customerActionJournal.js";
import { customerCallbackNotifyJob } from "../src/jobs/customerCallbackNotify.js";
import { openAuthenticatedCustomerMutationIntent } from "../src/lib/customerMutationIntent.js";
import { transitionManagedCustomerCallback } from "../src/lib/customerCallbackLifecycle.js";
import { loadPendingCallbackRequests } from "../src/lib/callbackRequests.js";
import type { Request } from "express";
import { customerActionIntentsSchema, resolvePermissions, type CustomerPropertyAdmission, type CustomerActionKind } from "@royal-home/shared";
import { sendPushToAgents } from "../src/push.js";

vi.mock("../src/push.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents: vi.fn(), sendPushToAgent: vi.fn(), closeLeadPushNotification: vi.fn() }));
vi.mock("../src/lib/recipients.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/recipients.js")>()),
  findAgentsWithPermission: vi.fn(async () => ["synthetic-recipient"]) }));

/** Real SQL/transactions and actual issuer/admission/journal, synthetic final-IN
 * adapter fixtures. This is not a signed HTTP parser or live provider test. */
const runId = randomUUID(); const accountIds: string[] = []; const nativeIds: string[] = []; const installedScopeIds = new Set<string>();
const staffIds: string[] = [];
const deletedNativeInquiryIds: string[] = [];
async function staff(role: "ADMIN" | "AGENT" = "ADMIN"): Promise<Request> {
  const row = await prisma.agent.create({ data: { fullName: "Synthetic P08 staff", phone: `synthetic-p08-${randomUUID()}`,
    role, passwordHash: "synthetic-not-a-login-hash", isActive: true } });
  staffIds.push(row.id);
  return { agent: { id: row.id, role, permissions: resolvePermissions(role), sipExtension: null } } as unknown as Request;
}
async function handover(options: { account?: Meta; peer?: string } = {}) {
  const topic = "Мне так и не звонили";
  const value = await freshInput(topic, "handover", options);
  const command = { name: "request_handover", args: { topic } } as const;
  expect(await openAuthenticatedCustomerMutationIntent(value.input, value.ticket, command)).toBe("opened");
  return { value, command, grant: await authority(value, "handover") };
}
type Meta = { id: string; channel: "INSTAGRAM" | "WHATSAPP"; externalId: string; secret: string };
type InstalledMeta = { id: null; channel: "FACEBOOK" | "WHATSAPP"; externalId: string; secret: string };
let settingsBefore: Awaited<ReturnType<typeof readSettings>>; let policyBefore: Awaited<ReturnType<typeof readPolicy>>;
function readSettings() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, botInstagramEnabled: true, botWhatsappEnabled: true, botFacebookEnabled: true, botWebsiteChatEnabled: true, metaEnabled: true,
  metaWaPhoneId: true, metaWaToken: true, metaPageId: true, metaPageToken: true, metaAppSecret: true,
} }); }
function readPolicy() { return prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } }); }
async function meta(channel: Meta["channel"] = "INSTAGRAM"): Promise<Meta> {
  const value: Meta = { id: randomUUID(), channel, externalId: `synthetic-customer-${runId}-${accountIds.length}`, secret: `synthetic-secret-${randomUUID()}` };
  await prisma.messengerAccount.create({ data: { id: value.id, channel, externalId: value.externalId, title: "Synthetic customer journal test", token: "synthetic-token",
    appSecret: encryptSecret(value.secret), enabled: true } });
  accountIds.push(value.id); return value;
}
async function freshInput(text: string, kind: CustomerActionKind, options: { account?: Meta | InstalledMeta; peer?: string; website?: boolean; publicEnvelope?: boolean } = {}): Promise<{
  input: AuthenticatedCustomerInput; ticket: CustomerPropertyAdmission;
}> {
  const account = options.website ? null : options.account ?? await meta();
  const channel = account?.channel ?? "WEBSITE"; const peer = options.peer ?? `synthetic-peer-${randomUUID()}`;
  const native = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel, subscriberId: peer, accountId: account?.id ?? null,
    ...(account ? { accountExternalId: account.externalId } : {}) }));
  if (!nativeIds.includes(native.id)) nativeIds.push(native.id);
  const request = { rawBody: Buffer.from(JSON.stringify({ synthetic: true, channel, peer, text })), get: (_name: string) => "" };
  if (account) {
    const header = `sha256=${createHmac("sha256", account.secret).update(request.rawBody).digest("hex")}`;
    request.get = () => header;
    registerAuthenticatedMetaCustomerRequest(request);
    const verify = options.publicEnvelope ? verifyAndRegisterPublicMetaCustomerIssuer : verifyAndRegisterMetaCustomerIssuer;
    expect(await verify(request, { channel: account.channel, accountId: account.id, accountExternalId: account.externalId })).toBe(true);
  } else registerAuthenticatedWebsiteCustomerRequest(request);
  const eventId = randomUUID(); const eventKind = account ? "message" as const : "website_message" as const;
  const input = captureAuthenticatedCustomerInput(request, { channel, peer, eventKind, eventId, inputText: text,
    ...(account ? { accountExternalId: account.externalId } : {}) });
  if (!input) throw new Error("Synthetic input was not authenticated");
  const admission = await admitCustomerPropertyInput({ channel, peer, eventKind, eventId, evidence: [], authenticatedInput: input,
    ...(account ? { accountId: account.id, accountExternalId: account.externalId } : {}) });
  if (admission.status !== "admitted") throw new Error(`Synthetic admission denied: ${admission.reason}`);
  const state = await loadCustomerStateSnapshot({ conversationId: native.id });
  if (!state) throw new Error("Synthetic state missing");
  if (account && account.id === null) installedScopeIds.add(state.fence.endpoint.endpointScopeId);
  const accepted = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: native.id }, select: {
    lastAcceptedEventKey: true, lastAcceptedOrder: true,
  } });
  if (accepted.lastAcceptedEventKey !== admission.ticket.eventKey || accepted.lastAcceptedOrder?.toString() !== admission.ticket.order) {
    const txGuard = await prisma.$transaction(tx => Promise.resolve({
      rootTransactionVisible: "$transaction" in tx, transactionMethodType: typeof Reflect.get(tx, "$transaction"),
    }));
    throw new Error(`Synthetic FINAL-IN not accepted: ${JSON.stringify({ ownerMode: state.ownerMode,
      acceptedEventPresent: accepted.lastAcceptedEventKey !== null, acceptedOrderPresent: accepted.lastAcceptedOrder !== null, txGuard })}`);
  }
  // Callback intent/consent is created by the actual accepted-IN boundary.
  // Do not fabricate its proof with a generic model-shaped intent transition.
  if (kind === "contact") {
    const changed = await prisma.$transaction(tx => transitionCustomerState(tx, state.fence, { type: "intent", kind, change: "request", evidenceRefs: [admission.ticket.eventKey] }));
    expect(changed.status, JSON.stringify(changed)).toBe("applied");
  }
  return { input, ticket: admission.ticket };
}
async function authority(value: Awaited<ReturnType<typeof freshInput>>, kind: CustomerActionKind, purpose: "execute" | "receipt" = "execute") {
  const issued = await issueCustomerWriteAuthority(value.input, value.ticket, kind, prisma, purpose);
  if (!issued) throw new Error("Synthetic write authority denied");
  return issued;
}
async function quarantineOwnJob(actionId: string) {
  // First observe the actual required enqueue; then park only this fixture's
  // task so concurrent queue tests cannot execute a synthetic customer request.
  const jobs = await prisma.backgroundJob.findMany({ where: { dedupeKey: `customer-callback-notify:${actionId}` } });
  expect(jobs).toHaveLength(1); expect(jobs[0].payload).toEqual({ version: 1, actionId });
  expect(jobs[0].runAt.getTime()).toBeLessThanOrEqual(Date.now() + 2000);
  await prisma.backgroundJob.update({ where: { id: jobs[0].id }, data: { runAt: new Date("2099-01-01T00:00:00.000Z") } });
}

beforeAll(async () => {
  settingsBefore = await readSettings(); policyBefore = await readPolicy();
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, botInstagramEnabled: true, botWhatsappEnabled: true, botFacebookEnabled: true, botWebsiteChatEnabled: true, metaEnabled: true } });
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "scoped", rolloutMode: "ACTIVE",
    capabilities: { publicRead: true, contactWrite: true, callbackWrite: true, handoverWrite: true, ownerQuestionWrite: true, newLeadBridge: false } } });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Original external I/O forbidden in customer journal tests"); }));
});
afterAll(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  try {
  const inquiries = await prisma.customerInquiry.findMany({ where: { conversationId: { in: nativeIds } }, select: { id: true } });
  const ids = [...inquiries.map(row => row.id), ...deletedNativeInquiryIds]; const actions = await prisma.customerAction.findMany({ where: { inquiryId: { in: ids } }, select: { id: true } });
  const actionIds = actions.map(row => row.id);
  await prisma.callbackRequest.deleteMany({ where: { customerActionId: { in: actionIds } } });
  if (actionIds.length) await prisma.backgroundJob.deleteMany({ where: { OR: actionIds.map(id => ({ dedupeKey: { startsWith: `customer-callback-notify:${id}` } })) } });
  await prisma.customerAction.deleteMany({ where: { inquiryId: { in: ids } } });
  await prisma.customerInquiry.deleteMany({ where: { id: { in: ids } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: nativeIds } } });
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { originalConversationId: { in: nativeIds } } });
  // WEBSITE may be a shared installation scope; remove only scopes for our UUID accounts.
  await prisma.customerEndpointScope.deleteMany({ where: { messengerAccountId: { in: accountIds } } });
  if (installedScopeIds.size) await prisma.customerEndpointScope.deleteMany({ where: { id: { in: [...installedScopeIds] }, messengerAccountId: null } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accountIds } } });
  if (staffIds.length) await prisma.agent.deleteMany({ where: { id: { in: staffIds } } });
  } finally {
    // Cleanup failures must not leave this fixture's ACTIVE policy enabled
    // for another test file or a later bounded run on the same own database.
    try { if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore }); }
    finally {
      if (policyBefore) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: {
        contractVersion: policyBefore.contractVersion, rolloutMode: policyBefore.rolloutMode, capabilities: policyBefore.capabilities!,
      } });
    }
  }
});

describe("Customer local action SQL boundary", () => {
  it("projects only protected contact availability or verified current WA input, without discovering a phone or creating effects", async () => {
    const account = await meta(); const peer = `synthetic-availability-${randomUUID()}`;
    const contact = await freshInput("Синтетик +992910044989", "contact", { account, peer });
    const oldContactGrant = await authority(contact, "contact");
    expect((await executeCustomerAction(oldContactGrant, { name: "save_contact", args: { name: "Синтетик", phone: "+992910044989" } })).status).toBe("created");
    const ordinary = await freshInput("Какой адрес?", "callback", { account, peer });
    expect(await observeProtectedInquiryPhone(ordinary.input, ordinary.ticket))
      .toEqual({ status: "current", knownPhoneSource: "scoped_contact" });
    const bot = await loadCustomerStateSnapshot({ conversationId: ordinary.ticket.conversationId });
    if (!bot) throw new Error("Synthetic state missing");
    expect((await prisma.$transaction(tx => transitionCustomerState(tx, bot.fence, {
      type: "owner", mode: "HUMAN", agentId: randomUUID(), token: randomUUID(), leaseUntil: null,
    }))).status).toBe("applied");
    expect((await observeProtectedInquiryPhone(ordinary.input, ordinary.ticket)).status).toBe("held");
    const human = await loadCustomerStateSnapshot({ conversationId: ordinary.ticket.conversationId });
    if (!human) throw new Error("Synthetic state missing");
    expect((await prisma.$transaction(tx => transitionCustomerState(tx, human.fence, {
      type: "owner", mode: "BOT", agentId: null, token: randomUUID(), leaseUntil: null,
    }))).status).toBe("applied");
    const returned = await freshInput("Цена?", "callback", { account, peer });
    expect(await observeProtectedInquiryPhone(returned.input, returned.ticket))
      .toEqual({ status: "current", knownPhoneSource: "scoped_contact" });
    expect((await executeCustomerAction(oldContactGrant, { name: "save_contact", args: { phone: "+992910044989" } })).status).toBe("stale");
    await prisma.botConversation.update({ where: { id: returned.ticket.conversationId }, data: { subscriberId: `synthetic-binding-aba-${randomUUID()}` } });
    await prisma.botConversation.update({ where: { id: returned.ticket.conversationId }, data: { subscriberId: peer } });
    expect((await observeProtectedInquiryPhone(returned.input, returned.ticket)).status).toBe("held");
    const rebound = await freshInput("Адрес?", "callback", { account, peer });
    expect(await observeProtectedInquiryPhone(rebound.input, rebound.ticket))
      .toEqual({ status: "current", knownPhoneSource: "none" });
    const waAccount = await meta("WHATSAPP");
    const wa = await freshInput("Какой адрес?", "callback", { account: waAccount, peer: "992910044990" });
    expect(await observeProtectedInquiryPhone(wa.input, wa.ticket))
      .toEqual({ status: "current", knownPhoneSource: "current_input" });
    const weakWa = await freshInput("Какой адрес?", "callback", { account: waAccount, peer: "992910044990", publicEnvelope: true });
    expect(await observeProtectedInquiryPhone(weakWa.input, weakWa.ticket))
      .toEqual({ status: "current", knownPhoneSource: "none" });
    expect(await observeProtectedInquiryPhone({} as never, ordinary.ticket))
      .toEqual({ status: "held", reason: "input_or_ticket_unverified" });
    const inquiries = await prisma.customerInquiry.findMany({ where: { conversationId: { in: [ordinary.ticket.conversationId, wa.ticket.conversationId] } }, select: { id: true } });
    expect(await prisma.customerAction.count({ where: { inquiryId: { in: inquiries.map(row => row.id) } } })).toBe(1);
    expect(await prisma.callbackRequest.count({ where: { conversationId: { in: [ordinary.ticket.conversationId, wa.ticket.conversationId] } } })).toBe(0);
  });
  it("public-envelope and guessed WEBSITE sessions cannot project prior committed contact availability", async () => {
    const account = await meta(); const peer = `synthetic-public-availability-${randomUUID()}`;
    const contact = await freshInput("Синтетик +992910044991", "contact", { account, peer });
    expect((await executeCustomerAction(await authority(contact, "contact"), { name: "save_contact", args: { name: "Синтетик", phone: "+992910044991" } })).status).toBe("created");
    const publicInput = await freshInput("Какой адрес?", "callback", { account, peer, publicEnvelope: true });
    expect(await observeProtectedInquiryPhone(publicInput.input, publicInput.ticket))
      .toEqual({ status: "current", knownPhoneSource: "none" });
    const websitePeer = `synthetic-guessed-availability-${randomUUID()}`;
    const websiteContact = await freshInput("Синтетик +992910044992", "contact", { website: true, peer: websitePeer });
    expect((await executeCustomerAction(await authority(websiteContact, "contact"), { name: "save_contact", args: { name: "Синтетик", phone: "+992910044992" } })).status).toBe("created");
    const guessed = await freshInput("Какой адрес?", "callback", { website: true, peer: websitePeer });
    expect(await observeProtectedInquiryPhone(guessed.input, guessed.ticket))
      .toEqual({ status: "current", knownPhoneSource: "none" });
    expect(await prisma.callbackRequest.count({ where: { conversationId: { in: [publicInput.ticket.conversationId, guessed.ticket.conversationId] } } })).toBe(0);
  });
  it("contact availability holds stale/revoked/closed frames and does not reuse a cancelled contact generation", async () => {
    const account = await meta(); const peer = `synthetic-revoked-availability-${randomUUID()}`;
    const contact = await freshInput("Синтетик +992910044993", "contact", { account, peer });
    expect((await executeCustomerAction(await authority(contact, "contact"), { name: "save_contact", args: { name: "Синтетик", phone: "+992910044993" } })).status).toBe("created");
    const old = await freshInput("Какой адрес?", "callback", { account, peer });
    expect((await observeProtectedInquiryPhone(old.input, old.ticket)).status).toBe("current");
    const current = await freshInput("Цена?", "callback", { account, peer });
    expect((await observeProtectedInquiryPhone(old.input, old.ticket)).status).toBe("held");
    await prisma.messengerAccount.update({ where: { id: account.id }, data: { appSecret: encryptSecret("synthetic-rotated-availability-secret") } });
    expect((await observeProtectedInquiryPhone(current.input, current.ticket)).status).toBe("held");
    await prisma.messengerAccount.update({ where: { id: account.id }, data: { appSecret: encryptSecret(account.secret) } });
    expect((await observeProtectedInquiryPhone(current.input, current.ticket)).status).toBe("held");
    const fresh = await freshInput("Адрес?", "callback", { account, peer });
    // Credential ABA invalidates prior stored phone proof even on a fresh input.
    expect(await observeProtectedInquiryPhone(fresh.input, fresh.ticket)).toEqual({ status: "current", knownPhoneSource: "none" });
    const correctedContact = await freshInput("Синтетик +992910044994", "contact", { account, peer });
    expect((await executeCustomerAction(await authority(correctedContact, "contact"), {
      name: "save_contact", args: { name: "Синтетик", phone: "+992910044994" },
    })).status).toBe("created");
    const beforeCancel = await freshInput("Адрес?", "callback", { account, peer });
    expect(await observeProtectedInquiryPhone(beforeCancel.input, beforeCancel.ticket))
      .toEqual({ status: "current", knownPhoneSource: "scoped_contact" });
    const state = await loadCustomerStateSnapshot({ conversationId: beforeCancel.ticket.conversationId });
    if (!state) throw new Error("Synthetic state missing");
    expect((await prisma.$transaction(tx => transitionCustomerState(tx, state.fence, {
      type: "intent", kind: "contact", change: "cancel", evidenceRefs: [beforeCancel.ticket.eventKey],
    }))).status).toBe("applied");
    const afterCancel = await freshInput("Цена?", "callback", { account, peer });
    expect(await observeProtectedInquiryPhone(afterCancel.input, afterCancel.ticket)).toEqual({ status: "current", knownPhoneSource: "none" });
    const active = await loadCustomerStateSnapshot({ conversationId: afterCancel.ticket.conversationId });
    if (!active) throw new Error("Synthetic state missing");
    expect((await prisma.$transaction(tx => transitionCustomerState(tx, active.fence, { type: "close", at: new Date().toISOString() }))).status).toBe("applied");
    expect((await observeProtectedInquiryPhone(afterCancel.input, afterCancel.ticket)).status).toBe("held");
    expect(await prisma.customerAction.count({ where: { inquiryId: active.fence.inquiryId } })).toBe(2);
    expect(await prisma.callbackRequest.count({ where: { conversationId: afterCancel.ticket.conversationId } })).toBe(0);
  });
  it("cannot replace a missing opaque authority with JSON or a private resource id", async () => {
    const result = await executeCustomerAction({} as never, { name: "request_callback", args: { topic: "Позвоните" } });
    expect(result).toEqual({ status: "denied", reason: "write_authority_or_command" });
  });
  it("commits one callback/resource/required job under duplicate concurrent calls", async () => {
    const value = await freshInput("Позвоните мне +992 91 004 49 71", "callback"); const grant = await authority(value, "callback");
    const results = await Promise.all([1, 2].map(() => executeCustomerAction(grant, { name: "request_callback", args: { topic: "Позвоните по квартире" } })));
    expect(results.map(result => result.status).sort()).toEqual(["created", "stale"]);
    const row = await prisma.customerAction.findFirstOrThrow({ where: { inquiry: { conversationId: value.ticket.conversationId }, kind: "callback" } });
    expect(await prisma.callbackRequest.count({ where: { customerActionId: row.id } })).toBe(1);
    const resource = await prisma.callbackRequest.findUniqueOrThrow({ where: { customerActionId: row.id } });
    expect(resource.phone).toBe("+992910044971"); expect(resource.clientId).toBeNull(); expect(row.status).toBe("COMMITTED");
    const receiptGrant = await authority(value, "callback", "receipt");
    expect((await loadCustomerActionReceipt(receiptGrant, row.id)).status).toBe("already_committed");
    await quarantineOwnJob(row.id);
  });
  it("same protected Meta inquiry reuses a committed stated contact on the next callback", async () => {
    const account = await meta(); const peer = `synthetic-repeat-${randomUUID()}`;
    const contact = await freshInput("Меня зовут Синтетик. +992 91 004 49 72", "contact", { account, peer });
    const saved = await executeCustomerAction(await authority(contact, "contact"), { name: "save_contact", args: { name: "Синтетик", phone: "+992910044972" } });
    expect(saved.status).toBe("created");
    const callback = await freshInput("Позвоните по квартире", "callback", { account, peer });
    const result = await executeCustomerAction(await authority(callback, "callback"), { name: "request_callback", args: { topic: "Позвоните по квартире" } });
    expect(result.status).toBe("created"); if (result.status !== "created") throw new Error("Callback not created");
    const resource = await prisma.callbackRequest.findUniqueOrThrow({ where: { id: result.receipt.resourceId } });
    expect(resource.phone).toBe("+992910044972"); expect(resource.clientId).toBeNull(); await quarantineOwnJob(result.receipt.actionId);
  });
  it("WEBSITE app authentication and the same guessed sid cannot reuse prior contact", async () => {
    const peer = `synthetic-website-${randomUUID()}`;
    const contact = await freshInput("Синтетик +992910044973", "contact", { website: true, peer });
    expect((await executeCustomerAction(await authority(contact, "contact"), { name: "save_contact", args: { name: "Синтетик", phone: "+992910044973" } })).status).toBe("created");
    const callback = await freshInput("Перезвоните мне", "callback", { website: true, peer });
    const result = await executeCustomerAction(await authority(callback, "callback"), { name: "request_callback", args: { topic: "Перезвоните мне" } });
    expect(result).toEqual({ status: "needs_input", reason: "phone_required" });
    const inquiry = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: callback.ticket.conversationId } });
    expect(await prisma.customerAction.count({ where: { inquiryId: inquiry.id, kind: "callback" } })).toBe(0);
    expect(await prisma.callbackRequest.count({ where: { conversationId: callback.ticket.conversationId } })).toBe(0);
    expect(await issueCustomerWriteAuthority(callback.input, callback.ticket, "callback", prisma, "receipt")).toBeNull();
  });
  it("retains protected explicit callback consent while waiting for a phone-only next IN", async () => {
    const account = await meta(); const peer = `synthetic-continuation-${randomUUID()}`;
    const request = await freshInput("Позвоните завтра", "callback", { account, peer });
    const firstGrant = await authority(request, "callback");
    expect(await executeCustomerAction(firstGrant, { name: "request_callback", args: { topic: "Позвоните завтра" } }))
      .toEqual({ status: "needs_input", reason: "phone_required" });
    const before = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: request.ticket.conversationId } });
    expect(await prisma.customerAction.count({ where: { inquiryId: before.id } })).toBe(0);
    expect(await prisma.callbackRequest.count({ where: { conversationId: request.ticket.conversationId } })).toBe(0);
    const phone = await freshInput("+992910044977", "callback", { account, peer });
    const after = await prisma.customerInquiry.findUniqueOrThrow({ where: { id: before.id } });
    const beforeSlot = customerActionIntentsSchema.parse(before.actionIntents).callback!;
    const afterSlot = customerActionIntentsSchema.parse(after.actionIntents).callback!;
    expect(afterSlot.generation).toBe(beforeSlot.generation);
    expect(afterSlot.status).toBe("open");
    expect(afterSlot.consent?.originalEventKey).toBe(request.ticket.eventKey);
    expect(afterSlot.evidenceRefs).toContain(phone.ticket.eventKey);
    const result = await executeCustomerAction(await authority(phone, "callback"), { name: "request_callback", args: { topic: "Клиент просит звонок" } });
    expect(result.status).toBe("created"); if (result.status !== "created") throw new Error("Callback not created");
    expect((await prisma.callbackRequest.findUniqueOrThrow({ where: { id: result.receipt.resourceId } })).phone).toBe("+992910044977");
    expect(await prisma.customerAction.count({ where: { inquiryId: before.id, kind: "callback" } })).toBe(1);
    await quarantineOwnJob(result.receipt.actionId);
  });
  it("mint A → ordinary IN B rejects old execution without rows/jobs, preserving consent for a fresh phone C grant", async () => {
    const account = await meta(); const peer = `synthetic-stale-input-${randomUUID()}`;
    const request = await freshInput("Позвоните +992910044985", "callback", { account, peer });
    const oldGrant = await authority(request, "callback");
    const before = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: request.ticket.conversationId } });
    const ordinary = await freshInput("Спасибо", "callback", { account, peer });
    const latest = await prisma.customerInquiry.findUniqueOrThrow({ where: { id: before.id } });
    expect(latest.lastAcceptedEventKey).toBe(ordinary.ticket.eventKey);
    expect(customerActionIntentsSchema.parse(latest.actionIntents).callback?.generation)
      .toBe(customerActionIntentsSchema.parse(before.actionIntents).callback?.generation);
    expect(customerActionIntentsSchema.parse(latest.actionIntents).callback?.status).toBe("open");
    // Read only this real execution transaction's persisted jobs, not global
    // counts that other fixture workers can legitimately change.
    const original = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce(async (operation, options) => {
      if (typeof operation !== "function") throw new Error("Expected actual customer executor transaction");
      return original(async tx => {
        const result = await operation(tx);
        const [jobs] = await tx.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM "BackgroundJob"
          WHERE "type"='customer-callback-notify' AND xmin::text::bigint=(txid_current()%4294967296)`;
        expect(jobs.count).toBe(0n);
        return result;
      }, options);
    });
    try {
      expect((await executeCustomerAction(oldGrant, { name: "request_callback", args: { topic: "Позвоните по квартире" } })).status).toBe("stale");
    } finally { spy.mockRestore(); }
    expect(await prisma.customerAction.count({ where: { inquiryId: before.id } })).toBe(0);
    expect(await prisma.callbackRequest.count({ where: { conversationId: request.ticket.conversationId } })).toBe(0);
    const phone = await freshInput("+992910044986", "callback", { account, peer });
    const result = await executeCustomerAction(await authority(phone, "callback"), { name: "request_callback", args: { topic: "Клиент просит звонок" } });
    expect(result.status).toBe("created"); if (result.status !== "created") throw new Error("Fresh callback not created");
    expect((await prisma.callbackRequest.findUniqueOrThrow({ where: { id: result.receipt.resourceId } })).phone).toBe("+992910044986");
    expect(result.receipt.generation).toBe(customerActionIntentsSchema.parse(before.actionIntents).callback?.generation);
    await quarantineOwnJob(result.receipt.actionId);
  });
  it("committed A → ordinary IN B invalidates both old execute and previously minted receipt grants without customer ACK", async () => {
    const account = await meta(); const peer = `synthetic-stale-receipt-${randomUUID()}`;
    const request = await freshInput("Позвоните +992910044987", "callback", { account, peer }); const oldGrant = await authority(request, "callback");
    const created = await executeCustomerAction(oldGrant, { name: "request_callback", args: { topic: "Позвоните по квартире" } });
    expect(created.status).toBe("created"); if (created.status !== "created") throw new Error("Callback not created");
    await quarantineOwnJob(created.receipt.actionId);
    const oldReceiptGrant = await authority(request, "callback", "receipt");
    expect((await loadCustomerActionReceipt(oldReceiptGrant, created.receipt.actionId)).status).toBe("already_committed");
    await freshInput("Спасибо", "callback", { account, peer });
    const replay = await executeCustomerAction(oldGrant, { name: "request_callback", args: { topic: "Позвоните по квартире" } });
    expect(replay.status).toBe("stale"); expect(replay).not.toHaveProperty("receipt");
    const staleReceipt = await loadCustomerActionReceipt(oldReceiptGrant, created.receipt.actionId);
    expect(staleReceipt.status).toBe("stale"); expect(staleReceipt).not.toHaveProperty("receipt");
    expect(await prisma.callbackRequest.count({ where: { customerActionId: created.receipt.actionId } })).toBe(1);
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: `customer-callback-notify:${created.receipt.actionId}` } })).toBe(1);
    expect(await issueCustomerWriteAuthority(request.input, request.ticket, "callback", prisma, "receipt")).toBeNull();
    expect((await reconcileCustomerAction(created.receipt.actionId)).status).toBe("committed");
  });
  it("Website phone-only input cannot revive a prior guessed-session callback consent", async () => {
    const peer = `synthetic-website-consent-${randomUUID()}`;
    const request = await freshInput("Позвоните завтра", "callback", { website: true, peer });
    expect(await executeCustomerAction(await authority(request, "callback"), { name: "request_callback", args: { topic: "Позвоните завтра" } }))
      .toEqual({ status: "needs_input", reason: "phone_required" });
    const phone = await freshInput("+992910044978", "callback", { website: true, peer });
    expect(await issueCustomerWriteAuthority(phone.input, phone.ticket, "callback", prisma)).toBeNull();
    expect(await prisma.callbackRequest.count({ where: { conversationId: phone.ticket.conversationId } })).toBe(0);
  });
  it("Website can create a public callback from fresh same-IN consent and customer-stated phone", async () => {
    const value = await freshInput("Позвоните мне +992910044980", "callback", { website: true });
    const result = await executeCustomerAction(await authority(value, "callback"), { name: "request_callback", args: { topic: "Позвоните по квартире" } });
    expect(result.status).toBe("created"); if (result.status !== "created") throw new Error("Website callback not created");
    const row = await prisma.callbackRequest.findUniqueOrThrow({ where: { id: result.receipt.resourceId } });
    expect(row.phone).toBe("+992910044980"); expect(row.clientId).toBeNull();
    await quarantineOwnJob(result.receipt.actionId);
  });
  it("public company phone is not a dial target and does not create a false callback receipt", async () => {
    const value = await freshInput("Позвоните +992 44 650 14 14", "callback");
    const result = await executeCustomerAction(await authority(value, "callback"), { name: "request_callback", args: { topic: "Позвоните" } });
    expect(result).toEqual({ status: "needs_input", reason: "phone_required" });
    const inquiry = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: value.ticket.conversationId } });
    expect(await prisma.customerAction.count({ where: { inquiryId: inquiry.id } })).toBe(0);
    expect(await prisma.callbackRequest.count({ where: { conversationId: value.ticket.conversationId } })).toBe(0);
  });
  it.each(["Не звоните мне", "Занг назанед"])("actual new IN cancellation '%s' fences an already captured callback plan", async cancellation => {
    const account = await meta(); const peer = `synthetic-cancel-${randomUUID()}`;
    const request = await freshInput("Позвоните +992910044982", "callback", { account, peer });
    const grant = await authority(request, "callback");
    const cancel = await freshInput(cancellation, "callback", { account, peer });
    expect(await issueCustomerWriteAuthority(cancel.input, cancel.ticket, "callback", prisma)).toBeNull();
    expect((await executeCustomerAction(grant, { name: "request_callback", args: { topic: "Позвоните по квартире" } })).status).toBe("stale");
    const inquiry = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: request.ticket.conversationId } });
    expect(customerActionIntentsSchema.parse(inquiry.actionIntents).callback?.status).toBe("cancelled");
    expect(await prisma.customerAction.count({ where: { inquiryId: inquiry.id } })).toBe(0);
    expect(await prisma.callbackRequest.count({ where: { conversationId: request.ticket.conversationId } })).toBe(0);
  });
  it("a real native human-pause mutation fences an earlier captured callback before any effect", async () => {
    const value = await freshInput("Позвоните +992910044983", "callback"); const grant = await authority(value, "callback");
    await prisma.botConversation.update({ where: { id: value.ticket.conversationId }, data: { pausedUntil: new Date(Date.now() + 60_000) } });
    expect((await executeCustomerAction(grant, { name: "request_callback", args: { topic: "Позвоните по квартире" } })).status).toBe("stale");
    const inquiry = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: value.ticket.conversationId } });
    expect(await prisma.customerAction.count({ where: { inquiryId: inquiry.id } })).toBe(0);
    expect(await prisma.callbackRequest.count({ where: { conversationId: value.ticket.conversationId } })).toBe(0);
  });
  it("account signing-key rotate-and-restore invalidates an earlier callback grant without revealing or using the restored key", async () => {
    const account = await meta(); const value = await freshInput("Позвоните +992910044984", "callback", { account });
    const grant = await authority(value, "callback");
    await prisma.messengerAccount.update({ where: { id: account.id }, data: { appSecret: encryptSecret(`synthetic-rotated-${randomUUID()}`) } });
    await prisma.messengerAccount.update({ where: { id: account.id }, data: { appSecret: encryptSecret(account.secret) } });
    expect((await executeCustomerAction(grant, { name: "request_callback", args: { topic: "Позвоните по квартире" } })).status).toBe("stale");
    const inquiry = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: value.ticket.conversationId } });
    expect(await prisma.customerAction.count({ where: { inquiryId: inquiry.id } })).toBe(0);
    expect(await prisma.callbackRequest.count({ where: { conversationId: value.ticket.conversationId } })).toBe(0);
  });
  it("authenticated WA peer provides a transport dial target without a private Client match", async () => {
    const account = await meta("WHATSAPP"); const value = await freshInput("Занг занед", "callback", { account, peer: "992910044974" });
    const result = await executeCustomerAction(await authority(value, "callback"), { name: "request_callback", args: { topic: "Занг занед" } });
    expect(result.status).toBe("created"); if (result.status !== "created") throw new Error("Callback not created");
    const row = await prisma.callbackRequest.findUniqueOrThrow({ where: { id: result.receipt.resourceId } });
    expect(row.phone).toBe("+992910044974"); expect(row.clientId).toBeNull(); await quarantineOwnJob(result.receipt.actionId);
  });
  it.each(["WHATSAPP", "FACEBOOK"] as const)("exact installed Settings %s grants scoped action with a legitimate NULL account", async channel => {
    const currentSettings = await readSettings();
    const account: InstalledMeta = { id: null, channel, externalId: `synthetic-installed-${randomUUID()}`, secret: `synthetic-installed-key-${randomUUID()}` };
    try {
      await prisma.settings.update({ where: { id: "singleton" }, data: { metaAppSecret: encryptSecret(account.secret),
        ...(channel === "WHATSAPP" ? { metaWaPhoneId: account.externalId, metaWaToken: encryptSecret("synthetic-wa-token") }
          : { metaPageId: account.externalId, metaPageToken: encryptSecret("synthetic-fb-token") }) } });
      const value = await freshInput("Позвоните мне +992910044979", "callback", { account });
      expect(value.ticket.accountId).toBeNull();
      expect(value.ticket.endpointScopeId).toBeTruthy();
      const storedTicket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: value.ticket.eventKey } });
      expect(storedTicket.endpointScopeId).toBe(value.ticket.endpointScopeId);
      const result = await executeCustomerAction(await authority(value, "callback"), { name: "request_callback", args: { topic: "Позвоните по квартире" } });
      expect(result.status).toBe("created"); if (result.status !== "created") throw new Error("Installed callback not created");
      expect((await prisma.callbackRequest.findUniqueOrThrow({ where: { id: result.receipt.resourceId } })).phone).toBe("+992910044979");
      await quarantineOwnJob(result.receipt.actionId);
    } finally { await prisma.settings.update({ where: { id: "singleton" }, data: currentSettings }); }
  });
  it("a lost commit ACK remains unknown, then read-only reconciliation finds the same receipt", async () => {
    const value = await freshInput("Перезвоните мне +992910044975", "callback"); const grant = await authority(value, "callback");
    const original = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce(async (...args: Parameters<typeof original>) => {
      await original(...args); throw new Error("Synthetic commit acknowledgement lost");
    });
    const result = await executeCustomerAction(grant, { name: "request_callback", args: { topic: "Перезвоните по квартире" } }); spy.mockRestore();
    expect(result).toEqual({ status: "unknown", reason: "commit_unconfirmed" });
    const action = await prisma.customerAction.findFirstOrThrow({ where: { inquiry: { conversationId: value.ticket.conversationId }, kind: "callback" } });
    const recovered = await reconcileCustomerAction(action.id); expect(recovered.status).toBe("committed");
    const receiptGrant = await authority(value, "callback", "receipt"); const loaded = await loadCustomerActionReceipt(receiptGrant, action.id);
    expect(loaded.status).toBe("already_committed"); expect(await prisma.callbackRequest.count({ where: { customerActionId: action.id } })).toBe(1);
    expect((await executeCustomerAction(receiptGrant, { name: "request_callback", args: { topic: "Перезвоните" } })).status).toBe("denied");
    await quarantineOwnJob(action.id);
  });
  it("a completed callback remains a known historical commit but cannot acknowledge a pending task or recreate it", async () => {
    const value = await freshInput("Позвоните +992910044981", "callback"); const grant = await authority(value, "callback");
    const created = await executeCustomerAction(grant, { name: "request_callback", args: { topic: "Позвоните по квартире" } });
    expect(created.status).toBe("created"); if (created.status !== "created") throw new Error("Callback not created");
    await quarantineOwnJob(created.receipt.actionId);
    expect((await transitionManagedCustomerCallback(await staff(), {
      requestId: created.receipt.resourceId, expectedRevision: "1", action: "close",
    })).status).toBe("applied");
    const recovered = await reconcileCustomerAction(created.receipt.actionId);
    expect(recovered.status).toBe("committed");
    if (recovered.status !== "committed") throw new Error("Historical commit not found");
    expect(recovered.resourceActive).toBe(false);
    const receiptGrant = await authority(value, "callback", "receipt");
    expect(await loadCustomerActionReceipt(receiptGrant, created.receipt.actionId))
      .toEqual({ status: "needs_review", reason: "callback_no_longer_pending" });
    expect((await executeCustomerAction(grant, { name: "request_callback", args: { topic: "Позвоните по квартире" } })).status).toBe("stale");
    expect(await prisma.callbackRequest.count({ where: { customerActionId: created.receipt.actionId } })).toBe(1);
  });
  it("postcommit push failure cannot undo the callback or turn it into agent delivery", async () => {
    const value = await freshInput("Позвоните мне +992910044976", "callback");
    const result = await executeCustomerAction(await authority(value, "callback"), { name: "request_callback", args: { topic: "Позвоните по квартире" } });
    expect(result.status).toBe("created"); if (result.status !== "created") throw new Error("Callback not created");
    vi.mocked(sendPushToAgents).mockRejectedValueOnce(new Error("Synthetic push unavailable"));
    await expect(customerCallbackNotifyJob.run({ version: 1, actionId: result.receipt.actionId })).rejects.toThrow("Synthetic push unavailable");
    expect((await prisma.customerAction.findUniqueOrThrow({ where: { id: result.receipt.actionId } })).status).toBe("COMMITTED");
    expect(await prisma.callbackRequest.count({ where: { customerActionId: result.receipt.actionId } })).toBe(1);
    await quarantineOwnJob(result.receipt.actionId);
  });
});

describe("P08 real HUMAN task / staff lifecycle", () => {
  it.each([
    { text: "Не нужен оператор", kind: "handover", name: "request_handover" },
    { text: "Кто такой оператор?", kind: "handover", name: "request_handover" },
    { text: "Не спрашивайте у собственника", kind: "owner_question", name: "ask_owner" },
    { text: "Не передавайте мой вопрос собственнику?", kind: "owner_question", name: "ask_owner" },
  ] as const)("actual protected refusal/mention '$text' cannot open an intent or create effects", async ({ text, kind, name }) => {
    const value = await freshInput(text, kind);
    const command = name === "request_handover" ? { name, args: { topic: text } } : { name, args: { question: text } };
    const before = await loadCustomerStateSnapshot({ conversationId: value.ticket.conversationId });
    expect(before?.ownerMode).toBe("BOT"); expect(before?.capabilities.handoverWrite).toBe(true); expect(before?.capabilities.ownerQuestionWrite).toBe(true);
    const storedBefore = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: value.ticket.conversationId }, select: { actionIntents: true } });
    expect(await openAuthenticatedCustomerMutationIntent(value.input, value.ticket, command)).toBe("denied");
    expect(await issueCustomerWriteAuthority(value.input, value.ticket, kind, prisma)).toBeNull();
    const stored = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: value.ticket.conversationId }, select: { actionIntents: true } });
    expect(stored.actionIntents).toEqual(storedBefore.actionIntents);
    const intents = customerActionIntentsSchema.parse(stored.actionIntents);
    expect(intents.handover).toBeUndefined(); expect(intents.owner_question).toBeUndefined();
    expect(await loadCustomerStateSnapshot({ conversationId: value.ticket.conversationId })).toEqual(before);
    expect(await prisma.customerAction.count({ where: { inquiryId: before!.fence.inquiryId } })).toBe(0);
    expect(await prisma.callbackRequest.count({ where: { conversationId: value.ticket.conversationId } })).toBe(0);
    expect(await prisma.ownerQuestion.count({ where: { conversationId: value.ticket.conversationId } })).toBe(0);
    const [jobs] = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM "BackgroundJob" j
      JOIN "CustomerAction" a ON a."id"=j."payload"->>'actionId' WHERE a."inquiryId"=${before!.fence.inquiryId}`;
    expect(jobs.count).toBe(0n);
  });
  it("actual selected queue masks contacts in current-IN topic using fresh staff phone rights and preserves stored text", async () => {
    const topic = "Прошу оператора +992910044995 @synthetic_contact t.me/synthetic_contact wa.me/992910044995";
    const value = await freshInput(topic, "handover"), command = { name: "request_handover", args: { topic } } as const;
    expect(await openAuthenticatedCustomerMutationIntent(value.input, value.ticket, command)).toBe("opened");
    const created = await executeCustomerAction(await authority(value, "handover"), command);
    expect(created.status).toBe("created"); if (created.status !== "created") throw new Error("Handover not committed");
    await quarantineOwnJob(created.receipt.actionId);
    const actor = await staff(), options = { staffAgentId: actor.agent!.id, conversationId: value.ticket.conversationId, includeLegacy: false };
    const visible = await loadPendingCallbackRequests(true, 1, options);
    expect(visible).toHaveLength(1); expect(visible[0]).toMatchObject({ id: created.receipt.resourceId, topic });
    await prisma.agent.update({ where: { id: actor.agent!.id }, data: { permissions: { revoked: ["clients.viewPhone"] } } });
    const masked = await loadPendingCallbackRequests(true, 1, options);
    expect(masked).toHaveLength(1); expect(masked[0].topic).toContain("Прошу оператора");
    expect(masked[0].topic).not.toContain("992910044995"); expect(masked[0].topic).not.toContain("synthetic_contact");
    expect(masked[0].topic).toContain("•"); expect(masked[0].closureReason).toBeNull();
    expect((await prisma.callbackRequest.findUniqueOrThrow({ where: { id: created.receipt.resourceId } })).topic).toBe(topic);
  });
  it("commits one V2 HUMAN resource, required job and HOLD; a later actual IN cannot reactivate or duplicate it", async () => {
    const account = await meta(), peer = `synthetic-handover-${randomUUID()}`;
    const opened = await handover({ account, peer });
    const result = await executeCustomerAction(opened.grant, opened.command);
    expect(result.status).toBe("created"); if (result.status !== "created") throw new Error("Handover not committed");
    expect(result.receipt).toMatchObject({ version: 2, kind: "handover", outcome: "handover_requested", resourceType: "CallbackRequest", resourceRevision: "1" });
    const row = await prisma.callbackRequest.findUniqueOrThrow({ where: { id: result.receipt.resourceId } });
    expect(row).toMatchObject({ requestKind: "HUMAN", lifecycleStatus: "QUEUED", lifecycleRevision: 1n,
      phone: null, assignedAgentId: null, acceptedAt: null, customerActionId: result.receipt.actionId });
    expect(row.handoverFence).not.toBeNull(); await quarantineOwnJob(result.receipt.actionId);
    const held = await loadCustomerStateSnapshot({ conversationId: opened.value.ticket.conversationId });
    expect(held?.ownerMode).toBe("HOLD"); expect(held?.fence.ownerToken).toBeTruthy(); expect(BigInt(held!.fence.ownershipEpoch)).toBeGreaterThan(0n);
    await freshInput("Спасибо, ещё вопрос", "handover", { account, peer });
    const after = await loadCustomerStateSnapshot({ conversationId: row.conversationId! });
    expect(after?.ownerMode).toBe("HOLD"); expect(after?.fence.ownerToken).toBe(held?.fence.ownerToken);
    expect((await executeCustomerAction(opened.grant, opened.command)).status).toBe("stale");
    expect(await prisma.callbackRequest.count({ where: { customerActionId: result.receipt.actionId } })).toBe(1);
    // Own HOLD intentionally revokes BOT receipt/OUT authority; P12 must supply
    // a separate narrow acknowledgement mechanism, never revive this grant.
    expect(await issueCustomerWriteAuthority(opened.value.input, opened.value.ticket, "handover", prisma, "receipt")).toBeNull();
    expect((await reconcileCustomerAction(result.receipt.actionId)).status).toBe("committed");
  });
  it("real staff claim uses revision CAS and HUMAN ownership; only that assignee can return, queued close never fakes acceptance", async () => {
    const opened = await handover(), result = await executeCustomerAction(opened.grant, opened.command);
    expect(result.status).toBe("created"); if (result.status !== "created") throw new Error("Handover not committed");
    await quarantineOwnJob(result.receipt.actionId);
    const actor = await staff(), other = await staff(), requestId = result.receipt.resourceId;
    const claims = await Promise.all([actor, other].map(req => transitionManagedCustomerCallback(req, { requestId, expectedRevision: "1", action: "accept" })));
    expect(claims.map(value => value.status).sort()).toEqual(["applied", "stale"]);
    const claimed = await prisma.callbackRequest.findUniqueOrThrow({ where: { id: requestId } });
    const winner = claimed.assignedAgentId === actor.agent!.id ? actor : other;
    const loser = winner === actor ? other : actor;
    expect(claimed.lifecycleRevision).toBe(2n); expect(claimed.acceptedAt).not.toBeNull();
    expect(await loadCustomerStateSnapshot({ conversationId: claimed.conversationId! })).toMatchObject({ ownerMode: "HUMAN", ownerAgentId: winner.agent!.id });
    expect((await transitionManagedCustomerCallback(loser, { requestId, expectedRevision: "2", action: "return" })).status).toBe("denied");
    expect((await transitionManagedCustomerCallback(winner, { requestId, expectedRevision: "2", action: "return" })).status).toBe("applied");
    const returned = await prisma.callbackRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(returned).toMatchObject({ lifecycleStatus: "QUEUED", lifecycleRevision: 3n, assignedAgentId: null, acceptedAt: null });
    const repeatJob = await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: `customer-callback-notify:${result.receipt.actionId}:r3` } });
    await prisma.backgroundJob.update({ where: { id: repeatJob.id }, data: { runAt: new Date("2099-01-01T00:00:00Z") } });
    expect((await transitionManagedCustomerCallback(loser, { requestId, expectedRevision: "3", action: "close" })).status).toBe("applied");
    expect(await prisma.callbackRequest.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({
      lifecycleStatus: "CLOSED", lifecycleRevision: 4n, assignedAgentId: null, acceptedAt: null, closureReason: "staff_closed" });
    expect((await loadCustomerStateSnapshot({ conversationId: claimed.conversationId! }))?.ownerMode).toBe("HOLD");
  });
  it("fresh DB staff ACL and changed owner token reject claims without task changes", async () => {
    const opened = await handover(), result = await executeCustomerAction(opened.grant, opened.command);
    expect(result.status).toBe("created"); if (result.status !== "created") throw new Error("Handover not committed");
    await quarantineOwnJob(result.receipt.actionId);
    const actor = await staff(), before = await prisma.callbackRequest.findUniqueOrThrow({ where: { id: result.receipt.resourceId } });
    await prisma.agent.update({ where: { id: actor.agent!.id }, data: { isActive: false } });
    expect((await transitionManagedCustomerCallback(actor, { requestId: before.id, expectedRevision: "1", action: "accept" })).status).toBe("denied");
    await prisma.agent.update({ where: { id: actor.agent!.id }, data: { isActive: true } });
    const state = await loadCustomerStateSnapshot({ conversationId: before.conversationId! });
    expect(state).not.toBeNull();
    expect((await prisma.$transaction(tx => transitionCustomerState(tx, state!.fence, {
      type: "owner", mode: "HOLD", agentId: null, token: randomUUID(), leaseUntil: null,
    }))).status).toBe("applied");
    expect((await transitionManagedCustomerCallback(actor, { requestId: before.id, expectedRevision: "1", action: "accept" })).status).toBe("stale");
    expect(await prisma.callbackRequest.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
  });
  it("CALLBACK acceptance does not claim the conversation or become HUMAN handover", async () => {
    const value = await freshInput("Позвоните +992910044996", "callback");
    const created = await executeCustomerAction(await authority(value, "callback"), { name: "request_callback", args: { topic: "Позвоните" } });
    expect(created.status).toBe("created"); if (created.status !== "created") throw new Error("Callback not committed");
    await quarantineOwnJob(created.receipt.actionId);
    const before = await loadCustomerStateSnapshot({ conversationId: value.ticket.conversationId });
    expect((await transitionManagedCustomerCallback(await staff(), { requestId: created.receipt.resourceId, expectedRevision: "1", action: "accept" })).status).toBe("applied");
    const after = await loadCustomerStateSnapshot({ conversationId: value.ticket.conversationId });
    expect(after?.ownerMode).toBe("BOT"); expect(after?.fence.ownershipEpoch).toBe(before?.fence.ownershipEpoch);
    expect(after?.fence.ownerToken).toBe(before?.fence.ownerToken);
  });
  it("credential rotation makes acceptance stale but permits administrative terminal cleanup without changing ownership", async () => {
    const account = await meta(), opened = await handover({ account });
    const result = await executeCustomerAction(opened.grant, opened.command);
    if (result.status !== "created") throw new Error("Handover not committed");
    await quarantineOwnJob(result.receipt.actionId);
    const actor = await staff(), requestId = result.receipt.resourceId;
    const oldTask = await prisma.callbackRequest.findUniqueOrThrow({ where: { id: requestId } });
    await prisma.messengerAccount.update({ where: { id: account.id }, data: { appSecret: encryptSecret(`rotated-${randomUUID()}`) } });
    const before = await loadCustomerStateSnapshot({ conversationId: opened.value.ticket.conversationId });
    expect((await transitionManagedCustomerCallback(actor, { requestId, expectedRevision: "1", action: "accept" })).status).toBe("stale");
    await prisma.agent.update({ where: { id: actor.agent!.id }, data: { permissions: { revoked: ["clients.assign"] } } });
    expect((await transitionManagedCustomerCallback(actor, { requestId, expectedRevision: "1", action: "close" })).status).toBe("denied");
    await prisma.agent.update({ where: { id: actor.agent!.id }, data: { permissions: {} } });
    const results = await Promise.all([1, 2].map(() => transitionManagedCustomerCallback(actor, { requestId, expectedRevision: "1", action: "close" })));
    expect(results.map(item => item.status).sort()).toEqual(["applied", "stale"]);
    expect(await loadCustomerStateSnapshot({ conversationId: opened.value.ticket.conversationId })).toEqual(before);
    expect(await prisma.callbackRequest.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({
      lifecycleStatus: "CLOSED", lifecycleRevision: 2n, closureReason: "obsolete_context", handoverFence: oldTask.handoverFence,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("a deleted native permits only terminal cleanup of its closed inquiry and never recreates a recipient", async () => {
    const opened = await handover(), result = await executeCustomerAction(opened.grant, opened.command);
    if (result.status !== "created") throw new Error("Handover not committed");
    await quarantineOwnJob(result.receipt.actionId);
    const nativeId = opened.value.ticket.conversationId, state = await loadCustomerStateSnapshot({ conversationId: nativeId });
    deletedNativeInquiryIds.push(state!.fence.inquiryId);
    await prisma.botConversation.delete({ where: { id: nativeId } });
    const before = await prisma.customerInquiry.findUniqueOrThrow({ where: { id: state!.fence.inquiryId } });
    expect(before.conversationId).toBeNull(); expect(before.closedAt).not.toBeNull();
    const actor = await staff(), requestId = result.receipt.resourceId;
    expect((await transitionManagedCustomerCallback(actor, { requestId, expectedRevision: "1", action: "accept" })).status).toBe("denied");
    expect(await transitionManagedCustomerCallback(actor, { requestId, expectedRevision: "1", action: "close" })).toMatchObject({
      status: "applied", task: { lifecycleStatus: "CLOSED", closureReason: "obsolete_context" },
    });
    expect(await prisma.customerInquiry.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
    expect(await prisma.botConversation.count({ where: { id: nativeId } })).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("required notification failure rolls back actual action/resource/intent commit and HOLD together", async () => {
    const opened = await handover(), before = await loadCustomerStateSnapshot({ conversationId: opened.value.ticket.conversationId });
    const original = prisma.$transaction.bind(prisma);
    let attempted = false;
    const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce(async (operation, options) => {
      if (typeof operation !== "function") throw new Error("Expected real execution transaction");
      return original(async tx => {
        const job = vi.spyOn(tx.backgroundJob, "create").mockImplementationOnce(async () => {
          attempted = true; throw new Error("Synthetic required job failure");
        });
        try { return await operation(tx); } finally { job.mockRestore(); }
      }, options);
    });
    try { expect(await executeCustomerAction(opened.grant, opened.command)).toEqual({ status: "unknown", reason: "commit_unconfirmed" }); }
    finally { spy.mockRestore(); }
    expect(attempted).toBe(true);
    expect(await loadCustomerStateSnapshot({ conversationId: opened.value.ticket.conversationId })).toEqual(before);
    expect(await prisma.customerAction.count({ where: { inquiryId: before!.fence.inquiryId } })).toBe(0);
    expect(await prisma.callbackRequest.count({ where: { conversationId: opened.value.ticket.conversationId } })).toBe(0);
  });
  it("committed V2 HUMAN notification has no fake success when no eligible staff exists", async () => {
    const opened = await handover(), created = await executeCustomerAction(opened.grant, opened.command);
    expect(created.status).toBe("created"); if (created.status !== "created") throw new Error("Handover not committed");
    await quarantineOwnJob(created.receipt.actionId);
    const original = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { callbackOperatorAgentId: true } });
    const pushCalls = vi.mocked(sendPushToAgents).mock.calls.length;
    try {
      await prisma.settings.update({ where: { id: "singleton" }, data: { callbackOperatorAgentId: null } });
      await expect(customerCallbackNotifyJob.run({ version: 1, actionId: created.receipt.actionId })).rejects.toThrow("no eligible recipients");
    } finally { await prisma.settings.update({ where: { id: "singleton" }, data: original }); }
    expect(vi.mocked(sendPushToAgents).mock.calls).toHaveLength(pushCalls);
    expect(await prisma.callbackRequest.findUniqueOrThrow({ where: { id: created.receipt.resourceId } })).toMatchObject({ lifecycleStatus: "QUEUED", assignedAgentId: null });
    const action = await prisma.customerAction.findUniqueOrThrow({ where: { id: created.receipt.actionId } });
    expect(action.status).toBe("COMMITTED"); expect(action.policyResult).toMatchObject({ notification: { recipientAgentIds: [], agentAcknowledged: false } });
    expect(JSON.stringify(action.policyResult)).not.toContain("providerAcceptedDevices");
  });
});
