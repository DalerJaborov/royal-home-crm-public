import { describe, expect, it } from "vitest";
import { applySourceResponse, reserveSourceRequest } from "../src/lib/somonLeads/sourceGate.js";

describe("Somon source request gate", () => {
  it("enforces spacing", () => {
    const gate = reserveSourceRequest({ stopped: false, nextAllowedAt: 0 }, 1000, 5000)!;
    expect(reserveSourceRequest(gate, 5999, 5000)).toBeNull();
    expect(reserveSourceRequest(gate, 6000, 5000)).not.toBeNull();
  });
  it("pauses on rate limit and stops on forbidden", () => {
    const state = { stopped: false, nextAllowedAt: 100 };
    const limited = applySourceResponse(state, 429, 1000, 120000);
    expect(reserveSourceRequest(limited, 120999, 1000)).toBeNull();
    const forbidden = applySourceResponse(state, 403, 1000);
    expect(reserveSourceRequest(forbidden, 1000000, 1000)).toBeNull();
    expect(applySourceResponse(state, 429, 1000, Number.POSITIVE_INFINITY).stopped).toBe(true);
    expect(applySourceResponse(state, 0, 1000).nextAllowedAt).toBe(61000);
  });
});
