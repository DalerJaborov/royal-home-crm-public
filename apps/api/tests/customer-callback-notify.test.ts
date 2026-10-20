import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { customerStateSchema, type CustomerStateSnapshot } from "@royal-home/shared";

const mocks = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn(), native: vi.fn(), settings: vi.fn(), agent: vi.fn(), own: vi.fn(),
  readState: vi.fn(), recipients: vi.fn(), push: vi.fn(), log: vi.fn() }));
vi.mock("../src/db.js", async original => {
  const actual = await original<typeof import("../src/db.js")>();
  return { ...actual, prisma: { $disconnect: actual.prisma.$disconnect.bind(actual.prisma),
  $queryRaw: mocks.query, $executeRaw: mocks.execute,
  botConversation: { findUnique: mocks.native, findFirst: mocks.own }, settings: { findUnique: mocks.settings }, agent: { findUnique: mocks.agent },
} };
});
vi.mock("../src/lib/customerState.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/customerState.js")>()), loadCustomerStateSnapshot: mocks.readState }));
vi.mock("../src/lib/recipients.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/recipients.js")>()), findAgentsWithPermission: mocks.recipients }));
vi.mock("../src/push.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/push.js")>()), sendPushToAgents: mocks.push }));
vi.mock("../src/lib/systemError.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: mocks.log }));
const { customerCallbackNotifyJob } = await import("../src/jobs/customerCallbackNotify.js");

let state: CustomerStateSnapshot;
let row: { resourceId: string; inquiryId: string; generation: bigint; supersededAt: Date | null; actionIntents: unknown;
  kind: "callback" | "handover"; phone: string | null; topic: string; doneAt: Date | null; conversationId: string | null;
  requestKind: string | null; lifecycleStatus: string | null; lifecycleRevision: string | null; handoverFence: unknown };
let actionId: string, assignedId: string, dutyId: string;
function sqlText(first: unknown) { return Array.isArray(first) ? first.join("?") : (first as { sql: string }).sql; }
beforeEach(() => {
  vi.clearAllMocks(); actionId = randomUUID(); assignedId = randomUUID(); dutyId = randomUUID();
  state = customerStateSchema.parse({ version: 1, fence: { inquiryId: randomUUID(), nativeId: randomUUID(), endpoint: {
    endpointScopeId: randomUUID(), channel: "INSTAGRAM", accountId: randomUUID(), peerId: "synthetic-notify", threadId: "",
  }, stateRevision: "3", intentRevision: "1", ownershipEpoch: "2", bindingRevision: "1", scopeRevision: "1", policyRevision: "1", ownerToken: randomUUID() },
    ownerMode: "HOLD", ownerAgentId: null, ownerLeaseUntil: null, closedAt: null, publicState: {}, privateAuthorization: "none",
    legacyMemoryQuarantined: true, contractVersion: "scoped", rolloutMode: "ACTIVE", capabilities: {} });
  row = { resourceId: randomUUID(), inquiryId: state.fence.inquiryId, generation: 1n, supersededAt: null,
    actionIntents: { handover: { generation: "1", status: "committed", evidenceRefs: ["synthetic-in"] } },
    kind: "handover", phone: null, topic: "Прошу живого человека", doneAt: null, conversationId: state.fence.nativeId,
    requestKind: "HUMAN", lifecycleStatus: "QUEUED", lifecycleRevision: "1",
    handoverFence: { version: 1, fence: structuredClone(state.fence), ownerMode: "HOLD", ownerAgentId: null } };
  mocks.query.mockImplementation(async (first: unknown) => {
    const sql = sqlText(first);
    if (sql.includes('FROM "CustomerAction" a JOIN "CustomerInquiry"')) {
      expect(sql).toContain('(a."kind"=\'callback\' AND a."receiptVersion"=1)');
      expect(sql).toContain('(a."kind"=\'handover\' AND a."receiptVersion"=2)');
      return [structuredClone(row)];
    }
    if (sql.startsWith('SELECT "lifecycleStatus"')) return [{ lifecycleStatus: row.lifecycleStatus, lifecycleRevision: row.lifecycleRevision, doneAt: row.doneAt }];
    throw new Error("Unexpected notification SQL");
  });
  mocks.execute.mockResolvedValue(1);
  mocks.native.mockImplementation(async () => ({ id: state.fence.nativeId, client: { assignedAgentId: assignedId, deletedAt: null } }));
  mocks.settings.mockImplementation(async () => ({ callbackOperatorAgentId: dutyId }));
  mocks.agent.mockResolvedValue({ isActive: true, role: "ADMIN", permissions: {} });
  mocks.own.mockResolvedValue({ id: state.fence.nativeId });
  mocks.readState.mockImplementation(async () => structuredClone(state));
  mocks.recipients.mockResolvedValue(["broadcast-only"]);
  mocks.push.mockResolvedValue(2); mocks.log.mockResolvedValue(undefined);
});

describe("managed callback notification is not human acceptance", () => {
  it("HUMAN routes only to the exact native assigned agent, without broad management broadcast", async () => {
    await customerCallbackNotifyJob.run({ version: 1, actionId });
    expect(mocks.native).toHaveBeenCalledWith(expect.objectContaining({ where: { id: state.fence.nativeId } }));
    expect(mocks.push).toHaveBeenCalledWith([assignedId], expect.objectContaining({ title: "🙋 Клиент просит живого человека" }));
    expect(mocks.recipients).not.toHaveBeenCalled();
    const final = mocks.execute.mock.calls.at(-1);
    expect(sqlText(final![0])).toContain("'agentAcknowledged',false");
    expect(sqlText(final![0])).toContain("'providerAcceptedDevices'");
    expect(mocks.execute.mock.calls.every(call => !sqlText(call[0]).includes('"lifecycleStatus"'))).toBe(true);
  });
  it("HUMAN without assigned client uses only configured duty with current message ACL", async () => {
    mocks.native.mockResolvedValue({ id: state.fence.nativeId, client: null });
    await customerCallbackNotifyJob.run({ version: 1, actionId });
    expect(mocks.push.mock.calls[0][0]).toEqual([dutyId]); expect(mocks.recipients).not.toHaveBeenCalled();
  });
  it("inactive assigned agent falls back to eligible duty; read-only users cannot become actionable recipients", async () => {
    mocks.agent.mockImplementation(async ({ where }: { where: { id: string } }) => ({ isActive: where.id !== assignedId, role: "ADMIN", permissions: {} }));
    await customerCallbackNotifyJob.run({ version: 1, actionId });
    expect(mocks.push.mock.calls[0][0]).toEqual([dutyId]); mocks.push.mockClear();
    mocks.agent.mockResolvedValue({ isActive: true, role: "SHAREHOLDER", permissions: { granted: ["messages.view"] } });
    await expect(customerCallbackNotifyJob.run({ version: 1, actionId })).rejects.toThrow("no eligible recipients");
    expect(mocks.push).not.toHaveBeenCalled();
  });
  it("own-only access is checked by actual exact native predicate, assignment does not grant access", async () => {
    mocks.agent.mockResolvedValue({ isActive: true, role: "AGENT", permissions: { granted: ["messages.viewOwn"], revoked: ["messages.view"] } });
    mocks.own.mockResolvedValue(null);
    await expect(customerCallbackNotifyJob.run({ version: 1, actionId })).rejects.toThrow("no eligible recipients");
    expect(mocks.own).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: state.fence.nativeId }) }));
    expect(mocks.push).not.toHaveBeenCalled(); expect(row.lifecycleStatus).toBe("QUEUED");
  });
  it("CALLBACK preserves existing P06 eligible broadcast and does not manufacture a recipient claim", async () => {
    row.kind = "callback"; row.requestKind = "CALLBACK"; row.phone = "+992900000111";
    state.ownerMode = "BOT";
    row.handoverFence = { version: 1, fence: structuredClone(state.fence), ownerMode: "BOT", ownerAgentId: null };
    row.actionIntents = { callback: { generation: "1", status: "committed", evidenceRefs: ["synthetic-in"] } };
    await customerCallbackNotifyJob.run({ version: 1, actionId });
    expect(mocks.recipients).toHaveBeenCalledWith("messages.view");
    expect(mocks.push.mock.calls[0][0]).toEqual(["broadcast-only"]);
    expect(mocks.native).not.toHaveBeenCalled(); expect(row.lifecycleStatus).toBe("QUEUED");
  });
  it("no recipient records unassigned routing observation, then retries without fake acceptance", async () => {
    mocks.native.mockResolvedValue({ id: state.fence.nativeId, client: null }); mocks.settings.mockResolvedValue({ callbackOperatorAgentId: null });
    await expect(customerCallbackNotifyJob.run({ version: 1, actionId })).rejects.toThrow("no eligible recipients");
    expect(mocks.push).not.toHaveBeenCalled(); expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(sqlText(mocks.execute.mock.calls[0][0])).toContain("'routingCheckedAt'");
    expect(sqlText(mocks.execute.mock.calls[0][0])).not.toContain("'providerAcceptedDevices'");
  });
  it("push throw preserves local task and retries no resource mutation", async () => {
    mocks.push.mockRejectedValue(new Error("Synthetic push unavailable"));
    await expect(customerCallbackNotifyJob.run({ version: 1, actionId })).rejects.toThrow("Synthetic push unavailable");
    expect(row.lifecycleStatus).toBe("QUEUED"); expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.execute.mock.calls.every(call => !sqlText(call[0]).includes('INSERT'))).toBe(true);
  });
  it.each(["ACCEPTED", "CLOSED"])("%s task is not notified as still waiting", async status => {
    row.lifecycleStatus = status;
    await customerCallbackNotifyJob.run({ version: 1, actionId }); expect(mocks.push).not.toHaveBeenCalled();
  });
  it("changed namespace/ownership witness is not silently rebound to fresh target", async () => {
    state.fence.bindingRevision = "2";
    await customerCallbackNotifyJob.run({ version: 1, actionId });
    expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
  });
  it("staff acceptance during recipient lookup invalidates the original queued attempt", async () => {
    mocks.settings.mockImplementation(async () => { row.lifecycleStatus = "ACCEPTED"; row.lifecycleRevision = "2"; return { callbackOperatorAgentId: dutyId }; });
    await customerCallbackNotifyJob.run({ version: 1, actionId }); expect(mocks.push).not.toHaveBeenCalled();
  });
  it("same queued status after accept→return still has a newer revision and stops the old attempt", async () => {
    mocks.settings.mockImplementation(async () => { row.lifecycleRevision = "3"; return { callbackOperatorAgentId: dutyId }; });
    await customerCallbackNotifyJob.run({ version: 1, actionId }); expect(mocks.push).not.toHaveBeenCalled();
  });
  it("onGiveUp logs only operational failure; it cannot close or recreate task", async () => {
    await customerCallbackNotifyJob.onGiveUp({ version: 1, actionId });
    expect(mocks.log).toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });
});
