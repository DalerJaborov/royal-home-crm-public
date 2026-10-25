import type { PostShowingCohortConfig } from "@royal-home/shared";

/** Definition-neutral arithmetic. Calling code must supply an approved, observable classification. */
export function compareRecordedCohorts(rows: Array<{ agentId: string; eligible: boolean; signal: boolean }>, config: PostShowingCohortConfig) {
  const groups = new Map<string, { eligible: number; signal: number; excluded: number }>();
  for (const row of rows) {
    const group = groups.get(row.agentId) ?? { eligible: 0, signal: 0, excluded: 0 };
    if (!row.eligible) group.excluded++;
    else { group.eligible++; if (row.signal) group.signal++; }
    groups.set(row.agentId, group);
  }
  const total = [...groups.values()].reduce((sum, g) => ({ eligible: sum.eligible + g.eligible, signal: sum.signal + g.signal }), { eligible: 0, signal: 0 });
  return [...groups].map(([agentId, group]) => {
    const peerEligible = total.eligible - group.eligible, peerSignal = total.signal - group.signal;
    const ratePercent = group.eligible ? 100 * group.signal / group.eligible : null;
    const peerRatePercent = peerEligible ? 100 * peerSignal / peerEligible : null;
    const ratio = ratePercent !== null && peerRatePercent !== null && peerRatePercent > 0 ? ratePercent / peerRatePercent : null;
    const gapPercentagePoints = ratePercent !== null && peerRatePercent !== null ? ratePercent - peerRatePercent : null;
    const sampleSufficient = group.eligible >= config.minAgentShowings && peerEligible >= config.minPeerShowings;
    return { agentId, ...group, peerEligible, peerSignal, ratePercent, peerRatePercent, ratio, gapPercentagePoints,
      evaluation: !sampleSufficient ? "INSUFFICIENT_SAMPLE" : ratio === null ? "ZERO_OR_MISSING_PEER_BASELINE" : "DESCRIPTIVE_COMPARISON",
      aboveDescriptiveThreshold: sampleSufficient && group.signal >= config.minSilentCases && ratio !== null && ratio >= config.minRatio && gapPercentagePoints !== null && gapPercentagePoints >= config.minGapPercentagePoints,
      automaticVerdict: false as const };
  });
}
