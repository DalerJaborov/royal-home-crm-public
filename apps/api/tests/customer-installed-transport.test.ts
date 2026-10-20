import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
const serverDb = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock("../src/db.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/db.js")>();
  return { ...original, prisma: { ...serverDb, $disconnect: () => original.prisma.$disconnect() } };
});
vi.mock("../src/crypto.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/crypto.js")>()), decryptSecretSafe: (value: string | null) => value?.startsWith("fixture:") ? value.slice(8) : "" }));
import { resolveCustomerEndpoint, type CustomerTransportReference } from "../src/lib/customerConversationScope.js";
import { readInstalledCustomerTransport } from "../src/lib/customerInstalledTransport.js";
import { customerPropertyEventKey, customerPropertyScopeKey } from "../src/lib/customerPropertyScope.js";
import { captureAuthenticatedCustomerInput, inspectAuthenticatedCustomerInput, registerAuthenticatedMetaCustomerRequest,
  verifyAndRegisterMetaCustomerIssuer, initializeVerifiedCustomerEndpoint } from "../src/lib/customerIngressAuthority.js";
import type { TxClient } from "../src/db.js";
import { bindCustomerMetaSendCredentials } from "../src/lib/customerMetaTransport.js";

function installedDb(channel = "WHATSAPP") {
  const endpointScopeId = randomUUID();
  const config = { externalId: "fixture-resource-A", token: "fixture:route-token", appSecret: "fixture:signing-A",
    endpointScopeId, scopeRevision: 4n, policyRevision: 6n };
  const db = { messengerAccount: { findMany: vi.fn(async () => [] as Array<{ id: string; externalId: string; messagingId: null; extraExternalIds: string[] }>) },
    $queryRaw: vi.fn(async (query: TemplateStringsArray) => query.join("?").includes('FROM "Settings"') ? [{ ...config }]
      : [{ id: endpointScopeId, messengerAccountId: null, kind: "NORMAL", scopeRevision: config.scopeRevision }]),
    $executeRaw: vi.fn(),
  };
  return { db: db as unknown as TxClient, query: db.$queryRaw, accounts: db.messengerAccount.findMany, config,
    endpointScopeId, input: { channel, subscriberId: "fixture-peer", accountExternalId: config.externalId } };
}
describe("installed Settings Meta routing is scoped without fake accounts", () => {
  it("only genuine same-target signed IN may initialize a routing namespace; initialization itself grants nothing", async () => {
    const f = installedDb(), rawBody = Buffer.from("fixture-new-installation");
    const request = { rawBody, get: () => `sha256=${createHmac("sha256", "signing-A").update(rawBody).digest("hex")}` };
    const target = { channel: "WHATSAPP" as const, peer: f.input.subscriberId, accountExternalId: "fixture-resource-A" };
    const frame = { kind: "message" as const, bareTemplateEcho: false, ownAccountSender: false, knownOutgoingMid: false, inFlightBotEcho: false };
    const readTarget = vi.fn(async () => []);
    const store = { readTarget, readGlobalSecrets: async () => ({ global: null, instagram: null }),
      readInstalledTarget: (channel: string, id: string) => readInstalledCustomerTransport(f.db, channel, id) };
    serverDb.$transaction.mockImplementation(async (callback: (tx: TxClient) => Promise<unknown>) => callback(f.db));
    expect(await initializeVerifiedCustomerEndpoint(request, target, frame, store)).toBeNull();
    registerAuthenticatedMetaCustomerRequest(request);
    expect(await initializeVerifiedCustomerEndpoint(request, target, { ...frame, isEcho: true }, store)).toBeNull();
    expect(await initializeVerifiedCustomerEndpoint(request, target, { ...frame, inFlightBotEcho: true }, store)).toBeNull();
    expect(await initializeVerifiedCustomerEndpoint(request, target, { ...frame, kind: "staff" }, store)).toBeNull();
    expect(readTarget).not.toHaveBeenCalled();
    expect(await initializeVerifiedCustomerEndpoint(request, { ...target, accountExternalId: "foreign-B" }, frame, store)).toBeNull();
    expect(serverDb.$transaction).not.toHaveBeenCalled();
    const transport = await initializeVerifiedCustomerEndpoint(request, target, frame, store);
    expect(transport).toMatchObject({ endpointScopeId: f.endpointScopeId, accountId: null, transportKey: "settings:WHATSAPP:fixture-resource-A" });
    expect(serverDb.$transaction).toHaveBeenCalledTimes(1);
    expect(captureAuthenticatedCustomerInput(request, { channel: "WHATSAPP", peer: target.peer, accountExternalId: target.accountExternalId,
      eventId: "fixture-mid", eventKind: "message", inputText: "Перезвоните" })).toBeNull();
    serverDb.$transaction.mockReset();
  });
  it.each(["WHATSAPP", "FACEBOOK"])("accepts the exact configured %s resource with nullable account", async channel => {
    const f = installedDb(channel); const endpoint = await resolveCustomerEndpoint(f.input, f.db);
    expect(endpoint).toMatchObject({ accountId: null, endpointScopeId: f.endpointScopeId,
      transportKey: `settings:${channel}:fixture-resource-A`, scopeRevision: "4" });
    expect(JSON.stringify(endpoint)).not.toContain("signing-A");
    expect(JSON.stringify(endpoint)).not.toContain("route-token");
  });
  it("does not infer installation from the peer, missing target or unknown target", async () => {
    const f = installedDb();
    await expect(resolveCustomerEndpoint({ ...f.input, accountExternalId: undefined }, f.db)).rejects.toMatchObject({ reason: "account_unknown" });
    await expect(resolveCustomerEndpoint({ ...f.input, accountExternalId: "foreign-B" }, f.db)).rejects.toMatchObject({ reason: "account_unknown" });
    f.config.token = "";
    vi.stubEnv("META_WA_TOKEN", "");
    try { await expect(resolveCustomerEndpoint(f.input, f.db)).rejects.toMatchObject({ reason: "account_unknown" }); }
    finally { vi.unstubAllEnvs(); }
  });
  it("an immutable A reference cannot adopt configuration B or credential epoch ABA", async () => {
    const f = installedDb(); const transport: CustomerTransportReference = await resolveCustomerEndpoint(f.input, f.db);
    f.config.externalId = "fixture-resource-B";
    await expect(resolveCustomerEndpoint({ ...f.input, transport }, f.db)).rejects.toMatchObject({ reason: "account_unknown" });
    f.config.externalId = "fixture-resource-A"; f.config.scopeRevision = 6n;
    await expect(resolveCustomerEndpoint({ ...f.input, transport }, f.db)).rejects.toMatchObject({ reason: "account_mismatch" });
  });
  it("duplicate Settings/account namespace is held rather than chosen by a default", async () => {
    const f = installedDb();
    f.accounts.mockResolvedValue([{ id: randomUUID(), externalId: f.input.accountExternalId, messagingId: null, extraExternalIds: [] }]);
    await expect(resolveCustomerEndpoint(f.input, f.db)).rejects.toMatchObject({ reason: "account_mismatch" });
  });
  it("NULL-account installation A/B ticket keys differ and legacy unbound NULL cannot mint a key", () => {
    const a = customerPropertyScopeKey("WHATSAPP", "same-peer", null, randomUUID());
    const b = customerPropertyScopeKey("WHATSAPP", "same-peer", null, randomUUID());
    expect(a).not.toBe(b);
    expect(customerPropertyEventKey(a, "message", "same-mid")).not.toBe(customerPropertyEventKey(b, "message", "same-mid"));
    expect(() => customerPropertyScopeKey("WHATSAPP", "same-peer", null)).toThrow(/namespace/);
    const account = randomUUID();
    expect(customerPropertyScopeKey("INSTAGRAM", "peer", account)).toBe(customerPropertyScopeKey("INSTAGRAM", "peer", account, randomUUID()));
    expect(customerPropertyScopeKey("WEBSITE", "sid", null)).toBe(customerPropertyScopeKey("WEBSITE", "sid", null, randomUUID()));
  });
  it("Settings signing resource/revisions share one SQL read and its key is runtime-only", async () => {
    const f = installedDb(); const row = await readInstalledCustomerTransport(f.db, "WHATSAPP", "fixture-resource-A");
    expect(row).toMatchObject({ signingSecret: "signing-A", scopeRevision: "4", policyRevision: "6" });
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it("the provider request keeps captured Settings A resource even if a caller loaded another phone ID", async () => {
    const f = installedDb(), transport = await resolveCustomerEndpoint(f.input, f.db);
    const bound = await bindCustomerMetaSendCredentials({ waPhoneId: "loaded-resource-B", waToken: "route-token" }, "WHATSAPP",
      f.input.subscriberId, "route-token", transport, f.db);
    expect(bound.credentials.waPhoneId).toBe("fixture-resource-A");
    expect(bound.token).toBe("route-token");
    await expect(bindCustomerMetaSendCredentials({ waPhoneId: "fixture-resource-A", waToken: "route-token" }, "WHATSAPP",
      f.input.subscriberId, "other-account-token", transport, f.db)).rejects.toMatchObject({ reason: "account_mismatch" });
  });
  it("a resource switch/credential revision while binding provider credentials is closed before POST", async () => {
    const f = installedDb(), transport = await resolveCustomerEndpoint(f.input, f.db);
    f.config.externalId = "fixture-resource-B";
    await expect(bindCustomerMetaSendCredentials({ waPhoneId: "fixture-resource-B", waToken: "route-token" }, "WHATSAPP",
      f.input.subscriberId, "route-token", transport, f.db)).rejects.toMatchObject({ reason: "account_unknown" });
    f.config.externalId = "fixture-resource-A"; f.config.scopeRevision = 6n;
    await expect(bindCustomerMetaSendCredentials({ waPhoneId: "fixture-resource-A", waToken: "route-token" }, "WHATSAPP",
      f.input.subscriberId, "route-token", transport, f.db)).rejects.toMatchObject({ reason: "account_mismatch" });
  });
  it.each(["WHATSAPP", "FACEBOOK"] as const)("genuine %s installed target binds scope, foreign app signature cannot", async channel => {
    const f = installedDb(channel), rawBody = Buffer.from("fixture-meta-frame");
    const request = { rawBody, get: () => `sha256=${createHmac("sha256", "signing-A").update(rawBody).digest("hex")}` };
    registerAuthenticatedMetaCustomerRequest(request);
    const store = { readTarget: async () => [], readGlobalSecrets: async () => ({ global: null, instagram: null }),
      readInstalledTarget: (ch: string, xid: string) => readInstalledCustomerTransport(f.db, ch, xid) };
    const target = { channel, accountId: null, accountExternalId: "fixture-resource-A" };
    expect(await verifyAndRegisterMetaCustomerIssuer(request, target, store)).toBe(true);
    const input = captureAuthenticatedCustomerInput(request, { channel, peer: "peer", accountExternalId: target.accountExternalId,
      eventId: "fixture-mid", eventKind: "message", inputText: "Перезвоните" });
    expect(inspectAuthenticatedCustomerInput(input)).toMatchObject({ protectedMetaAccountId: null,
      protectedMetaEndpointScopeId: f.endpointScopeId, issuerScopeRevision: "4", issuerPolicyRevision: "6" });
    const foreign = { rawBody, get: () => `sha256=${createHmac("sha256", "app-B").update(rawBody).digest("hex")}` };
    registerAuthenticatedMetaCustomerRequest(foreign);
    expect(await verifyAndRegisterMetaCustomerIssuer(foreign, target, store)).toBe(false);
    expect(captureAuthenticatedCustomerInput(foreign, { channel, peer: "peer", accountExternalId: target.accountExternalId,
      eventId: "fixture-mid", eventKind: "message", inputText: "Перезвоните" })).toBeNull();
    expect(await verifyAndRegisterMetaCustomerIssuer(request, { ...target, accountExternalId: "foreign-B" }, store)).toBe(false);
  });
});
