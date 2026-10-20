import { randomInt, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/push.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/push.js")>(),
  sendPushToAgent: vi.fn(async () => {}), sendPushToAgents: vi.fn(async () => {}),
}));
vi.mock("../src/lib/livePublish.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/livePublish.js")>(), publishConversationUpdated: vi.fn(async () => {}),
}));

import { prisma } from "../src/db.js";
import { sendPushToAgent, sendPushToAgents } from "../src/push.js";
import { ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";
import * as notice from "../src/lib/propertyInterestNotice.js";
import { linkConversationPropertyByChannel } from "../src/lib/propertyVoice/linkConversation.js";
import { waitFor } from "./helpers/waitFor.js";

/** Actual DB/trigger/conditional SQL tests, synthetic resources only. These are
 * prepared for the owned foundation stand; never run against primary/prod. */
const run = randomUUID();
const nativeIds: string[] = [], inquiryIds: string[] = [], clientIds: string[] = [], scopeIds: string[] = [];
let accountA: string, accountB: string, ownerId: string, otherAgentId: string, propertyId: string;
const phone = () => `+9929${randomInt(10_000_000, 99_999_999)}`;

beforeAll(async () => {
  const mkAccount = (label: string) => prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId: `interest-${run}-${label}`,
    title: `Scoped interest fixture ${label}`, token: "synthetic-not-used", enabled: true } });
  accountA = (await mkAccount("a")).id; accountB = (await mkAccount("b")).id;
  ownerId = (await prisma.agent.create({ data: { fullName: `Interest owner ${run}`, phone: phone(), passwordHash: "fixture", role: "AGENT" } })).id;
  otherAgentId = (await prisma.agent.create({ data: { fullName: `Interest other agent ${run}`, phone: phone(), passwordHash: "fixture", role: "AGENT" } })).id;
  propertyId = (await prisma.property.create({ data: { title: `Interest property ${run}`, type: "APARTMENT", address: "Synthetic public district",
    areaSqm: 60, price: 200_000, currency: "TJS", condition: "GOOD", status: "AVAILABLE", intakeAgentId: ownerId } })).id;
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
afterAll(async () => {
  await prisma.conversationProperty.deleteMany({ where: { conversationId: { in: nativeIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: nativeIds } } });
  await prisma.customerInquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await prisma.customerEndpointScope.deleteMany({ where: { id: { in: scopeIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyId].filter(Boolean) } } });
  await prisma.agent.deleteMany({ where: { id: { in: [ownerId, otherAgentId].filter(Boolean) } } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: [accountA, accountB].filter(Boolean) } } });
});

async function thread() {
  const peer = `interest-${run}-${randomUUID()}`;
  const make = (accountId: string, subscriberId: string) => prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel: "INSTAGRAM", accountId, subscriberId }));
  const a = await make(accountA, peer), b = await make(accountB, `${peer}-other`);
  nativeIds.push(a.id, b.id); scopeIds.push(a.transport.endpointScopeId, b.transport.endpointScopeId);
  const inquiries = await prisma.customerInquiry.findMany({ where: { conversationId: { in: [a.id, b.id] } }, select: { id: true } });
  inquiryIds.push(...inquiries.map(x => x.id)); expect(inquiries).toHaveLength(2);
  return { a, b, peer };
}
function deferred() {
  let release!: () => void, resolved = false;
  return { promise: new Promise<void>(resolve => { release = resolve; }),
    resolved: () => resolved, release: () => { resolved = true; release(); } };
}

describe("PostgreSQL scoped interest relation fence", () => {
  it("actual lookup A → committed rebind B → resume A writes no link/promotion/notice", async () => {
    const { a, b, peer } = await thread();
    const captured = deferred(), resume = deferred();
    const read = notice.readScopedConversationInterestWitness;
    vi.spyOn(notice, "readScopedConversationInterestWitness").mockImplementationOnce(async input => {
      const witness = await read(input); expect(witness?.conversationId).toBe(a.id); captured.release(); await resume.promise; return witness;
    });
    const pending = linkConversationPropertyByChannel({ channel: "INSTAGRAM", recipientId: peer, transport: a.transport, propertyId, source: "SHARED_MEDIA" });
    try {
      await waitFor(() => captured.resolved());
      await prisma.botConversation.update({ where: { id: a.id }, data: { accountId: accountB, endpointScopeId: b.transport.endpointScopeId } });
    } finally { resume.release(); }
    expect(await pending).toBe(false);
    expect(await prisma.conversationProperty.count({ where: { conversationId: a.id, propertyId } })).toBe(0);
    expect(sendPushToAgent).not.toHaveBeenCalled(); expect(sendPushToAgents).not.toHaveBeenCalled();
  });
  it("actual A→B→A trigger increments reject stale witness despite restored native tuple", async () => {
    const { a, b } = await thread();
    const captured = await notice.readConversationInterestWitness(a.id); expect(captured).not.toBeNull();
    await prisma.botConversation.update({ where: { id: a.id }, data: { accountId: accountB, endpointScopeId: b.transport.endpointScopeId } });
    await prisma.botConversation.update({ where: { id: a.id }, data: { accountId: accountA, endpointScopeId: a.transport.endpointScopeId } });
    const current = await notice.readConversationInterestWitness(a.id);
    expect(current?.bindingRevision).not.toBe(captured?.bindingRevision);
    expect(await prisma.$transaction(tx => notice.lockConversationInterestWitness(tx, captured!))).toBe(false);
  });
  it("old Client A witness cannot create timeline/notification after native links Client B", async () => {
    const { a } = await thread();
    const makeClient = () => prisma.client.create({ data: { fullName: `PRIVATE-SYNTHETIC-${randomUUID()}`, phone: phone(), source: "INSTAGRAM", assignedAgentId: otherAgentId } });
    const first = await makeClient(), second = await makeClient(); clientIds.push(first.id, second.id);
    await prisma.botConversation.update({ where: { id: a.id }, data: { clientId: first.id } });
    const captured = await notice.readConversationInterestWitness(a.id); expect(captured?.clientId).toBe(first.id);
    await prisma.botConversation.update({ where: { id: a.id }, data: { clientId: second.id } });
    await notice.noticeInterestInOtherAgentProperty({ clientId: first.id, propertyId, witness: captured! });
    expect(await prisma.interaction.count({ where: { clientId: { in: [first.id, second.id] } } })).toBe(0);
    expect(sendPushToAgent).not.toHaveBeenCalled(); expect(sendPushToAgents).not.toHaveBeenCalled();
  });
  it("current scoped exposure succeeds and repeated link increments exactly once each", async () => {
    const { a, peer } = await thread();
    const input = { channel: "INSTAGRAM", recipientId: peer, transport: a.transport, propertyId, source: "EXPOSURE" as const };
    expect(await linkConversationPropertyByChannel(input)).toBe(true);
    expect(await linkConversationPropertyByChannel(input)).toBe(true);
    const rows = await prisma.conversationProperty.findMany({ where: { conversationId: a.id, propertyId } });
    expect(rows).toHaveLength(1); expect(rows[0].hits).toBe(2); expect(rows[0].source).toBe("EXPOSURE");
    expect(sendPushToAgent).not.toHaveBeenCalled(); expect(sendPushToAgents).not.toHaveBeenCalled();
  });
  it("Client-held legacy update can finish: waiting notice does not pre-lock Inquiry", async () => {
    const { a } = await thread();
    const client = await prisma.client.create({ data: { fullName: `PRIVATE-SYNTHETIC-${randomUUID()}`, phone: phone(), source: "INSTAGRAM", assignedAgentId: otherAgentId } });
    clientIds.push(client.id);
    await prisma.botConversation.update({ where: { id: a.id }, data: { clientId: client.id } });
    const captured = await notice.readConversationInterestWitness(a.id); expect(captured?.clientId).toBe(client.id);
    const held = deferred(), finishLegacy = deferred();
    const original = prisma.$transaction.bind(prisma);
    const legacy = original(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Client" WHERE "id"=${client.id} FOR UPDATE`;
      held.release(); await finishLegacy.promise;
      // Real legacy Client UPDATE → AFTER Inquiry epoch trigger.
      await tx.client.update({ where: { id: client.id }, data: { deletedAt: new Date() } });
    }, { timeout: 10_000 });
    const appName = `interest-lock-${randomUUID()}`;
    let pending: Promise<void> | undefined;
    try {
      await waitFor(() => held.resolved());
      const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce(async (...args: Parameters<typeof original>) => {
        const run = args[0]; if (typeof run !== "function") throw new Error("Expected a callback transaction");
        return original(async tx => {
          await tx.$queryRaw`SELECT set_config('application_name', ${appName}, true)`;
          return run(tx);
        }, args[1]);
      });
      pending = notice.noticeInterestInOtherAgentProperty({ clientId: client.id, propertyId, witness: captured! });
      await waitFor(async () => {
        const rows = await prisma.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND application_name=${appName} AND wait_event_type='Lock') AS "waiting"`;
        return rows[0]?.waiting;
      });
      spy.mockRestore();
      // The old order already held Inquiry while waiting for Client: NOWAIT
      // would fail. The correct order leaves Inquiry free for legacy trigger.
      expect(await original(async tx => {
        const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "CustomerInquiry" WHERE "id"=${captured!.inquiryId} FOR UPDATE NOWAIT`;
        return rows.length;
      })).toBe(1);
    } finally {
      finishLegacy.release(); await legacy; if (pending) await pending;
    }
    expect(await prisma.interaction.count({ where: { clientId: client.id } })).toBe(0);
    expect(sendPushToAgent).not.toHaveBeenCalled(); expect(sendPushToAgents).not.toHaveBeenCalled();
  });
});
