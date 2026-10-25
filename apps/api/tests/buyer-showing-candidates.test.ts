import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ $disconnect: vi.fn(), $transaction: vi.fn(), $queryRaw: vi.fn(), interaction: { findUnique: vi.fn(), findFirst: vi.fn() },
  client: { findUnique: vi.fn() }, settings: { findUnique: vi.fn() }, agent: { findUnique: vi.fn() }, workflowCheckpoint: { findUnique: vi.fn() }, property: { findFirst: vi.fn() }, buyerShowingCandidate: { upsert: vi.fn(), findMany: vi.fn() }, botConversation: { findUnique: vi.fn() } }));
vi.mock("../src/db.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: db }));
import { rememberCallShowingCandidate, previewBuyerShowingCandidates, rememberConversationShowingRequest } from "../src/lib/buyerShowingCandidates.js";
const at = new Date("2026-10-25T09:00:00Z");
const source = { id: "call", clientId: "client", agentId: "agent", type: "CALL", callAttempt: "TALKED", recordingUrl: "private-recording", transcript: "Обсудили показ", investigationOnly: false, createdAt: at };
const client = { id: "client", assignedAgentId: "agent", assignedAt: new Date(at.getTime() - 1000), kind: "BUYER", deletedAt: null, assignmentCompletedAt: null };
beforeEach(() => {
  vi.clearAllMocks(); db.$transaction.mockImplementation(fn => fn(db)); db.interaction.findUnique.mockResolvedValue(source);
  db.$queryRaw.mockResolvedValue([]); db.settings.findUnique.mockResolvedValue(null); db.agent.findUnique.mockResolvedValue(null);
  db.client.findUnique.mockResolvedValue(client); db.property.findFirst.mockResolvedValue({ id: "property" });
  db.workflowCheckpoint.findUnique.mockResolvedValue({ createdAt: new Date(at.getTime() - 1000) });
  db.buyerShowingCandidate.upsert.mockImplementation(args => args.create);
});
describe("durable candidate evidence without tasks, surveys or scores", () => {
  it("binds call once to exact source and assignment, always PREVIEW with three-day review", async () => {
    const row = await rememberCallShowingCandidate("call", at, "property");
    expect(row).toMatchObject({ sourceKey: "CALL:call", sourceInteractionId: "call", assignmentAt: client.assignedAt, executionMode: "PREVIEW", reviewDueAt: new Date(at.getTime() + 3 * 86400_000) });
    expect(db.buyerShowingCandidate.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
  });
  it("rejects manual notes, missing provider recording and previous assignment", async () => {
    for (const invalid of [{ ...source, type: "OTHER" }, { ...source, callAttempt: null }, { ...source, recordingUrl: null }, { ...source, investigationOnly: true }]) {
      db.interaction.findUnique.mockResolvedValue(invalid); expect(await rememberCallShowingCandidate("call", at)).toBeNull();
    }
    db.interaction.findUnique.mockResolvedValue(source); db.client.findUnique.mockResolvedValue({ ...client, assignedAt: new Date(at.getTime() + 1) });
    expect(await rememberCallShowingCandidate("call", at)).toBeNull(); expect(db.buyerShowingCandidate.upsert).not.toHaveBeenCalled();
  });
  it("keeps an unknown time null only with an exact quote from the real transcript", async () => {
    expect(await rememberCallShowingCandidate("call", null, "property", "Несуществующая договорённость")).toBeNull();
    const row = await rememberCallShowingCandidate("call", null, "property", source.transcript);
    expect(row).toMatchObject({ proposedAt: null, sourceExcerpt: source.transcript, sourceOccurredAt: at });
  });
  it("never catches up historical calls or auto-enrolls with a missing activation checkpoint", async () => {
    for (const checkpoint of [null, { createdAt: new Date(at.getTime() + 1) }]) {
      db.workflowCheckpoint.findUnique.mockResolvedValue(checkpoint);
      expect(await rememberCallShowingCandidate("call", at, "property")).toBeNull();
    }
    expect(db.buyerShowingCandidate.upsert).not.toHaveBeenCalled();
  });
  it("never uses staff-written or timestamp-less chat as authenticated customer evidence", async () => {
    for (const message of [{ role: "user", content: "Показ завтра" }, { role: "user", at: at.toISOString(), by: { kind: "manual" } },
      { role: "user", at: at.toISOString(), by: { kind: "synthetic" } }, { role: "user", at: at.toISOString(), by: "staff" }]) {
      db.botConversation.findUnique.mockResolvedValue({ messages: [message] });
      expect(await rememberConversationShowingRequest("conversation", { day: "tomorrow", time: "15:00", propertyCode: 121 })).toBeNull();
    }
    expect(db.buyerShowingCandidate.upsert).not.toHaveBeenCalled();
  });
  it("past-due missing showing is a preview reminder, not auto escalation; stale owner is excluded", async () => {
    db.buyerShowingCandidate.findMany.mockResolvedValue([{ id: "candidate", ...client, clientId: "client", agentId: "agent", assignmentAt: client.assignedAt, sourceOccurredAt: at, proposedAt: at, propertyId: "property", reviewDueAt: at }]);
    db.interaction.findFirst.mockResolvedValue(null);
    expect((await previewBuyerShowingCandidates(at))[0]).toMatchObject({ evaluation: "MISSING_SHOWING", plannedAction: "AGENT_REMINDER_PREVIEW", followupEscalation: "NOT_CONFIGURED" });
    db.client.findUnique.mockResolvedValue({ ...client, assignedAgentId: "new-agent" });
    expect((await previewBuyerShowingCandidates(at))[0]).toMatchObject({ evaluation: "ASSIGNMENT_ENDED", plannedAction: null });
  });
  it("configured followup yields a private preview deadline without writes; same-date returned owner cannot reuse a candidate", async () => {
    db.settings.findUnique.mockResolvedValue({ companyDaysOff: [], sellerControlConfig: { agentDueWorkingDays: 1, ropReceiptDueWorkingDays: 1, ropActionDueWorkingDays: 1, buyerCandidateFollowupWorkingDays: 2 } });
    db.buyerShowingCandidate.findMany.mockResolvedValue([{ id: "candidate", clientId: "client", agentId: "agent", assignmentAt: client.assignedAt, sourceOccurredAt: at, proposedAt: at, propertyId: "property", reviewDueAt: at }]);
    db.interaction.findFirst.mockResolvedValue(null);
    expect((await previewBuyerShowingCandidates(new Date(at.getTime() + 10 * 86400_000)))[0]).toMatchObject({ followupEscalation: "PRIVATE_REVIEW_PREVIEW" });
    expect(db.buyerShowingCandidate.upsert).not.toHaveBeenCalled();
    db.$queryRaw.mockResolvedValueOnce([{ id: "old", toAgentId: "agent", createdAt: at }]).mockResolvedValueOnce([{ id: "new", toAgentId: "agent", createdAt: new Date(at.getTime() + 1) }]);
    expect((await previewBuyerShowingCandidates(new Date(at.getTime() + 10 * 86400_000)))[0]).toMatchObject({ evaluation: "ASSIGNMENT_ENDED", plannedAction: null });
  });
});
