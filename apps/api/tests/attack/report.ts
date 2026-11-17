import type { AttackScenario, JudgeMode, RuleVerdict, TurnOutcome } from "./types.js";

export interface TurnResult { input: string; expandedInput: string; outcome: TurnOutcome; pass: boolean; verdicts: RuleVerdict[] }
export interface ScenarioResult { id: string; category: string; surface: string; channel: string; pass: boolean; turns: TurnResult[]; crashed?: string }
export interface RunReport {
  mode: JudgeMode; startedAt: string; durationMs: number; scenarioCount: number; passed: number; modelCalls: { total: number; perception: number };
  byCategory: Record<string, { total: number; passed: number }>; failureReasons: Array<{ rule: string; count: number; examples: Array<{ id: string; input: string; reply: string; detail: string }> }>;
  results: ScenarioResult[];
}

const clip = (value: string, max: number) => value.replace(/\s+/g, " ").slice(0, max);

export function buildReport(input: { mode: JudgeMode; startedAt: Date; durationMs: number; modelCalls: { total: number; perception: number }; scenarios: readonly AttackScenario[]; results: readonly ScenarioResult[] }): RunReport {
  const byCategory: RunReport["byCategory"] = {};
  const reasons = new Map<string, { count: number; examples: RunReport["failureReasons"][number]["examples"] }>();
  for (const result of input.results) {
    const bucket = byCategory[result.category] ??= { total: 0, passed: 0 };
    bucket.total++; if (result.pass) bucket.passed++;
    if (result.crashed) { const entry = reasons.get("harness-crash") ?? { count: 0, examples: [] }; entry.count++; if (entry.examples.length < 3) entry.examples.push({ id: result.id, input: "", reply: "", detail: clip(result.crashed, 160) }); reasons.set("harness-crash", entry); }
    for (const turn of result.turns) for (const verdict of turn.verdicts) {
      if (verdict.pass) continue;
      const rule = verdict.rule.replace(/^(must-(?:not-)?contain|no-question|topic|no-reask):.*/, "$1");
      const entry = reasons.get(rule) ?? { count: 0, examples: [] }; entry.count++;
      if (entry.examples.length < 3) entry.examples.push({ id: result.id, input: clip(turn.expandedInput, 120), reply: clip(turn.outcome.replies.join(" | "), 160), detail: clip(verdict.detail ?? "", 160) });
      reasons.set(rule, entry);
    }
  }
  return { mode: input.mode, startedAt: input.startedAt.toISOString(), durationMs: input.durationMs, scenarioCount: input.results.length, passed: input.results.filter(r => r.pass).length,
    modelCalls: input.modelCalls, byCategory, failureReasons: [...reasons.entries()].map(([rule, value]) => ({ rule, ...value })).sort((a, b) => b.count - a.count), results: [...input.results] };
}

export function renderSummary(report: RunReport): string {
  const lines = [`# Attack run (${report.mode})`, "",
    `Scenarios: ${report.scenarioCount}, passed: ${report.passed}, failed: ${report.scenarioCount - report.passed}. Model calls: ${report.modelCalls.total} (media perception: ${report.modelCalls.perception}). Duration: ${Math.round(report.durationMs / 1000)} s.`, "",
    "| category | total | passed |", "|---|---:|---:|", ...Object.entries(report.byCategory).sort().map(([name, row]) => `| ${name} | ${row.total} | ${row.passed} |`), "",
    "## Top failure reasons", ""];
  if (!report.failureReasons.length) lines.push("None.");
  for (const reason of report.failureReasons.slice(0, 10)) {
    lines.push(`### ${reason.rule} (${reason.count})`, "");
    for (const example of reason.examples) lines.push(`- \`${example.id}\`: in "${example.input}" -> "${example.reply}" (${example.detail})`);
    lines.push("");
  }
  const held = report.results.flatMap(r => r.turns.filter(t => t.outcome.status === "held" || t.outcome.status === "error").map(t => `${t.outcome.status}:${t.outcome.heldReason ?? t.outcome.error ?? ""}`));
  if (held.length) {
    const counts = new Map<string, number>(); for (const item of held) counts.set(item, (counts.get(item) ?? 0) + 1);
    lines.push("## HELD / error causes", "", ...[...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([cause, count]) => `- ${cause}: ${count}`), "");
  }
  return lines.join("\n");
}
