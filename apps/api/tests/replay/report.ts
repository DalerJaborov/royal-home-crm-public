import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface ReplayAssertion { key: string; obligation: string; provenance: "synthetic-companion" | "observed-precondition"; status: "passed" | "failed" | "unavailable"; reason?: string }
export interface ReplayCase { key: string; channel: string; language: string; media: string; historicalLabel: string; assertions: ReplayAssertion[]; transcript: { role: string; content: string }[]; draft: unknown; receipts: unknown[]; attempts: unknown[]; unavailable: string[] }
export function replayReport(input: { sha: string; hashes: Record<string, string>; cases: ReplayCase[]; integrity: { records: number; selectedTurns: number }; quoteAccounting?: { roleLineMatchedTurns: number; unavailableTurns: number }; layer: string; flags: Record<string, boolean> }) {
  if (!/^[a-f0-9]{40}$/.test(input.sha)) throw new Error("Verified source SHA required");
  const assertions = input.cases.flatMap((item) => item.assertions);
  const count = (status: ReplayAssertion["status"]) => assertions.filter((item) => item.status === status).length;
  const deniedAttempts = input.cases.flatMap((item) => item.attempts).filter((attempt) => (attempt as { allowed?: boolean }).allowed === false).length;
  return { version: 1, adapterVersion: "p04-v1", graderVersion: "structural-obligations-v1", factFixtureVersion: "synthetic-public-v1", providerFixtureVersion: "scripted-v1", normalizerVersion: "semantic-v1", seed: null,
    randomness: "No seeded generator; fixed scripted model/card/clock, random physical stand resource IDs and contact aliases; explicit repeat comparison uses declared normalized semantic fields",
    clock: "2026-10-14T10:17:00.000Z", ...input,
    accounting: { recordsAccounted: input.integrity.records, turnsAccounted: input.integrity.selectedTurns, evaluatedCases: input.cases.filter((item) => item.assertions.some((assertion) => assertion.status !== "unavailable")).length,
      assertionsEvaluated: count("passed") + count("failed"), assertionsPassed: count("passed"), assertionsFailed: count("failed"), assertionsUnavailable: count("unavailable") },
    historicalBehavior: { fullHistoricalBehaviorEvaluated: 0, fullHistoricalBehaviorUnavailable: input.integrity.selectedTurns, historicalTrajectoryReplayed: false, explanation: "Structural synthetic companions and dataset accounting are separate from full historical semantic grading" },
    sandbox: { deniedAttempts, networkPolicy: "all-original-provider-io-denied", scripts: "bounded-scripted-model" },
    cost: { mode: "offline", realProviderRequests: 0, deniedNetworkAttempts: input.cases.flatMap((item) => item.attempts).filter((attempt) => (attempt as { kind?: string; allowed?: boolean }).kind === "network" && (attempt as { allowed?: boolean }).allowed === false).length,
      spendUsd: 0, proof: "scripted-model/fake-publication only; known original I/O hooks reject before execution; denied attempts remain red" }, exitCode: count("failed") || deniedAttempts ? 1 : 0 };
}
export function writeReplayReport(path: string, report: ReturnType<typeof replayReport>): void {
  if (!path) throw new Error("Explicit private artifact path required");
  const target = resolve(path); mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
