import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { customerStateSchema, type CustomerStateSnapshot } from "@royal-home/shared";
import { txScope, isActiveTransactionClient } from "../src/lib/transactionScope.js";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), lockState: vi.fn(), transition: vi.fn() }));
vi.mock("../src/db.js", async original => {
  const actual = await original<typeof import("../src/db.js")>();
  return { ...actual, prisma: { $transaction: mocks.transaction, $disconnect: actual.prisma.$disconnect.bind(actual.prisma) } };
});
vi.mock("../src/lib/customerState.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerState.js")>()),
  lockCustomerStateSnapshot: mocks.lockState, transitionCustomerState: mocks.transition }));
const { createManagedCustomerCallbackTx, finalizeManagedHandoverHoldTx, transitionManagedCustomerCallback,
  managedCustomerCallbackWitnessMatches } = await import("../src/lib/customerCallbackLifecycle.js");

type Task = {
  id: string; customerActionId: string; inquiryId: string; conversationId: string | null; requestKind: "CALLBACK" | "HUMAN";
  lifecycleStatus: "QUEUED" | "ACCEPTED" | "CLOSED"; lifecycleRevision: string; assignedAgentId: string | null;
  acceptedAt: Date | null; closureReason: string | null; doneAt: Date | null; handoverFence: unknown;
  actionKind: string; generation: bigint; actionStatus: string; supersededAt: Date | null; currentIntent: boolean;
};
let snapshot: CustomerStateSnapshot, task: Task | null, jobs: unknown[], operations: string[];
let tx: any, actionId: string, staffId: string, intentCommitted: boolean;
let fail: "job" | "cas" | "witness" | null;
let staff: { isActive: boolean; role: string; permissions: unknown }, ownAccess: boolean;
function witness() { return { version: 1, fence: structuredClone(snapshot.fence), ownerMode: snapshot.ownerMode, ownerAgentId: snapshot.ownerAgentId }; }
function request(permissions = ["messages.view"], id = staffId): Request {
  return { agent: { id, role: "ADMIN", permissions: new Set(permissions), sipExtension: null, can: (permission: string) => permissions.includes(permission) } } as unknown as Request;
}
function makeTask(kind: "CALLBACK" | "HUMAN" = "HUMAN"): Task {
  snapshot.ownerMode = kind === "HUMAN" ? "HOLD" : "BOT";
  return { id: randomUUID(), customerActionId: actionId, inquiryId: snapshot.fence.inquiryId, conversationId: snapshot.fence.nativeId,
    requestKind: kind, lifecycleStatus: "QUEUED", lifecycleRevision: "1", assignedAgentId: null, acceptedAt: null,
    closureReason: null, doneAt: null, handoverFence: witness(), actionKind: kind === "HUMAN" ? "handover" : "callback",
    generation: 1n, actionStatus: "COMMITTED", supersededAt: null, currentIntent: true };
}
function sqlText(first: unknown): string { return Array.isArray(first) ? first.join("?") : (first as { sql: string }).sql; }

/** Strict local transaction double: only this module's exact SQL operations are
 * supported; unknown queries throw. Actual PG/HTTP/opaque authority gates are
 * separate. ALS predicate is real, active only during the fake tx callback. */
beforeEach(() => {
  actionId = randomUUID(); staffId = randomUUID(); jobs = []; operations = []; fail = null; intentCommitted = true; ownAccess = true;
  staff = { isActive: true, role: "ADMIN", permissions: {} };
  snapshot = customerStateSchema.parse({ version: 1,
    fence: { inquiryId: randomUUID(), nativeId: randomUUID(), endpoint: { endpointScopeId: randomUUID(), channel: "INSTAGRAM",
      accountId: randomUUID(), peerId: "synthetic-peer", threadId: "" }, stateRevision: "2", intentRevision: "1",
      ownershipEpoch: "1", bindingRevision: "1", scopeRevision: "1", policyRevision: "1", ownerToken: randomUUID() },
    ownerMode: "BOT", ownerAgentId: null, ownerLeaseUntil: null, closedAt: null, publicState: {},
    privateAuthorization: "none", legacyMemoryQuarantined: true, contractVersion: "scoped", rolloutMode: "ACTIVE",
    capabilities: { publicRead: true, callbackWrite: true, handoverWrite: true } });
  task = null;
  mocks.lockState.mockReset().mockImplementation(async (db: unknown, reference: { inquiryId: string }) => {
    if (db !== tx || !isActiveTransactionClient(db) || reference.inquiryId !== snapshot.fence.inquiryId) throw new Error("Wrong canonical transaction/reference");
    operations.push("canonical_lock"); return structuredClone(snapshot);
  });
  mocks.transition.mockReset().mockImplementation(async (db: unknown, fence: unknown, event: any) => {
    if (db !== tx || !isActiveTransactionClient(db) || JSON.stringify(fence) !== JSON.stringify(snapshot.fence) || event.type !== "owner") {
      throw new Error("Wrong owner transaction/fence");
    }
    operations.push("owner_transition");
    snapshot.ownerMode = event.mode; snapshot.ownerAgentId = event.agentId; snapshot.fence.ownerToken = event.token;
    snapshot.fence.ownershipEpoch = String(BigInt(snapshot.fence.ownershipEpoch) + 1n);
    snapshot.fence.stateRevision = String(BigInt(snapshot.fence.stateRevision) + 1n);
    return { status: "applied", snapshot: structuredClone(snapshot) };
  });
  tx = {
    $queryRaw: vi.fn(async (first: unknown, ...values: unknown[]) => {
      const sql = sqlText(first);
      if (sql.includes('SELECT "id","kind","status" FROM "CustomerAction"')) {
        operations.push("action_lock"); return [{ id: actionId, kind: "handover", status: "EXECUTING" }];
      }
      if (sql.startsWith('SELECT r."id" FROM "CallbackRequest"')) {
        operations.push("task_lock");
        expect(sql).toContain('"actionIntents"->\'handover\'->>\'status\'=\'committed\'');
        expect(sql).toContain('"lifecycleRevision"=1');
        return task && intentCommitted && task.handoverFence === null ? [{ id: task.id }] : [];
      }
      if (sql.includes('FROM "CallbackRequest" r JOIN "CustomerAction"')) {
        operations.push(sql.includes("FOR UPDATE OF r") ? "task_lock" : "anchor_read");
        return task && task.id === values[0] ? [structuredClone(task)] : [];
      }
      throw new Error("Unexpected lifecycle query");
    }),
    $executeRaw: vi.fn(async (first: unknown, ...v: any[]) => {
      const sql = sqlText(first);
      if (sql.startsWith('INSERT INTO "CallbackRequest"')) {
        operations.push("task_insert");
        const ownerMode = snapshot.ownerMode;
        task = { ...makeTask(v[6]), id: v[0], customerActionId: v[1], conversationId: v[2],
          handoverFence: null, actionStatus: "EXECUTING" };
        snapshot.ownerMode = ownerMode;
        return 1;
      }
      if (sql.includes('SET "handoverFence"=')) {
        operations.push("witness_write"); if (fail === "witness") return 0;
        if (!task || task.id !== v[1]) return 0;
        task.handoverFence = JSON.parse(v[0]); return 1;
      }
      if (sql.includes('SET "lifecycleStatus"=')) {
        operations.push("task_update"); if (fail === "cas") return 0;
        if (!task || task.id !== v[7] || task.customerActionId !== v[8] || task.lifecycleRevision !== String(v[9]) || task.lifecycleStatus !== v[10]) return 0;
        Object.assign(task, { lifecycleStatus: v[0], lifecycleRevision: String(v[1]), assignedAgentId: v[2], acceptedAt: v[3], closureReason: v[4], doneAt: v[5] });
        return 1;
      }
      throw new Error("Unexpected lifecycle mutation");
    }),
    agent: { findUnique: vi.fn(async () => { operations.push("staff_read"); return structuredClone(staff); }) },
    botConversation: { findFirst: vi.fn(async () => ownAccess ? { id: snapshot.fence.nativeId } : null) },
    backgroundJob: { create: vi.fn(async (value: unknown) => { operations.push("job_create"); if (fail === "job") throw new Error("Synthetic required job failure"); jobs.push(structuredClone(value)); return { id: randomUUID() }; }) },
  };
  mocks.transaction.mockReset().mockImplementation(async (fn: (db: unknown) => Promise<unknown>) => {
    const saved = structuredClone({ snapshot, task, jobs });
    const scope = { tx, open: true, pending: [] };
    try { return await txScope.run(scope, () => fn(tx)); }
    catch (error) { snapshot = saved.snapshot; task = saved.task; jobs = saved.jobs; throw error; }
    finally { scope.open = false; }
  });
});
async function createHuman() {
  return mocks.transaction(async (db: any) => createManagedCustomerCallbackTx(db, { actionId, fence: snapshot.fence,
    requestKind: "HUMAN", topic: "Прошу живого человека", phone: null }));
}
function writes() { return operations.filter(item => ["task_insert", "task_update", "owner_transition", "witness_write", "job_create"].includes(item)); }

describe("managed request creation / HOLD ordering", () => {
  it("creates QUEUED task plus required job; creator does not take ownership before intent commit", async () => {
    const result = await createHuman();
    expect(result.lifecycleRevision).toBe("1"); expect(task?.lifecycleStatus).toBe("QUEUED");
    expect(task?.handoverFence).toBeNull(); expect(snapshot.ownerMode).toBe("BOT");
    expect(mocks.transition).not.toHaveBeenCalled(); expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ data: { type: "customer-callback-notify", payload: { version: 1, actionId } } });
    expect(operations.indexOf("canonical_lock")).toBeLessThan(operations.indexOf("action_lock"));
  });
  it("refuses root client and stale fence before insertion/job", async () => {
    await expect(createManagedCustomerCallbackTx(tx, { actionId, fence: snapshot.fence, requestKind: "HUMAN", topic: "Человек", phone: null })).rejects.toThrow("Invalid managed customer request mutation");
    expect(writes()).toEqual([]);
    const stale = structuredClone(snapshot.fence); stale.bindingRevision = "0";
    await expect(mocks.transaction((db: any) => createManagedCustomerCallbackTx(db, { actionId, fence: stale, requestKind: "HUMAN", topic: "Человек", phone: null }))).rejects.toThrow("fence changed");
    expect(writes()).toEqual([]);
  });
  it("required job failure rolls back the just-inserted task", async () => {
    fail = "job"; await expect(createHuman()).rejects.toThrow("required job"); expect(task).toBeNull(); expect(jobs).toEqual([]);
  });
  it("finalize refuses uncommitted intent, then holds only the exact committed resource", async () => {
    const created = await createHuman(); intentCommitted = false;
    await expect(mocks.transaction((db: any) => finalizeManagedHandoverHoldTx(db, { requestId: created.resourceId, expectedFence: snapshot.fence }))).rejects.toThrow("not committed");
    expect(snapshot.ownerMode).toBe("BOT"); expect(task?.handoverFence).toBeNull();
    intentCommitted = true;
    const held = await mocks.transaction((db: any) => finalizeManagedHandoverHoldTx(db, { requestId: created.resourceId, expectedFence: snapshot.fence }));
    expect(held.ownerMode).toBe("HOLD"); expect(held.fence.ownerToken).not.toBeNull(); expect(task?.handoverFence).toMatchObject({ ownerMode: "HOLD", fence: held.fence });
    expect(held.fence.ownershipEpoch).toBe("2"); // A later IN is not a bootstrap epoch0 HOLD.
  });
});

describe("staff CAS, owner witness and rollback", () => {
  it("accepts HUMAN once; canonical lock precedes task lock; no arbitrary actor input", async () => {
    task = makeTask(); const result = await transitionManagedCustomerCallback(request(), { requestId: task.id, expectedRevision: "1", action: "accept", actorId: randomUUID() } as never);
    expect(result).toMatchObject({ status: "applied", task: { lifecycleStatus: "ACCEPTED", assignedAgentId: staffId, lifecycleRevision: "2" } });
    expect(snapshot.ownerMode).toBe("HUMAN"); expect(snapshot.ownerAgentId).toBe(staffId);
    expect(operations.indexOf("canonical_lock")).toBeLessThan(operations.indexOf("task_lock"));
    const again = await transitionManagedCustomerCallback(request(), { requestId: task.id, expectedRevision: "1", action: "accept" });
    expect(again.status).toBe("stale"); expect(mocks.transition).toHaveBeenCalledTimes(1);
  });
  it("accepts CALLBACK task without changing chat owner", async () => {
    task = makeTask("CALLBACK");
    expect((await transitionManagedCustomerCallback(request(), { requestId: task.id, expectedRevision: "1", action: "accept" })).status).toBe("applied");
    expect(snapshot.ownerMode).toBe("BOT"); expect(mocks.transition).not.toHaveBeenCalled();
  });
  it("queued close records staff closure without fake acceptance or resuming BOT", async () => {
    task = makeTask();
    expect(await transitionManagedCustomerCallback(request(), { requestId: task.id, expectedRevision: "1", action: "close" })).toMatchObject({
      status: "applied", task: { lifecycleStatus: "CLOSED", assignedAgentId: null, acceptedAt: null, closureReason: "staff_closed" } });
    expect(snapshot.ownerMode).toBe("HOLD"); expect(mocks.transition).not.toHaveBeenCalled();
  });
  it("returns only the accepted assignee to QUEUED/HOLD with one required notification job", async () => {
    task = makeTask();
    await transitionManagedCustomerCallback(request(), { requestId: task.id, expectedRevision: "1", action: "accept" });
    const foreign = await transitionManagedCustomerCallback(request(["messages.view"], randomUUID()), { requestId: task.id, expectedRevision: "2", action: "return" });
    expect(foreign.status).toBe("denied"); expect(snapshot.ownerMode).toBe("HUMAN");
    expect((await transitionManagedCustomerCallback(request(), { requestId: task.id, expectedRevision: "2", action: "return" })).status).toBe("applied");
    expect(task.lifecycleStatus).toBe("QUEUED"); expect(task.assignedAgentId).toBeNull(); expect(snapshot.ownerMode).toBe("HOLD");
    expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ data: { dedupeKey: `customer-callback-notify:${actionId}:r3` } });
  });
  it.each(["ownershipEpoch", "bindingRevision", "scopeRevision", "ownerToken"] as const)("rejects changed %s / ABA with no task or owner effect", async field => {
    task = makeTask(); snapshot.fence[field] = field === "ownerToken" ? randomUUID() : "3";
    expect((await transitionManagedCustomerCallback(request(), { requestId: task.id, expectedRevision: "1", action: "accept" })).status).toBe("stale");
    expect(writes()).toEqual([]);
  });
  it("ordinary semantic IN and global OFF do not grant BOT but keep persisted staff handling possible", async () => {
    task = makeTask(); snapshot.fence.stateRevision = "15"; snapshot.fence.intentRevision = "8"; snapshot.fence.policyRevision = "3"; snapshot.rolloutMode = "OFF";
    expect((await transitionManagedCustomerCallback(request(), { requestId: task.id, expectedRevision: "1", action: "close" })).status).toBe("applied");
    expect(snapshot.ownerMode).toBe("HOLD"); expect(mocks.transition).not.toHaveBeenCalled();
  });
  it.each(["scope", "owner", "intent"])("admin can terminal-close obsolete %s without adopting its witness or changing ownership", async field => {
    task = makeTask(); const savedWitness = structuredClone(task.handoverFence);
    if (field === "scope") snapshot.fence.scopeRevision = "3";
    if (field === "owner") snapshot.fence.ownerToken = randomUUID();
    if (field === "intent") task.currentIntent = false;
    const before = structuredClone(snapshot);
    const result = await transitionManagedCustomerCallback(request(["messages.view", "clients.assign"]), { requestId: task.id, expectedRevision: "1", action: "close" });
    expect(result).toMatchObject({ status: "applied", task: { lifecycleStatus: "CLOSED", closureReason: "obsolete_context", lifecycleRevision: "2" } });
    expect(snapshot).toEqual(before); expect(task.handoverFence).toEqual(savedWitness);
    expect(mocks.transition).not.toHaveBeenCalled(); expect(operations).not.toContain("witness_write");
  });
  it("obsolete cleanup requires both authenticated and freshly rechecked administrative rights", async () => {
    task = makeTask(); task.currentIntent = false;
    expect((await transitionManagedCustomerCallback(request(), { requestId: task.id, expectedRevision: "1", action: "close" })).status).toBe("denied");
    staff.permissions = { revoked: ["clients.assign"] };
    expect((await transitionManagedCustomerCallback(request(["messages.view", "clients.assign"]), { requestId: task.id, expectedRevision: "1", action: "close" })).status).toBe("denied");
    expect(writes()).toEqual([]);
  });
  it.each(["inactive", "read_only", "no_own_access", "permission_revoked"] as const)("denies current staff %s even with an authenticated route context", async mode => {
    task = makeTask();
    if (mode === "inactive") staff.isActive = false;
    if (mode === "read_only") staff.role = "SHAREHOLDER";
    if (mode === "no_own_access") { staff.role = "AGENT"; staff.permissions = { granted: ["messages.viewOwn"], revoked: ["messages.view"] }; ownAccess = false; }
    if (mode === "permission_revoked") staff.permissions = { revoked: ["messages.view", "messages.viewOwn"] };
    expect((await transitionManagedCustomerCallback(request(), { requestId: task.id, expectedRevision: "1", action: "accept" })).status).toBe("denied");
    expect(writes()).toEqual([]);
  });
  it("superseded/cancelled intent cannot be accepted from an old queue card", async () => {
    task = makeTask(); task.currentIntent = false;
    expect((await transitionManagedCustomerCallback(request(), { requestId: task.id, expectedRevision: "1", action: "accept" })).status).toBe("stale");
    expect(writes()).toEqual([]);
  });
  it.each(["cas", "witness", "job"] as const)("%s failure rolls owner and task back; never reports applied", async fault => {
    task = makeTask();
    if (fault === "job") await transitionManagedCustomerCallback(request(), { requestId: task.id, expectedRevision: "1", action: "accept" });
    const before = structuredClone({ task, snapshot }); fail = fault;
    const result = await transitionManagedCustomerCallback(request(), { requestId: task.id, expectedRevision: task.lifecycleRevision, action: fault === "job" ? "return" : "accept" });
    expect(result.status).toBe("unknown"); expect(task).toEqual(before.task); expect(snapshot).toEqual(before.snapshot); expect(jobs).toEqual([]);
  });
  it("malformed/zero revision is not permission to close a managed task", async () => {
    task = makeTask();
    expect((await transitionManagedCustomerCallback(request(), { requestId: task.id, expectedRevision: "0", action: "close" })).status).toBe("denied");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("witness comparison fails closed for another endpoint and malformed storage", () => {
    task = makeTask(); expect(managedCustomerCallbackWitnessMatches(task.handoverFence, snapshot)).toBe(true);
    snapshot.fence.endpoint.endpointScopeId = randomUUID(); expect(managedCustomerCallbackWitnessMatches(task.handoverFence, snapshot)).toBe(false);
    expect(managedCustomerCallbackWitnessMatches({ ...task.handoverFence as object, arbitraryGrant: true }, snapshot)).toBe(false);
  });
});
