import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ $disconnect: vi.fn(), $transaction: vi.fn(), $queryRaw: vi.fn(), workflowCheckpoint: { findUnique: vi.fn() },
  client: { findUnique: vi.fn() }, clientWorkflowObservation: { upsert: vi.fn() }, botConversation: { findUnique: vi.fn() }, interaction: { findUnique: vi.fn() } }));
const epoch = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/investigationAssignmentEpoch.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/investigationAssignmentEpoch.js")>(), assignmentSourceEpochIsCurrent: epoch }));
const detect = vi.hoisted(() => vi.fn());
vi.mock("../src/db.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: db }));
vi.mock("../src/lib/requestedAgent.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/requestedAgent.js")>(), detectRequestedAgent: detect }));
import { recordClientWorkflowObservation, recordConversationNamedRequest, recordIncomingNamedDeclaration, recordNamedAssignmentDeclaration } from "../src/lib/clientWorkflowObservations.js";
import type { TxClient } from "../src/db.js";
const tx = db as unknown as TxClient;
const at = new Date("2026-10-25T10:00:00Z");
beforeEach(() => {
  vi.clearAllMocks(); epoch.mockResolvedValue(true); db.$queryRaw.mockResolvedValue([]); db.$transaction.mockImplementation(fn => fn(tx));
  db.workflowCheckpoint.findUnique.mockResolvedValue({ createdAt: new Date(at.getTime() - 1000) });
  db.client.findUnique.mockResolvedValue({ createdAt: at, assignedAt: at, assignedAgentId: "actual-owner", deletedAt: null, assignmentCompletedAt: null });
  db.clientWorkflowObservation.upsert.mockImplementation(args => args.create);
  detect.mockResolvedValue({ status: "matched", agentId: "requested-agent", namedAs: "Умед" });
});
describe("private workflow facts are observations, never verdicts or ownership writes", () => {
  it("a declared name never becomes verified customer evidence or changes actual owner", async () => {
    const row = await recordNamedAssignmentDeclaration(tx, "client", "claimed-owner");
    expect(row).toMatchObject({ subjectAgentId: "actual-owner", executionMode: "PREVIEW", payload: { verification: "UNVERIFIED", requestedAgentId: "claimed-owner" } });
    expect(db.clientWorkflowObservation.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
  });
  it("requires real inbound source identity and rejects staff/synthetic timestamped user entries", async () => {
    const genuine = { role: "user", content: "Мне нужен Умед", mid: "provider-mid", at: at.toISOString() };
    for (const entry of [{ ...genuine, mid: undefined }, { ...genuine, by: { kind: "manual" } }, { ...genuine, by: "synthetic" }, { ...genuine, silentCapture: true }]) {
      db.botConversation.findUnique.mockResolvedValue({ clientId: "client", client: { assignedAt: at }, messages: [entry] });
      expect(await recordConversationNamedRequest("conversation")).toBeNull();
    }
    expect(db.clientWorkflowObservation.upsert).not.toHaveBeenCalled();
    db.botConversation.findUnique.mockResolvedValue({ clientId: "client", client: { assignedAt: at }, messages: [genuine] });
    expect(await recordConversationNamedRequest("conversation")).toMatchObject({ sourceId: "conversation:provider-mid", subjectAgentId: "actual-owner",
      payload: { verification: "AUTHENTICATED_CUSTOMER_TEXT", requestedAgentId: "requested-agent", quote: genuine.content } });
  });
  it("guards owner race and activation cutoff without reattaching old evidence", async () => {
    const input = { clientId: "client", kind: "NAMED_CLIENT_REQUEST", sourceType: "CONVERSATION", sourceId: "mid", occurredAt: at,
      expectedAssignmentAt: new Date(at.getTime() - 1), payload: {} };
    expect(await recordClientWorkflowObservation(tx, input)).toBeNull();
    db.workflowCheckpoint.findUnique.mockResolvedValue(null);
    expect(await recordClientWorkflowObservation(tx, { ...input, expectedAssignmentAt: at })).toBeNull();
    expect(db.clientWorkflowObservation.upsert).not.toHaveBeenCalled();
  });
  it("operator input remains a staff declaration even when it names a real employee", async () => {
    expect(await recordIncomingNamedDeclaration(tx, { clientId: "client", callId: "call", interactionId: "interaction", requestedAgentId: "real-agent", operatorId: "operator" }))
      .toMatchObject({ sourceType: "STAFF_DECLARATION", payload: { verification: "UNVERIFIED" } });
    expect(db.interaction.findUnique).not.toHaveBeenCalled(); expect(detect).not.toHaveBeenCalled();
  });
});

describe("named source belongs to the actual assignment and turn", () => {
  const genuine = { role: "user", content: "Мне нужен Умед", mid: "named-mid", at: at.toISOString() };
  it("does not search an older matching message when the current turn does not name an employee", async () => {
    db.botConversation.findUnique.mockResolvedValue({ clientId: "client", client: { assignedAt: at }, messages: [genuine, { ...genuine, content: "Спасибо", mid: "new-mid" }] });
    detect.mockResolvedValue({ status: "none" });
    expect(await recordConversationNamedRequest("conversation", { messageId: "new-mid" })).toBeNull();
    expect(detect).toHaveBeenCalledTimes(1); expect(detect).toHaveBeenCalledWith("Спасибо");
    expect(db.clientWorkflowObservation.upsert).not.toHaveBeenCalled();
  });
  it("rejects old source after ABA despite reused assignedAt", async () => {
    epoch.mockResolvedValue(false);
    db.botConversation.findUnique.mockResolvedValue({ clientId: "client", client: { assignedAt: at }, messages: [genuine] });
    expect(await recordConversationNamedRequest("conversation", { messageId: "named-mid" })).toBeNull();
    expect(db.clientWorkflowObservation.upsert).not.toHaveBeenCalled();
  });
  it("permits an authentic new lead source just before first assignment, not a previous owner's source", async () => {
    const assigned = new Date(at.getTime() + 1000);
    db.client.findUnique.mockResolvedValue({ createdAt: assigned, assignedAt: assigned, assignedAgentId: "actual-owner", deletedAt: null, assignmentCompletedAt: null });
    db.botConversation.findUnique.mockResolvedValue({ clientId: "client", client: { assignedAt: assigned }, messages: [genuine] });
    db.$queryRaw.mockImplementation(async (query: TemplateStringsArray) => query.join("").includes('FROM "AuditLog"') ? [{ fromAgentId: null, toAgentId: "actual-owner", createdAt: assigned }] : []);
    expect(await recordConversationNamedRequest("conversation", { initialLead: true })).toMatchObject({ sourceId: "conversation:named-mid", payload: { verification: "AUTHENTICATED_CUSTOMER_TEXT" } });
    db.clientWorkflowObservation.upsert.mockClear();
    db.$queryRaw.mockImplementation(async (query: TemplateStringsArray) => query.join("").includes('FROM "AuditLog"') ? [{ fromAgentId: "other-owner", toAgentId: "actual-owner", createdAt: assigned }] : []);
    expect(await recordConversationNamedRequest("conversation", { initialLead: true })).toBeNull();
    expect(db.clientWorkflowObservation.upsert).not.toHaveBeenCalled();
  });
});
