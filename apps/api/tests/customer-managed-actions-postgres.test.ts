import { createHmac, randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerMutationCommand, CustomerMutationReceipt } from "@royal-home/shared";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";
import { admitCustomerPropertyInput } from "../src/lib/customerPropertyAdmission.js";
import { captureAuthenticatedCustomerInput, registerAuthenticatedMetaCustomerRequest, verifyAndRegisterMetaCustomerIssuer } from "../src/lib/customerIngressAuthority.js";
import { loadCustomerStateSnapshot, transitionCustomerState, issueCustomerWriteAuthority } from "../src/lib/customerState.js";
import { executeCustomerAction, reconcileCustomerAction } from "../src/lib/customerActionJournal.js";
import { executeNewOnlyCustomerLeadBridge } from "../src/lib/customerNewLeadBridge.js";
import { openAuthenticatedCustomerMutationIntent } from "../src/lib/customerMutationIntent.js";
import { customerMutationKind } from "../src/lib/customerActionCommand.js";
import { readCustomerPropertyFocus, completeCustomerPropertyFocus } from "../src/lib/customerPropertyFocus.js";
import { resolveCustomerPropertyEvidence } from "../src/lib/customerPropertyResolver.js";
import { customerPropertyRegistry } from "../src/lib/customerPropertyRegistry.js";
import { customerPropertyEvidenceFromText } from "../src/lib/customerPropertyEvidence.js";
import { sendPushToAgent, sendPushToAgents } from "../src/push.js";

vi.mock("../src/push.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(), sendPushToAgents: vi.fn(), closeLeadPushNotification: vi.fn() }));

/** Real issuer→FINAL-IN→P03 resolver→intent→authority→journal→resource+job.
 * No trusted EXECUTING rows/grants, model, HTTP parser or live provider is faked
 * into success. Only the explicit owned queue-insert fault below is injected. */
const accountIds: string[] = [], nativeIds: string[] = [], clientIds: string[] = [], propertyIds: string[] = [];
const scopeIds = new Set<string>();
let staffId: string;
const settingsRead = () => prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, botInstagramEnabled: true, metaEnabled: true,
} });
let settingsBefore: Awaited<ReturnType<typeof settingsRead>>;
let policyBefore: Awaited<ReturnType<typeof prisma.customerRuntimePolicy.findUniqueOrThrow>>;
const phone = () => `+99298${randomInt(0, 10_000_000).toString().padStart(7, "0")}`;
type Endpoint = { id: string; externalId: string; secret: string; peer: string; nativeId: string; inquiryId: string };
type Property = { id: string; shortId: number };
const date = (days: number) => {
  const wall = new Date(Date.now() + 5 * 3_600_000 + days * 86_400_000);
  const at = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), 10));
  const label = `${String(wall.getUTCDate()).padStart(2, "0")}.${String(wall.getUTCMonth() + 1).padStart(2, "0")}.${wall.getUTCFullYear()} в 15:00`;
  return { at: at.toISOString(), label };
};

async function endpoint(): Promise<Endpoint> {
  const id = randomUUID(), externalId = `managed-action-${randomUUID()}`, secret = `synthetic-secret-${randomUUID()}`, peer = `managed-peer-${randomUUID()}`;
  await prisma.messengerAccount.create({ data: { id, channel: "INSTAGRAM", externalId, title: "Synthetic managed actions", token: "synthetic-token",
    appSecret: encryptSecret(secret), enabled: true } }); accountIds.push(id);
  const native = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel: "INSTAGRAM", subscriberId: peer, accountId: id, accountExternalId: externalId }));
  nativeIds.push(native.id); scopeIds.add(native.transport.endpointScopeId);
  const inquiry = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: native.id }, select: { id: true } });
  return { id, externalId, secret, peer, nativeId: native.id, inquiryId: inquiry.id };
}
async function input(target: Endpoint, text: string, property?: Property) {
  const rawBody = Buffer.from(JSON.stringify({ synthetic: true, peer: target.peer, text }));
  const request = { rawBody, get: () => `sha256=${createHmac("sha256", target.secret).update(rawBody).digest("hex")}` };
  registerAuthenticatedMetaCustomerRequest(request);
  expect(await verifyAndRegisterMetaCustomerIssuer(request, { channel: "INSTAGRAM", accountId: target.id, accountExternalId: target.externalId })).toBe(true);
  const eventId = randomUUID();
  const authenticated = captureAuthenticatedCustomerInput(request, { channel: "INSTAGRAM", peer: target.peer, accountExternalId: target.externalId,
    eventKind: "message", eventId, inputText: text });
  if (!authenticated) throw new Error("Actual protected input was not captured");
  const evidence = customerPropertyEvidenceFromText(text);
  if (property) expect(evidence).toContainEqual({ kind: "public_selector", origin: "message", reference: `short:${property.shortId}` });
  const admitted = await admitCustomerPropertyInput({ channel: "INSTAGRAM", peer: target.peer, accountId: target.id,
    accountExternalId: target.externalId, eventKind: "message", eventId, evidence, authenticatedInput: authenticated });
  expect(admitted.status).toBe("admitted"); if (admitted.status !== "admitted") throw new Error("Actual admission denied");
  if (property) {
    const pending = await readCustomerPropertyFocus(admitted.ticket);
    if (!pending) throw new Error("P03 pending focus missing");
    const resolved = await resolveCustomerPropertyEvidence(evidence, admitted.ticket, customerPropertyRegistry);
    expect(resolved).toMatchObject({ status: "resolved", propertyId: property.id });
    expect(await completeCustomerPropertyFocus(admitted.ticket, pending, resolved)).toBe(true);
  }
  const accepted = await prisma.customerInquiry.findUniqueOrThrow({ where: { id: target.inquiryId }, select: { lastAcceptedEventKey: true, lastAcceptedOrder: true } });
  expect(accepted.lastAcceptedEventKey).toBe(admitted.ticket.eventKey); expect(accepted.lastAcceptedOrder?.toString()).toBe(admitted.ticket.order);
  return { input: authenticated, ticket: admitted.ticket };
}
async function parkJob(actionId: string, type: string) {
  const jobs = await prisma.backgroundJob.findMany({ where: { dedupeKey: `${type}:${actionId}` } });
  expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ type, payload: { version: 1, actionId } });
  expect(jobs[0].runAt.getTime()).toBeLessThanOrEqual(Date.now() + 2000);
  await prisma.backgroundJob.update({ where: { id: jobs[0].id }, data: { runAt: new Date("2099-01-01T00:00:00Z") } });
}
async function fixture() {
  const target = await endpoint(); const ownPhone = phone(); const name = `Синтетик ${randomUUID()}`;
  const incoming = await input(target, `${name}. ${ownPhone}`);
  const state = await loadCustomerStateSnapshot({ inquiryId: target.inquiryId }); if (!state) throw new Error("Canonical state missing");
  expect((await prisma.$transaction(tx => transitionCustomerState(tx, state.fence, { type: "intent", kind: "contact", change: "request", evidenceRefs: [incoming.ticket.eventKey] }))).status).toBe("applied");
  const authority = await issueCustomerWriteAuthority(incoming.input, incoming.ticket, "contact");
  if (!authority) throw new Error("Actual contact authority missing");
  expect((await executeCustomerAction(authority, { name: "save_contact", args: { name, phone: ownPhone } })).status).toBe("created");
  const bridge = await executeNewOnlyCustomerLeadBridge(authority, { version: 1, kind: "BUYER", deferAssignment: false });
  expect(bridge.status).toBe("created"); if (bridge.status !== "created" || bridge.receipt.resourceType !== "Client") throw new Error("Actual new-only bridge did not commit");
  const clientId = bridge.receipt.resourceId; clientIds.push(clientId); await parkJob(bridge.receipt.actionId, "customer-intake-policy");
  // Owned staff fixture chooses/accepts this newly created Client. It is not
  // customer identity proof; every tested action uses a FRESH signed IN after
  // these actual binding/assignment triggers have changed revisions.
  await prisma.client.update({ where: { id: clientId }, data: { assignedAgentId: staffId, acceptedAt: new Date() } });
  const property = await prisma.property.create({ data: { title: `Managed property ${randomUUID()}`, type: "APARTMENT", areaSqm: 60,
    price: 500000, currency: "TJS", address: "PRIVATE SENTINEL MUST NOT LEAK", condition: "GOOD", status: "AVAILABLE",
    publishedOnSite: true, assignedAgentId: staffId } }); propertyIds.push(property.id);
  return { ...target, clientId, property: { id: property.id, shortId: property.shortId } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function prepare(value: Fixture, command: CustomerMutationCommand, text: string, property?: Property) {
  const incoming = await input(value, text, property);
  expect(await openAuthenticatedCustomerMutationIntent(incoming.input, incoming.ticket, command)).toBe("opened");
  const authority = await issueCustomerWriteAuthority(incoming.input, incoming.ticket, customerMutationKind(command));
  if (!authority) throw new Error("Actual managed action authority missing");
  return authority;
}
function createdReceipt(result: Awaited<ReturnType<typeof executeCustomerAction>>): Extract<CustomerMutationReceipt, { version: 2 }> {
  expect(result.status).toBe("created"); if (result.status !== "created" || result.receipt.version !== 2) throw new Error("Managed journal did not commit a V2 receipt");
  expect(result.receipt.publicRef).toMatch(/^[0-9a-f-]{36}$/); expect(BigInt(result.receipt.resourceRevision)).toBeGreaterThan(0n);
  return result.receipt;
}
async function book(value: Fixture, days = 1) {
  const when = date(days); const command = { name: "book_showing", args: { propertyShortId: value.property.shortId, at: when.at } } as const;
  const authority = await prepare(value, command, `Объект ${value.property.shortId}. Запишите на показ ${when.label}`, value.property);
  const receipt = createdReceipt(await executeCustomerAction(authority, command));
  await parkJob(receipt.actionId, "customer-showing-notify"); return receipt;
}
async function noAction(value: Fixture, kind: string) {
  expect(await prisma.customerAction.count({ where: { inquiryId: value.inquiryId, kind } })).toBe(0);
}
function noOut() { expect(fetch).not.toHaveBeenCalled(); expect(sendPushToAgent).not.toHaveBeenCalled(); expect(sendPushToAgents).not.toHaveBeenCalled(); }

beforeAll(async () => {
  settingsBefore = await settingsRead(); policyBefore = await prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, botInstagramEnabled: true, metaEnabled: true } });
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "scoped", rolloutMode: "ACTIVE",
    capabilities: { publicRead: true, contactWrite: true, callbackWrite: true, handoverWrite: true, showingWrite: true, ownerQuestionWrite: true, newLeadBridge: true } } });
  staffId = (await prisma.agent.create({ data: { fullName: "Synthetic managed-action administrator", phone: `managed-staff-${randomUUID()}`,
    role: "ADMIN", passwordHash: "synthetic-unused-hash", isActive: true } })).id;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("External I/O forbidden in managed-action PG tests"); }));
});
beforeEach(() => { vi.mocked(fetch).mockClear(); vi.mocked(sendPushToAgent).mockClear(); vi.mocked(sendPushToAgents).mockClear(); });
afterAll(async () => {
  const actions = await prisma.customerAction.findMany({ where: { inquiry: { conversationId: { in: nativeIds } } }, select: { id: true } });
  const actionIds = actions.map(row => row.id);
  if (actionIds.length) await prisma.backgroundJob.deleteMany({ where: { OR: actionIds.map(id => ({ payload: { path: ["actionId"], equals: id } })) } });
  await prisma.ownerQuestion.deleteMany({ where: { customerActionId: { in: actionIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.customerAction.deleteMany({ where: { id: { in: actionIds } } });
  await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: nativeIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: nativeIds } } });
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { originalConversationId: { in: nativeIds } } });
  await prisma.outboundShieldState.deleteMany({ where: { endpointScopeId: { in: [...scopeIds] } } });
  await prisma.customerEndpointScope.deleteMany({ where: { id: { in: [...scopeIds] } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  if (staffId) await prisma.agent.delete({ where: { id: staffId } });
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  if (policyBefore) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: {
    contractVersion: policyBefore.contractVersion, rolloutMode: policyBefore.rolloutMode, capabilities: policyBefore.capabilities! } });
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("actual protected customer journal: managed showing and owner question", () => {
  it("books a real V2 resource and exactly one required notification job without customer/provider OUT", async () => {
    const value = await fixture(); const receipt = await book(value);
    expect(receipt).toMatchObject({ kind: "book_showing", resourceType: "Interaction", resourceRevision: "1" });
    expect(await prisma.interaction.findUniqueOrThrow({ where: { id: receipt.resourceId } })).toMatchObject({
      customerBookingActionId: receipt.actionId, managedShowingRevision: 1n, actorKind: "BOT", agentId: null,
      subjectAgentId: staffId, nextAction: "Показ объекта", completedAt: null,
    }); noOut();
  });
  it("a fresh real grant cannot book an assigned but unaccepted Client or autoaccept the lead", async () => {
    const value = await fixture(); await prisma.client.update({ where: { id: value.clientId }, data: { acceptedAt: null } });
    const when = date(1); const command = { name: "book_showing", args: { propertyShortId: value.property.shortId, at: when.at } } as const;
    const grant = await prepare(value, command, `Объект ${value.property.shortId}. Запишите на показ ${when.label}`, value.property);
    expect(await executeCustomerAction(grant, command)).toEqual({ status: "unknown", reason: "commit_unconfirmed" });
    await noAction(value, "book_showing"); expect(await prisma.interaction.count({ where: { clientId: value.clientId, type: "SHOWING" } })).toBe(0);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: value.clientId } })).acceptedAt).toBeNull(); noOut();
  });
  it("reschedules the exact original public bookingRef on the same Interaction with a new revision", async () => {
    const value = await fixture(); const original = await book(value); const when = date(2);
    const command = { name: "reschedule_showing", args: { bookingRef: original.publicRef, expectedRevision: original.resourceRevision, at: when.at } } as const;
    const grant = await prepare(value, command, `Объект ${value.property.shortId}. Перенесите показ ${when.label}`, value.property);
    const receipt = createdReceipt(await executeCustomerAction(grant, command)); await parkJob(receipt.actionId, "customer-showing-notify");
    expect(receipt.resourceId).toBe(original.resourceId); expect(BigInt(receipt.resourceRevision)).toBeGreaterThan(BigInt(original.resourceRevision));
    expect(await prisma.interaction.count({ where: { clientId: value.clientId, type: "SHOWING" } })).toBe(1);
    expect(await prisma.interaction.findUniqueOrThrow({ where: { id: original.resourceId } })).toMatchObject({
      nextActionDate: new Date(when.at), customerBookingActionId: original.actionId,
    }); noOut();
  });
  it("cancels without completed KPI and observes its actual cancellation receipt as active", async () => {
    const value = await fixture(); const original = await book(value);
    const command = { name: "cancel_showing", args: { bookingRef: original.publicRef, expectedRevision: original.resourceRevision } } as const;
    const grant = await prepare(value, command, "Отмените показ");
    const receipt = createdReceipt(await executeCustomerAction(grant, command)); await parkJob(receipt.actionId, "customer-showing-notify");
    expect(receipt.resourceId).toBe(original.resourceId);
    expect(await prisma.interaction.findUniqueOrThrow({ where: { id: original.resourceId } })).toMatchObject({ nextAction: null, declinedAt: expect.any(Date), completedAt: null });
    expect(await reconcileCustomerAction(receipt.actionId)).toMatchObject({ status: "committed", current: true, resourceActive: true }); noOut();
  });
  it("a valid grant in another Inquiry cannot cancel a foreign public bookingRef", async () => {
    const own = await fixture(); const other = await fixture(); const original = await book(own);
    const before = await prisma.interaction.findUniqueOrThrow({ where: { id: original.resourceId } });
    const command = { name: "cancel_showing", args: { bookingRef: original.publicRef, expectedRevision: original.resourceRevision } } as const;
    const grant = await prepare(other, command, "Отмените показ");
    expect(await executeCustomerAction(grant, command)).toEqual({ status: "denied", reason: "owned_resource_required" });
    expect(await prisma.interaction.findUniqueOrThrow({ where: { id: original.resourceId } })).toEqual(before);
    await noAction(other, "cancel_showing"); noOut();
  });
  it("a fresh signed IN after Client binding A→B→A cannot revive the original booking ownership", async () => {
    const value = await fixture(); const other = await fixture(); const original = await book(value);
    await prisma.botConversation.update({ where: { id: value.nativeId }, data: { clientId: other.clientId } });
    await prisma.botConversation.update({ where: { id: value.nativeId }, data: { clientId: value.clientId } });
    const before = await prisma.interaction.findUniqueOrThrow({ where: { id: original.resourceId } });
    const command = { name: "cancel_showing", args: { bookingRef: original.publicRef, expectedRevision: original.resourceRevision } } as const;
    const grant = await prepare(value, command, "Отмените показ");
    expect(await executeCustomerAction(grant, command)).toEqual({ status: "denied", reason: "owned_resource_required" });
    expect(await prisma.interaction.findUniqueOrThrow({ where: { id: original.resourceId } })).toEqual(before);
    await noAction(value, "cancel_showing"); noOut();
  });
  it("model time absent from current IN and ambiguous dates cannot mint executable showing intent", async () => {
    const value = await fixture(); const when = date(1);
    const command = { name: "book_showing", args: { propertyShortId: value.property.shortId, at: when.at } } as const;
    for (const text of [`Объект ${value.property.shortId}. Запишите меня на показ`, `Объект ${value.property.shortId}. Запишите ${when.label} или ${date(2).label}`]) {
      const incoming = await input(value, text, value.property);
      expect(await openAuthenticatedCustomerMutationIntent(incoming.input, incoming.ticket, command)).toBe("denied");
      expect(await issueCustomerWriteAuthority(incoming.input, incoming.ticket, "book_showing")).toBeNull();
    }
    await noAction(value, "book_showing"); expect(await prisma.interaction.count({ where: { clientId: value.clientId, type: "SHOWING" } })).toBe(0); noOut();
  });
  it("a property changed after the real grant produces no showing, receipt or required job", async () => {
    const value = await fixture(); const when = date(1);
    const command = { name: "book_showing", args: { propertyShortId: value.property.shortId, at: when.at } } as const;
    const grant = await prepare(value, command, `Объект ${value.property.shortId}. Запишите на показ ${when.label}`, value.property);
    await prisma.property.update({ where: { id: value.property.id }, data: { offSite: true } });
    expect(await executeCustomerAction(grant, command)).toEqual({ status: "unknown", reason: "commit_unconfirmed" });
    await noAction(value, "book_showing"); expect(await prisma.interaction.count({ where: { clientId: value.clientId, type: "SHOWING" } })).toBe(0);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: value.property.id } })).viewsCount).toBe(0); noOut();
  });
  it("failure inserting this action's required job rolls back the real showing and journal transaction", async () => {
    const value = await fixture(); const when = date(1);
    const command = { name: "book_showing", args: { propertyShortId: value.property.shortId, at: when.at } } as const;
    const grant = await prepare(value, command, `Объект ${value.property.shortId}. Запишите на показ ${when.label}`, value.property);
    const transaction = prisma.$transaction.bind(prisma); let injected = false; let failedActionId: string | null = null;
    const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce(async (operation, options) => {
      if (typeof operation !== "function") throw new Error("Expected actual journal transaction");
      return transaction(async tx => {
        const create = tx.backgroundJob.create.bind(tx.backgroundJob);
        const job = vi.spyOn(tx.backgroundJob, "create").mockImplementation(async args => {
          if (args.data.type === "customer-showing-notify") {
            const action = await tx.customerAction.findFirstOrThrow({ where: { inquiryId: value.inquiryId, kind: "book_showing" } });
            expect(args.data.dedupeKey).toBe(`customer-showing-notify:${action.id}`); failedActionId = action.id;
            injected = true; throw new Error("Synthetic required job failure");
          }
          return create(args);
        });
        try { return await operation(tx); } finally { job.mockRestore(); }
      }, options);
    });
    try { expect(await executeCustomerAction(grant, command)).toEqual({ status: "unknown", reason: "commit_unconfirmed" }); }
    finally { spy.mockRestore(); }
    expect(injected).toBe(true); await noAction(value, "book_showing");
    expect(failedActionId).not.toBeNull();
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: `customer-showing-notify:${failedActionId}` } })).toBe(0);
    expect(await prisma.interaction.count({ where: { clientId: value.clientId, type: "SHOWING" } })).toBe(0);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: value.property.id } })).viewsCount).toBe(0); noOut();
  });
  it("two owned still-pending bookings require clarification instead of a model-chosen cancel target", async () => {
    const value = await fixture(); const first = await book(value);
    // Controlled historical state: the first appointment elapsed but its task
    // was never completed. Actual staff-row revision trigger remains enabled.
    await prisma.interaction.update({ where: { id: first.resourceId }, data: { nextActionDate: new Date(Date.now() - 86_400_000) } });
    const second = await book(value, 2);
    const before = await prisma.interaction.findMany({ where: { clientId: value.clientId, type: "SHOWING" }, orderBy: { id: "asc" } });
    const command = { name: "cancel_showing", args: { bookingRef: second.publicRef, expectedRevision: second.resourceRevision } } as const;
    const grant = await prepare(value, command, "Отмените показ");
    expect(await executeCustomerAction(grant, command)).toEqual({ status: "unknown", reason: "commit_unconfirmed" });
    expect(await prisma.interaction.findMany({ where: { clientId: value.clientId, type: "SHOWING" }, orderBy: { id: "asc" } })).toEqual(before);
    await noAction(value, "cancel_showing"); noOut();
  });
  it("persists an owner question through the same actual issuer/journal and exact P03 target", async () => {
    const value = await fixture(); const question = `Объект ${value.property.shortId}. Спросите собственника, можно ли оплатить частями`;
    const command = { name: "ask_owner", args: { question } } as const;
    const grant = await prepare(value, command, question, value.property);
    const receipt = createdReceipt(await executeCustomerAction(grant, command));
    expect(receipt).toMatchObject({ kind: "owner_question", resourceType: "OwnerQuestion", resourceRevision: "1" });
    await parkJob(receipt.actionId, "customer_owner_question_notify");
    expect(await prisma.ownerQuestion.findUniqueOrThrow({ where: { id: receipt.resourceId } })).toMatchObject({
      customerActionId: receipt.actionId, propertyId: value.property.id, question, answeredAt: null,
      replyTarget: expect.objectContaining({ inquiryId: value.inquiryId, nativeId: value.nativeId, accountId: value.id }),
    }); noOut();
  });
});
