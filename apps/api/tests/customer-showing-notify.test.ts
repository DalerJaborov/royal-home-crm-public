import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
const delivery = vi.hoisted(() => ({ sendPushToAgent: vi.fn(async () => 0) }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()), sendPushToAgent: delivery.sendPushToAgent,
}));
import { prisma } from "../src/db.js";
import { customerShowingNotifyJob } from "../src/jobs/customerShowingNotify.js";

/** Narrow postcommit worker controls. SQL snapshots are scripted here; actual
 * journal→resource joins/revisions still require the separate real PG gate. */
const actionId = randomUUID(); const agentId = randomUUID(); const clientId = randomUUID();
const active = () => ({ kind: "book_showing", generation: 1n, inquiryId: randomUUID(), resourceId: randomUUID(),
  resourceRevision: 1n, currentRevision: 1n, actionIntents: { book_showing: { generation: "1", status: "committed", evidenceRefs: ["event-1"] } },
  nextAction: "Показ объекта", at: new Date("2026-10-16T10:00:00Z"), declinedAt: null, completedAt: null,
  clientId, clientShortId: 123, clientAssignedAgentId: agentId, clientAcceptedAt: new Date(), effectiveAgentId: agentId });
function snapshots(rows: unknown[][]) {
  const read = vi.spyOn(prisma, "$queryRaw");
  for (const row of rows) read.mockResolvedValueOnce(row);
  const agent = vi.spyOn(prisma.agent, "findUnique").mockResolvedValue({ id: agentId, isActive: true, role: "AGENT", permissions: {} } as never);
  const record = vi.spyOn(prisma, "$executeRaw").mockResolvedValue(1);
  return { read, agent, record };
}
afterEach(() => { vi.restoreAllMocks(); delivery.sendPushToAgent.mockClear(); });

describe("customer showing notification does not execute or acknowledge the business action", () => {
  it("a stale or removed resource is suppressed rather than rebooked or notified", async () => {
    const spies = snapshots([[]]);
    await customerShowingNotifyJob.run({ version: 1, actionId });
    expect(delivery.sendPushToAgent).not.toHaveBeenCalled();
    expect(spies.agent).not.toHaveBeenCalled(); expect(spies.record).not.toHaveBeenCalled();
  });
  it("notifies the current effective agent with the existing stable tag and no private freeform text", async () => {
    const row = active(); const spies = snapshots([[row], [row]]);
    await customerShowingNotifyJob.run({ version: 1, actionId });
    expect(delivery.sendPushToAgent).toHaveBeenCalledExactlyOnceWith(agentId, {
      title: "✅ Бот назначил показ", body: "Показ 16.10 в 15:00. Проверьте договорённость в карточке клиента.",
      url: "/clients/123", tag: `showing-${row.resourceId}`,
    });
    expect(spies.record).toHaveBeenCalledOnce();
    const [sql] = spies.record.mock.calls[0];
    expect(String(sql)).not.toContain("Client");
    // Device count 0 is retained as telemetry, never promoted to acceptance.
    expect(spies.record.mock.calls[0].slice(1)).toContain(0);
  });
  it("a closed intent cannot produce an old booking notification", async () => {
    const row = active(); row.actionIntents.book_showing.status = "cancelled";
    const spies = snapshots([[row]]);
    await customerShowingNotifyJob.run({ version: 1, actionId });
    expect(delivery.sendPushToAgent).not.toHaveBeenCalled(); expect(spies.record).not.toHaveBeenCalled();
  });
  it("does not grant an old effective agent access to a reassigned client", async () => {
    const row = active(); row.clientAssignedAgentId = randomUUID(); const spies = snapshots([[row]]);
    await expect(customerShowingNotifyJob.run({ version: 1, actionId })).rejects.toThrow("cannot access the client");
    expect(delivery.sendPushToAgent).not.toHaveBeenCalled(); expect(spies.record).not.toHaveBeenCalled();
  });
  it("rereads resource state after recipient lookup and suppresses a superseded version", async () => {
    const row = active(); const spies = snapshots([[row], []]);
    await customerShowingNotifyJob.run({ version: 1, actionId });
    expect(spies.agent).toHaveBeenCalledOnce(); expect(spies.read).toHaveBeenCalledTimes(2);
    expect(delivery.sendPushToAgent).not.toHaveBeenCalled(); expect(spies.record).not.toHaveBeenCalled();
  });
});
