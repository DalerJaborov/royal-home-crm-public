import { createHmac, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { customerToolResultSchema } from "@royal-home/shared";
import { customerPropertyScopeKey, customerPropertyEventKey } from "../src/lib/customerPropertyScope.js";
import { loadPublicCustomerPrincipal, isCustomerPrincipal, type CustomerPrincipalSnapshot, type CustomerPrincipal } from "../src/lib/customerPrincipal.js";
import { customerToolDefinitions, dispatchCustomerTool } from "../src/ai/customerToolRegistry.js";
import type { TxClient } from "../src/db.js";
import { captureAuthenticatedCustomerInput, registerAuthenticatedMetaCustomerRequest, registerAuthenticatedWebsiteCustomerRequest, verifyAndRegisterMetaCustomerIssuer, verifyAndRegisterPublicMetaCustomerIssuer, inspectAuthenticatedCustomerInput } from "../src/lib/customerIngressAuthority.js";
import type { CustomerFence } from "@royal-home/shared";
import { prisma } from "../src/db.js";
import { acceptAuthenticatedCustomerAdmission, issueCustomerWriteAuthority } from "../src/lib/customerState.js";
import { encryptSecret } from "../src/crypto.js";

// Only an actual fixture callback simulates an open transaction. Root objects,
// detached callbacks and arbitrary shapes do not pass the P07 transaction guard.
const activeFixtureTransaction = new AsyncLocalStorage<unknown>();
vi.mock("../src/lib/transactionScope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/transactionScope.js")>()),
  isActiveTransactionClient: (value: unknown) => value !== undefined && activeFixtureTransaction.getStore() === value,
}));

const call = { name: "get_property_facts", args: { kinds: ["price", "address", "builder"] } };
async function fixture(channel: "INSTAGRAM" | "WEBSITE" | "WHATSAPP" | "FACEBOOK" = "INSTAGRAM", peer = "synthetic-peer", bindAccepted = true,
  options: { installed?: boolean; publicEnvelope?: boolean } = {}) {
  const accountId = channel === "WEBSITE" || options.installed ? null : randomUUID();
  const endpointScopeId = randomUUID();
  const scopeKey = customerPropertyScopeKey(channel, peer, accountId, endpointScopeId), eventId = "synthetic-event";
  const eventKind = channel === "WEBSITE" ? "website_message" as const : "message" as const;
  const reference = { eventKey: customerPropertyEventKey(scopeKey, eventKind, eventId),
    order: "10", conversationId: randomUUID(), scopeKey, accountId, channel, ...(options.installed ? { endpointScopeId } : {}) };
  const propertyId = randomUUID();
  const snapshot: CustomerPrincipalSnapshot = { reference, peer,
    account: accountId ? { id: accountId, channel, enabled: true, externalIds: ["synthetic-page"] } : null,
    transport: { endpointScopeId, accountId, channel, scopeRevision: "2", accountExternalId: channel === "WEBSITE" ? undefined : "synthetic-page",
      transportKey: options.installed ? `settings:${channel}:synthetic-page` : accountId ? `messenger-account:${accountId}` : "website-public-chat" },
    knownClientId: randomUUID(), knownProfileId: randomUUID(), clientDeleted: false, profileMerged: false,
    optedOut: false, pausedUntil: null, propertyChatAgentId: null, outputRecorded: false,
    focus: { version: 1, scopeKey: reference.scopeKey, generation: randomUUID(), lastEvidenceOrder: "9",
      eventKey: "b".repeat(64), status: "resolved", propertyId, evidence: [] }, focusRevision: 4,
    state: { version: 1, fence: { inquiryId: randomUUID(), endpoint: { endpointScopeId, channel, accountId, peerId: peer, threadId: "" },
      nativeId: reference.conversationId, stateRevision: "12", intentRevision: "3", ownershipEpoch: "5", bindingRevision: "7", scopeRevision: "2", policyRevision: "4", ownerToken: null },
      ownerMode: "BOT", ownerAgentId: null, ownerLeaseUntil: null, closedAt: null, publicState: { language: "ru", topic: "buyer", openQuestion: "price" },
      privateAuthorization: "none", legacyMemoryQuarantined: true, contractVersion: "compat", rolloutMode: "SHADOW",
      capabilities: { publicRead: true, contactWrite: false, callbackWrite: false, newLeadBridge: false } } };
  const event = { channel, peer, eventKind, eventId, inputText: "Цена?", ...(channel !== "WEBSITE" ? { accountExternalId: "synthetic-page" } : {}) };
  const rawBody = Buffer.from(JSON.stringify(event));
  const header = `sha256=${createHmac("sha256", "synthetic-own-app-secret").update(rawBody).digest("hex")}`;
  const request = { rawBody, get: () => header };
  if (channel === "WEBSITE") registerAuthenticatedWebsiteCustomerRequest(request);
  else {
    registerAuthenticatedMetaCustomerRequest(request);
    expect(await (options.publicEnvelope ? verifyAndRegisterPublicMetaCustomerIssuer : verifyAndRegisterMetaCustomerIssuer)(request, { channel, accountId, accountExternalId: "synthetic-page" }, {
      readTarget: async () => accountId ? [{ id: accountId, explicitSecret: !options.publicEnvelope, secret: options.publicEnvelope ? null : "synthetic-own-app-secret",
        endpointScopeId, scopeRevision: "2", policyRevision: "4" }] : [],
      readGlobalSecrets: async () => options.publicEnvelope ? { global: "synthetic-own-app-secret", instagram: "synthetic-other-app-secret" } : { global: null, instagram: null },
      readInstalledTarget: async () => options.installed ? { signingSecret: "synthetic-own-app-secret", endpointScopeId, scopeRevision: "2", policyRevision: "4" } : null,
    })).toBe(true);
  }
  const authenticatedInput = captureAuthenticatedCustomerInput(request, event);
  if (!authenticatedInput) throw new Error("Expected synthetic authenticated frame");
  if (bindAccepted) {
    const fence = snapshot.state.fence;
    const row = stateRow(snapshot, reference.eventKey, 10n);
    const db = { $queryRaw: vi.fn(async (sql: { sql: string } | TemplateStringsArray) => {
      const text = Array.isArray(sql) ? sql.join("?") : (sql as { sql: string }).sql;
      if (text.includes('FROM "Settings"')) return options.installed ? [{ externalId: "synthetic-page", token: encryptSecret("synthetic-token"), appSecret: encryptSecret("synthetic-own-app-secret"),
        endpointScopeId, scopeRevision: 2n, policyRevision: 4n }] : [];
      // This fixture has no recruitment catalog. Do not return an inquiry row
      // for a real catalog read caused by a possible single-word campaign.
      if (text.includes('FROM "RecruitmentPosition"')) return [];
      return text.includes('FROM "CustomerEndpointScope"') ? [{ id: endpointScopeId, messengerAccountId: accountId, kind: "NORMAL", scopeRevision: 2n }] : [structuredClone(row)];
    }),
      $executeRaw: vi.fn(async () => 1),
      messengerAccount: { findMany: vi.fn(async () => accountId ? [{ id: accountId, externalId: "synthetic-page", messagingId: null, extraExternalIds: [] }] : []) },
      customerPropertyIngressTicket: { findUnique: vi.fn(async () => ({ conversationId: reference.conversationId, order: 10n, scopeKey, endpointScopeId, managedOutputRecordedAt: null })) },
    } as unknown as TxClient;
    expect(await activeFixtureTransaction.run(db, () => acceptAuthenticatedCustomerAdmission(authenticatedInput, { ...reference, evidence: [] }, db))).not.toBeNull();
  }
  const read = vi.fn(async (_eventKey: string) => structuredClone(snapshot));
  const assertReadFence = vi.fn(async (fence: CustomerFence) => {
    if (JSON.stringify(fence) !== JSON.stringify(snapshot.state.fence)) return { status: "stale" as const, reason: "revision_changed" };
    if (snapshot.state.ownerMode !== "BOT" || snapshot.state.rolloutMode === "OFF" || !snapshot.state.capabilities.publicRead) return { status: "denied" as const, reason: "scope_owner_or_policy" };
    return { status: "current" as const, snapshot: structuredClone(snapshot.state) };
  });
  const store = { read, assertReadFence };
  const input = { admission: { ...reference, evidence: [] }, visibility: channel === "WEBSITE" ? "website_chat" : "private_dm", authenticatedInput };
  const property = { id: propertyId, shortId: 71, status: "AVAILABLE", deletedAt: null as Date | null,
    publishedOnSite: true, publishedChannels: [], offSite: false, price: "41000.25", currency: "TJS",
    siteListingId: null, updatedAt: new Date("2026-10-14T00:00:00Z"), district: { name: "Сино", city: "Душанбе" },
    ownerPhone: "PRIVATE-OWNER", address: "PRIVATE-HOUSE-APARTMENT", notes: "PRIVATE-NOTES" };
  const findUnique = vi.fn(async (_query: unknown) => structuredClone(property));
  const factsDb = { property: { findUnique } } as unknown as Pick<TxClient, "property">;
  return { snapshot, read, assertReadFence, store, input, property, findUnique, factsDb };
}
function stateRow(snapshot: CustomerPrincipalSnapshot, eventKey: string, order: bigint) {
  const state = snapshot.state, fence = state.fence, endpoint = fence.endpoint;
  return { id: fence.inquiryId, endpointScopeId: endpoint.endpointScopeId, peerId: snapshot.peer, threadId: "", conversationId: fence.nativeId,
    stateRevision: fence.stateRevision, intentRevision: fence.intentRevision, ownershipEpoch: fence.ownershipEpoch, bindingRevision: fence.bindingRevision,
    ownerMode: "BOT", ownerAgentId: null, ownerToken: null, ownerLeaseUntil: null, closedAt: null, publicState: state.publicState, actionIntents: {},
    lastAcceptedEventKey: eventKey, lastAcceptedOrder: order, legacyMemoryQuarantined: true,
    scopeRevision: fence.scopeRevision, channel: endpoint.channel, scopeKind: "NORMAL", scopeAccountId: endpoint.accountId,
    policyRevision: fence.policyRevision, contractVersion: "compat", rolloutMode: "SHADOW", capabilities: state.capabilities,
    nativeId: fence.nativeId, nativeEndpointScopeId: endpoint.endpointScopeId, nativeChannel: endpoint.channel, nativePeer: snapshot.peer, nativeAccountId: endpoint.accountId,
    pausedUntil: null, optedOutAt: null, propertyChatAgentId: null, accountEnabled: endpoint.accountId ? true : null, installedTransportCurrent: endpoint.channel !== "WEBSITE" && endpoint.accountId === null,
    clientDeletedAt: null, profileMergedIntoId: null, legacyBotEnabled: true };
}
async function principal(f: Awaited<ReturnType<typeof fixture>>): Promise<CustomerPrincipal> {
  const loaded = await loadPublicCustomerPrincipal(f.input, f.store);
  expect(loaded.status).toBe("public_only");
  if (loaded.status !== "public_only") throw new Error("Expected synthetic public principal");
  return loaded.principal;
}
const fetchDenied = vi.fn(() => { throw new Error("Unexpected external fetch in no-DB P05 test"); });
beforeEach(() => { fetchDenied.mockClear(); vi.stubGlobal("fetch", fetchDenied); });
afterEach(() => { expect(fetchDenied).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("P05 public-only server principal and closed customer registry", () => {
  it("uses the actual P03 DB read/projection; facts are observations, not action receipts", async () => {
    const f = await fixture(); const p = await principal(f);
    const result = await dispatchCustomerTool(p, call, { enabled: true, factsDb: f.factsDb });
    expect(result.status).toBe("observed"); expect(customerToolResultSchema.safeParse(result).success).toBe(true);
    if (result.status !== "observed") throw new Error("Expected useful public facts");
    expect(result.facts).toMatchObject({ price: "41000.25", currency: "TJS", publicAddress: "Сино, Душанбе", addressPolicy: "district_city_only", builder: null });
    expect(f.findUnique).toHaveBeenCalledTimes(2);
    expect(f.findUnique.mock.calls[0][0]).toMatchObject({ where: { id: f.property.id } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE-");
    expect(result).not.toHaveProperty("receipt"); expect(result).not.toHaveProperty("committed");
    expect(JSON.stringify(result)).not.toContain(p.knownContact.clientId);
    expect(p.privateAuthorization).toBe("none"); expect(p.authority.purpose).toBe("public_read");
    expect(p.authority.fence.stateRevision).toBe("12");
  });

  it.each([
    { name: "search_clients", args: {} }, { name: "get_finance_summary", args: {} }, { name: "request_callback", args: {} },
    { name: "get_property_facts", args: { kinds: ["price"], clientId: "foreign" } },
    { name: "get_property_facts", args: { kinds: ["price"], propertyId: "foreign" } },
    { name: "get_property_facts", args: { kinds: ["price"], actor: "ADMIN", consent: true } },
    { name: "get_property_facts", args: { kinds: ["SELECT * FROM Client"] } },
    { name: "get_property_facts", args: { kinds: ["price"], proof: { verified: true } } },
    { ...call, principal: { peer: "foreign", role: "ADMIN" } },
  ])("rejects injected tool/fields %# before the DB reader", async (injected) => {
    const f = await fixture(); const p = await principal(f); f.read.mockClear();
    expect(await dispatchCustomerTool(p, injected, { enabled: true, factsDb: f.factsDb })).toEqual({ status: "denied", reason: "invalid_call" });
    expect(f.read).not.toHaveBeenCalled(); expect(f.findUnique).not.toHaveBeenCalled();
  });

  it("does not accept a JSON-cloned principal or advertise a disabled capability", async () => {
    const f = await fixture(); const p = await principal(f); f.read.mockClear();
    const copy = JSON.parse(JSON.stringify(p)); expect(isCustomerPrincipal(copy)).toBe(false);
    expect(await dispatchCustomerTool(copy, call, { enabled: true, factsDb: f.factsDb })).toEqual({ status: "denied", reason: "invalid_principal" });
    expect(customerToolDefinitions(p, false)).toEqual([]); expect(customerToolDefinitions(copy, true)).toEqual([]);
    expect(customerToolDefinitions(p, true).map((tool) => tool.name)).toEqual(["get_property_facts"]);
    expect(await dispatchCustomerTool(p, call, { enabled: false, factsDb: f.factsDb })).toEqual({ status: "denied", reason: "disabled" });
    expect(f.findUnique).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
    expect(() => Object.assign(p.scope, { peer: "foreign" })).toThrow();
  });
  it.each([{}, { verified: true, provenance: "meta_signature" }])("serialized authenticated claims %# cannot mint a principal", async (authenticatedInput) => {
    const f = await fixture();
    expect(await loadPublicCustomerPrincipal({ ...f.input, authenticatedInput }, f.store)).toEqual({ status: "denied", reason: "invalid_context" });
    expect(f.read).not.toHaveBeenCalled(); expect(f.assertReadFence).not.toHaveBeenCalled();
  });
  it("an authenticated frame for another event or no longer configured target cannot reuse a ticket", async () => {
    const f = await fixture(); f.input.admission.eventKey = "c".repeat(64);
    expect(await loadPublicCustomerPrincipal(f.input, f.store)).toEqual({ status: "denied", reason: "scope_mismatch" });
    expect(f.assertReadFence).not.toHaveBeenCalled();
    const next = await fixture(); next.snapshot.account!.externalIds = ["new-page"];
    expect(await loadPublicCustomerPrincipal(next.input, next.store)).toEqual({ status: "denied", reason: "scope_mismatch" });
  });
  it("default reader rejects an early durable ticket before canonical FINAL-IN acceptance", async () => {
    const f = await fixture("INSTAGRAM", "synthetic-peer", false);
    const ticketRead = vi.spyOn(prisma.customerPropertyIngressTicket, "findUnique").mockResolvedValueOnce({
      ...f.snapshot.reference, order: 10n, managedOutputRecordedAt: null,
      conversation: { channel: f.snapshot.reference.channel, subscriberId: f.snapshot.peer, accountId: f.snapshot.reference.accountId,
        clientId: f.snapshot.knownClientId, contactProfileId: f.snapshot.knownProfileId, optedOutAt: null, pausedUntil: null,
        propertyChatAgentId: null, customerPropertyFocus: f.snapshot.focus, customerPropertyFocusRevision: 4,
        account: { id: f.snapshot.account!.id, channel: "INSTAGRAM", enabled: true, externalId: "synthetic-page", messagingId: null, extraExternalIds: [] },
        client: { deletedAt: null }, contactProfile: { mergedIntoId: null } },
    } as never);
    const stateRead = vi.spyOn(prisma, "$queryRaw").mockResolvedValueOnce([stateRow(f.snapshot, "not-this-early-ticket", 9n)]);
    expect(await loadPublicCustomerPrincipal(f.input)).toEqual({ status: "denied", reason: "scope_mismatch" });
    expect(ticketRead).toHaveBeenCalledTimes(1); expect(stateRead).toHaveBeenCalledTimes(1);
  });
  it("an issuer-verified frame without an accepted boundary cannot borrow a current state", async () => {
    const f = await fixture("INSTAGRAM", "synthetic-peer", false);
    expect(await loadPublicCustomerPrincipal(f.input, f.store)).toEqual({ status: "denied", reason: "scope_mismatch" });
    expect(f.assertReadFence).not.toHaveBeenCalled();
  });

  it.each(["TELEGRAM", "PHONE", "YOUTUBE"])("does not invent admission for unsupported %s", async (channel) => {
    const f = await fixture();
    expect(await loadPublicCustomerPrincipal({ ...f.input, admission: { ...f.input.admission, channel } }, f.store)).toEqual({ status: "denied", reason: "invalid_context" });
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["public_group", "public_comment"])("rejects %s rather than constructing a private conversation principal", async (visibility) => {
    const f = await fixture();
    expect(await loadPublicCustomerPrincipal({ ...f.input, visibility }, f.store)).toEqual({ status: "denied", reason: "invalid_context" });
    expect(f.read).not.toHaveBeenCalled();
  });
  it("website app/recognized contact and even the exact company telephone do not grant private authority", async () => {
    for (const f of [await fixture("WEBSITE"), await fixture("WHATSAPP", "992446501414")]) {
      const p = await principal(f);
      expect(p.knownContact.clientId).toBeTruthy(); expect(p.privateAuthorization).toBe("none"); expect(p.authority.purpose).toBe("public_read");
      expect(p.provenance).toBe(f.snapshot.reference.channel === "WEBSITE" ? "website_application_key" : "meta_signature");
      expect(p).not.toHaveProperty("endpointVerified");
      expect(await loadPublicCustomerPrincipal({ ...f.input, phone: "+992 44 650 14 14", verified: true }, f.store)).toEqual({ status: "denied", reason: "invalid_context" });
    }
  });
  it.each(["WHATSAPP", "FACEBOOK"] as const)("Settings-backed %s NULL account needs exact namespace, not a default account", async channel => {
    const f = await fixture(channel, "synthetic-settings-peer", true, { installed: true });
    const p = await principal(f);
    expect(p.scope.accountId).toBeNull(); expect(p.scope.endpointScopeId).toBe(f.snapshot.transport!.endpointScopeId);
    expect(p.assurance).toBe("protected_namespace"); expect(p.privateAuthorization).toBe("none");
    const result = await dispatchCustomerTool(p, call, { enabled: true, factsDb: f.factsDb });
    expect(result.status).toBe("observed"); expect(JSON.stringify(result)).not.toContain("PRIVATE-");
    const withoutScope = { ...f.input.admission }; delete withoutScope.endpointScopeId;
    expect(await loadPublicCustomerPrincipal({ ...f.input, admission: withoutScope }, f.store)).toEqual({ status: "denied", reason: "scope_mismatch" });
  });
  it("actual weaker public-envelope brand may read public facts, never mint P06 write authority", async () => {
    const f = await fixture("INSTAGRAM", "synthetic-public-peer", true, { publicEnvelope: true });
    const evidence = inspectAuthenticatedCustomerInput(f.input.authenticatedInput);
    expect(evidence?.protectedMetaAccountId).toBeNull(); expect(evidence?.protectedMetaEndpointScopeId).toBeNull();
    expect(evidence?.assurance).toBe("public_envelope");
    const p = await principal(f);
    expect(p.assurance).toBe("public_envelope"); expect(p.privateAuthorization).toBe("none");
    expect((await dispatchCustomerTool(p, call, { enabled: true, factsDb: f.factsDb })).status).toBe("observed");
    const forbiddenDb = { $queryRaw: vi.fn(() => { throw new Error("Public envelope must reject before DB write planning"); }) } as unknown as TxClient;
    expect(await issueCustomerWriteAuthority(f.input.authenticatedInput, f.input.admission, "contact", forbiddenDb)).toBeNull();
    expect(forbiddenDb.$queryRaw).not.toHaveBeenCalled();
    expect(await loadPublicCustomerPrincipal({ ...f.input, authenticatedInput: { ...evidence } }, f.store)).toEqual({ status: "denied", reason: "invalid_context" });
  });
  it.each(["target", "scope", "revision"] as const)("Settings-backed transport %s change cannot adopt a new namespace with the old accepted frame", async kind => {
    const f = await fixture("WHATSAPP", "synthetic-settings-peer", true, { installed: true });
    const p = await principal(f);
    if (kind === "target") f.snapshot.transport!.accountExternalId = "different-configured-resource";
    if (kind === "scope") f.snapshot.transport!.endpointScopeId = randomUUID();
    if (kind === "revision") f.snapshot.transport!.scopeRevision = "3";
    expect(await dispatchCustomerTool(p, call, { enabled: true, factsDb: f.factsDb })).toEqual({ status: "denied", reason: "scope_changed" });
    expect(f.findUnique).not.toHaveBeenCalled();
  });

  it.each(["account", "peer", "order", "conversation"])("exact DB scope rejects changed %s instead of default/healing lookup", async (kind) => {
    const f = await fixture();
    if (kind === "account") f.snapshot.account!.id = randomUUID();
    if (kind === "peer") f.snapshot.peer = "foreign-peer";
    if (kind === "order") f.snapshot.reference.order = "11";
    if (kind === "conversation") f.snapshot.reference.conversationId = randomUUID();
    expect((await loadPublicCustomerPrincipal(f.input, f.store)).status).toBe("denied");
  });
  it.each(["clientDeleted", "profileMerged", "optedOut", "outputRecorded"] as const)("blocked %s never becomes a public principal", async (field) => {
    const f = await fixture(); f.snapshot[field] = true;
    expect(await loadPublicCustomerPrincipal(f.input, f.store)).toEqual({ status: "denied", reason: "scope_blocked" });
  });
  it("disabled adapter and active pause refuse even recognized contacts", async () => {
    const f = await fixture(); f.snapshot.account!.enabled = false;
    expect((await loadPublicCustomerPrincipal(f.input, f.store)).status).toBe("denied");
    f.snapshot.account!.enabled = true; f.snapshot.pausedUntil = new Date(Date.now() + 60_000);
    expect(await loadPublicCustomerPrincipal(f.input, f.store)).toEqual({ status: "denied", reason: "scope_blocked" });
  });
  it("a pause introduced during the last fact await refuses OUT observations", async () => {
    const f = await fixture(); const p = await principal(f);
    f.findUnique.mockImplementationOnce(async () => structuredClone(f.property));
    f.findUnique.mockImplementationOnce(async () => { f.snapshot.pausedUntil = new Date(Date.now() + 60_000); return structuredClone(f.property); });
    expect(await dispatchCustomerTool(p, call, { enabled: true, factsDb: f.factsDb })).toEqual({ status: "denied", reason: "scope_changed" });
  });
  it("scope and recognition change during the actual fact await refuse the result", async () => {
    const f = await fixture(); const p = await principal(f);
    f.findUnique.mockImplementationOnce(async () => { f.snapshot.knownClientId = randomUUID(); return structuredClone(f.property); });
    expect(await dispatchCustomerTool(p, call, { enabled: true, factsDb: f.factsDb })).toEqual({ status: "denied", reason: "scope_changed" });
  });
  it.each(["stateRevision", "intentRevision", "ownershipEpoch", "bindingRevision", "scopeRevision", "policyRevision"] as const)("real %s change without a new ad still invalidates an old public plan", async (field) => {
    const f = await fixture(); const p = await principal(f);
    f.findUnique.mockImplementationOnce(async () => { f.snapshot.state.fence[field] = (BigInt(f.snapshot.state.fence[field]) + 1n).toString(); return structuredClone(f.property); });
    expect(await dispatchCustomerTool(p, call, { enabled: true, factsDb: f.factsDb })).toEqual({ status: "denied", reason: "scope_changed" });
  });
  it("new canonical ordinary IN makes the original ticket unavailable even when the property focus is unchanged", async () => {
    const f = await fixture(); const p = await principal(f);
    f.read.mockResolvedValueOnce(null as never);
    expect(await dispatchCustomerTool(p, call, { enabled: true, factsDb: f.factsDb })).toEqual({ status: "denied", reason: "scope_changed" });
    expect(f.findUnique).not.toHaveBeenCalled();
  });
  it("newer focus, or same property in a new revision, cannot reuse an older plan", async () => {
    const f = await fixture(); const p = await principal(f);
    f.findUnique.mockImplementationOnce(async () => { f.snapshot.focusRevision++; return structuredClone(f.property); });
    expect(await dispatchCustomerTool(p, call, { enabled: true, factsDb: f.factsDb })).toEqual({ status: "denied", reason: "scope_changed" });
    (f.snapshot.focus as { lastEvidenceOrder: string }).lastEvidenceOrder = "11"; f.findUnique.mockClear();
    expect(await dispatchCustomerTool(p, call, { enabled: true, factsDb: f.factsDb })).toEqual({ status: "denied", reason: "scope_changed" });
    expect(f.findUnique).not.toHaveBeenCalled();
  });
  it("unpublished/deleted cards and publication changed after await do not produce observations", async () => {
    const f = await fixture(); const p = await principal(f);
    f.property.publishedOnSite = false;
    expect((await dispatchCustomerTool(p, call, { enabled: true, factsDb: f.factsDb })).status).toBe("missing");
    f.property.publishedOnSite = true;
    f.property.deletedAt = new Date();
    expect((await dispatchCustomerTool(p, call, { enabled: true, factsDb: f.factsDb })).status).toBe("missing");
    f.property.deletedAt = null; f.property.offSite = true;
    expect((await dispatchCustomerTool(p, call, { enabled: true, factsDb: f.factsDb })).status).toBe("missing");
    f.property.offSite = false;
    f.findUnique.mockImplementationOnce(async () => { const initial = structuredClone(f.property); f.property.publishedOnSite = false; return initial; });
    expect(await dispatchCustomerTool(p, call, { enabled: true, factsDb: f.factsDb })).toEqual({ status: "denied", reason: "stale_facts" });
  });
  it("storage errors are explicit unavailable and never proof or write success", async () => {
    const f = await fixture(); f.read.mockRejectedValueOnce(new Error("synthetic DB failure"));
    expect(await loadPublicCustomerPrincipal(f.input, f.store)).toEqual({ status: "unavailable", reason: "storage_unavailable" });
    const p = await principal(f); f.findUnique.mockRejectedValueOnce(new Error("synthetic property read failure"));
    expect(await dispatchCustomerTool(p, call, { enabled: true, factsDb: f.factsDb })).toEqual({ status: "unavailable", reason: "storage_unavailable" });
  });
});
