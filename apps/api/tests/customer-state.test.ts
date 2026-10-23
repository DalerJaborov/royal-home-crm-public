import { createHash, createHmac, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { customerRevisionSchema, customerStateEventSchema, customerStateSchema } from "@royal-home/shared";
const transactionContext = vi.hoisted(() => ({ active: new WeakSet<object>() }));
vi.mock("../src/db.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/db.js")>();
  return { ...original, prisma: { $disconnect: () => original.prisma.$disconnect() } };
});
vi.mock("../src/lib/transactionScope.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/transactionScope.js")>()),
  isActiveTransactionClient: (value: unknown) => !!value && typeof value === "object" && transactionContext.active.has(value) }));
import { reduceCustomerState, type CustomerReducerState } from "../src/lib/customerStateReducer.js";
import { acceptAuthenticatedCustomerAdmission, assertCustomerFence, inspectCustomerWriteAuthority, issueCustomerWriteAuthority, loadCustomerStateSnapshot, transitionCustomerState, type CustomerStateDb } from "../src/lib/customerState.js";
import { captureAuthenticatedCustomerInput, inspectAuthenticatedCustomerInput, registerAuthenticatedMetaCustomerRequest,
  registerAuthenticatedWebsiteCustomerRequest, verifyAndRegisterMetaCustomerIssuer } from "../src/lib/customerIngressAuthority.js";
import { verifyAndRegisterPublicMetaCustomerIssuer } from "../src/lib/customerIngressAuthority.js";
import { customerPropertyScopeKey } from "../src/lib/customerPropertyScope.js";
import type { TxClient } from "../src/db.js";
import { isFinalCustomerInputFrame } from "../src/lib/customerInputFrame.js";

// Explicit mocked callback lifetime for leaf SQL adapters. The real ALS/Prisma
// proxy/context is verified separately by customer-transaction-boundary.test.
async function inFixtureTransaction<T>(db: CustomerStateDb, work: () => Promise<T>): Promise<T> {
  transactionContext.active.add(db);
  try { return await work(); } finally { transactionContext.active.delete(db); }
}

function fixture(): CustomerReducerState {
  return { snapshot: customerStateSchema.parse({ version: 1, fence: { inquiryId: randomUUID(), nativeId: randomUUID(),
    endpoint: { endpointScopeId: randomUUID(), channel: "INSTAGRAM", accountId: randomUUID(), peerId: "same-raw-peer", threadId: "" },
    stateRevision: "10", intentRevision: "3", ownershipEpoch: "7", bindingRevision: "2", scopeRevision: "4", policyRevision: "6", ownerToken: randomUUID() },
    ownerMode: "BOT", ownerAgentId: null, ownerLeaseUntil: null, closedAt: null, publicState: {}, privateAuthorization: "none",
    legacyMemoryQuarantined: true, contractVersion: "scoped", rolloutMode: "ACTIVE", capabilities: { publicRead: true, contactWrite: true, callbackWrite: true } }),
    actionIntents: {}, lastAcceptedEventKey: "event-A", lastAcceptedOrder: "10" };
}
function rows(state = fixture()) {
  const s = state.snapshot, f = s.fence, e = f.endpoint;
  return { id: f.inquiryId, endpointScopeId: e.endpointScopeId, peerId: e.peerId, threadId: e.threadId,
    conversationId: f.nativeId, stateRevision: f.stateRevision, intentRevision: f.intentRevision, ownershipEpoch: f.ownershipEpoch,
    bindingRevision: f.bindingRevision, ownerMode: s.ownerMode, ownerAgentId: s.ownerAgentId, ownerToken: f.ownerToken,
    ownerLeaseUntil: null, closedAt: null, publicState: s.publicState, actionIntents: state.actionIntents,
    lastAcceptedEventKey: state.lastAcceptedEventKey, lastAcceptedOrder: 10n, legacyMemoryQuarantined: true,
    scopeRevision: f.scopeRevision, channel: e.channel, scopeKind: "NORMAL", scopeAccountId: e.accountId,
    policyRevision: f.policyRevision, contractVersion: s.contractVersion, rolloutMode: s.rolloutMode, capabilities: s.capabilities,
    nativeId: f.nativeId, nativeEndpointScopeId: e.endpointScopeId, nativeChannel: e.channel, nativePeer: e.peerId, nativeAccountId: e.accountId,
    pausedUntil: null as Date | null, optedOutAt: null as Date | null, propertyChatAgentId: null as string | null,
    accountEnabled: true, clientDeletedAt: null, profileMergedIntoId: null, legacyBotEnabled: true,
    claimedContact: { name: "PRIVATE-OLD-NAME", phone: "PRIVATE-OLD-PHONE" } };
}
function fakeDb(row: ReturnType<typeof rows>) {
  const query = vi.fn(async () => [structuredClone(row)]);
  const execute = vi.fn(async () => 1);
  const db = { $queryRaw: query, $executeRaw: execute } as unknown as CustomerStateDb;
  return { db, query, execute };
}
function applied(result: ReturnType<typeof reduceCustomerState>) {
  expect(result.status).toBe("applied"); return result.state;
}

describe("canonical customer revisions and bounded intent slots", () => {
  it("keeps PG BigInt precision and rejects overflow/malformed revisions", () => {
    expect(customerRevisionSchema.parse("9007199254740993")).toBe("9007199254740993");
    for (const value of ["9223372036854775808", "01", "-1", "1e3"]) expect(customerRevisionSchema.safeParse(value).success).toBe(false);
    expect(customerStateEventSchema.safeParse({ type: "accepted_inbound", eventKey: "x", order: "0" }).success).toBe(false);
  });
  it("does not admit older A after B nor register a duplicate as fresh", () => {
    const start = fixture();
    const b = applied(reduceCustomerState(start, { type: "accepted_inbound", eventKey: "event-B", order: "12" }));
    expect(b.snapshot.fence.stateRevision).toBe("11");
    expect(reduceCustomerState(b, { type: "accepted_inbound", eventKey: "event-A", order: "11" }).status).toBe("stale");
    expect(reduceCustomerState(b, { type: "accepted_inbound", eventKey: "event-B", order: "12" }).status).toBe("same_event");
    expect(start.snapshot.fence.stateRevision).toBe("10");
  });
  it("unrelated price IN does not recreate a committed callback", () => {
    let state = applied(reduceCustomerState(fixture(), { type: "intent", kind: "callback", change: "request", evidenceRefs: ["event-A"] }));
    state = applied(reduceCustomerState(state, { type: "intent_committed", kind: "callback", generation: "1" }));
    state = applied(reduceCustomerState(state, { type: "accepted_inbound", eventKey: "price-B", order: "11", publicState: { language: "ru", topic: "buyer", openQuestion: "price" } }));
    expect(state.actionIntents.callback).toEqual({ generation: "1", status: "committed", evidenceRefs: ["event-A"] });
    expect(state.snapshot.fence.intentRevision).toBe("4");
  });
  function withConsent() {
    const start = fixture(), f = start.snapshot.fence;
    return applied(reduceCustomerState(start, { type: "callback_consent", consent: { matcherVersion: 1,
      originalEventKey: "event-A", originalOrder: "10", nativeId: f.nativeId!, endpointScopeId: f.endpoint.endpointScopeId,
      accountId: f.endpoint.accountId, ownershipEpoch: f.ownershipEpoch, bindingRevision: f.bindingRevision,
      scopeRevision: f.scopeRevision, policyRevision: f.policyRevision, ownerToken: f.ownerToken! } }));
  }
  it("duplicate original callback consent after COMMITTED cannot allocate a second effect generation", () => {
    const open = withConsent(), proof = open.actionIntents.callback!.consent!;
    const committed = applied(reduceCustomerState(open, { type: "intent_committed", kind: "callback", generation: "1" }));
    const duplicate = reduceCustomerState(committed, { type: "callback_consent", consent: proof });
    expect(duplicate.status).toBe("same_event");
    expect(duplicate.state.actionIntents.callback).toEqual(committed.actionIntents.callback);
  });
  it("same accepted-IN command digest cannot reopen a committed handover or replace it with a changed command", () => {
    const commandDigest = "a".repeat(64);
    const open = applied(reduceCustomerState(fixture(), { type: "intent", kind: "handover", change: "request", evidenceRefs: ["event-A"], commandDigest }));
    const committed = applied(reduceCustomerState(open, { type: "intent_committed", kind: "handover", generation: "1" }));
    expect(reduceCustomerState(committed, { type: "intent", kind: "handover", change: "request", evidenceRefs: ["event-A"], commandDigest }).status).toBe("same_event");
    expect(reduceCustomerState(committed, { type: "intent", kind: "handover", change: "request", evidenceRefs: ["event-A"], commandDigest: "b".repeat(64) }).status).toBe("denied");
    expect(committed.actionIntents.handover?.generation).toBe("1");
  });
  it("actual original consent A and phone-only accepted B retain the same callback generation", () => {
    const requested = withConsent();
    const accepted = applied(reduceCustomerState(requested, { type: "accepted_inbound", eventKey: "phone-B", order: "11" }));
    const continued = applied(reduceCustomerState(accepted, { type: "intent_evidence", kind: "callback", generation: "1", eventKey: "phone-B" }));
    expect(continued.actionIntents.callback).toMatchObject({ generation: "1", status: "open", evidenceRefs: ["event-A", "phone-B"],
      consent: { originalEventKey: "event-A", originalOrder: "10" } });
    expect(continued.snapshot.fence.intentRevision).toBe(requested.snapshot.fence.intentRevision);
    expect(reduceCustomerState(continued, { type: "intent_evidence", kind: "callback", generation: "1", eventKey: "phone-B" }).status).toBe("same_event");
  });
  it.each(["ownershipEpoch", "bindingRevision", "scopeRevision", "policyRevision"] as const)("original callback consent cannot be revived after %s changes", key => {
    const state = applied(reduceCustomerState(withConsent(), { type: "accepted_inbound", eventKey: "phone-B", order: "11" }));
    state.snapshot.fence[key] = String(BigInt(state.snapshot.fence[key]) + 2n);
    expect(reduceCustomerState(state, { type: "intent_evidence", kind: "callback", generation: "1", eventKey: "phone-B" }).status).toBe("stale");
  });
  it("callback cancel/correction review invalidates old consent without opting out the whole chat", () => {
    let state = applied(reduceCustomerState(withConsent(), { type: "accepted_inbound", eventKey: "correction-B", order: "11" }));
    state = applied(reduceCustomerState(state, { type: "intent", kind: "callback", change: "review", evidenceRefs: ["correction-B"] }));
    expect(state.actionIntents.callback).toMatchObject({ generation: "2", status: "needs_review" });
    expect(state.actionIntents.callback?.consent).toBeUndefined();
    expect(state.snapshot.ownerMode).toBe("BOT");
    expect(reduceCustomerState(state, { type: "intent_committed", kind: "callback", generation: "2" }).status).toBe("stale");
    expect(reduceCustomerState(state, { type: "intent_evidence", kind: "callback", generation: "1", eventKey: "correction-B" }).status).toBe("stale");
  });
  it("a model-shaped proof for another native/event is not accepted by the reducer", () => {
    const state = withConsent(), consent = state.actionIntents.callback!.consent!;
    expect(reduceCustomerState(state, { type: "callback_consent", consent: { ...consent, originalEventKey: "foreign-A" } }).status).toBe("denied");
    expect(reduceCustomerState(state, { type: "callback_consent", consent: { ...consent, nativeId: randomUUID() } }).status).toBe("denied");
  });
  it("contact correction changes its own generation, not the callback slot", () => {
    let state = applied(reduceCustomerState(fixture(), { type: "intent", kind: "callback", change: "request", evidenceRefs: ["event-A"] }));
    state = applied(reduceCustomerState(state, { type: "intent", kind: "contact", change: "request", evidenceRefs: ["event-A"] }));
    state = applied(reduceCustomerState(state, { type: "accepted_inbound", eventKey: "contact-B", order: "11" }));
    state = applied(reduceCustomerState(state, { type: "intent", kind: "contact", change: "correct", evidenceRefs: ["contact-B"] }));
    expect(state.actionIntents.contact?.generation).toBe("2"); expect(state.actionIntents.callback?.generation).toBe("1");
  });
  it("requires current IN evidence; a model UUID cannot manufacture a new intent", () => {
    expect(reduceCustomerState(fixture(), { type: "intent", kind: "callback", change: "request", evidenceRefs: [randomUUID()] }).status).toBe("denied");
    const state = applied(reduceCustomerState(fixture(), { type: "intent", kind: "callback", change: "request", evidenceRefs: ["event-A"] }));
    expect(reduceCustomerState(state, { type: "intent", kind: "callback", change: "request", evidenceRefs: ["event-A"] }).status).toBe("same_event");
  });
  it("cancel advances the callback generation and rejects an old completion", () => {
    let state = applied(reduceCustomerState(fixture(), { type: "intent", kind: "callback", change: "request", evidenceRefs: ["event-A"] }));
    state = applied(reduceCustomerState(state, { type: "accepted_inbound", eventKey: "cancel-B", order: "11" }));
    state = applied(reduceCustomerState(state, { type: "intent", kind: "callback", change: "cancel", evidenceRefs: ["cancel-B"] }));
    expect(state.actionIntents.callback?.status).toBe("cancelled"); expect(state.actionIntents.callback?.generation).toBe("2");
    expect(reduceCustomerState(state, { type: "intent_committed", kind: "callback", generation: "1" }).status).toBe("stale");
  });
  it("BOT HUMAN BOT ABA retains a new ownership epoch and token", () => {
    const before = fixture(), agentId = randomUUID();
    const human = applied(reduceCustomerState(before, { type: "owner", mode: "HUMAN", agentId, token: randomUUID(), leaseUntil: null }));
    const bot = applied(reduceCustomerState(human, { type: "owner", mode: "BOT", agentId: null, token: randomUUID(), leaseUntil: null }));
    expect(bot.snapshot.ownerMode).toBe("BOT"); expect(bot.snapshot.fence.ownershipEpoch).toBe("9");
    expect(bot.snapshot.fence.ownerToken).not.toBe(before.snapshot.fence.ownerToken);
  });
  it("does not infer HUMAN owner from an assigned-client claim without an agent", () => {
    expect(reduceCustomerState(fixture(), { type: "owner", mode: "HUMAN", agentId: null, token: randomUUID(), leaseUntil: null }).status).toBe("denied");
  });
  it("closing retains a tombstone and refuses an automatic reopen", () => {
    const closed = applied(reduceCustomerState(fixture(), { type: "close", at: "2026-10-14T12:00:00.000Z" }));
    expect(closed.snapshot.ownerMode).toBe("HOLD"); expect(closed.snapshot.fence.bindingRevision).toBe("3");
    expect(reduceCustomerState(closed, { type: "accepted_inbound", eventKey: "new", order: "30" }).status).toBe("denied");
  });
});

describe("transport provenance cannot be supplied by customer JSON", () => {
  const event = { channel: "INSTAGRAM" as const, peer: "same-raw-peer", accountExternalId: "server-page", eventId: "stable-mid",
    eventKind: "message" as const, inputText: "Перезвоните мне" };
  it("unverified request/forged proof/admission JSON do not authorize current IN", () => {
    expect(captureAuthenticatedCustomerInput({}, event)).toBeNull();
    expect(inspectAuthenticatedCustomerInput({ ...event, provenance: "meta_signature", issuedAt: Date.now() })).toBeNull();
  });
  it("site key cannot impersonate Meta and Meta cannot impersonate a browser session", () => {
    const website = {}, meta = {}; registerAuthenticatedWebsiteCustomerRequest(website); registerAuthenticatedMetaCustomerRequest(meta);
    expect(captureAuthenticatedCustomerInput(website, event)).toBeNull();
    expect(captureAuthenticatedCustomerInput(meta, { ...event, channel: "WEBSITE" })).toBeNull();
  });
  async function protectedRequest(accountId: string, endpointScopeId: string, secret = "fixture-own-secret", signedWith = secret) {
    const rawBody = Buffer.from(JSON.stringify(event));
    const header = `sha256=${createHmac("sha256", signedWith).update(rawBody).digest("hex")}`;
    const request = { rawBody, get: () => header }; registerAuthenticatedMetaCustomerRequest(request);
    const store = { readTarget: vi.fn(async () => [{ id: accountId, explicitSecret: true, secret, endpointScopeId, scopeRevision: "4", policyRevision: "6" }]),
      readGlobalSecrets: vi.fn(async () => ({ global: "different-global", instagram: null })) };
    return { request, store, accountId, endpointScopeId, target: { channel: event.channel, accountId, accountExternalId: event.accountExternalId } };
  }
  it("requires stable event identity/exact recipient and bounds retained current input", async () => {
    const f = await protectedRequest(randomUUID(), randomUUID());
    expect(await verifyAndRegisterMetaCustomerIssuer(f.request, f.target, f.store)).toBe(true);
    const request = f.request;
    expect(captureAuthenticatedCustomerInput(request, { ...event, accountExternalId: undefined })).toBeNull();
    expect(captureAuthenticatedCustomerInput(request, { ...event, eventId: "" })).toBeNull();
    expect(captureAuthenticatedCustomerInput(request, { ...event, inputText: "x".repeat(8001) })).toBeNull();
    expect(inspectAuthenticatedCustomerInput(captureAuthenticatedCustomerInput(request, event))?.inputText).toBe(event.inputText);
  });
  it("issues a kind grant only for exact current admitted event plus canonical open intent", async () => {
    const state = fixture(); const endpoint = state.snapshot.fence.endpoint;
    const scopeKey = customerPropertyScopeKey(event.channel, event.peer, endpoint.accountId);
    const eventKey = createHash("sha256").update(JSON.stringify(["customer-property-event-v1", scopeKey, event.eventKind, event.eventId])).digest("hex");
    state.lastAcceptedEventKey = eventKey; state.actionIntents.callback = { generation: "8", status: "open", evidenceRefs: [eventKey] };
    const row = rows(state), signed = await protectedRequest(endpoint.accountId!, endpoint.endpointScopeId);
    expect(await verifyAndRegisterMetaCustomerIssuer(signed.request, signed.target, signed.store)).toBe(true);
    const request = signed.request;
    const input = captureAuthenticatedCustomerInput(request, event); if (!input) throw new Error("Expected synthetic authenticated IN");
    const ticket = { eventKey, order: "10", scopeKey, conversationId: row.nativeId!, accountId: endpoint.accountId, channel: event.channel, evidence: [] };
    const db = { $queryRaw: vi.fn(async (sql: { sql: string } | TemplateStringsArray) => (Array.isArray(sql) ? sql.join("?") : (sql as { sql: string }).sql).includes('FROM "CustomerEndpointScope"')
      ? [{ id: endpoint.endpointScopeId, messengerAccountId: endpoint.accountId, kind: "NORMAL", scopeRevision: BigInt(row.scopeRevision) }] : [structuredClone(row)]),
      $executeRaw: vi.fn(), messengerAccount: { findMany: vi.fn(async () => [{ id: endpoint.accountId, externalId: event.accountExternalId, messagingId: null, extraExternalIds: [] }]) },
      customerPropertyIngressTicket: { findUnique: vi.fn(async () => ({ conversationId: row.nativeId, order: 10n, scopeKey, managedOutputRecordedAt: null })) },
    } as unknown as TxClient;
    expect(await issueCustomerWriteAuthority({} as typeof input, ticket, "callback", db)).toBeNull();
    // A bound request alone is not an accepted state boundary / grant.
    expect(await issueCustomerWriteAuthority(input, ticket, "callback", db)).toBeNull();
    expect(await inFixtureTransaction(db, () => acceptAuthenticatedCustomerAdmission(input, ticket, db))).not.toBeNull();
    expect(await issueCustomerWriteAuthority(input, { ...ticket, eventKey: "other" }, "callback", db)).toBeNull();
    expect(await issueCustomerWriteAuthority(input, ticket, "contact", db)).toBeNull();
    const grant = await issueCustomerWriteAuthority(input, ticket, "callback", db);
    expect(inspectCustomerWriteAuthority(grant)).toMatchObject({ kind: "callback", generation: "8", currentInputText: event.inputText, provenance: "meta_signature", eventKey,
      protectedMetaAccountId: endpoint.accountId, purpose: "execute" });
    row.scopeRevision = "6";
    expect(await issueCustomerWriteAuthority(input, ticket, "callback", db)).toBeNull();
    row.scopeRevision = "4"; row.policyRevision = "8";
    expect(await issueCustomerWriteAuthority(input, ticket, "callback", db)).toBeNull();
    row.policyRevision = "6"; row.ownershipEpoch = "9";
    expect(await issueCustomerWriteAuthority(input, ticket, "callback", db)).toBeNull();
    row.ownershipEpoch = "7"; row.bindingRevision = "4";
    expect(await issueCustomerWriteAuthority(input, ticket, "callback", db)).toBeNull();
    row.bindingRevision = "2"; row.actionIntents.callback!.status = "committed";
    expect(await issueCustomerWriteAuthority(input, ticket, "callback", db)).toBeNull();
    expect(inspectCustomerWriteAuthority(await issueCustomerWriteAuthority(input, ticket, "callback", db, "receipt"))?.purpose).toBe("receipt");
    row.rolloutMode = "OFF"; expect(await issueCustomerWriteAuthority(input, ticket, "callback", db)).toBeNull();
  });
  it("an A app key cannot authorize B even though the envelope's legacy verifier accepted it", async () => {
    const f = await protectedRequest(randomUUID(), randomUUID(), "fixture-app-B", "fixture-app-A");
    expect(await verifyAndRegisterMetaCustomerIssuer(f.request, f.target, f.store)).toBe(false);
    expect(captureAuthenticatedCustomerInput(f.request, event)).toBeNull();
    expect(f.store.readGlobalSecrets).not.toHaveBeenCalled(); // explicit B is ONLY B
  });
  it("bad explicit account key never falls back; with two globals the signature must match exactly one, none stays closed", async () => {
    const f = await protectedRequest(randomUUID(), randomUUID());
    f.store.readTarget.mockResolvedValue([{ id: f.accountId, explicitSecret: true, secret: "", endpointScopeId: f.endpointScopeId, scopeRevision: "4", policyRevision: "6" }]);
    expect(await verifyAndRegisterMetaCustomerIssuer(f.request, f.target, f.store)).toBe(false);
    expect(f.store.readGlobalSecrets).not.toHaveBeenCalled();
    f.store.readTarget.mockResolvedValue([{ id: f.accountId, explicitSecret: false, secret: "", endpointScopeId: f.endpointScopeId, scopeRevision: "4", policyRevision: "6" }]);
    // F02 (23.10.2026): two configured keys no longer close the proof — the signature picks the issuing app.
    f.store.readGlobalSecrets.mockResolvedValue({ global: "fixture-own-secret", instagram: "different-app" });
    expect(await verifyAndRegisterMetaCustomerIssuer(f.request, f.target, f.store)).toBe(true);
    // Signed by NEITHER configured key: closed.
    f.store.readGlobalSecrets.mockResolvedValue({ global: "different-global", instagram: "different-app" });
    expect(await verifyAndRegisterMetaCustomerIssuer(f.request, f.target, f.store)).toBe(false);
    f.store.readGlobalSecrets.mockResolvedValue({ global: "fixture-own-secret", instagram: null });
    expect(await verifyAndRegisterMetaCustomerIssuer(f.request, f.target, f.store)).toBe(true);
  });
  it("a request signed by a global key while the account owns a DIFFERENT secret yields public-only assurance, never contact/callback/receipt authority", async () => {
    const state = fixture(), endpoint = state.snapshot.fence.endpoint;
    const f = await protectedRequest(endpoint.accountId!, endpoint.endpointScopeId);
    f.store.readTarget.mockResolvedValue([{ id: f.accountId, explicitSecret: true, secret: "fixture-explicit-other-secret",
      endpointScopeId: f.endpointScopeId, scopeRevision: "4", policyRevision: "6" }]);
    f.store.readGlobalSecrets.mockResolvedValue({ global: "fixture-own-secret", instagram: "fixture-second-usable-key" });
    expect(await verifyAndRegisterMetaCustomerIssuer(f.request, f.target, f.store)).toBe(false);
    expect(await verifyAndRegisterPublicMetaCustomerIssuer(f.request, f.target, f.store)).toBe(true);
    const input = captureAuthenticatedCustomerInput(f.request, event); if (!input) throw new Error("Expected public-only frame");
    expect(inspectAuthenticatedCustomerInput(input)).toMatchObject({ assurance: "public_envelope", issuerAccountId: endpoint.accountId,
      issuerEndpointScopeId: endpoint.endpointScopeId, protectedMetaAccountId: null, protectedMetaEndpointScopeId: null });
    const scopeKey = customerPropertyScopeKey(event.channel, event.peer, endpoint.accountId);
    const eventKey = createHash("sha256").update(JSON.stringify(["customer-property-event-v1", scopeKey, event.eventKind, event.eventId])).digest("hex");
    state.lastAcceptedEventKey = eventKey;
    state.actionIntents.callback = { generation: "7", status: "open", evidenceRefs: [eventKey] };
    const row = rows(state), execute = vi.fn();
    const db = { $queryRaw: vi.fn(async (query: { sql: string } | TemplateStringsArray) =>
      (Array.isArray(query) ? query.join("?") : (query as { sql: string }).sql).includes('FROM "CustomerEndpointScope"')
        ? [{ id: endpoint.endpointScopeId, messengerAccountId: endpoint.accountId, kind: "NORMAL", scopeRevision: 4n }] : [structuredClone(row)]),
      $executeRaw: execute, messengerAccount: { findMany: async () => [{ id: endpoint.accountId, externalId: event.accountExternalId, messagingId: null, extraExternalIds: [] }] },
      customerPropertyIngressTicket: { findUnique: async () => ({ conversationId: row.nativeId, order: 10n, scopeKey, managedOutputRecordedAt: null }) },
    } as unknown as TxClient;
    const ticket = { eventKey, order: "10", scopeKey, conversationId: row.nativeId!, accountId: endpoint.accountId, channel: event.channel, evidence: [] };
    const accepted = await inFixtureTransaction(db, () => acceptAuthenticatedCustomerAdmission(input, ticket, db));
    expect(accepted?.privateAuthorization).toBe("none");
    // Existing open callback state does not turn weaker public input into
    // deterministic consent or a new mutation, including an explicit call ask.
    expect(execute).not.toHaveBeenCalled();
    expect(await issueCustomerWriteAuthority(input, ticket, "callback", db)).toBeNull();
    expect(await issueCustomerWriteAuthority(input, ticket, "contact", db)).toBeNull();
    expect(await issueCustomerWriteAuthority(input, ticket, "callback", db, "receipt")).toBeNull();
    row.policyRevision = "8";
    expect(await inFixtureTransaction(db, () => acceptAuthenticatedCustomerAdmission(input, ticket, db))).toBeNull();
  });
});

describe("authenticated frames still require final customer-IN classification", () => {
  const client = { kind: "message" as const, bareTemplateEcho: false, ownAccountSender: false,
    knownOutgoingMid: false, inFlightBotEcho: false };
  it.each(["status", "read", "typing", "staff"] as const)("%s cannot become an accepted customer intent", kind => {
    expect(isFinalCustomerInputFrame({ ...client, kind })).toBe(false);
  });
  it.each(["isEcho", "bareTemplateEcho", "ownAccountSender", "fromStaff", "referralOnly", "knownOutgoingMid", "inFlightBotEcho"] as const)("%s suppresses canonical input/activation, including own echo before Graph response", key => {
    expect(isFinalCustomerInputFrame({ ...client, [key]: true })).toBe(false);
  });
  it("actual text and postback remain eligible without changing their durable event order", () => {
    expect(isFinalCustomerInputFrame(client)).toBe(true);
    expect(isFinalCustomerInputFrame({ ...client, kind: "postback" })).toBe(true);
  });
});

describe("actual customer-state SQL adapter without DB/network", () => {
  it("never exposes claimed contact on a public website projection", async () => {
    const row = rows(); row.channel = row.nativeChannel = "WEBSITE"; row.scopeAccountId = row.nativeAccountId = null;
    const { db } = fakeDb(row); const value = await loadCustomerStateSnapshot({ inquiryId: row.id }, db);
    expect(value?.privateAuthorization).toBe("none"); expect(JSON.stringify(value)).not.toContain("PRIVATE-OLD");
    expect(value).not.toHaveProperty("actionIntents"); expect(value).not.toHaveProperty("claimedContact");
  });
  it("same raw peer on another account never matches the captured fence", async () => {
    const state = fixture(), row = rows(state); row.scopeAccountId = row.nativeAccountId = randomUUID();
    const { db } = fakeDb(row); expect((await assertCustomerFence(db, state.snapshot.fence, "public_read")).status).toBe("stale");
  });
  it("native row moved to another brand/scope is denied even with same account/peer", async () => {
    const state = fixture(), row = rows(state); row.nativeEndpointScopeId = randomUUID();
    const { db } = fakeDb(row); expect((await assertCustomerFence(db, state.snapshot.fence, "public_read")).status).toBe("denied");
  });
  it.each(["stateRevision", "intentRevision", "ownershipEpoch", "bindingRevision", "scopeRevision", "policyRevision"] as const)("invalidates an awaited plan after %s ABA", async key => {
    const state = fixture(), row = rows(state); row[key] = (BigInt(row[key]) + 2n).toString();
    const { db } = fakeDb(row); expect((await assertCustomerFence(db, state.snapshot.fence, "public_read")).status).toBe("stale");
  });
  it.each(["OFF", "HOLD", "HUMAN"])("owner %s blocks a customer plan", async mode => {
    const state = fixture(), row = rows(state); row.ownerMode = mode;
    const { db } = fakeDb(row); expect((await assertCustomerFence(db, state.snapshot.fence, "outbound")).status).toBe("denied");
  });
  it("rollout OFF and legacy-unknown binding fail closed", async () => {
    const state = fixture(), row = rows(state); row.rolloutMode = "OFF";
    const { db } = fakeDb(row); expect((await assertCustomerFence(db, state.snapshot.fence, "public_read")).status).toBe("denied");
    row.rolloutMode = "ACTIVE"; row.scopeKind = "LEGACY_UNKNOWN";
    expect(await loadCustomerStateSnapshot({ inquiryId: row.id }, db)).toBeNull();
  });
  it("unsupported native state cannot fabricate a Bot conversation", async () => {
    const row = rows(); row.nativeId = null;
    const { db } = fakeDb(row); expect(await loadCustomerStateSnapshot({ inquiryId: row.id }, db)).toBeNull();
  });
  it("local write requires transaction and locks canonical scope/policy/state", async () => {
    const state = fixture(), { db, query } = fakeDb(rows(state));
    expect((await assertCustomerFence({ ...db, $transaction: vi.fn() } as CustomerStateDb, state.snapshot.fence, "local_write")).status).toBe("denied");
    expect((await assertCustomerFence(db, state.snapshot.fence, "local_write")).status).toBe("denied");
    expect(query).not.toHaveBeenCalled();
    expect((await inFixtureTransaction(db, () => assertCustomerFence(db, state.snapshot.fence, "local_write"))).status).toBe("current");
    const sql = query.mock.calls.map(([arg]) => String((arg as { sql: string }).sql));
    expect(sql[0]).toContain('SELECT i."conversationId"');
    expect(sql[1]).toContain('FOR UPDATE'); expect(sql[1]).toContain('"BotConversation"');
    expect(sql[2]).toContain('FROM "CustomerEndpointScope"'); expect(sql[2]).toContain("FOR SHARE");
    expect(sql[3]).toContain('FROM "CustomerRuntimePolicy"'); expect(sql[3]).toContain("FOR SHARE");
    expect(sql[4]).toContain("FOR UPDATE OF i"); expect(sql[4]).not.toContain("FOR SHARE OF");
  });
  it("does not adopt a new native binding while waiting for the old native lock", async () => {
    const state = fixture(), row = rows(state), oldNative = row.nativeId;
    const { db, query } = fakeDb(row);
    query.mockImplementationOnce(async () => [{ conversationId: oldNative, endpointScopeId: row.endpointScopeId }] as never)
      .mockImplementationOnce(async () => { row.nativeId = randomUUID(); return [{ id: oldNative }] as never; });
    expect((await inFixtureTransaction(db, () => assertCustomerFence(db, state.snapshot.fence, "local_write"))).status).toBe("denied");
  });
  it("a missing native cannot acquire a canonical write fence", async () => {
    const state = fixture(), { db, query } = fakeDb(rows(state));
    query.mockImplementationOnce(async () => [{ conversationId: state.snapshot.fence.nativeId, endpointScopeId: state.snapshot.fence.endpoint.endpointScopeId }] as never)
      .mockImplementationOnce(async () => []);
    expect((await inFixtureTransaction(db, () => assertCustomerFence(db, state.snapshot.fence, "local_write"))).status).toBe("denied");
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("transition returns actual post-trigger revisions rather than assumed plus-one", async () => {
    const state = fixture(), row = rows(state), { db, execute } = fakeDb(row);
    execute.mockImplementation(async () => { row.stateRevision = "19"; row.intentRevision = "8"; return 1; });
    const result = await inFixtureTransaction(db, () => transitionCustomerState(db, state.snapshot.fence, { type: "intent", kind: "callback", change: "request", evidenceRefs: ["event-A"] }));
    expect(result.status).toBe("applied"); if (result.status !== "applied") throw new Error("Expected transition");
    expect(result.snapshot.fence.stateRevision).toBe("19"); expect(result.snapshot.fence.intentRevision).toBe("8");
    expect(execute).toHaveBeenCalledOnce();
  });
  it("public JSON and P03 references cannot mint write authority", () => {
    expect(inspectCustomerWriteAuthority({ fence: fixture().snapshot.fence, kind: "callback", generation: "1", eventKey: "event-A", order: "10" })).toBeNull();
  });
});
