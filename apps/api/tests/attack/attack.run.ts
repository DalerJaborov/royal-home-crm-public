import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, it, vi } from "vitest";
import { createAttackStand, type AttackStand } from "./attackStand.js";
import { loadCorpusDir, selectScenarios, SYNTHETIC_CORPUS_DIR } from "./corpus.js";
import { judgeTurn } from "./judge.js";
import { buildReport, renderSummary, type ScenarioResult, type TurnResult } from "./report.js";
import type { AttackScenario, JudgeMode, TurnOutcome } from "./types.js";

// The synthetic media hosts must resolve to a public address, otherwise the (real) SSRF-safe downloader refuses them and every
// attachment degrades to "content unavailable". Same trick as tests/customer-dm-media-perception-postgres.test.ts.
vi.mock("node:dns/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:dns/promises")>();
  const base = (original as unknown as { default: typeof original }).default;
  return { ...original, default: { ...base, lookup: async (hostname: string, options: unknown) =>
    ["synthetic-core-cdn.invalid", "fixture.cdninstagram.com"].includes(hostname) ? [{ address: "93.184.216.34", family: 4 }] : base.lookup(hostname, options as never) } };
});

// Driver of the attack contour. Parameters arrive from scripts/attack-customer-core.mjs through ATTACK_* variables.
// It never fails on a judge verdict (those are the findings, written to the report); only a harness crash fails a scenario.
const mode: JudgeMode = process.env.ATTACK_MODEL === "live" ? "live" : "scripted";
const out = process.env.ATTACK_OUT ?? "";
const scenarios: AttackScenario[] = selectScenarios([
  ...loadCorpusDir(SYNTHETIC_CORPUS_DIR), ...(process.env.ATTACK_DATASET ? loadCorpusDir(process.env.ATTACK_DATASET) : []),
], { category: process.env.ATTACK_CATEGORY || undefined, limit: process.env.ATTACK_LIMIT ? Number(process.env.ATTACK_LIMIT) : undefined,
  ids: process.env.ATTACK_IDS ? process.env.ATTACK_IDS.split(",") : undefined });
const extraRules = new Set((process.env.ATTACK_EXTRA_RULES ?? "").split(",").filter(Boolean));

// The own-identity registry of the core refuses to classify when more than 128 messenger accounts exist, and every DM session
// owns one. The stand is therefore rebuilt (full cleanup + fresh fixture) every DM_SESSIONS_PER_STAND sessions.
const DM_SESSIONS_PER_STAND = 80;
const results: ScenarioResult[] = [];
let stand: AttackStand | undefined, dmSessions = 0; const startedAt = new Date(), began = Date.now();
const modelTotals = { total: 0, perception: 0 };
const retire = async () => { if (!stand) return; const calls = stand.modelCalls(); modelTotals.total += calls.total; modelTotals.perception += calls.perception; await stand.cleanup(); stand = undefined; };
async function standFor(surface: "dm" | "public_comment"): Promise<AttackStand> {
  if (stand && surface === "dm" && dmSessions >= DM_SESSIONS_PER_STAND) await retire();
  if (!stand) { stand = await createAttackStand({ mode, geminiKey: process.env.ATTACK_GEMINI_KEY || undefined, geminiModel: process.env.ATTACK_GEMINI_MODEL || undefined }); dmSessions = 0; }
  if (surface === "dm") dmSessions++;
  return stand;
}

afterAll(async () => {
  try {
    await retire();
    if (out) {
      mkdirSync(out, { recursive: true });
      const report = buildReport({ mode, startedAt, durationMs: Date.now() - began, modelCalls: modelTotals, scenarios, results });
      writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
      writeFileSync(join(out, "summary.md"), renderSummary(report));
    }
  } finally { await stand?.cleanup(); }
}, 180_000);

describe(`attack corpus (${mode}, ${scenarios.length} scenarios)`, () => {
  it.each(scenarios.map(scenario => [scenario.id, scenario] as const))("%s", async (_id, scenario) => {
    const result: ScenarioResult = { id: scenario.id, category: scenario.category, surface: scenario.surface, channel: scenario.channel, pass: false, turns: [] };
    results.push(result);
    try {
      const active = await standFor(scenario.surface);
      await active.arrange(scenario.fixture);
      const expanded: AttackScenario = { ...scenario, turns: scenario.turns.map(turn => ({ ...turn, in: active.expand(turn.in) })) };
      const session = scenario.surface === "dm" ? await active.newDmSession() : null;
      const outcomes: TurnOutcome[] = [];
      for (const [index, turn] of scenario.turns.entries()) {
        const outcome = session ? await session.turn(turn.in, turn.attach, { storyReply: turn.storyReply })
          : await active.publicComment(scenario.channel === "FACEBOOK" ? "FACEBOOK" : "INSTAGRAM", turn.in, scenario.fixture);
        outcomes.push(outcome);
        const judgement = judgeTurn({ scenario: expanded, turnIndex: index, outcomes, facts: active.facts, mode, extraRules });
        const entry: TurnResult = { input: turn.in, expandedInput: expanded.turns[index].in, outcome, pass: judgement.pass, verdicts: judgement.verdicts.filter(v => !v.pass || v.skipped) };
        result.turns.push(entry);
      }
      result.pass = result.turns.every(turn => turn.pass);
    } catch (error) { result.crashed = (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 600); throw error; }
  }, mode === "live" ? 300_000 : 120_000);
});
