import { describe, expect, it, vi } from "vitest";
vi.mock("../src/db.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: { $disconnect: vi.fn() } }));
import { summarizeNamedAssignments } from "../src/lib/namedAssignmentPreview.js";
const at = new Date("2026-10-25T10:00:00Z");
function rows(agent: string, count: number, confirmed: number, source = "intake") {
  return Array.from({ length: count }, (_, i) => {
    const base = { id: `${agent}${i}`, clientId: `${agent}${i}`, subjectAgentId: agent, assignmentAt: at, occurredAt: at };
    return [{ ...base, kind: "ASSIGNMENT_SNAPSHOT", payload: { source } }, { ...base, id: `${base.id}d`, kind: "NAMED_ASSIGNMENT", payload: { requestedAgentId: agent, verification: "UNVERIFIED" } },
      ...(i < confirmed ? [{ ...base, id: `${base.id}q`, kind: "NAMED_CLIENT_REQUEST", payload: { requestedAgentId: agent, verification: "AUTHENTICATED_CUSTOMER_TEXT" } }] : [])];
  }).flat();
}
describe("named-source cohort preview", () => {
  it("uses actual assignment denominator and trusted sources, never declarations as confirmation", () => {
    const result = summarizeNamedAssignments([...rows("one", 10, 8), ...rows("peer", 10, 2)], 5, true);
    expect(result.find(row => row.subjectAgentId === "one")).toMatchObject({ allObservedAssignments: 10, namedDeclared: 10, namedSourceConfirmed: 8, evaluation: "PRIVATE_REVIEW_PREVIEW", automaticLevel: null });
  });
  it("requires explicit sample and full observation period; never compares different routing sources", () => {
    const data = [...rows("one", 10, 8), ...rows("peer", 10, 2, "different-path")];
    expect(summarizeNamedAssignments(data, null, true)[0].evaluation).toBe("NOT_CONFIGURED");
    expect(summarizeNamedAssignments(data, 5, false)[0].evaluation).toBe("INSUFFICIENT_WINDOW");
    expect(summarizeNamedAssignments(data, 5, true)[0].evaluation).toBe("INSUFFICIENT_SAMPLE");
  });
  it("does not reuse a quote for ambiguous repeated assignment timestamps", () => {
    const data = rows("one", 1, 1); data.push({ ...data[0], id: "second-event" });
    expect(summarizeNamedAssignments(data, 1, true)[0]).toMatchObject({ allObservedAssignments: 2, namedSourceConfirmed: 0, evaluation: "SOURCE_QUALITY_UNKNOWN" });
  });
});
