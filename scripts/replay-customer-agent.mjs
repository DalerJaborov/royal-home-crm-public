#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, existsSync, realpathSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shardVerdict } from "../apps/api/tests/runParallelVerdict.ts";
import { canonicalNewArtifact, within } from "./replayArtifactPaths.mjs";
import { readReplaySourceFingerprint, assertReplaySourceFingerprint } from "./replaySourceIntegrity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2); const take = (key) => { const index = args.indexOf(key); return index < 0 ? null : args[index + 1]; };
const mode = take("--mode") ?? "offline";
let manifestPath; let manifest;
try {
  if (!['offline', 'stand'].includes(mode) || process.env.TEST_ENV_PIN === "0") throw new Error("Unknown/unsafe replay mode or explicit pin opt-out");
  const dataset = take("--dataset"); const artifact = take("--artifact");
  if (!dataset || !artifact || !isAbsolute(dataset) || !isAbsolute(artifact)) throw new Error("Explicit absolute dataset/private artifact paths required");
  const corpus = realpathSync(dataset); const destination = canonicalNewArtifact(artifact); const target = destination.target;
  if (within(corpus, target)) throw new Error("Artifact cannot overwrite immutable corpus");
  let destinationRepository = null;
  try { destinationRepository = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: destination.ancestor, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* external private directory */ }
  if (destinationRepository) { try { execFileSync("git", ["check-ignore", "--quiet", "--", target], { cwd: destinationRepository, stdio: "ignore" }); } catch { throw new Error("Artifact canonical path is tracked/not ignored"); } }
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) throw new Error("Choose a new private artifact path; existing files are never overwritten");
  const fingerprint = readReplaySourceFingerprint(root); const { sha } = fingerprint;
  const runId = randomUUID(); const pending = `${target}.pending-${runId}`; const tests = `${target}.vitest-${runId}.json`; const violation = `${target}.violation-${runId}.json`;
  manifestPath = `${target}.run.json`; if (existsSync(manifestPath)) throw new Error("Existing run manifest cannot be overwritten");
  manifest = { version: 1, runId, sourceSha: sha, graderHash: fingerprint.graderHash, mode, status: "running", childExit: null, suitesComplete: false, testCounts: null, reportHash: null };
  const save = () => writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }); save();
  assertReplaySourceFingerprint(root, fingerprint);
  const env = { ...process.env, REPLAY_DATASET_DIR: corpus, REPLAY_ARTIFACT: pending, REPLAY_SOURCE_SHA: sha, REPLAY_VIOLATION_MARKER: violation, TEST_ENV_PIN: "1", TZ: "UTC" };
  const probe = take("--negative-probe");
  if (probe && !["late-caught-network", "unfinished-drain", "extra-model", "wrong-oracle"].includes(probe)) throw new Error("Unknown negative replay probe");
  if (probe && mode !== "offline") throw new Error("Negative replay probes require offline mode; stand never silently ignores the probe");
  delete env.REPLAY_NEGATIVE_PROBE; if (probe) env.REPLAY_NEGATIVE_PROBE = probe;
  delete env.NODE_OPTIONS;
  const cli = resolve(root, "node_modules/vitest/vitest.mjs");
  const config = mode === "offline" ? "tests/replay/vitest.replay.config.ts" : "tests/replay/vitest.stand.config.ts";
  const result = spawnSync(process.execPath, [cli, "run", "--config", config, "--reporter=default", "--reporter=json", `--outputFile.json=${tests}`], { cwd: resolve(root, "apps/api"), env, stdio: "inherit", timeout: 120000 });
  const code = result.status ?? 1; let vitest = null; let report = null;
  try { vitest = JSON.parse(readFileSync(tests, "utf8")); } catch { /* missing/malformed is red */ }
  try { report = JSON.parse(readFileSync(pending, "utf8")); } catch { /* no completed case artifact */ }
  const complete = shardVerdict(code, vitest) === "green";
  // Preserve the actual child outcome even if the evidence identity fails next.
  const counter = (name) => Number.isSafeInteger(vitest?.[name]) && vitest[name] >= 0 ? vitest[name] : null;
  manifest = { ...manifest, childExit: code, suitesComplete: complete,
    testCounts: { total: counter("numTotalTests"), passed: counter("numPassedTests"), failed: counter("numFailedTests"), pending: counter("numPendingTests"), todo: counter("numTodoTests") },
    reportHash: report ? createHash("sha256").update(readFileSync(pending)).digest("hex") : null };
  assertReplaySourceFingerprint(root, fingerprint);
  const green = complete && report?.exitCode === 0 && report?.sha === sha && report?.sandbox?.deniedAttempts === 0 && !existsSync(violation);
  manifest = { ...manifest, childExit: code, suitesComplete: complete, status: green ? "passed" : "failed", sandboxViolation: existsSync(violation), completedAt: new Date().toISOString(),
    reportHash: report ? createHash("sha256").update(readFileSync(pending)).digest("hex") : null };
  if (green) { if (existsSync(target)) throw new Error("Artifact appeared during run; refusing overwrite"); renameSync(pending, target); }
  save(); process.exit(green ? 0 : 1);
} catch (error) {
  const reason = (error instanceof Error ? error.message : "Replay integrity/preflight failed").replace(/\s+/g, " ").slice(0, 240);
  if (manifestPath && manifest) writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, status: "failed", failureReason: reason, completedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  console.error(reason); process.exit(1);
}
