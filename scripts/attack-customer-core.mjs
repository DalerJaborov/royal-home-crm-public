#!/usr/bin/env node
// Attack contour for the customer agent core: the REAL core behind the normal signed intake/outbox, a scripted router or REAL Gemini
// as the model, a corpus of scenarios and an automatic judge. Docs: docs/customer-core-attack.md.
//   node scripts/attack-customer-core.mjs --model scripted                      # CI mode, no key, checks mechanics + judge
//   GEMINI_API_KEY=... node scripts/attack-customer-core.mjs --model live       # real model (owner provides the key)
//   ... --dataset <abs folder with real-scenarios.json> --category buyer --limit 20 --out <abs folder outside git> --strict
// Needs the owned stand database (apps/api/.env -> DATABASE_URL, migrated) and `npm run build:shared`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const take = key => { const index = args.indexOf(key); return index < 0 ? null : args[index + 1]; };
const flag = key => args.includes(key);
const fail = (message, code = 2) => { console.error(message); process.exit(code); };

const mode = take("--model") ?? "scripted";
if (!["live", "scripted"].includes(mode)) fail("--model must be live or scripted");
if (mode === "live" && !process.env.GEMINI_API_KEY) fail("live mode needs GEMINI_API_KEY in the environment (the owner provides the key; it is never written to a report).\nExample: GEMINI_API_KEY=... node scripts/attack-customer-core.mjs --model live --category buyer --limit 20");
const dataset = take("--dataset");
if (dataset && (!isAbsolute(dataset) || !existsSync(dataset))) fail("--dataset must be an existing absolute folder with scenario *.json files");
const repo = realpathSync(root);
const insideRepo = target => { const rel = relative(repo, target); return rel === "" || !rel.startsWith("..") && !isAbsolute(rel); };
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = take("--out") ?? join(tmpdir(), "royal-attack", `${mode}-${stamp}`);
if (!isAbsolute(out)) fail("--out must be an absolute path");
if (insideRepo(resolve(out))) fail("--out must be outside the git repository: reports can contain customer texts");
if (dataset && insideRepo(realpathSync(dataset))) fail("--dataset must live outside the git repository: real customer texts never enter git");
mkdirSync(out, { recursive: true });

// Opt-in judge rules: from the real findings file next to the dataset, or all of them with --strict.
const extra = new Set(flag("--strict") ? ["answers-the-question", "public-no-links-phone", "no-commission-first"] : []);
if (dataset) {
  const rulesFile = join(dataset, "real-findings-rules.json");
  if (existsSync(rulesFile)) for (const rule of JSON.parse(readFileSync(rulesFile, "utf8")).enableRules ?? []) extra.add(rule);
}

const env = { ...process.env, ATTACK_MODEL: mode, ATTACK_OUT: out, ATTACK_EXTRA_RULES: [...extra].join(","), TEST_ENV_PIN: "1", TZ: "UTC" };
for (const [key, name] of [["--dataset", "ATTACK_DATASET"], ["--category", "ATTACK_CATEGORY"], ["--limit", "ATTACK_LIMIT"], ["--ids", "ATTACK_IDS"]]) {
  const value = take(key); if (value) env[name] = value; else delete env[name];
}
if (take("--gemini-model")) env.ATTACK_GEMINI_MODEL = take("--gemini-model");
const cli = resolve(root, "node_modules/vitest/vitest.mjs");
console.error(`attack run: model=${mode}${dataset ? " +dataset" : ""} out=${out}`);
const result = spawnSync(process.execPath, [cli, "run", "--config", "tests/attack/vitest.attack.config.ts"], { cwd: resolve(root, "apps/api"), env, stdio: "inherit" });

const reportFile = join(out, "report.json");
if (!existsSync(reportFile)) fail(`no report written (vitest exit ${result.status ?? "?"}). Is the stand database up (apps/api/.env DATABASE_URL) and \`npm run build:shared\` done?`, 1);
const report = JSON.parse(readFileSync(reportFile, "utf8"));
console.log(`\nAttack ${report.mode}: ${report.passed}/${report.scenarioCount} scenarios passed, model calls ${report.modelCalls.total} (perception ${report.modelCalls.perception}), ${Math.round(report.durationMs / 1000)} s`);
for (const [category, row] of Object.entries(report.byCategory).sort()) console.log(`  ${category.padEnd(11)} ${row.passed}/${row.total}`);
for (const reason of report.failureReasons.slice(0, 10)) console.log(`  FAIL ${reason.rule}: ${reason.count}`);
console.log(`report: ${reportFile}\nsummary: ${join(out, "summary.md")}`);
// scripted: any failed scenario is a mechanical regression (exit 1). live: the failures ARE the findings, exit 0 unless --fail-on-findings.
const failed = report.passed !== report.scenarioCount;
process.exit(mode === "scripted" ? (failed || (result.status ?? 1) !== 0 ? 1 : 0) : flag("--fail-on-findings") && failed ? 1 : 0);
