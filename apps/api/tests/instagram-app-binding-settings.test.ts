import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { response, type Response } from "express";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { encryptSecret, decryptSecret } from "../src/crypto.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { grantElevation, revokeElevation } from "../src/lib/stepUp.js";
import { ensureCustomerEndpoint } from "../src/lib/customerConversationScope.js";
import { readInstagramAppBindingStatus, bindInstagramAppForAccount } from "../src/lib/instagramAppBinding.js";
import { persistVerifiedCustomerIngressBatch } from "../src/lib/customerIngressProducer.js";
import { admitCustomerPropertyInput } from "../src/lib/customerPropertyAdmission.js";
import { recordScopedCustomerInput } from "../src/lib/customerQualifierLedger.js";
import { createCustomerRolloutFixture } from "./helpers/customerRolloutFixture.js";
import { decryptCustomerFinalOrigin, encryptCustomerFinalOrigin } from "../src/lib/customerOriginPayload.js";
import type { InstagramAppBindingInput } from "@royal-home/shared";
import { registerAuthenticatedMetaCustomerRequest, verifyAndRegisterMetaCustomerIssuer, verifyAndRegisterPublicMetaCustomerIssuer,
  captureAuthenticatedCustomerInput, inspectAuthenticatedCustomerInput } from "../src/lib/customerIngressAuthority.js";
import { waitFor } from "./helpers/waitFor.js";

const externalId = BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString();
const appId = "300", secret = "stand-application-secret";
let actorId = "", accountId = "", accessToken = "";
let settings: { metaAppSecret: string | null; metaIgAppSecret: string | null };
let scopeId = "";
let body: InstagramAppBindingInput;
let rollout: Awaited<ReturnType<typeof createCustomerRolloutFixture>>;
const ticketKeys: string[] = [], nativeIds: string[] = [];
let flags: { botEnabled: boolean; metaEnabled: boolean; botInstagramEnabled: boolean };
async function observe(assurance: "public" | "protected" = "public") {
  const peer = `stand-binding-peer-${randomUUID()}`, eventId = randomUUID();
  await rollout.allowDm({ peer, accountId, accountExternalId: externalId });
  const rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: externalId, messaging: [{
    sender: { id: peer }, recipient: { id: externalId }, timestamp: Date.now(), message: { mid: eventId, text: "stand input" },
  }] }] }));
  const req = { rawBody, get: () => `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` };
  registerAuthenticatedMetaCustomerRequest(req);
  const pending = await persistVerifiedCustomerIngressBatch(req);
  expect(pending.status).toBe("persisted");
  if (pending.status !== "persisted") throw Error("Stand pending required");
  ticketKeys.push(...pending.tickets.map(t => t.eventKey));
  const verify = assurance === "public" ? verifyAndRegisterPublicMetaCustomerIssuer : verifyAndRegisterMetaCustomerIssuer;
  expect(await verify(req, { channel: "INSTAGRAM", accountId, accountExternalId: externalId })).toBe(true);
  const input = captureAuthenticatedCustomerInput(req, { channel: "INSTAGRAM", peer, accountExternalId: externalId,
    eventId, eventKind: "message", inputText: "stand input" });
  const admitted = await admitCustomerPropertyInput({ channel: "INSTAGRAM", peer, accountId, accountExternalId: externalId,
    eventId, eventKind: "message", evidence: [], authenticatedInput: input });
  expect(admitted.status).toBe("admitted");
  if (admitted.status !== "admitted") throw Error("Stand final required");
  nativeIds.push(admitted.ticket.conversationId);
  expect(await recordScopedCustomerInput({ channel: "INSTAGRAM", subscriberId: peer }, input, admitted.ticket)).toBe(true);
  await prisma.customerPropertyIngressTicket.update({ where: { eventKey: admitted.ticket.eventKey }, data: { processingState: "HELD", errorCode: "stand_observation_only" } });
  return admitted.ticket;
}
const url = () => `/api/v1/settings/messenger-accounts/${accountId}/instagram-app-binding`;
const submit = (value: unknown = body) => request(app).post(url())
  .set("Authorization", `Bearer ${accessToken}`).send(value);
function successfulMeta(afterProof?: () => Promise<void>) {
  const fake = vi.fn(async (target: string) => {
    if (target.includes("subscribed_apps")) await afterProof?.();
    return new Response(JSON.stringify(target.includes("subscribed_apps")
      ? { data: [{ id: appId, subscribed_fields: ["messages", "messaging_postbacks", "messaging_referral", "comments"] }] }
      : target.includes("graph.facebook.com") ? { id: appId } : { id: externalId, user_id: externalId }));
  });
  vi.stubGlobal("fetch", fake); return fake;
}
async function expectNotSaved() {
  expect((await prisma.messengerAccount.findUniqueOrThrow({ where: { id: accountId } })).appSecret).toBeNull();
  expect(await prisma.auditLog.count({ where: { action: "INSTAGRAM_SIGNER_OWNER_CONFIGURED", entityId: accountId } })).toBe(0);
}
beforeAll(async () => {
  flags = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true } });
  rollout = await createCustomerRolloutFixture();
  settings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { metaAppSecret: true, metaIgAppSecret: true } });
  const actor = await prisma.agent.create({ data: { role: "ADMIN", fullName: "Stand binding administrator", phone: `stand-binding-${randomUUID()}`, passwordHash: "stand-no-login" } });
  actorId = actor.id; accessToken = signAccessToken({ sub: actor.id, role: "ADMIN" }); grantElevation(actor.id);
  const account = await prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId,
    title: "Stand binding account", token: encryptSecret("stand-instagram-token"), enabled: true } });
  accountId = account.id;
  scopeId = (await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel: "INSTAGRAM", accountId,
    accountExternalId: externalId, subscriberId: "stand-binding-peer" }))).endpointScopeId;
});
beforeEach(async () => {
  grantElevation(actorId);
  await prisma.agent.update({ where: { id: actorId }, data: { role: "ADMIN", isActive: true, permissions: { granted: [], revoked: [] } } });
  await prisma.messengerAccount.update({ where: { id: accountId }, data: { appSecret: null, token: encryptSecret("stand-instagram-token"),
    extraExternalIds: [], enabled: true, channel: "INSTAGRAM" } });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("stand test forbids network"); }));
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true,
    metaIgAppSecret: encryptSecret(secret), metaAppSecret: encryptSecret("stand-other-app-key") } });
  await observe();
  const status = await readInstagramAppBindingStatus(accountId);
  expect(status.candidates).toHaveLength(1);
  body = { mode: "owner_selected_observed_signer", appId, secretSource: "settings_instagram", confirmFutureInputs: true,
    observationId: status.candidates[0].observationId, observationVersion: status.candidates[0].observationVersion,
    configurationVersion: status.configurationVersion };
});
afterEach(async () => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: ticketKeys.map(key => `customer-inbox-consume:${key}`) } } });
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: ticketKeys } } });
  await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: nativeIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: nativeIds } } });
  ticketKeys.length = 0; nativeIds.length = 0;
  await prisma.auditLog.deleteMany({ where: { entityId: accountId } });
  await prisma.settings.update({ where: { id: "singleton" }, data: settings });
});
afterAll(async () => {
  vi.unstubAllGlobals(); revokeElevation(actorId);
  await prisma.auditLog.deleteMany({ where: { entityId: accountId } });
  await prisma.messengerAccount.deleteMany({ where: { id: accountId } });
  await prisma.customerEndpointScope.deleteMany({ where: { id: scopeId } });
  await prisma.agent.deleteMany({ where: { id: actorId } });
  await prisma.settings.update({ where: { id: "singleton" }, data: flags });
  await rollout.restore();
});
describe("authenticated Instagram application binding", () => {
  it.each(["observationId", "observationVersion", "configurationVersion"] as const)("rejects changed %s before any provider request", async key => {
    const fake = successfulMeta(); const result = await submit({ ...body, [key]: "f".repeat(64) });
    expect(result.status).toBe(409); expect(fake).not.toHaveBeenCalled(); await expectNotSaved();
  });
  it.each([false, undefined])("requires an explicit future-input configuration confirmation (%s)", async confirmFutureInputs => {
    const fake = successfulMeta(); const result = await submit({ ...body, confirmFutureInputs });
    expect(result.status).toBe(400); expect(fake).not.toHaveBeenCalled(); await expectNotSaved();
  });
  it("does not select the other stored signing key without its own observed evidence", async () => {
    const fake = successfulMeta(); const result = await submit({ ...body, secretSource: "settings_meta" });
    expect(result.status).toBe(409); expect(result.body.code).toBe("observation_unavailable");
    expect(fake).not.toHaveBeenCalled(); await expectNotSaved();
  });
  it("rejects a settings-key version change even when its plaintext is unchanged", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaIgAppSecret: encryptSecret(secret) } });
    const fake = successfulMeta(); const result = await submit();
    expect(result.status).toBe(409); expect(fake).not.toHaveBeenCalled();
    expect((await readInstagramAppBindingStatus(accountId)).candidates).toHaveLength(0); await expectNotSaved();
  });
  it("rejects a delegated settings permission without an administrator/director role", async () => {
    await prisma.agent.update({ where: { id: actorId }, data: { role: "AGENT", permissions: { granted: ["settings.manage"], revoked: [] } } });
    const fake = successfulMeta(); const result = await submit();
    expect(result.status).toBe(403); expect(fake).not.toHaveBeenCalled(); await expectNotSaved();
  });
  it("rejects an expired diagnostic observation without renewing it", async () => {
    const fake = successfulMeta();
    await expect(bindInstagramAppForAccount(actorId, accountId, body, { now: () => Date.now() + 24 * 60 * 60_000 + 1_000 }))
      .rejects.toMatchObject({ code: "observation_unavailable" });
    expect(fake).not.toHaveBeenCalled(); await expectNotSaved();
  });
  it.each(["wrong_account", "wrong_receiver", "forged_ciphertext", "transplanted_row"] as const)("rejects %s diagnostic material", async kind => {
    const original = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: body.observationId } });
    const origin = decryptCustomerFinalOrigin(original.originCiphertext!);
    if (kind === "wrong_account") origin.input.issuerAccountId = randomUUID();
    if (kind === "wrong_receiver") origin.input.accountExternalId = "999";
    await prisma.customerPropertyIngressTicket.delete({ where: { eventKey: original.eventKey } });
    const { order: _order, ...copy } = original;
    const eventKey = kind === "transplanted_row" ? createHmac("sha256", "stand-row-key").update(randomUUID()).digest("hex") : copy.eventKey;
    await prisma.customerPropertyIngressTicket.create({ data: { ...copy, eventKey, order: kind === "transplanted_row" ? undefined : original.order,
      originCiphertext: kind === "forged_ciphertext" ? "stand-not-a-sealed-origin" : encryptCustomerFinalOrigin(origin) } });
    ticketKeys.push(eventKey);
    const status = await readInstagramAppBindingStatus(accountId); expect(status.candidates).toHaveLength(0);
    const fake = successfulMeta(); const result = await submit();
    expect(result.status).toBe(409); expect(fake).not.toHaveBeenCalled(); await expectNotSaved();
  });
  it("rolls back if the exact source row disappears during the provider checks", async () => {
    const before = await prisma.customerEndpointScope.findUniqueOrThrow({ where: { id: scopeId } });
    successfulMeta(async () => { await prisma.customerPropertyIngressTicket.delete({ where: { eventKey: body.observationId } }); });
    const result = await submit(); expect(result.status).toBe(409); expect(result.body.code).toBe("observation_unavailable");
    await expectNotSaved();
    expect((await prisma.customerEndpointScope.findUniqueOrThrow({ where: { id: scopeId } })).scopeRevision).toBe(before.scopeRevision);
  });
  it("rejects a scope revision change during provider checks", async () => {
    successfulMeta(async () => { await prisma.customerEndpointScope.update({ where: { id: scopeId }, data: { scopeRevision: { increment: 1 } } }); });
    const result = await submit(); expect(result.status).toBe(409); expect(result.body.code).toBe("account_changed"); await expectNotSaved();
  });
  it("does not offer or accept an old-scope sealed witness even with unchanged key and fresh UI version", async () => {
    await prisma.customerEndpointScope.update({ where: { id: scopeId }, data: { scopeRevision: { increment: 1 } } });
    const status = await readInstagramAppBindingStatus(accountId);
    expect(status.candidates).toHaveLength(0);
    const fake = successfulMeta(); const result = await submit({ ...body, configurationVersion: status.configurationVersion });
    expect(result.status).toBe(409); expect(result.body.code).toBe("observation_unavailable");
    expect(fake).not.toHaveBeenCalled(); await expectNotSaved();
  });
  it("keeps an owner-configured status pending until a genuinely fresh account-signed FINAL arrives", async () => {
    successfulMeta(); const result = await submit(); expect(result.status).toBe(200);
    expect(result.body.authority).toBe("owner_selected_observed_signer");
    expect(result.body.configuredAt).toBeTruthy(); expect(result.body.freshSignatureObservedAt).toBeNull();
    expect(JSON.stringify(result.body)).not.toMatch(/Meta.verified|meta_verified/);
    const previous = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: body.observationId } });
    await observe("protected");
    const status = await readInstagramAppBindingStatus(accountId);
    expect(status.freshSignatureObservedAt).toBeTruthy();
    expect(status.freshSignatureObservedAt! > result.body.configuredAt).toBe(true);
    const retained = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: body.observationId } });
    expect(retained.originCiphertext).toBe(previous.originCiphertext); expect(retained.payloadCiphertext).toBe(previous.payloadCiphertext);
  });
  it("persists a verified write-only key and its audit together", async () => {
    const fake = successfulMeta();
    const before = await prisma.customerEndpointScope.findUniqueOrThrow({ where: { id: scopeId } });
    const result = await submit();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const saved = await prisma.messengerAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(saved.appSecret).not.toBe(secret); expect(decryptSecret(saved.appSecret!)).toBe(secret);
    expect(JSON.stringify(result.body)).not.toContain(secret);
    const audit = await prisma.auditLog.findFirst({ where: { action: "INSTAGRAM_SIGNER_OWNER_CONFIGURED", entityId: accountId } });
    expect(audit?.agentId).toBe(actorId); expect(JSON.stringify(audit)).not.toContain(secret);
    expect(fake).toHaveBeenCalledTimes(2);
    const after = await prisma.customerEndpointScope.findUniqueOrThrow({ where: { id: scopeId } });
    expect(after.scopeRevision).toBe(before.scopeRevision + 1n);
    const status = await request(app).get(url()).set("Authorization", `Bearer ${accessToken}`);
    expect(status.body).toMatchObject({ hasAppSecret: true, configuredAppId: appId });
    expect(JSON.stringify(status.body)).not.toContain(secret);
  });
  it("does not rotate the namespace again when rechecking the same verified key", async () => {
    successfulMeta(); expect((await submit()).status).toBe(200);
    const before = await prisma.customerEndpointScope.findUniqueOrThrow({ where: { id: scopeId } });
    const result = await submit(); expect(result.status).toBe(200); expect(result.body.configurationChanged).toBe(false);
    expect((await prisma.customerEndpointScope.findUniqueOrThrow({ where: { id: scopeId } })).scopeRevision).toBe(before.scopeRevision);
  });
  it("can read back and retry a lost HTTP response without re-encrypting or rotating the accepted key", async () => {
    successfulMeta();
    const drop = vi.spyOn(response, "json").mockImplementationOnce(function (this: Response) { this.destroy(); return this; });
    try { await expect(submit()).rejects.toBeDefined(); } finally { drop.mockRestore(); }
    const accepted = await prisma.messengerAccount.findUniqueOrThrow({ where: { id: accountId } });
    const scope = await prisma.customerEndpointScope.findUniqueOrThrow({ where: { id: scopeId } });
    expect(decryptSecret(accepted.appSecret!)).toBe(secret);
    const status = await request(app).get(url()).set("Authorization", `Bearer ${accessToken}`);
    expect(status.body.configuredAppId).toBe(appId);
    const repeated = await submit(); expect(repeated.status).toBe(200); expect(repeated.body.configurationChanged).toBe(false);
    expect((await prisma.messengerAccount.findUniqueOrThrow({ where: { id: accountId } })).appSecret).toBe(accepted.appSecret);
    expect((await prisma.customerEndpointScope.findUniqueOrThrow({ where: { id: scopeId } })).scopeRevision).toBe(scope.scopeRevision);
  });
  it("requires authentication and an elevated settings identity before contacting Meta", async () => {
    const fake = successfulMeta();
    expect((await request(app).post(url()).send({ appId, secretSource: "manual", appSecret: secret })).status).toBe(401);
    revokeElevation(actorId);
    expect((await submit()).status).toBe(428);
    expect(fake).not.toHaveBeenCalled(); await expectNotSaved();
  });
  it("does not accept an undeclared key through the old generic account save route", async () => {
    const fake = successfulMeta();
    const result = await request(app).post("/api/v1/settings/messenger-accounts").set("Authorization", `Bearer ${accessToken}`)
      .send({ id: accountId, title: "Stand binding account", appSecret: secret });
    expect(result.status).toBe(400); expect(fake).not.toHaveBeenCalled(); await expectNotSaved();
  });
  it.each(["token", "extraExternalIds", "enabled"] as const)("rejects verification after concurrent %s change", async field => {
    successfulMeta(async () => {
      await prisma.messengerAccount.update({ where: { id: accountId }, data: field === "token" ? { token: encryptSecret("stand-rotated-token") }
        : field === "enabled" ? { enabled: false } : { extraExternalIds: ["999"] } });
    });
    const result = await submit(); expect(result.status).toBe(409); expect(result.body.code).toBe("account_changed"); await expectNotSaved();
  });
  it("does not copy an existing global key unless the same fresh provider proof succeeds", async () => {
    const fake = successfulMeta();
    expect((await submit()).status).toBe(200);
    expect(fake).toHaveBeenCalledTimes(2);
  });
  it("rejects rotation of the selected global key during provider verification", async () => {
    successfulMeta(async () => { await prisma.settings.update({ where: { id: "singleton" }, data: { metaIgAppSecret: encryptSecret("stand-changed-global-key") } }); });
    const result = await submit();
    expect(result.status).toBe(409); expect(result.body.code).toBe("account_changed"); await expectNotSaved();
  });
  it("rechecks proof expiry inside the write transaction", async () => {
    successfulMeta();
    const base = Date.now(); let reads = 0;
    const now = () => ++reads <= 4 ? base : base + 30_001;
    await expect(bindInstagramAppForAccount(actorId, accountId, body, { now }))
      .rejects.toMatchObject({ code: "proof_expired" });
    await expectNotSaved();
  });
  it("does not rotate the key or namespace while managed provider work is open", async () => {
    successfulMeta();
    const scope = await prisma.customerEndpointScope.findUniqueOrThrow({ where: { id: scopeId } });
    const operation = await prisma.aiProviderOperation.create({ data: { policyKey: "royal-customer-gemini", policyHash: "e".repeat(64),
      dayKey: "2026-10-22", deadlineAt: new Date(Date.now() + 60_000), maxAttempts: 1, reservedUsd: "0.01" } });
    try {
      const result = await submit(); expect(result.status).toBe(409); expect(result.body.code).toBe("account_busy");
      await expectNotSaved();
      expect((await prisma.customerEndpointScope.findUniqueOrThrow({ where: { id: scopeId } })).scopeRevision).toBe(scope.scopeRevision);
    } finally { await prisma.aiProviderOperation.delete({ where: { id: operation.id } }); }
  });
  it("expires a provider proof that becomes stale while waiting for the account row lock", async () => {
    successfulMeta(); let clock = Date.now(); const initial = clock;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { entered = resolve; });
    const lock = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "MessengerAccount" WHERE "id"=${accountId} FOR UPDATE`;
      entered(); await gate;
    }, { timeout: 5_000 });
    await locked;
    const attempt = bindInstagramAppForAccount(actorId, accountId, body, { now: () => clock })
      .then(result => ({ result }), error => ({ error }));
    let outcome: Awaited<typeof attempt> | undefined;
    try {
      await waitFor(async () => {
        const [row] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
            AND query ILIKE '%UPDATE%' AND query LIKE '%MessengerAccount%') AS waiting`;
        return row?.waiting;
      });
      clock = initial + 30_001;
    } finally { release(); await lock; outcome = await attempt; }
    expect(outcome).toMatchObject({ error: { code: "proof_expired" } }); await expectNotSaved();
  });
  it.each(["role", "isActive"] as const)("rejects revocation of the acting administrator's %s during verification", async field => {
    successfulMeta(async () => {
      await prisma.agent.update({ where: { id: actorId }, data: field === "role" ? { role: "AGENT" } : { isActive: false } });
    });
    const result = await submit(); expect(result.status).toBe(403); await expectNotSaved();
  });
  it("does not keep a stale verification badge after a token rotation", async () => {
    successfulMeta(); expect((await submit()).status).toBe(200);
    await prisma.messengerAccount.update({ where: { id: accountId }, data: { token: encryptSecret("stand-new-access-token") } });
    const result = await request(app).get(url()).set("Authorization", `Bearer ${accessToken}`);
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ hasAppSecret: true, configuredAppId: null, configuredAt: null });
  });
  it("rolls back the encrypted key if its audit cannot be committed", async () => {
    successfulMeta();
    const scopeBefore = await prisma.customerEndpointScope.findUniqueOrThrow({ where: { id: scopeId } });
    const name = `stand_binding_${randomUUID().replaceAll("-", "")}`;
    await prisma.$executeRawUnsafe(`CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'stand audit failure'; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "${name}" BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW."entityId"='${accountId}') EXECUTE FUNCTION "${name}"()`);
    try {
      const result = await submit(); expect(result.status).toBe(500); expect(JSON.stringify(result.body)).not.toContain(secret);
      await expectNotSaved();
      expect((await prisma.customerEndpointScope.findUniqueOrThrow({ where: { id: scopeId } })).scopeRevision).toBe(scopeBefore.scopeRevision);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER "${name}" ON "AuditLog"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION "${name}"()`);
    }
  });
  it("keeps a previously captured public input public and verifies only a new signed request with the account key", async () => {
    const target = { channel: "INSTAGRAM" as const, accountId, accountExternalId: externalId };
    function frame(key: string) {
      const eventId = randomUUID(), rawBody = Buffer.from(JSON.stringify({ eventId, recipient: externalId }));
      const req = { rawBody, get: () => `sha256=${createHmac("sha256", key).update(rawBody).digest("hex")}` };
      registerAuthenticatedMetaCustomerRequest(req); return { req, eventId };
    }
    const old = frame(secret);
    expect(await verifyAndRegisterMetaCustomerIssuer(old.req, target)).toBe(false);
    expect(await verifyAndRegisterPublicMetaCustomerIssuer(old.req, target)).toBe(true);
    const oldInput = captureAuthenticatedCustomerInput(old.req, { channel: "INSTAGRAM", peer: "stand-binding-peer", accountExternalId: externalId,
      eventId: old.eventId, eventKind: "message", inputText: "stand input" });
    expect(inspectAuthenticatedCustomerInput(oldInput)?.assurance).toBe("public_envelope");
    successfulMeta(); expect((await submit()).status).toBe(200);
    expect(inspectAuthenticatedCustomerInput(oldInput)?.assurance).toBe("public_envelope");
    const fresh = frame(secret);
    expect(await verifyAndRegisterMetaCustomerIssuer(fresh.req, target)).toBe(true);
    const wrong = frame("stand-wrong-app-key");
    expect(await verifyAndRegisterMetaCustomerIssuer(wrong.req, target)).toBe(false);
  });
});
