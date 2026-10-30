import { beforeEach, describe, expect, it, vi } from "vitest";
const store = vi.hoisted(() => ({ claim: vi.fn(), record: vi.fn() }));
vi.mock("../src/lib/somonLeads/sourceBudgetStore.js", () => ({ claimSomonRequest: store.claim, recordSomonResponse: store.record }));
import { fetchSomon } from "../src/lib/somonLeads/sourceClient.js";
const path = "/nedvizhimost/prodazha-kvartir/dushanbe/";
beforeEach(() => { vi.clearAllMocks(); store.claim.mockResolvedValue("test-lease"); store.record.mockResolvedValue(undefined); });
describe("Somon diagnostics without upstream data leakage", () => {
  it.each([
    [new DOMException("private response", "TimeoutError"), "REQUEST_TIMEOUT"],
    [Object.assign(new Error("private URL"), { cause: { code: "EAI_AGAIN" } }), "EAI_AGAIN"],
    [new Error("secret upstream body"), "FETCH_FAILED"],
  ])("retains a safe cause and records the failure", async (error, code) => {
    await expect(fetchSomon(path, new Date(), vi.fn().mockRejectedValue(error))).rejects.toThrow(`network (${code})`);
    expect(store.record).toHaveBeenCalledWith("test-lease", 0, expect.any(Date));
  });
  it("reports HTTP status and retains the refusal gate", async () => {
    await expect(fetchSomon(path, new Date(), vi.fn().mockResolvedValue(new Response("private", { status: 403 })))).rejects.toThrow("HTTP 403");
    expect(store.record).toHaveBeenCalledWith("test-lease", 403, expect.any(Date), undefined);
  });
  it("does not request when the gate is stopped", async () => {
    store.claim.mockResolvedValue(null);
    const request = vi.fn();
    await expect(fetchSomon(path, new Date(), request)).rejects.toMatchObject({ reason: "not_ready" });
    expect(request).not.toHaveBeenCalled();
  });
});
