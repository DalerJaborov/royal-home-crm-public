import { afterEach, describe, expect, it, vi } from "vitest";
import { newBuyerCandidateMode } from "../src/lib/buyerCandidateControl.js";
import { newSellerIntakeMode } from "../src/lib/sellerIntakeExecution.js";
afterEach(() => vi.unstubAllEnvs());
describe("future candidate execution activation", () => {
  it("seller intake freezes PREVIEW unless both explicit activation and source cutoff are present", () => {
    const at = new Date("2026-10-25T12:00:00Z");
    vi.stubEnv("SELLER_CONTROL_INTERNAL_LIVE", "explicitly-approved"); vi.stubEnv("SELLER_CONTROL_LIVE_FROM", "");
    expect(newSellerIntakeMode(at)).toBe("PREVIEW");
    vi.stubEnv("SELLER_CONTROL_LIVE_FROM", at.toISOString());
    expect(newSellerIntakeMode(new Date(at.getTime() - 1))).toBe("PREVIEW"); expect(newSellerIntakeMode(at)).toBe("LIVE");
    vi.stubEnv("SELLER_CONTROL_INTERNAL_LIVE", ""); expect(newSellerIntakeMode(at)).toBe("PREVIEW");
  });
  it("needs both gates and an explicit source cutover, never late-analysis old calls", () => {
    const at = new Date("2026-10-25T12:00:00Z");
    vi.stubEnv("BUYER_CANDIDATE_INTERNAL_LIVE", "explicitly-approved"); vi.stubEnv("SELLER_CONTROL_INTERNAL_LIVE", "explicitly-approved");
    vi.stubEnv("BUYER_CANDIDATE_LIVE_FROM", ""); expect(newBuyerCandidateMode(at)).toBe("PREVIEW");
    vi.stubEnv("BUYER_CANDIDATE_LIVE_FROM", at.toISOString()); expect(newBuyerCandidateMode(new Date(at.getTime() - 1))).toBe("PREVIEW");
    expect(newBuyerCandidateMode(at)).toBe("LIVE");
    vi.stubEnv("BUYER_CANDIDATE_INTERNAL_LIVE", ""); expect(newBuyerCandidateMode(at)).toBe("PREVIEW");
  });
});
