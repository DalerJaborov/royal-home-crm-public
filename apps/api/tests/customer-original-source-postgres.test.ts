import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { registerAuthenticatedMetaCustomerRequest } from "../src/lib/customerIngressAuthority.js";
import { normalizeAuthenticatedCustomerIngress } from "../src/lib/customerIngressNormalize.js";
import { persistVerifiedCustomerIngressBatch } from "../src/lib/customerIngressProducer.js";
import { customerDmRoutingForIncoming, inspectCustomerDmRouting, prepareVerifiedCustomerDmRouting } from "../src/lib/customerAgentIngressRouting.js";
import { admitCustomerPropertyInput } from "../src/lib/customerPropertyAdmission.js";
import { customerPropertyEventKey, customerPropertyScopeKey } from "../src/lib/customerPropertyScope.js";
import { ensureCustomerEndpoint, ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";
import { createCustomerRolloutFixture } from "./helpers/customerRolloutFixture.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";
import { resetMetaAccountCredsCache } from "../src/messengers/meta.js";

const accounts: string[] = [], scopes: string[] = [], events: string[] = [], natives: string[] = [];
let savedPolicy: Awaited<ReturnType<typeof readPolicy>>;
const readPolicy = () => prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  contractVersion: true, rolloutMode: true, activeAgentRevisionId: true, capabilities: true, rolloutConfig: true,
} });
async function input(text = "Салом хона ҳоло ҳаст?", mid = randomUUID()) {
  const id = randomUUID(), externalId = `original-install-${id}`, peer = `original-peer-${id}`, secret = `original-secret-${id}`;
  await prisma.messengerAccount.create({ data: { id, externalId, channel: "INSTAGRAM", enabled: true,
    title: "Original source PG fixture", token: encryptSecret(`fixture-token-${id}`), appSecret: encryptSecret(secret) } });
  accounts.push(id); resetAccountsCache(); resetMetaAccountCredsCache();
  function signed(body: unknown) {
    const rawBody = Buffer.from(JSON.stringify(body));
    const req = { rawBody, get: (name: string) => name === "x-hub-signature-256"
      ? `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` : undefined };
    registerAuthenticatedMetaCustomerRequest(req); return req;
  }
  function request(content = text, sourceMid = mid, sourcePeer = peer) {
    return signed({ object: "instagram", entry: [{ id: externalId, messaging: [{
      sender: { id: sourcePeer }, recipient: { id: externalId }, timestamp: 1792634400000, message: { mid: sourceMid, text: content },
    }] }] });
  }
  return { id, peer, externalId, mid, request, signed };
}
async function persist(i: Awaited<ReturnType<typeof input>>, req = i.request()) {
  const result = await persistVerifiedCustomerIngressBatch(req);
  const entry = normalizeAuthenticatedCustomerIngress(req).entries[0];
  const witness = customerDmRoutingForIncoming(req, { channel: "INSTAGRAM", senderId: entry.peer, accountExternalId: i.externalId, messageId: entry.eventId });
  const routing = inspectCustomerDmRouting(witness);
  if (routing) {
    scopes.push(routing.transport.endpointScopeId);
    if (routing.eventKey) events.push(routing.eventKey);
  }
  return { result, witness, routing };
}
async function admit(i: Awaited<ReturnType<typeof input>>, selected: Awaited<ReturnType<typeof persist>>) {
  const result = await admitCustomerPropertyInput({ channel: "INSTAGRAM", peer: i.peer, accountExternalId: i.externalId,
    eventKind: "message", eventId: i.mid, evidence: [], deferFocusUntilClassification: true,
    customerRoutingWitness: selected.witness ?? undefined });
  if (result.status === "admitted") natives.push(result.ticket.conversationId);
  return result;
}
async function native(i: Awaited<ReturnType<typeof input>>, role: "user" | "assistant", mid = i.mid) {
  const row = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel: "INSTAGRAM", subscriberId: i.peer,
    accountId: i.id, accountExternalId: i.externalId }));
  natives.push(row.id); scopes.push(row.transport.endpointScopeId);
  await prisma.botConversation.update({ where: { id: row.id }, data: { messages: [{ role, content: "fixture", mid }] } });
  return row;
}
beforeAll(async () => {
  savedPolicy = await readPolicy();
  await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "contractVersion"='compat',"rolloutMode"='OFF',
    "activeAgentRevisionId"=NULL,"rolloutConfig"=NULL WHERE "id"='singleton'`;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Original ownership must not call model/provider"); }));
});
afterAll(async () => {
  try {
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: events.map(key => `customer-inbox-consume:${key}`) } } });
    await prisma.customerPropertyIngressTicket.deleteMany({ where: { eventKey: { in: events } } });
    await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: natives } } });
    await prisma.botConversation.deleteMany({ where: { id: { in: natives } } });
    const ownedScopes = await prisma.customerEndpointScope.findMany({ where: { messengerAccountId: { in: accounts } }, select: { id: true } });
    await prisma.customerEndpointScope.deleteMany({ where: { id: { in: [...new Set([...scopes, ...ownedScopes.map(s => s.id)])] } } });
    await prisma.messengerAccount.deleteMany({ where: { id: { in: accounts } } });
  } finally {
    if (savedPolicy) {
      const { rolloutConfig, ...values } = savedPolicy;
      await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: values });
      if (rolloutConfig === null) await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=NULL WHERE "id"='singleton'`;
      else await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${JSON.stringify(rolloutConfig)}::jsonb WHERE "id"='singleton'`;
    }
    vi.unstubAllGlobals(); resetAccountsCache(); resetMetaAccountCredsCache();
  }
});

it("commits original LEGACY MID before the OFF bypass, without a native, RAW job or provider call", async () => {
  const i = await input(), { result, routing } = await persist(i);
  expect(result).toEqual({ status: "bypass", reason: "unsupported" });
  expect(routing?.execution.lane).toBe("LEGACY");
  const ticket = await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey: routing!.eventKey! } });
  expect(ticket).not.toBeNull();
  expect(ticket).toMatchObject({ rolloutAssignmentId: routing!.execution.lane === "LEGACY" ? routing!.execution.assignment!.id : null,
    conversationId: null, originalConversationId: null, payloadVersion: null, intakeAgentRevisionId: null });
  expect(await prisma.botConversation.count({ where: { subscriberId: i.peer } })).toBe(0);
  expect(await prisma.backgroundJob.count({ where: { dedupeKey: `customer-inbox-consume:${routing!.eventKey}` } })).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("same MID with changed content is held before native/provider work and retains original metadata", async () => {
  const i = await input(), first = await persist(i);
  const before = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: first.routing!.eventKey! } });
  const changed = await persist(i, i.request("Different question"));
  expect(changed.result.status).toBe("unavailable");
  expect(changed.routing?.execution).toEqual({ lane: "HELD", reason: "original_source_changed" });
  expect(await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: before.eventKey } })).toEqual(before);
  expect(await prisma.botConversation.count({ where: { subscriberId: i.peer } })).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("one original binding is fresh across concurrent same-witness and independently signed requests", async () => {
  const i = await input(), first = await persist(i), second = await persist(i);
  const results = await Promise.all([admit(i, first), admit(i, first), admit(i, second), admit(i, second)]);
  expect(results.every(r => r.status === "admitted")).toBe(true);
  expect(results.filter(r => r.status === "admitted" && r.fresh)).toHaveLength(1);
  expect(new Set(results.flatMap(r => r.status === "admitted" ? [r.ticket.conversationId] : [])).size).toBe(1);
  expect(await prisma.botConversation.count({ where: { subscriberId: i.peer } })).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});

it("a new signed retry recovers the pre-native crash boundary once without renewing original intake time", async () => {
  const i = await input(), first = await persist(i);
  const original = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: first.routing!.eventKey! } });
  // No admission of the original request; its process/RAM may disappear here.
  const retry = await persist(i), recovered = await admit(i, retry);
  expect(recovered).toMatchObject({ status: "admitted", fresh: true });
  expect(await admit(i, retry)).toMatchObject({ status: "admitted", fresh: false });
  const after = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: original.eventKey } });
  expect(after.receivedAt).toEqual(original.receivedAt); expect(after.order).toBe(original.order);
  expect(after.rolloutAssignmentId).toBe(original.rolloutAssignmentId);
  expect(after.payloadVersion).toBeNull(); expect(after.intakeAgentRevisionId).toBeNull();
});

it("real native deletion leaves a source tombstone and cannot recreate the conversation on redelivery", async () => {
  const i = await input(), first = await persist(i), admitted = await admit(i, first);
  if (admitted.status !== "admitted") throw new Error("Actual native admission required");
  await prisma.customerInquiry.deleteMany({ where: { conversationId: admitted.ticket.conversationId } });
  await prisma.botConversation.delete({ where: { id: admitted.ticket.conversationId } });
  const retry = await persist(i);
  expect(retry.result.status).toBe("unavailable"); expect(retry.routing?.execution.lane).toBe("HELD");
  const tombstone = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: first.routing!.eventKey! } });
  expect(tombstone.tombstonedAt).not.toBeNull(); expect(tombstone.conversationId).toBeNull();
  expect(tombstone.originalConversationId).toBe(admitted.ticket.conversationId);
  expect(await prisma.botConversation.count({ where: { subscriberId: i.peer } })).toBe(0);
});

it("native-first user MID becomes a durable guard, including after deletion; assistant MID does not", async () => {
  const i = await input(), existing = await native(i, "user"), selected = await persist(i);
  expect(selected.result.status).toBe("unavailable");
  expect(selected.routing?.execution).toEqual({ lane: "HELD", reason: "original_native_source_already_observed" });
  const stored = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: selected.routing!.eventKey! } });
  expect(stored).toMatchObject({ routingProvenance: "NATIVE_HISTORY", conversationId: existing.id,
    originalConversationId: existing.id, intakeAgentRevisionId: null, rolloutAssignmentId: null, payloadVersion: null });
  await prisma.customerInquiry.deleteMany({ where: { conversationId: existing.id } });
  await prisma.botConversation.delete({ where: { id: existing.id } });
  expect((await persist(i)).routing?.execution.lane).toBe("HELD");
  const outbound = await input(); await native(outbound, "assistant");
  expect((await persist(outbound)).routing?.execution.lane).toBe("LEGACY");
});

it("same provider MID in another exact installation has independent ownership", async () => {
  const mid = randomUUID(), a = await input("A", mid), b = await input("B", mid);
  await native(a, "user"); const first = await persist(a), second = await persist(b);
  expect(first.routing?.execution.lane).toBe("HELD"); expect(second.routing?.execution.lane).toBe("LEGACY");
  expect(first.routing!.eventKey).not.toBe(second.routing!.eventKey);
});

it("an unbound original source cannot be consumed through a fabricated witness", async () => {
  const i = await input(), selected = await persist(i);
  const fake = { ...selected, witness: { purpose: "routing_only" as const } };
  expect(await admit(i, fake)).toEqual({ status: "denied", reason: "account_mismatch" });
  expect(await prisma.botConversation.count({ where: { subscriberId: i.peer } })).toBe(0);
});

it("original routing metadata is immutable in SQL, including a NULL historical source", async () => {
  const i = await input(), first = await persist(i), key = first.routing!.eventKey!;
  await expect(prisma.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "routingSourceHash"=${"a".repeat(64)} WHERE "eventKey"=${key}`)
    .rejects.toThrow("customer original routing source is immutable");
  const historical = customerPropertyEventKey(first.routing!.scopeKey, "message", randomUUID()); events.push(historical);
  await prisma.$executeRaw`INSERT INTO "CustomerPropertyIngressTicket" ("eventKey","scopeKey","endpointScopeId")
    VALUES (${historical},${first.routing!.scopeKey},${first.routing!.transport.endpointScopeId})`;
  await expect(prisma.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "routingSourceVersion"=1,"routingSourceHash"=${"a".repeat(64)},
    "routingScopeRevision"=0,"routingProvenance"='META_ENVELOPE' WHERE "eventKey"=${historical}`)
    .rejects.toThrow("customer original routing source is immutable");
});

it("CORE still creates its RAW payload and job together, without a payloadless precreated CORE source", async () => {
  const i = await input(), rollout = await createCustomerRolloutFixture();
  try {
    const endpoint = await rollout.allowDm({ peer: i.peer, accountId: i.id, accountExternalId: i.externalId }); scopes.push(endpoint.endpointScopeId);
    const req = i.request(), prepared = await prepareVerifiedCustomerDmRouting(req);
    expect(prepared.status).toBe("current");
    const scopeKey = customerPropertyScopeKey("INSTAGRAM", i.peer, i.id, endpoint.endpointScopeId);
    const key = customerPropertyEventKey(scopeKey, "message", i.mid);
    expect(await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey: key } })).toBeNull();
    const selected = await persist(i, req);
    expect(selected.result.status).toBe("persisted"); expect(selected.routing?.execution.lane).toBe("CORE");
    const stored = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: selected.routing!.eventKey! } });
    expect(stored).toMatchObject({ payloadVersion: 1, intakeAgentRevisionId: rollout.revision.id, routingSourceVersion: 1,
      routingProvenance: "META_ENVELOPE", routingScopeRevision: BigInt(endpoint.scopeRevision) });
    expect(stored.payloadCiphertext).toBeTruthy(); expect(stored.routingSourceHash).toBe(stored.payloadHash);
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: `customer-inbox-consume:${stored.eventKey}` } })).toBe(1);
    expect(await prisma.botConversation.count({ where: { subscriberId: i.peer } })).toBe(0);
    // Regression: original metadata must not impose a LEGACY routing witness
    // on the existing server-side CORE native admission. No FINAL/principal
    // is fabricated by this metadata-only call.
    const admitted = await admitCustomerPropertyInput({ channel: "INSTAGRAM", peer: i.peer,
      accountExternalId: i.externalId, eventKind: "message", eventId: i.mid, evidence: [], deferFocusUntilClassification: true });
    expect(admitted).toMatchObject({ status: "admitted", fresh: false });
    if (admitted.status === "admitted") natives.push(admitted.ticket.conversationId);
  } finally { await rollout.restore(); }
});

it("a retry cannot renew expired original intake into a fresh first binding", async () => {
  const i = await input(), clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 16 * 60_000);
  let first: Awaited<ReturnType<typeof persist>>;
  try { first = await persist(i); } finally { clock.mockRestore(); }
  const original = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: first!.routing!.eventKey! } });
  const retry = await persist(i);
  expect(await admit(i, retry)).toEqual({ status: "denied", reason: "retry_ticket_missing" });
  expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: original.eventKey } })).receivedAt).toEqual(original.receivedAt);
  expect(await prisma.botConversation.count({ where: { subscriberId: i.peer } })).toBe(0);
});

it("mixed CORE/LEGACY batch keeps separate immutable source pins and only CORE gets a RAW job", async () => {
  const i = await input(), legacy = await persist(i), rollout = await createCustomerRolloutFixture();
  try {
    await rollout.allowDm({ peer: i.peer, accountId: i.id, accountExternalId: i.externalId });
    const coreMid = randomUUID(), corePeer = `mixed-new-${randomUUID()}`;
    const legacyFrame = JSON.parse(i.request().rawBody.toString()).entry[0].messaging[0];
    const coreFrame = JSON.parse(i.request("Нархаш чанд?", coreMid, corePeer).rawBody.toString()).entry[0].messaging[0];
    const req = i.signed({ object: "instagram", entry: [{ id: i.externalId, messaging: [legacyFrame, coreFrame] }] });
    expect((await persistVerifiedCustomerIngressBatch(req)).status).toBe("persisted");
    const witness = customerDmRoutingForIncoming(req, { channel: "INSTAGRAM", senderId: corePeer, accountExternalId: i.externalId, messageId: coreMid });
    const core = inspectCustomerDmRouting(witness)!; events.push(core.eventKey!);
    expect(core.execution.lane).toBe("CORE");
    const stored = await prisma.customerPropertyIngressTicket.findMany({ where: { eventKey: { in: [legacy.routing!.eventKey!, core.eventKey!] } } });
    expect(stored.find(t => t.eventKey === legacy.routing!.eventKey)).toMatchObject({ payloadVersion: null, intakeAgentRevisionId: null });
    expect(stored.find(t => t.eventKey === core.eventKey)).toMatchObject({ payloadVersion: 1, intakeAgentRevisionId: rollout.revision.id });
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: { in: stored.map(t => `customer-inbox-consume:${t.eventKey}`) } } })).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  } finally { await rollout.restore(); }
});

it("aborted authenticated requests never allocate an original source or a native", async () => {
  const i = await input(), req = { ...i.request(), aborted: true };
  registerAuthenticatedMetaCustomerRequest(req);
  expect((await persistVerifiedCustomerIngressBatch(req)).status).toBe("unavailable");
  expect(await prisma.botConversation.count({ where: { subscriberId: i.peer } })).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("scope rotation holds an original MID without rewriting its first scope revision", async () => {
  const i = await input(), first = await persist(i), transport = first.routing!.transport;
  await prisma.$executeRaw`UPDATE "CustomerEndpointScope" SET "scopeRevision"="scopeRevision"+1 WHERE "id"=${transport.endpointScopeId}`;
  const retry = await persist(i);
  expect(retry.routing?.execution).toEqual({ lane: "HELD", reason: "original_source_changed" });
  const row = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: first.routing!.eventKey! } });
  expect(row.routingScopeRevision).toBe(BigInt(transport.scopeRevision));
  expect(await prisma.botConversation.count({ where: { subscriberId: i.peer } })).toBe(0);
});

it("a historical NULL source is not upgraded into new routing provenance or CORE RAW", async () => {
  const i = await input();
  const admitted = await admitCustomerPropertyInput({ channel: "INSTAGRAM", peer: i.peer, accountId: i.id,
    accountExternalId: i.externalId, eventKind: "message", eventId: i.mid, evidence: [], deferFocusUntilClassification: true });
  if (admitted.status !== "admitted") throw new Error("Historical admission fixture required");
  natives.push(admitted.ticket.conversationId); events.push(admitted.ticket.eventKey);
  const before = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: admitted.ticket.eventKey } });
  const rollout = await createCustomerRolloutFixture();
  try {
    await rollout.allowDm({ peer: i.peer, accountId: i.id, accountExternalId: i.externalId });
    const retry = await persist(i);
    expect(retry.routing?.execution.lane).toBe("LEGACY");
    expect(await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: before.eventKey } })).toEqual(before);
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: `customer-inbox-consume:${before.eventKey}` } })).toBe(0);
  } finally { await rollout.restore(); }
});

it("a mixed-batch CORE job fault rolls back only RAW while retaining the original LEGACY pin for a signed retry", async () => {
  const i = await input(), legacy = await persist(i), rollout = await createCustomerRolloutFixture();
  let blockerId: string | undefined;
  try {
    const endpoint = await rollout.allowDm({ peer: i.peer, accountId: i.id, accountExternalId: i.externalId });
    const corePeer = `mixed-fault-${randomUUID()}`, coreMid = randomUUID();
    const scopeKey = customerPropertyScopeKey("INSTAGRAM", corePeer, i.id, endpoint.endpointScopeId);
    const coreKey = customerPropertyEventKey(scopeKey, "message", coreMid); events.push(coreKey);
    const a = JSON.parse(i.request().rawBody.toString()).entry[0].messaging[0];
    const b = JSON.parse(i.request("Салом", coreMid, corePeer).rawBody.toString()).entry[0].messaging[0];
    const body = { object: "instagram", entry: [{ id: i.externalId, messaging: [a, b] }] };
    blockerId = (await prisma.backgroundJob.create({ data: { type: "original-source-test-blocker", payload: {},
      dedupeKey: `customer-inbox-consume:${coreKey}`, maxAttempts: 1 } })).id;
    expect((await persistVerifiedCustomerIngressBatch(i.signed(body))).status).toBe("unavailable");
    expect(await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey: coreKey } })).toBeNull();
    const retained = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: legacy.routing!.eventKey! } });
    expect(retained).toMatchObject({ intakeAgentRevisionId: null, payloadVersion: null, conversationId: null });
    await prisma.backgroundJob.delete({ where: { id: blockerId } }); blockerId = undefined;
    expect((await persistVerifiedCustomerIngressBatch(i.signed(body))).status).toBe("persisted");
    expect(await admit(i, await persist(i))).toMatchObject({ status: "admitted", fresh: true });
    expect((await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: retained.eventKey } })).receivedAt).toEqual(retained.receivedAt);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    if (blockerId) await prisma.backgroundJob.deleteMany({ where: { id: blockerId } });
    await rollout.restore();
  }
});
