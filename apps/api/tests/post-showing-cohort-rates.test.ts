import { describe, expect, it } from "vitest";
import { postShowingCohortConfigSchema } from "@royal-home/shared";
import { compareRecordedCohorts } from "../src/lib/postShowingCohortRates.js";
const config = postShowingCohortConfigSchema.parse({});
const rows = (agentId: string, n: number, signal: number) => Array.from({ length: n }, (_, index) => ({ agentId, eligible: true, signal: index < signal }));
describe("descriptive cohort arithmetic", () => {
  it("uses the rest of the team and exposes both exact denominators", () => {
    const a = compareRecordedCohorts([...rows("a", 8, 4), ...rows("b", 20, 4)], config)[0];
    expect(a).toMatchObject({ eligible: 8, signal: 4, peerEligible: 20, peerSignal: 4, ratePercent: 50, peerRatePercent: 20, ratio: 2.5, gapPercentagePoints: 30, aboveDescriptiveThreshold: true, automaticVerdict: false });
  });
  it("excluded unknown observations never improve or worsen either rate", () => {
    const a = compareRecordedCohorts([...rows("a", 8, 4), ...rows("b", 20, 4), ...rows("a", 10, 10).map(r => ({ ...r, eligible: false }))], config)[0];
    expect(a).toMatchObject({ eligible: 8, excluded: 10, ratePercent: 50, peerEligible: 20 });
  });
  it("small samples and absent peer baseline never produce a threshold verdict", () => {
    expect(compareRecordedCohorts([...rows("a", 7, 7), ...rows("b", 20, 4)], config)[0]).toMatchObject({ evaluation: "INSUFFICIENT_SAMPLE", aboveDescriptiveThreshold: false });
    expect(compareRecordedCohorts([...rows("a", 8, 8), ...rows("b", 20, 0)], config)[0]).toMatchObject({ ratio: null, evaluation: "ZERO_OR_MISSING_PEER_BASELINE", aboveDescriptiveThreshold: false });
  });
});
