import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ $disconnect: vi.fn(), postShowingCall: { findUnique: vi.fn() }, sellerProbeCall: { findUnique: vi.fn() }, liveVoiceSession: { findMany: vi.fn() } }));
vi.mock("../src/db.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: db }));
import { loadInvestigationRecommendation, recommendInvestigationLevel } from "../src/lib/investigationRecommendation.js";
beforeEach(() => vi.clearAllMocks());
const trace = { id: "1", sourceType: "SHOWING", sourceId: "showing", kind: "late-cancellation", independenceKey: "showing:1", payload: {} };
describe("read-only evidence severity suggestions", () => {
  it("does not turn duplicate analyses, manual allegations or unverified absence into C2/C3", () => {
    expect(recommendInvestigationLevel("OPEN", [trace, { ...trace, id: "2" }, { ...trace, id: "3", independenceKey: "manual:actor" }]).level).toBe("C1");
    expect(recommendInvestigationLevel("OPEN", Array.from({ length: 10 }, (_, i) => ({ ...trace, id: `${i}`, sourceType: "unknown", independenceKey: `${i}` }))).level).toBe("C1");
  });
  it("distinct grounded kinds suggest C2; cleared human result remains C0 and no count produces C4", () => {
    const other = { ...trace, id: "2", sourceType: "CALL", kind: "SELLER_INTAKE_DATE_CHANGES", independenceKey: "call:2" };
    expect(recommendInvestigationLevel("OPEN", [trace, other])).toMatchObject({ level: "C2", mode: "PREVIEW" });
    expect(recommendInvestigationLevel("CLEARED", [{ ...trace, verifiedRedQuote: true }]).level).toBe("C0");
  });
  it("C3 needs matching private recorded client speech, not a fabricated quote or another client's call", async () => {
    const item = { ...trace, sourceType: "post-showing-call", sourceId: "call", kind: "outcome", payload: { unconfirmedOutcome: false } };
    db.postShowingCall.findUnique.mockResolvedValue({ clientId: "client", channelId: "channel", quote: "он предложил напрямую", outcome: "BYPASS", outcomeConfidence: 0.9 });
    db.liveVoiceSession.findMany.mockResolvedValue([{ recordingUrl: "private", transcript: "Клиент: он предложил напрямую" }]);
    expect((await loadInvestigationRecommendation({ status: "OPEN", clientId: "client", evidence: [item] })).level).toBe("C3");
    db.liveVoiceSession.findMany.mockResolvedValue([{ recordingUrl: "private", transcript: "Клиент: он не предложил напрямую" }]);
    expect((await loadInvestigationRecommendation({ status: "OPEN", clientId: "client", evidence: [item] })).level).toBe("C1");
    for (const quote of ["предложил напрямую", "да"]) {
      db.postShowingCall.findUnique.mockResolvedValue({ clientId: "client", channelId: "channel", quote, outcome: "BYPASS", outcomeConfidence: 0.9 });
      expect((await loadInvestigationRecommendation({ status: "OPEN", clientId: "client", evidence: [item] })).level).toBe("C1");
    }
    expect((await loadInvestigationRecommendation({ status: "OPEN", clientId: "other", evidence: [item] })).level).toBe("C1");
  });
});
