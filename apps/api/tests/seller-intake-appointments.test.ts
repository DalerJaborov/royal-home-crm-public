import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ $disconnect: vi.fn(), $transaction: vi.fn(), $queryRaw: vi.fn(), interaction: { findUnique: vi.fn() },
  client: { findUnique: vi.fn() }, workflowCheckpoint: { findUnique: vi.fn() }, sellerIntakeAppointmentEvidence: { upsert: vi.fn(), findMany: vi.fn() } }));
const signal = vi.hoisted(() => vi.fn());
vi.mock("../src/db.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: db }));
vi.mock("../src/lib/investigationCases.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/investigationCases.js")>(), recordInvestigationSignal: signal }));
import { countIntakeDateChanges, rememberSellerIntakeAppointment } from "../src/lib/sellerIntakeAppointments.js";
const at = new Date("2026-10-25T10:00:00Z");
const dates = [1, 2, 3, 4].map(day => new Date(at.getTime() + day * 86400_000));
const source = { id: "call4", clientId: "client", agentId: "agent", type: "CALL", callAttempt: "TALKED", recordingUrl: "recording", transcript: "Договорились перенести приём квартиры", createdAt: at, investigationOnly: false };
beforeEach(() => {
  vi.clearAllMocks(); db.$transaction.mockImplementation(fn => fn(db)); db.interaction.findUnique.mockResolvedValue(source);
  db.$queryRaw.mockResolvedValue([]);
  db.workflowCheckpoint.findUnique.mockResolvedValue({ createdAt: new Date(at.getTime() - 1000) });
  db.client.findUnique.mockResolvedValue({ id: "client", kind: "SELLER", assignedAt: new Date(at.getTime() - 1000), assignedAgentId: "agent" });
  db.sellerIntakeAppointmentEvidence.upsert.mockResolvedValue({ id: "e4" });
  db.sellerIntakeAppointmentEvidence.findMany.mockResolvedValue(dates.map((proposedAt, i) => ({ id: `e${i + 1}`, proposedAt, sourceOccurredAt: new Date(at.getTime() - (3 - i) * 1000) })));
});
describe("future seller intake snapshots", () => {
  it("three moves require initial appointment and three date changes; repeat date is not another move", () => {
    expect(countIntakeDateChanges(dates.slice(0, 3).map(proposedAt => ({ proposedAt })))).toBe(2);
    expect(countIntakeDateChanges([...dates.slice(0, 3), dates[2], dates[3]].map(proposedAt => ({ proposedAt })))).toBe(3);
  });
  it("keeps call snapshot immutable and records only private descriptive evidence", async () => {
    await rememberSellerIntakeAppointment(source.id, dates[3]);
    expect(db.sellerIntakeAppointmentEvidence.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {}, create: expect.objectContaining({ sourceInteractionId: source.id, sourceExcerpt: source.transcript }) }));
    expect(signal).toHaveBeenCalledWith(expect.objectContaining({ independenceKey: "call:call4", payload: expect.objectContaining({ mode: "PREVIEW", dateChanges: 3, assessment: "NOT_A_VERDICT" }) }), db);
  });
  it("does not add a new signal for another call repeating the same last appointment", async () => {
    db.sellerIntakeAppointmentEvidence.findMany.mockResolvedValue([...dates.map((proposedAt, i) => ({ id: `old${i}`, proposedAt, sourceOccurredAt: new Date(at.getTime() - (4 - i) * 1000) })), { id: "e4", proposedAt: dates[3], sourceOccurredAt: at }]);
    await rememberSellerIntakeAppointment(source.id, dates[3]); expect(signal).not.toHaveBeenCalled();
  });
  it("preserves simultaneous conflicting sources without inventing three ordered moves", async () => {
    db.sellerIntakeAppointmentEvidence.findMany.mockResolvedValue(dates.map((proposedAt, i) => ({ id: `e${i + 1}`, proposedAt, sourceOccurredAt: at })));
    expect(await rememberSellerIntakeAppointment(source.id, dates[3])).toEqual({ id: "e4" });
    expect(db.sellerIntakeAppointmentEvidence.upsert).toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });
  it("rejects notes and prior ownership instead of reconstructing overwritten historical dates", async () => {
    db.interaction.findUnique.mockResolvedValue({ ...source, callAttempt: null });
    expect(await rememberSellerIntakeAppointment(source.id, dates[3])).toBeNull();
    db.interaction.findUnique.mockResolvedValue(source);
    db.client.findUnique.mockResolvedValue({ id: "client", kind: "SELLER", assignedAt: new Date(at.getTime() + 1), assignedAgentId: "agent" });
    expect(await rememberSellerIntakeAppointment(source.id, dates[3])).toBeNull();
    expect(db.sellerIntakeAppointmentEvidence.upsert).not.toHaveBeenCalled();
  });
  it("does not reconstruct old appointments when an old call is analyzed after release", async () => {
    for (const cutover of [null, { createdAt: new Date(at.getTime() + 1) }]) {
      db.workflowCheckpoint.findUnique.mockResolvedValue(cutover);
      expect(await rememberSellerIntakeAppointment(source.id, dates[3])).toBeNull();
    }
    expect(signal).not.toHaveBeenCalled(); expect(db.sellerIntakeAppointmentEvidence.upsert).not.toHaveBeenCalled();
  });
});
