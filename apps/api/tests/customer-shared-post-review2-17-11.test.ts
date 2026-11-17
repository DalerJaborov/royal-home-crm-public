import { describe, expect, it, vi } from "vitest";

/** Review #225 N4 (17.11.2026): the marks of our company cannot be read from the database → the customer turn does not fall. */
const logSystemError = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/lib/systemError.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/systemError.js")>(), logSystemError }));
vi.mock("../src/lib/customerOwnBrandMarks.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/customerOwnBrandMarks.js")>(),
  loadCustomerOwnBrandMarks: vi.fn(async () => { throw new Error("db down"); }) }));
const { safeAnalyzeCustomerBurstReferences, analyzeCustomerBurstReferences } = await import("../src/lib/customerAgentMediaFocus.js");

const burst = { inputs: [] } as unknown as Parameters<typeof analyzeCustomerBurstReferences>[0];
const current = { eventKey: "e1", order: "1", media: false, evidence: [], captions: ["Royal Home\nОбъект №45"] };

describe("N4: unreadable marks", () => {
  it("the plain reader throws (the cause), the safe one answers null and writes a warning to the journal", async () => {
    await expect(analyzeCustomerBurstReferences(burst, current)).rejects.toThrow("db down");
    await expect(safeAnalyzeCustomerBurstReferences(burst, current)).resolves.toBeNull();
    expect(logSystemError).toHaveBeenCalledWith("ai", expect.stringContaining("db down"), expect.objectContaining({ dedupKey: "customer-burst-references-unreadable" }));
  });
});
