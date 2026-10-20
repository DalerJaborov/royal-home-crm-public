import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../src/generated/prisma/client.js";

const mocks = vi.hoisted(() => ({ list: vi.fn(), first: vi.fn(), update: vi.fn(), agent: vi.fn(), query: vi.fn(), clients: vi.fn() }));
vi.mock("../src/db.js", async original => {
  const actual = await original<typeof import("../src/db.js")>();
  return { ...actual, prisma: { $disconnect: actual.prisma.$disconnect.bind(actual.prisma),
  callbackRequest: { findMany: mocks.list, findFirst: mocks.first, updateMany: mocks.update },
  agent: { findUnique: mocks.agent }, client: { findMany: mocks.clients }, $queryRaw: mocks.query,
} };
});
const { loadPendingCallbackRequests, markCallbackDone, closeSettledCallbackRequests, tryConnectPendingCallback } = await import("../src/lib/callbackRequests.js");
const { cancelClientCallbackRequests } = await import("../src/lib/callbackRequestsCancel.js");

let staffId: string;
function recordedSql(call: unknown[]) {
  return Array.isArray(call[0]) ? Prisma.sql(call[0] as unknown as TemplateStringsArray, ...call.slice(1))
    : call[0] as { sql: string; values: unknown[] };
}
beforeEach(() => {
  vi.clearAllMocks(); staffId = randomUUID();
  mocks.list.mockResolvedValue([]); mocks.first.mockResolvedValue(null); mocks.update.mockResolvedValue({ count: 0 });
  mocks.agent.mockResolvedValue({ isActive: true, role: "ADMIN", permissions: {} }); mocks.query.mockResolvedValue([]); mocks.clients.mockResolvedValue([]);
});

describe("legacy callback facades cannot close/mutate managed tasks", () => {
  it("old done facade cannot bypass the managed revision contract", async () => {
    expect(await markCallbackDone(randomUUID(), staffId)).toBe(false);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ doneAt: null, customerActionId: null }) }));
  });
  it("legacy auto-close never consumes managed requests through phone→Client/CALL lookup", async () => {
    await closeSettledCallbackRequests();
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ where: { doneAt: null, customerActionId: null } }));
    expect(mocks.clients).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
  });
  it("late legacy phone/client enrichment ignores managed request and never auto-connects it", async () => {
    await tryConnectPendingCallback(randomUUID(), randomUUID());
    expect(mocks.first).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ doneAt: null, customerActionId: null }) }));
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("client bulk cleanup closes only legacy rows, retaining managed lifecycle evidence", async () => {
    const clientId = randomUUID(); let managedClosed = false, legacyClosed = false;
    mocks.update.mockImplementation(async ({ where }: { where: { clientId: string; customerActionId?: string | null } }) => {
      expect(where.clientId).toBe(clientId);
      legacyClosed = where.customerActionId === null;
      managedClosed = where.customerActionId !== null;
      return { count: legacyClosed ? 1 : 2 };
    });
    expect(await cancelClientCallbackRequests(clientId)).toBe(1);
    expect(legacyClosed).toBe(true); expect(managedClosed).toBe(false);
  });
});

describe("staff queue current ACL before LIMIT / rollback visibility", () => {
  it("no server staff context cannot reveal a managed queue via includeLegacy=false", async () => {
    expect(await loadPendingCallbackRequests(true, 20, { includeLegacy: false })).toEqual([]);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("callback OFF still lists previously recorded managed HUMAN/callback tasks for permitted staff", async () => {
    await loadPendingCallbackRequests(true, 20, { includeLegacy: false, staffAgentId: staffId });
    expect(mocks.list).toHaveBeenCalledWith({ where: { doneAt: null, customerActionId: { not: null } }, orderBy: { requestedAt: "asc" }, take: 20 });
  });
  it("own-only permission uses exact saved scope/native/peer/binding predicate BEFORE LIMIT", async () => {
    mocks.agent.mockResolvedValue({ isActive: true, role: "AGENT", permissions: { granted: ["messages.viewOwn"], revoked: ["messages.view"] } });
    await loadPendingCallbackRequests(false, 7, { includeLegacy: true, staffAgentId: staffId });
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.query).toHaveBeenCalledTimes(1);
    const sql = recordedSql(mocks.query.mock.calls[0]);
    expect(sql.sql).toContain('c."endpointScopeId"=i."endpointScopeId"');
    expect(sql.sql).toContain('IS NOT DISTINCT FROM');
    expect(sql.sql).toContain("'bindingRevision'=i.");
    expect(sql.sql).toContain("'scopeRevision'=s.");
    expect(sql.sql).toContain('link.source <> \'EXPOSURE\'');
    expect(sql.sql.indexOf('cl."assignedAgentId"')).toBeLessThan(sql.sql.indexOf("LIMIT"));
    expect(sql.values).toContain(staffId); expect(sql.values.at(-1)).toBe(7);
  });
  it("selected conversation is filtered before LIMIT for broad, own and internal legacy lists", async () => {
    const conversationId = randomUUID();
    await loadPendingCallbackRequests(false, 2, { staffAgentId: staffId, conversationId });
    expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ conversationId }), take: 2 }));
    mocks.agent.mockResolvedValue({ isActive: true, role: "AGENT", permissions: { granted: ["messages.viewOwn"], revoked: ["messages.view"] } });
    await loadPendingCallbackRequests(false, 2, { staffAgentId: staffId, conversationId });
    const sql = recordedSql(mocks.query.mock.calls.at(-1)!);
    expect(sql.sql.indexOf('r."conversationId"=')).toBeLessThan(sql.sql.indexOf("LIMIT"));
    expect(sql.values).toContain(conversationId);
    await loadPendingCallbackRequests(false, 2, { conversationId });
    expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ where: { doneAt: null, customerActionId: null, conversationId }, take: 2 }));
  });
  it.each(["inactive", "read_only", "revoked"])("%s current staff cannot use cached route permission to list tasks", async mode => {
    mocks.agent.mockResolvedValue({ isActive: mode !== "inactive", role: mode === "read_only" ? "SHAREHOLDER" : "ADMIN",
      permissions: mode === "revoked" ? { revoked: ["messages.view", "messages.viewOwn"] } : {} });
    expect(await loadPendingCallbackRequests(true, 20, { staffAgentId: staffId })).toEqual([]);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("revoked phone permission masks actual task phone even if route passed a stale true", async () => {
    mocks.agent.mockResolvedValue({ isActive: true, role: "ADMIN", permissions: { revoked: ["clients.viewPhone"] } });
    mocks.list.mockResolvedValue([{ id: randomUUID(), customerActionId: randomUUID(), requestKind: "HUMAN", lifecycleStatus: "QUEUED",
      lifecycleRevision: 1n, assignedAgentId: null, acceptedAt: null, closureReason: null, topic: "Нужен человек",
      channel: "INSTAGRAM", phone: "+992900000111", requestedAt: new Date(), conversationId: randomUUID(), clientId: null }]);
    const rows = await loadPendingCallbackRequests(true, 20, { staffAgentId: staffId });
    expect(rows).toHaveLength(1); expect(rows[0].phone).not.toBe("+992900000111"); expect(rows[0].lifecycleRevision).toBe("1");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each([true, false])("topic uses current contact visibility (%s), including raw input handles/links/phone", async allowed => {
    const topic = "Нужен оператор +992910044995 @synthetic_contact t.me/synthetic_contact wa.me/992910044995";
    mocks.agent.mockResolvedValue({ isActive: true, role: "ADMIN", permissions: allowed ? {} : { revoked: ["clients.viewPhone"] } });
    mocks.list.mockResolvedValue([{ id: randomUUID(), customerActionId: randomUUID(), requestKind: "HUMAN", lifecycleStatus: "QUEUED",
      lifecycleRevision: 1n, assignedAgentId: null, acceptedAt: null, closureReason: null, topic,
      channel: "INSTAGRAM", phone: null, requestedAt: new Date(), conversationId: randomUUID(), clientId: null }]);
    const rows = await loadPendingCallbackRequests(true, 20, { staffAgentId: staffId });
    expect(rows).toHaveLength(1);
    if (allowed) expect(rows[0].topic).toBe(topic);
    else {
      expect(rows[0].topic).not.toContain("992910044995"); expect(rows[0].topic).not.toContain("synthetic_contact");
      expect(rows[0].topic).toContain("Нужен оператор"); expect(rows[0].topic).toContain("•");
    }
    await expect(mocks.list.mock.results[0].value).resolves.toEqual([expect.objectContaining({ topic })]);
  });
});
