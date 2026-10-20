import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  binding: "7", ownerEpoch: "3", account: "account-a", clientId: "client-a" as string | null,
  beforeTx: null as null | (() => void), duringTx: false, ops: [] as string[],
  query: vi.fn(), upsert: vi.fn(), createMany: vi.fn(), promote: vi.fn(),
  timeline: vi.fn(), push: vi.fn(), pushMany: vi.fn(), leadPush: vi.fn(),
  autopilot: vi.fn(), satellites: vi.fn(), change: vi.fn(), clientRead: vi.fn(), nativeRead: vi.fn(),
  property: { id: "property-a", shortId: 77, intakeAgentId: "owner-a", assignedAgentId: null, createdById: null },
}));

vi.mock("../src/db.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/db.js")>();
  const db = {
    $disconnect: () => original.prisma.$disconnect(),
    $queryRaw: fake.query,
    conversationProperty: { upsert: fake.upsert, createMany: fake.createMany, updateMany: fake.promote },
    client: { findUnique: fake.clientRead }, botConversation: { findUnique: fake.nativeRead },
    property: { findFirst: vi.fn(async () => fake.property) },
    agent: { findUnique: vi.fn(async () => ({ isActive: true, role: "AGENT" })) },
    interaction: { findFirst: vi.fn(async () => null) }, notification: { findFirst: vi.fn(async () => null) },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
      fake.beforeTx?.(); fake.beforeTx = null;
      fake.duringTx = true;
      try { const result = await run(db); fake.ops.push("commit"); return result; }
      finally { fake.duringTx = false; }
    }),
  };
  return { ...original, prisma: db };
});
vi.mock("../src/lib/customerConversationScope.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/customerConversationScope.js")>(),
  resolveCustomerEndpoint: vi.fn(async (input: { channel: string; subscriberId: string; transport?: unknown }, db?: unknown) => {
    if (db) fake.ops.push("scope-recheck");
    return { endpointScopeId: "scope-a", channel: input.channel, subscriberId: input.subscriberId,
      accountId: fake.account, transportKey: "messenger-account:account-a", scopeRevision: "2" };
  }),
  loadCustomerTransportForConversation: vi.fn(async () => ({ endpointScopeId: "scope-a", channel: "INSTAGRAM",
    accountId: fake.account, transportKey: "messenger-account:account-a", scopeRevision: "2" })),
}));
vi.mock("../src/lib/timeline.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/timeline.js")>(), logTimeline: fake.timeline }));
vi.mock("../src/push.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/push.js")>(), sendPushToAgent: fake.push, sendPushToAgents: fake.pushMany }));
vi.mock("../src/lib/pushLeadActions.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/pushLeadActions.js")>(), sendLeadPush: fake.leadPush }));
vi.mock("../src/lib/changeClientAgent.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/changeClientAgent.js")>(), changeClientAgent: fake.change }));
vi.mock("../src/lib/ownershipSatellites.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/ownershipSatellites.js")>(), closeOwnershipSatellites: fake.satellites }));
vi.mock("../src/lib/clientAutopilot.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/clientAutopilot.js")>(), runClientAutopilotInBackground: fake.autopilot }));
vi.mock("../src/lib/livePublish.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/livePublish.js")>(), publishConversationUpdated: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/systemError.js")>(), logSystemError: vi.fn(async () => {}) }));

import { prisma } from "../src/db.js";
import { linkConversationProperty, linkConversationPropertyByChannel } from "../src/lib/propertyVoice/linkConversation.js";
import { lockConversationInterestWitness, noticeInterestByConversation, noticeInterestInOtherAgentProperty, noticeOwnerOfConversationInterest, readConversationInterestWitness } from "../src/lib/propertyInterestNotice.js";
import type { TxClient } from "../src/db.js";

function witness() {
  return { conversationId: "native-a", inquiryId: "inquiry-a", endpointScopeId: "scope-a", channel: "INSTAGRAM", subscriberId: "peer-a",
    accountId: fake.account, clientId: fake.clientId, contactProfileId: null, bindingRevision: fake.binding,
    ownershipEpoch: fake.ownerEpoch, scopeRevision: "2", scopeKind: "NORMAL" };
}
function statement(input: { sql?: string; values?: unknown[] } | TemplateStringsArray, values: unknown[]) {
  const query = input as { sql?: string; values?: unknown[] };
  return Array.isArray(input) ? { text: input.join("?"), values } : { text: query.sql ?? "", values: query.values ?? [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No provider calls in local interest test"); }));
  fake.binding = "7"; fake.ownerEpoch = "3"; fake.account = "account-a"; fake.clientId = "client-a";
  fake.beforeTx = null; fake.duringTx = false; fake.ops.length = 0;
  fake.query.mockImplementation(async (input, ...values: unknown[]) => {
    const sql = statement(input, values);
    if (sql.text.includes('SELECT i."id"')) {
      fake.ops.push("fence");
      // This is a stub of PostgreSQL's conditional selection, NOT a PG proof.
      return sql.values.includes(BigInt(fake.binding)) && sql.values.includes(BigInt(fake.ownerEpoch)) &&
        sql.values.includes(fake.account) && sql.values.includes(fake.clientId) ? [{ id: "inquiry-a" }] : [];
    }
    if (sql.text.includes('AS "conversationId"')) return [witness()];
    if (sql.text.includes('FROM "BotConversation"') && sql.text.includes("FOR UPDATE")) {
      fake.ops.push("native-lock"); return [{ id: "native-a" }];
    }
    if (sql.text.includes('FROM "Client"')) { fake.ops.push("client-lock"); return [{ id: fake.clientId }]; }
    return [{ id: "native-a" }];
  });
  fake.upsert.mockImplementation(async () => { expect(fake.duringTx).toBe(true); fake.ops.push("upsert"); });
  fake.createMany.mockResolvedValue({ count: 0 }); fake.promote.mockResolvedValue({ count: 1 });
  fake.timeline.mockImplementation(async () => { expect(fake.duringTx).toBe(true); fake.ops.push("timeline"); return { id: "timeline-a" }; });
  for (const send of [fake.push, fake.pushMany, fake.leadPush, fake.satellites]) send.mockImplementation(async () => { expect(fake.duringTx).toBe(false); });
  fake.autopilot.mockImplementation(() => { expect(fake.duringTx).toBe(false); });
  fake.clientRead.mockResolvedValue({ id: "client-a", fullName: "PRIVATE-NAME-SENTINEL", assignedAgentId: "agent-a", deletedAt: null, acceptedAt: null, assignReason: "queue", lastAgentId: null });
  fake.nativeRead.mockImplementation(async () => ({ id: "native-a", channel: "INSTAGRAM", clientId: fake.clientId,
    propertyChatAgentId: null, propertyChatAgent: null, client: fake.clientId ? { id: fake.clientId, fullName: "PRIVATE-NAME-SENTINEL",
      assignedAgentId: "agent-a", deletedAt: null, acceptedAt: null, assignReason: "queue", lastAgentId: null, shortId: 88 } : null }));
  fake.change.mockImplementation(async (input) => {
    expect(fake.duringTx).toBe(true); expect(input.tx).toBeDefined(); expect(input.skipSatellites).toBe(true);
    fake.binding = "8"; fake.ownerEpoch = "4"; fake.ops.push("transfer"); return { ok: true };
  });
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); delete process.env.OBJECT_INTEREST_PULLS_QUEUE_LEAD; vi.unstubAllGlobals(); });

describe("local scoped interest: real helpers, fake DB and transport, no private identity grant", () => {
  it("ByChannel rebind after lookup rejects before link/promotion/client/timeline/push", async () => {
    fake.beforeTx = () => { fake.account = "account-b"; fake.clientId = "client-b"; fake.binding = "8"; };
    expect(await linkConversationPropertyByChannel({ channel: "INSTAGRAM", recipientId: "peer-a", accountId: "account-a", propertyId: "property-a", source: "SHARED_MEDIA" })).toBe(false);
    expect(fake.ops).toEqual(["native-lock", "fence", "commit"]);
    for (const effect of [fake.upsert, fake.promote, fake.clientRead, fake.timeline, fake.push, fake.pushMany, fake.change]) expect(effect).not.toHaveBeenCalled();
  });
  it("ABA restored account/client still rejects changed binding revision", async () => {
    const captured = await readConversationInterestWitness("native-a");
    fake.binding = "9";
    expect(await lockConversationInterestWitness(prisma as unknown as TxClient, captured!)).toBe(false);
  });
  it("current exposure writes in tx after native lock/fence, without owner effects", async () => {
    expect(await linkConversationPropertyByChannel({ channel: "INSTAGRAM", recipientId: "peer-a", accountId: "account-a", propertyId: "property-a", source: "EXPOSURE" })).toBe(true);
    expect(fake.ops).toEqual(["native-lock", "fence", "scope-recheck", "upsert", "commit"]);
    expect(fake.upsert.mock.calls[0][0].update.hits).toEqual({ increment: 1 });
    expect(fake.promote).not.toHaveBeenCalled(); expect(fake.push).not.toHaveBeenCalled(); expect(fake.pushMany).not.toHaveBeenCalled();
  });
  it("ensureOnly preserves counters and does not use incrementing upsert", async () => {
    expect(await linkConversationProperty({ conversationId: "native-a", propertyId: "property-a", source: "EXPOSURE", ensureOnly: true })).toBe(true);
    expect(fake.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    expect(fake.upsert).not.toHaveBeenCalled();
  });
  it("unique conflict retries in a new locked transaction, not the aborted tx", async () => {
    fake.upsert.mockRejectedValueOnce({ code: "P2002" });
    expect(await linkConversationProperty({ conversationId: "native-a", propertyId: "property-a", source: "EXPOSURE" })).toBe(true);
    expect(fake.upsert).toHaveBeenCalledTimes(2);
    expect(fake.ops.filter(op => op === "native-lock")).toHaveLength(2);
    expect(fake.ops.filter(op => op === "commit")).toHaveLength(1);
  });
  it("stale notice witness does not read a replacement Client or write timeline", async () => {
    const captured = await readConversationInterestWitness("native-a");
    fake.binding = "8"; fake.clientId = "client-b";
    await noticeInterestInOtherAgentProperty({ clientId: "client-a", propertyId: "property-a", witness: captured! });
    expect(fake.clientRead).not.toHaveBeenCalled(); expect(fake.timeline).not.toHaveBeenCalled(); expect(fake.push).not.toHaveBeenCalled();
    expect(fake.ops.slice(0, 3)).toEqual(["client-lock", "native-lock", "fence"]);
  });
  it("public comment author never causes private DM/Client lookup", async () => {
    await noticeInterestByConversation({ channel: "INSTAGRAM", recipientId: "peer-a", accountId: "account-a", propertyId: "property-a" });
    for (const effect of [fake.query, fake.clientRead, fake.nativeRead, fake.timeline, fake.push, fake.change]) expect(effect).not.toHaveBeenCalled();
  });
  it("authorized by-ID staff notice retains timeline, generic push has no private name", async () => {
    await noticeInterestInOtherAgentProperty({ clientId: "client-a", propertyId: "property-a" });
    expect(fake.timeline).toHaveBeenCalledWith(expect.objectContaining({ clientId: "client-a", tx: expect.anything() }));
    expect(fake.push).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fake.push.mock.calls)).not.toContain("PRIVATE-NAME-SENTINEL");
  });
  it("queue transfer preserves guarded CRM service, dispatches satellites only after commit", async () => {
    process.env.OBJECT_INTEREST_PULLS_QUEUE_LEAD = "1";
    await noticeOwnerOfConversationInterest({ conversationId: "native-a", propertyId: "property-a" });
    expect(fake.change).toHaveBeenCalledTimes(1);
    expect(fake.change.mock.calls[0][0].guardWhere).toEqual({ assignedAgentId: "agent-a", acceptedAt: null, assignReason: "queue" });
    expect(fake.autopilot).toHaveBeenCalledTimes(1); expect(fake.satellites).toHaveBeenCalledTimes(1); expect(fake.leadPush).toHaveBeenCalledTimes(1);
    expect(fake.ops.indexOf("transfer")).toBeLessThan(fake.ops.lastIndexOf("commit"));
    const clientLock = fake.ops.indexOf("client-lock");
    expect(fake.ops.slice(clientLock, clientLock + 3)).toEqual(["client-lock", "native-lock", "fence"]);
    expect(JSON.stringify(fake.leadPush.mock.calls)).not.toContain("PRIVATE-NAME-SENTINEL");
  });
  it("accepted client after initial lookup cannot enter transfer/escalation service under the lock", async () => {
    process.env.OBJECT_INTEREST_PULLS_QUEUE_LEAD = "1";
    fake.clientRead.mockResolvedValue({ id: "client-a", assignedAgentId: "agent-a", acceptedAt: new Date("2031-01-01T00:00:00Z"), assignReason: "queue", deletedAt: null });
    await noticeOwnerOfConversationInterest({ conversationId: "native-a", propertyId: "property-a" });
    expect(fake.change).not.toHaveBeenCalled(); expect(fake.autopilot).not.toHaveBeenCalled();
    expect(fake.satellites).not.toHaveBeenCalled(); expect(fake.leadPush).not.toHaveBeenCalled();
    // Existing notify-only policy remains, without private names/contacts.
    expect(fake.push).toHaveBeenCalledTimes(1);
  });
});
