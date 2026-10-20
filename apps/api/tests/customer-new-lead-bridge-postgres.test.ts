import { createHmac, randomInt, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type TxClient } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";
import { admitCustomerPropertyInput } from "../src/lib/customerPropertyAdmission.js";
import { captureAuthenticatedCustomerInput, registerAuthenticatedMetaCustomerRequest, verifyAndRegisterMetaCustomerIssuer } from "../src/lib/customerIngressAuthority.js";
import { inspectCustomerWriteAuthority, issueCustomerWriteAuthority, loadCustomerStateSnapshot, transitionCustomerState } from "../src/lib/customerState.js";
import { executeCustomerAction } from "../src/lib/customerActionJournal.js";
import { executeNewOnlyCustomerLeadBridge } from "../src/lib/customerNewLeadBridge.js";
import { sendPushToAgent, sendPushToAgents } from "../src/push.js";

/** Actual SQL/transactions/legacy triggers and opaque issuer/admission/contact.
 * Synthetic current-IN is not a live Meta HTTP parser or intake-assignment gate.
 * Only the required job insertion fault is injected; its whole tx stays real. */
vi.mock("../src/push.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents: vi.fn(), sendPushToAgent: vi.fn(), closeLeadPushNotification: vi.fn() }));
const accountIds: string[] = [], nativeIds: string[] = [], clientIds: string[] = [];
const ownedAgentIds: string[] = [];
const scopeIds = new Set<string>();
const context = { version: 1, kind: "BUYER", deferAssignment: false } as const;
function ownPhone(): string { return `+99298${randomInt(0, 10_000_000).toString().padStart(7, "0")}`; }
function settings() { return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  botEnabled: true, botInstagramEnabled: true, metaEnabled: true,
} }); }
let originalSettings: Awaited<ReturnType<typeof settings>>;
let originalPolicy: Awaited<ReturnType<typeof prisma.customerRuntimePolicy.findUniqueOrThrow>>;
async function bridgeEnabled(enabled: boolean) {
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "scoped", rolloutMode: "ACTIVE",
    capabilities: { publicRead: true, contactWrite: true, callbackWrite: true, newLeadBridge: enabled } } });
}
async function contactFixture(phone = ownPhone()) {
  const account = { id: randomUUID(), externalId: `synthetic-new-lead-${randomUUID()}`, secret: `synthetic-secret-${randomUUID()}` };
  await prisma.messengerAccount.create({ data: { id: account.id, channel: "INSTAGRAM", externalId: account.externalId,
    title: "Synthetic new-only bridge", token: "synthetic-token", appSecret: encryptSecret(account.secret), enabled: true } });
  accountIds.push(account.id);
  const peer = `synthetic-peer-${randomUUID()}`, eventId = randomUUID(), name = `Синтетик ${randomUUID()}`;
  const native = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel: "INSTAGRAM", subscriberId: peer,
    accountId: account.id, accountExternalId: account.externalId }));
  nativeIds.push(native.id); scopeIds.add(native.transport.endpointScopeId);
  const text = `${name}. ${phone}`;
  const rawBody = Buffer.from(JSON.stringify({ synthetic: true, text, peer }));
  const request = { rawBody, get: () => `sha256=${createHmac("sha256", account.secret).update(rawBody).digest("hex")}` };
  registerAuthenticatedMetaCustomerRequest(request);
  expect(await verifyAndRegisterMetaCustomerIssuer(request, { channel: "INSTAGRAM", accountId: account.id, accountExternalId: account.externalId })).toBe(true);
  const input = captureAuthenticatedCustomerInput(request, { channel: "INSTAGRAM", peer, accountExternalId: account.externalId,
    eventKind: "message", eventId, inputText: text });
  if (!input) throw new Error("Synthetic protected input missing");
  const admission = await admitCustomerPropertyInput({ channel: "INSTAGRAM", peer, accountId: account.id, accountExternalId: account.externalId,
    eventKind: "message", eventId, evidence: [], authenticatedInput: input });
  if (admission.status !== "admitted") throw new Error("Synthetic admission denied");
  const state = await loadCustomerStateSnapshot({ conversationId: native.id });
  if (!state) throw new Error("Synthetic canonical state missing");
  const accepted = await prisma.customerInquiry.findUniqueOrThrow({ where: { id: state.fence.inquiryId }, select: { lastAcceptedEventKey: true, lastAcceptedOrder: true } });
  expect(accepted.lastAcceptedEventKey).toBe(admission.ticket.eventKey);
  expect(accepted.lastAcceptedOrder?.toString()).toBe(admission.ticket.order);
  expect((await prisma.$transaction(tx => transitionCustomerState(tx, state.fence, { type: "intent", kind: "contact", change: "request",
    evidenceRefs: [admission.ticket.eventKey] }))).status).toBe("applied");
  const grant = await issueCustomerWriteAuthority(input, admission.ticket, "contact");
  if (!grant) throw new Error("Synthetic real contact grant missing");
  expect((await executeCustomerAction(grant, { name: "save_contact", args: { name, phone } })).status).toBe("created");
  const evidence = inspectCustomerWriteAuthority(grant);
  if (!evidence) throw new Error("Synthetic grant evidence missing");
  return { grant, inquiryId: evidence.fence.inquiryId, nativeId: native.id, name, phone };
}
async function policyJobs(inquiryId: string) {
  const actions = await prisma.customerAction.findMany({ where: { inquiryId, kind: "new_lead" }, select: { id: true } });
  if (!actions.length) return [];
  return prisma.backgroundJob.findMany({ where: { dedupeKey: { in: actions.map(row => `customer-intake-policy:${row.id}`) } } });
}
async function noLeadEffects(value: Awaited<ReturnType<typeof contactFixture>>) {
  expect(await prisma.client.count({ where: { fullName: value.name } })).toBe(0);
  expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: value.nativeId }, select: { clientId: true } })).clientId).toBeNull();
  expect(await prisma.customerAction.count({ where: { inquiryId: value.inquiryId, kind: "new_lead", status: "COMMITTED" } })).toBe(0);
  expect(await policyJobs(value.inquiryId)).toHaveLength(0);
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  expect(sendPushToAgent).not.toHaveBeenCalled(); expect(sendPushToAgents).not.toHaveBeenCalled();
}
async function assertOneLead(value: Awaited<ReturnType<typeof contactFixture>>) {
  const actions = await prisma.customerAction.findMany({ where: { inquiryId: value.inquiryId, kind: "new_lead" } });
  expect(actions).toHaveLength(1); const action = actions[0];
  expect(action.status).toBe("COMMITTED"); expect(action.receiptVersion).toBe(1); expect(action.committedAt).not.toBeNull();
  const client = await prisma.client.findUniqueOrThrow({ where: { id: action.resourceId! } }); clientIds.push(client.id);
  // Fixture input is already the canonical +992 form; CRM keeps the leading +.
  expect(client.fullName).toBe(value.name); expect(client.phone).toBe(value.phone);
  expect(client.kind).toBe("BUYER"); expect(client.source).toBe("INSTAGRAM");
  expect(client.customerIntakeActionId).toBe(action.id); expect(client.assignedAgentId).toBeNull();
  expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: value.nativeId }, select: { clientId: true } })).clientId).toBe(client.id);
  expect(await prisma.client.count({ where: { fullName: value.name } })).toBe(1);
  const jobs = await policyJobs(value.inquiryId); expect(jobs).toHaveLength(1);
  expect(jobs[0].type).toBe("customer-intake-policy"); expect(jobs[0].payload).toEqual({ version: 1, actionId: action.id });
  expect(jobs[0].runAt.getTime()).toBeLessThanOrEqual(Date.now() + 2000);
  await prisma.backgroundJob.update({ where: { id: jobs[0].id }, data: { runAt: new Date("2099-01-01T00:00:00.000Z") } });
  expect(vi.mocked(fetch)).not.toHaveBeenCalled(); expect(sendPushToAgent).not.toHaveBeenCalled(); expect(sendPushToAgents).not.toHaveBeenCalled();
  return { action, client };
}
function signal<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function reached<T>(barrier: { promise: Promise<T> }, task: Promise<unknown>): Promise<T> {
  return Promise.race([barrier.promise, task.then(() => { throw new Error("Task ended before its owned barrier"); })]);
}
async function observedLock(pid: number, holderPid: number): Promise<void> {
  const deadline = performance.now() + 350;
  let last: unknown;
  while (performance.now() < deadline) {
    const [row] = await prisma.$queryRaw<{ waiting: boolean; holderOwnsClient: boolean; state: string; waitType: string | null; locks: unknown }[]>`
      SELECT a.wait_event_type='Lock' AND EXISTS(
        SELECT 1 FROM pg_locks WHERE pid=${pid} AND relation='"Client"'::regclass AND mode='ShareRowExclusiveLock' AND NOT granted
      ) AS waiting, EXISTS(SELECT 1 FROM pg_locks WHERE pid=${holderPid} AND relation='"Client"'::regclass
        AND mode='RowExclusiveLock' AND granted) AS "holderOwnsClient", a.state,a.wait_event_type AS "waitType",
        (SELECT jsonb_agg(jsonb_build_object('mode',mode,'granted',granted)) FROM pg_locks
          WHERE pid=${pid} AND relation='"Client"'::regclass) AS locks
      FROM pg_stat_activity a WHERE a.pid=${pid}`;
    last = row ?? { sessionVisible: false };
    if (row?.waiting) expect(row.holderOwnsClient).toBe(true);
    if (row?.waiting) return;
    await new Promise(done => setTimeout(done, 10));
  }
  throw new Error(`Expected bridge Client ShareRowExclusive wait before 500ms timeout; owned-session snapshot=${JSON.stringify(last)}`);
}

beforeAll(async () => {
  originalSettings = await settings(); originalPolicy = await prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, botInstagramEnabled: true, metaEnabled: true } });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Original external I/O forbidden in new-only bridge tests"); }));
});
beforeEach(async () => { vi.clearAllMocks(); await bridgeEnabled(false); });
afterAll(async () => {
  const inquiries = await prisma.customerInquiry.findMany({ where: { conversationId: { in: nativeIds } }, select: { id: true } });
  const ids = inquiries.map(row => row.id);
  const actions = await prisma.customerAction.findMany({ where: { inquiryId: { in: ids } }, select: { id: true, kind: true, resourceId: true } });
  const actionIds = actions.map(row => row.id);
  if (actionIds.length) await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: actionIds.flatMap(id => [
    `customer-intake-policy:${id}`, `customer-intake-notify:${id}`, `customer-contact-intake:${id}`,
  ]) } } });
  const ownClients = [...new Set([...clientIds, ...actions.filter(row => row.kind === "new_lead" && row.resourceId).map(row => row.resourceId!)])];
  await prisma.client.deleteMany({ where: { id: { in: ownClients } } });
  await prisma.agent.deleteMany({ where: { id: { in: ownedAgentIds } } });
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

describe("Customer new-only lead bridge actual local boundary", () => {
  it("disabled bridge capability creates no Client/binding/job despite a real committed contact", async () => {
    const value = await contactFixture();
    expect(await executeNewOnlyCustomerLeadBridge(value.grant, context)).toEqual({ status: "stale", reason: "bridge_disabled_or_changed" });
    expect(await prisma.customerAction.count({ where: { inquiryId: value.inquiryId, kind: "new_lead" } })).toBe(0);
    await noLeadEffects(value);
  });
  it("enabled bridge commits exactly one new Client, native binding, policy task and actual receipt", async () => {
    await bridgeEnabled(true); const value = await contactFixture();
    const result = await executeNewOnlyCustomerLeadBridge(value.grant, context);
    expect(result.status).toBe("created"); if (result.status !== "created") throw new Error("New-only bridge did not commit");
    const { action, client } = await assertOneLead(value);
    expect(result.receipt).toMatchObject({ kind: "new_lead", outcome: "new_lead_created", resourceType: "Client", resourceId: client.id, actionId: action.id });
  });
  it("parallel duplicate execution cannot create two Clients, bindings, jobs or receipts", async () => {
    await bridgeEnabled(true); const value = await contactFixture();
    const results = await Promise.all([1, 2].map(() => executeNewOnlyCustomerLeadBridge(value.grant, context)));
    expect(results.map(row => row.status).sort()).toEqual(["created", "stale"]);
    await assertOneLead(value);
  });
  it("active, deleted and formatted extra-phone collisions require review and never resume/reassign foreign Clients", async () => {
    await bridgeEnabled(true);
    // --clean-db has migrations/settings but no seed agents. This foreign
    // assignee belongs to the fixture and survives unchanged in each collision.
    const agent = await prisma.agent.create({ data: { fullName: `Синтетический агент ${randomUUID()}`,
      phone: ownPhone(), role: "AGENT", passwordHash: "synthetic-unused-password-hash" }, select: { id: true } });
    ownedAgentIds.push(agent.id);
    for (const collision of ["active", "deleted", "extra"] as const) {
      const phone = ownPhone(), digits = phone.replace(/\D/g, "");
      const foreign = await prisma.client.create({ data: { id: randomUUID(), fullName: `Синтетическая чужая ${randomUUID()}`,
        phone: collision === "extra" ? ownPhone() : phone, extraPhones: collision === "extra" ? [`+992 (${digits.slice(3, 5)}) ${digits.slice(5, 8)}-${digits.slice(8)}`] : [],
        kind: "BUYER", source: "INSTAGRAM", assignedAgentId: agent.id, deletedAt: collision === "deleted" ? new Date() : null } });
      clientIds.push(foreign.id); const before = await prisma.client.findUniqueOrThrow({ where: { id: foreign.id } });
      const value = await contactFixture(phone);
      expect(await executeNewOnlyCustomerLeadBridge(value.grant, context)).toEqual({ status: "needs_review", reason: "phone_collision" });
      expect(await prisma.client.findUniqueOrThrow({ where: { id: foreign.id } })).toEqual(before);
      await noLeadEffects(value);
    }
  });
  it("required policy task insertion failure rolls back Client, native binding and the whole new-lead journal mutation", async () => {
    await bridgeEnabled(true); const value = await contactFixture();
    const original = prisma.$transaction.bind(prisma); let injected = false;
    const transactionSpy = vi.spyOn(prisma, "$transaction").mockImplementationOnce(async (operation, options) => {
      if (typeof operation !== "function") throw new Error("Expected real new-only bridge transaction");
      return original(async tx => {
        const delegate = tx.backgroundJob; const create = delegate.create.bind(delegate);
        const jobSpy = vi.spyOn(delegate, "create").mockImplementation(async args => {
          if (args.data.type === "customer-intake-policy") {
            const [owned] = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "CustomerAction" WHERE "inquiryId"=${value.inquiryId} AND "kind"='new_lead'`;
            expect(owned).toBeDefined(); expect(args.data.dedupeKey).toBe(`customer-intake-policy:${owned.id}`);
            expect(args.data.payload).toEqual({ version: 1, actionId: owned.id });
            injected = true; throw new Error("Synthetic required local queue insertion unavailable");
          }
          return create(args);
        });
        try { return await operation(tx); } finally { jobSpy.mockRestore(); }
      }, options);
    });
    try { expect(await executeNewOnlyCustomerLeadBridge(value.grant, context)).toEqual({ status: "unknown", reason: "commit_unconfirmed" }); }
    finally { transactionSpy.mockRestore(); }
    expect(injected).toBe(true);
    expect(await prisma.customerAction.count({ where: { inquiryId: value.inquiryId, kind: "new_lead" } })).toBe(0);
    await noLeadEffects(value);
  });
  it("legacy Client UPDATE holds its actual trigger chain while bridge waits on the table before locking its native/Inquiry", async () => {
    await bridgeEnabled(true); const value = await contactFixture(); const legacy = await contactFixture();
    const foreign = await prisma.client.create({ data: { id: randomUUID(), fullName: `Синтетическая legacy ${randomUUID()}`, phone: ownPhone(), kind: "BUYER", source: "INSTAGRAM" } });
    clientIds.push(foreign.id);
    await prisma.botConversation.update({ where: { id: legacy.nativeId }, data: { clientId: foreign.id } });
    const before = await prisma.customerInquiry.findUniqueOrThrow({ where: { id: legacy.inquiryId }, select: { bindingRevision: true } });
    const holderReady = signal<number>(), releaseHolder = signal<void>(), bridgePid = signal<number>();
    const holder = prisma.$transaction(async tx => {
      await tx.client.update({ where: { id: foreign.id }, data: { deletedAt: new Date() } });
      const actual = await tx.customerInquiry.findUniqueOrThrow({ where: { id: legacy.inquiryId }, select: { bindingRevision: true } });
      expect(actual.bindingRevision).toBeGreaterThan(before.bindingRevision);
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      holderReady.resolve(backend.pid); await releaseHolder.promise;
    }, { maxWait: 3000, timeout: 8000 });
    let bridge: ReturnType<typeof executeNewOnlyCustomerLeadBridge> | undefined;
    const original = prisma.$transaction.bind(prisma);
    let transactionSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const heldPid = await reached(holderReady, holder);
      transactionSpy = vi.spyOn(prisma, "$transaction").mockImplementationOnce(async (operation, options) => {
        if (typeof operation !== "function") throw new Error("Expected real bridge transaction");
        return original(async tx => {
          const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          bridgePid.resolve(row.pid); return operation(tx);
        }, options);
      });
      bridge = executeNewOnlyCustomerLeadBridge(value.grant, context);
      await observedLock(await reached(bridgePid, bridge), heldPid);
      // Actual NOWAIT proves the waiting bridge has not acquired either its
      // native or canonical Inquiry, despite the legacy Client→Inquiry holder.
      await original(async (tx: TxClient) => {
        const native = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "BotConversation" WHERE "id"=${value.nativeId} FOR UPDATE NOWAIT`;
        const inquiry = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "CustomerInquiry" WHERE "id"=${value.inquiryId} FOR UPDATE NOWAIT`;
        expect(native).toHaveLength(1); expect(inquiry).toHaveLength(1);
      }, { maxWait: 3000, timeout: 3000 });
      releaseHolder.resolve(); await holder;
      expect((await bridge).status).toBe("created");
      await assertOneLead(value);
    } catch (error) {
      releaseHolder.resolve();
      const result = bridge ? await bridge : null;
      const safeResult = result ? { status: result.status, ...("reason" in result ? { reason: result.reason } : {}) } : null;
      throw new Error(`${error instanceof Error ? error.message : "Owned bridge barrier failed"}; bridge=${JSON.stringify(safeResult)}`);
    } finally {
      releaseHolder.resolve(); await Promise.allSettled([holder, ...(bridge ? [bridge] : [])]); transactionSpy?.mockRestore();
    }
  });
});
