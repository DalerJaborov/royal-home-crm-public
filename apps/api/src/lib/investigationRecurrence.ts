import type { InvestigationCaseConfig } from "@royal-home/shared";

/** Sample is observed cases, not all agent transactions. Never estimates guilt or changes case levels. */
export function evaluateInvestigationRecurrence(config: InvestigationCaseConfig | null, cases: Array<{
  id: string; subjectAgentId: string | null; status: string; evidence: Array<{ independenceKey: string }>;
}>) {
  const agents = new Map<string, { subjectAgentId: string; cases: number; cleared: number; pending: number; confirmed: number; sourceGroups: number }>();
  const seen = new Set<string>();
  for (const row of cases) {
    if (!row.subjectAgentId || seen.has(row.id)) continue;
    seen.add(row.id);
    const item = agents.get(row.subjectAgentId) ?? { subjectAgentId: row.subjectAgentId, cases: 0, cleared: 0, pending: 0, confirmed: 0, sourceGroups: 0 };
    item.cases++;
    if (row.status === "CLEARED") item.cleared++;
    else if (row.status === "CONFIRMED") item.confirmed++;
    else item.pending++;
    item.sourceGroups += new Set(row.evidence.map(e => e.independenceKey)).size;
    agents.set(row.subjectAgentId, item);
  }
  return [...agents.values()].map(row => ({ ...row, evaluation: !config ? "NOT_CONFIGURED" : row.cases < config.minSample
    ? "INSUFFICIENT_SAMPLE" : row.pending + row.confirmed >= config.repeatThreshold ? "REPEATED_CASES_FOR_REVIEW" : "BELOW_REPEAT_THRESHOLD" }));
}
