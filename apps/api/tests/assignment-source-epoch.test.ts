import { describe, expect, it, vi } from "vitest";
import { assignmentSourceEpochIsCurrent } from "../src/lib/investigationAssignmentEpoch.js";
import type { TxClient } from "../src/db.js";
const at = new Date("2026-10-25T10:00:00Z");
const input = { clientId: "client", subjectAgentId: "A", assignmentAt: at, sourceAt: at, now: new Date(at.getTime() + 3000) };
describe("retained future workflow sources and assignment ABA", () => {
  it("rejects returned A with reused assignedAt and rejects ambiguous transition ties", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValueOnce([{ id: "first-A", toAgentId: "A", createdAt: at }])
      .mockResolvedValueOnce([{ id: "returned-A", toAgentId: "A", createdAt: new Date(at.getTime() + 2000) }]) };
    expect(await assignmentSourceEpochIsCurrent(tx as unknown as TxClient, input)).toBe(false);
    tx.$queryRaw.mockResolvedValue([{ id: "A", toAgentId: "A", createdAt: at }, { id: "B", toAgentId: "B", createdAt: at }]);
    expect(await assignmentSourceEpochIsCurrent(tx as unknown as TxClient, input)).toBe(false);
  });
  it("requires known source time and allows the same unambiguous recorded epoch", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ id: "A", toAgentId: "A", createdAt: at }]) };
    expect(await assignmentSourceEpochIsCurrent(tx as unknown as TxClient, { ...input, sourceAt: null })).toBe(false);
    expect(await assignmentSourceEpochIsCurrent(tx as unknown as TxClient, input)).toBe(true);
  });
});
