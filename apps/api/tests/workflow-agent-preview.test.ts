import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ $disconnect: vi.fn(), $queryRaw: vi.fn(), clientWorkflowObservation: { findMany: vi.fn() }, agent: { findMany: vi.fn() } }));
vi.mock("../src/db.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: db }));
import { previewWorkflowAgentCounts } from "../src/lib/workflowAgentPreview.js";
beforeEach(() => { vi.clearAllMocks(); db.agent.findMany.mockResolvedValue([{ id: "a", fullName: "Fixture" }]); });
describe("descriptive local workflow aggregates", () => {
  it("uses >3 cards, deduplicates showing sources and never calls unknown delivery a proven pocket showing", async () => {
    db.$queryRaw.mockResolvedValue([{ subjectAgentId: "a", count: 4n }, { subjectAgentId: "b", count: 3n }]);
    const row = { subjectAgentId: "a", sourceId: "s1", payload: { state: "DELIVERY_UNCONFIRMED", directDispatchState: "UNCONFIRMED" } };
    db.clientWorkflowObservation.findMany.mockResolvedValue([row, row, { ...row, sourceId: "s2" }, { ...row, sourceId: "s3", payload: { state: "DELIVERY_CONFIRMED" } }]);
    const result = await previewWorkflowAgentCounts();
    expect(result).toMatchObject({ coverage: "UNKNOWN", assessment: "NOT_A_VERDICT", mode: "PREVIEW" });
    expect(result.manual.map(row => row.reviewSuggested)).toEqual([true, false]);
    expect(result.showingContexts[0]).toMatchObject({ recordedUnconfirmedContexts: 2, reviewSuggested: true, countCompleteness: "LOCAL_RECORDS_ONLY" });
  });
});
