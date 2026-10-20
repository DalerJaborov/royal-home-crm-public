import { createHmac, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma, type TxClient } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";
import { admitCustomerPropertyInput } from "../src/lib/customerPropertyAdmission.js";
import { captureAuthenticatedCustomerInput, registerAuthenticatedMetaCustomerRequest, verifyAndRegisterMetaCustomerIssuer } from "../src/lib/customerIngressAuthority.js";
import { assertCustomerFence, inspectCustomerWriteAuthority, issueCustomerWriteAuthority } from "../src/lib/customerState.js";
import { executeCustomerAction } from "../src/lib/customerActionJournal.js";
import { lockCustomerNative } from "../src/lib/customerNativeLock.js";

/** Real PostgreSQL sessions/row locks/triggers. No database or lock mocks.
 * Synthetic accepted-IN adapters are not a real Meta HTTP parser/provider. */
vi.mock("../src/push.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents: vi.fn(), sendPushToAgent: vi.fn(), closeLeadPushNotification: vi.fn() }));
const accountIds: string[] = [], nativeIds: string[] = [], scopeIds = new Set<string>();
const txOptions = { maxWait: 3000, timeout: 8000 };
function signal<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function reached<T>(barrier: { promise: Promise<T> }, transaction: Promise<unknown>): Promise<T> {
  return Promise.race([barrier.promise, transaction.then(() => { throw new Error("Transaction ended before its owned barrier"); })]);
}
async function pid(tx: TxClient): Promise<number> {
  const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  return row.pid;
}
/** The wait is proved by PostgreSQL, never by assuming an arbitrary delay. */
async function observedLock(backendPid: number): Promise<void> {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    const [row] = await prisma.$queryRaw<{ waiting: boolean }[]>`SELECT wait_event_type='Lock' AS waiting
      FROM pg_stat_activity WHERE pid=${backendPid}`;
    if (row?.waiting) return;
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error("Expected owned PostgreSQL session to wait on an actual lock");
}
async function account() {
  const value = { id: randomUUID(), externalId: `synthetic-concurrency-${randomUUID()}`, secret: `synthetic-key-${randomUUID()}` };
  await prisma.messengerAccount.create({ data: { id: value.id, channel: "INSTAGRAM", externalId: value.externalId,
    title: "Synthetic concurrency test", token: "synthetic-token", appSecret: encryptSecret(value.secret), enabled: true } });
  accountIds.push(value.id); return value;
}
async function native(a: Awaited<ReturnType<typeof account>>, peer = `synthetic-peer-${randomUUID()}`) {
  const value = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel: "INSTAGRAM", subscriberId: peer,
    accountId: a.id, accountExternalId: a.externalId }));
  nativeIds.push(value.id); scopeIds.add(value.transport.endpointScopeId);
  return { ...value, peer };
}
async function accepted(a: Awaited<ReturnType<typeof account>>) {
  const n = await native(a); const text = "Позвоните +992910044991", eventId = randomUUID();
  const rawBody = Buffer.from(JSON.stringify({ synthetic: true, text, peer: n.peer }));
  const request = { rawBody, get: () => `sha256=${createHmac("sha256", a.secret).update(rawBody).digest("hex")}` };
  registerAuthenticatedMetaCustomerRequest(request);
  expect(await verifyAndRegisterMetaCustomerIssuer(request, { channel: "INSTAGRAM", accountId: a.id, accountExternalId: a.externalId })).toBe(true);
  const input = captureAuthenticatedCustomerInput(request, { channel: "INSTAGRAM", peer: n.peer, eventKind: "message",
    eventId, inputText: text, accountExternalId: a.externalId });
  if (!input) throw new Error("Synthetic protected input missing");
  const admission = await admitCustomerPropertyInput({ channel: "INSTAGRAM", peer: n.peer, accountId: a.id,
    accountExternalId: a.externalId, eventKind: "message", eventId, evidence: [], authenticatedInput: input });
  if (admission.status !== "admitted") throw new Error("Synthetic admission denied");
  const grant = await issueCustomerWriteAuthority(input, admission.ticket, "callback");
  if (!grant) throw new Error("Synthetic actual callback grant denied");
  const evidence = inspectCustomerWriteAuthority(grant);
  if (!evidence) throw new Error("Synthetic grant evidence missing");
  return { ...n, grant, fence: evidence.fence };
}
async function noEffects(inquiryId: string, conversationId: string) {
  expect(await prisma.customerAction.count({ where: { inquiryId } })).toBe(0);
  expect(await prisma.callbackRequest.count({ where: { conversationId } })).toBe(0);
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
}
function settings() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, botInstagramEnabled: true, metaEnabled: true, metaAppSecret: true, metaWaPhoneId: true,
} }); }
let originalSettings: Awaited<ReturnType<typeof settings>>;
let originalPolicy: Awaited<ReturnType<typeof prisma.customerRuntimePolicy.findUniqueOrThrow>>;
beforeAll(async () => {
  originalSettings = await settings();
  originalPolicy = await prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, botInstagramEnabled: true, metaEnabled: true } });
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "scoped", rolloutMode: "ACTIVE",
    capabilities: { publicRead: true, contactWrite: true, callbackWrite: true, newLeadBridge: false } } });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Original external I/O forbidden in concurrency tests"); }));
});
afterAll(async () => {
  const inquiries = await prisma.customerInquiry.findMany({ where: { conversationId: { in: nativeIds } }, select: { id: true } });
  const ids = inquiries.map(row => row.id);
  const actions = await prisma.customerAction.findMany({ where: { inquiryId: { in: ids } }, select: { id: true } });
  const actionIds = actions.map(row => row.id);
  await prisma.callbackRequest.deleteMany({ where: { customerActionId: { in: actionIds } } });
  if (actionIds.length) await prisma.backgroundJob.deleteMany({ where: { OR: actionIds.map(id => ({ dedupeKey: `customer-callback-notify:${id}` })) } });
  await prisma.customerAction.deleteMany({ where: { inquiryId: { in: ids } } });
  await prisma.customerInquiry.deleteMany({ where: { id: { in: ids } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: nativeIds } } });
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { originalConversationId: { in: nativeIds } } });
  await prisma.customerEndpointScope.deleteMany({ where: { id: { in: [...scopeIds] } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accountIds } } });
  if (originalSettings) await prisma.settings.update({ where: { id: "singleton" }, data: originalSettings });
  if (originalPolicy) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: {
    contractVersion: originalPolicy.contractVersion, rolloutMode: originalPolicy.rolloutMode, capabilities: originalPolicy.capabilities!,
  } });
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("Customer foundation actual two-session lock barriers", () => {
  it("simultaneous same-endpoint creators converge while both global and scoped unique indexes remain", async () => {
    const a = await account();
    await native(a);
    for (let round = 0; round < 8; round++) {
      const peer = `synthetic-simultaneous-${randomUUID()}`;
      const results = await Promise.allSettled(Array.from({ length: 4 }, () => prisma.$transaction(tx =>
        ensureScopedBotConversation(tx, { channel: "INSTAGRAM", subscriberId: peer, accountId: a.id,
          accountExternalId: a.externalId }), txOptions)));
      const successful = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      nativeIds.push(...new Set(successful.map(value => value.id)));
      successful.forEach(value => scopeIds.add(value.transport.endpointScopeId));
      expect(results.map(result => result.status)).toEqual(Array(4).fill("fulfilled"));
      expect(new Set(successful.map(value => value.id)).size).toBe(1);
      expect(await prisma.botConversation.count({ where: { channel: "INSTAGRAM", subscriberId: peer } })).toBe(1);
      expect(await prisma.customerInquiry.count({ where: { endpointScopeId: successful[0].transport.endpointScopeId, peerId: peer } })).toBe(1);
    }
  });
  it("retained global uniqueness denies another account without returning or modifying the incumbent conversation", async () => {
    const a = await account(), b = await account();
    const existing = await native(a);
    await native(b);
    const before = await prisma.botConversation.findUniqueOrThrow({ where: { id: existing.id } });
    await expect(prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel: "INSTAGRAM",
      subscriberId: existing.peer, accountId: b.id, accountExternalId: b.externalId }), txOptions))
      .rejects.toMatchObject({ reason: "account_mismatch" });
    expect(await prisma.botConversation.findUniqueOrThrow({ where: { id: existing.id } })).toEqual(before);
    expect(await prisma.botConversation.count({ where: { channel: "INSTAGRAM", subscriberId: existing.peer } })).toBe(1);
  });
  it("Account DELETE waits before native→scope→policy→Inquiry fence, then invalidates the captured action", async () => {
    const a = await account(), value = await accepted(a);
    const holderReady = signal<void>(), continueHolder = signal<void>(), writerPid = signal<number>();
    const holder = prisma.$transaction(async tx => {
      expect(await lockCustomerNative(tx, { kind: "bot", id: value.id })).toBe(true);
      holderReady.resolve(); await continueHolder.promise;
      return assertCustomerFence(tx, value.fence, "local_write");
    }, txOptions);
    let deletion: Promise<unknown> | undefined;
    try {
      await reached(holderReady, holder);
      deletion = prisma.$transaction(async tx => { writerPid.resolve(await pid(tx)); return tx.messengerAccount.delete({ where: { id: a.id } }); }, txOptions);
      await observedLock(await reached(writerPid, deletion));
      continueHolder.resolve();
      expect((await holder).status).toBe("current");
      await deletion;
    } finally { continueHolder.resolve(); await Promise.allSettled([holder, ...(deletion ? [deletion] : [])]); }
    const stored = await prisma.botConversation.findUniqueOrThrow({ where: { id: value.id } });
    expect(stored.accountId).toBeNull(); expect(stored.endpointScopeId).toBe(value.fence.endpoint.endpointScopeId);
    expect((await executeCustomerAction(value.grant, { name: "request_callback", args: { topic: "Позвоните" } })).status).toBe("stale");
    await noEffects(value.fence.inquiryId, value.id);
  });
  it("fresh native creation holds actual Account FK KEY SHARE before Account DELETE", async () => {
    const a = await account(), peer = `synthetic-create-first-${randomUUID()}`;
    const created = signal<{ id: string; scope: string }>(), releaseCreate = signal<void>(), writerPid = signal<number>();
    const creation = prisma.$transaction(async tx => {
      const n = await ensureScopedBotConversation(tx, { channel: "INSTAGRAM", subscriberId: peer, accountId: a.id, accountExternalId: a.externalId });
      nativeIds.push(n.id); scopeIds.add(n.transport.endpointScopeId);
      created.resolve({ id: n.id, scope: n.transport.endpointScopeId }); await releaseCreate.promise;
      // The creator can reach the real later scope guard while deletion waits
      // on its earlier Account FK lock; an inverted prelock would not suffice.
      await tx.$queryRaw`SELECT "id" FROM "CustomerEndpointScope" WHERE "id"=${n.transport.endpointScopeId} FOR SHARE`;
      return n;
    }, txOptions);
    let deletion: Promise<unknown> | undefined;
    try {
      const n = await reached(created, creation);
      deletion = prisma.$transaction(async tx => { writerPid.resolve(await pid(tx)); return tx.messengerAccount.delete({ where: { id: a.id } }); }, txOptions);
      await observedLock(await reached(writerPid, deletion)); releaseCreate.resolve(); await creation; await deletion;
      const stored = await prisma.botConversation.findUniqueOrThrow({ where: { id: n.id } });
      expect(stored.accountId).toBeNull(); expect(stored.endpointScopeId).toBe(n.scope);
      const inquiry = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: n.id } });
      expect(inquiry.ownerMode).toBe("HOLD"); await noEffects(inquiry.id, n.id);
    } finally { releaseCreate.resolve(); await Promise.allSettled([creation, ...(deletion ? [deletion] : [])]); }
  });
  it("Account DELETE first fences a fresh creator before it can register a native/Inquiry", async () => {
    const a = await account(); const seed = await native(a); const peer = `synthetic-delete-first-${randomUUID()}`;
    const deleted = signal<void>(), releaseDelete = signal<void>(), creatorPid = signal<number>();
    const deletion = prisma.$transaction(async tx => { await tx.messengerAccount.delete({ where: { id: a.id } }); deleted.resolve(); await releaseDelete.promise; }, txOptions);
    let creation: Promise<unknown> | undefined;
    try {
      await reached(deleted, deletion);
      creation = prisma.$transaction(async tx => { creatorPid.resolve(await pid(tx)); return ensureScopedBotConversation(tx,
        { channel: "INSTAGRAM", subscriberId: peer, accountId: a.id, accountExternalId: a.externalId }); }, txOptions);
      // Attach rejection handling before releasing the competing transaction.
      const settled = creation.then(() => "created", () => "denied");
      await observedLock(await reached(creatorPid, creation)); releaseDelete.resolve(); await deletion;
      expect(await settled).toBe("denied");
      expect(await prisma.botConversation.count({ where: { subscriberId: peer } })).toBe(0);
      expect(await prisma.customerInquiry.count({ where: { peerId: peer } })).toBe(0);
      const inquiry = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: seed.id } });
      await noEffects(inquiry.id, seed.id);
    } finally { releaseDelete.resolve(); await Promise.allSettled([deletion, ...(creation ? [creation] : [])]); }
  });
  it("held Settings credential/resource update invalidates a native-first grant and rotate/restore cannot revive it", async () => {
    const a = await account(), value = await accepted(a), previous = await settings();
    const holderReady = signal<number>(), continueHolder = signal<void>(), settingsUpdated = signal<void>(), releaseSettings = signal<void>();
    const holder = prisma.$transaction(async tx => {
      expect(await lockCustomerNative(tx, { kind: "bot", id: value.id })).toBe(true);
      holderReady.resolve(await pid(tx)); await continueHolder.promise;
      return assertCustomerFence(tx, value.fence, "local_write");
    }, txOptions);
    let rotation: Promise<unknown> | undefined;
    try {
      const holderPid = await reached(holderReady, holder);
      rotation = prisma.$transaction(async tx => {
        await tx.settings.update({ where: { id: "singleton" }, data: { metaAppSecret: encryptSecret(`synthetic-rotation-${randomUUID()}`), metaWaPhoneId: `synthetic-resource-${randomUUID()}` } });
        settingsUpdated.resolve(); await releaseSettings.promise;
      }, txOptions);
      await reached(settingsUpdated, rotation); continueHolder.resolve(); await observedLock(holderPid);
      releaseSettings.resolve(); await rotation;
      expect((await holder).status).toBe("stale");
      await prisma.settings.update({ where: { id: "singleton" }, data: previous });
      const scope = await prisma.customerEndpointScope.findUniqueOrThrow({ where: { id: value.fence.endpoint.endpointScopeId } });
      expect(scope.scopeRevision).toBeGreaterThan(BigInt(value.fence.scopeRevision) + 1n);
      expect((await executeCustomerAction(value.grant, { name: "request_callback", args: { topic: "Позвоните" } })).status).toBe("stale");
      await noEffects(value.fence.inquiryId, value.id);
    } finally {
      continueHolder.resolve(); releaseSettings.resolve(); await Promise.allSettled([holder, ...(rotation ? [rotation] : [])]);
      await prisma.settings.update({ where: { id: "singleton" }, data: previous });
    }
  });
});
